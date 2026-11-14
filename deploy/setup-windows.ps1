# Central de Cortes no Windows: instala o que falta, cria o .env e deixa rodando sozinho com o Windows.
#
#   Tudo em um PC so (painel + processamento):
#     powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1
#
#   So o worker (o hub fica em outra maquina):
#     powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1 -Role worker -HubUrl http://IP_DO_HUB:8095 -WorkerToken SEGREDO
#
# Pode rodar de novo quando quiser: o .env existente e respeitado (so entram as chaves que faltam)
# e nada que ja esta instalado e baixado de novo. Para tirar da inicializacao: deploy\uninstall-worker-startup.ps1
# (Sem acentos de proposito: o PowerShell 5 le arquivos sem BOM como ANSI.)
param(
  [ValidateSet("", "all", "worker")][string]$Role = "",
  [string]$HubUrl = "",
  [string]$WorkerToken = "",
  [string]$AnthropicKey = "",
  [switch]$LocalAi,   # usa IA local (Ollama) em vez do Claude
  [switch]$NoStartup, # nao instala a inicializacao automatica nem inicia agora
  [string]$WhisperModel = "large-v3-turbo-q5_0"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest fica muito lento com a barra de progresso
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$envFile = Join-Path $root ".env"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Winget-Install($id, $what, $manual) {
  if (-not (Has "winget")) { throw "Falta $what e este Windows nao tem o winget para instalar sozinho. Instale manualmente ($manual), abra um PowerShell novo e rode este script de novo." }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
# Mesmo PATH que o worker usa ao iniciar (deploy\worker-start.ps1): o Node pode estar instalado sem estar no PATH desta janela.
$env:Path = "C:\Program Files\nodejs;" + $env:Path

# ---------- .env: le o que existe e so acrescenta o que falta ----------
$envLines = New-Object System.Collections.Generic.List[string]
if (Test-Path $envFile) { foreach ($l in [IO.File]::ReadAllLines($envFile)) { $envLines.Add($l) } }
function Get-Env($key) {
  foreach ($l in $envLines) { if ($l -match "^\s*$key\s*=(.*)$") { return $Matches[1].Trim() } }
  return ""
}
function Set-Env($key, $value, [switch]$Force) {
  for ($i = 0; $i -lt $envLines.Count; $i++) {
    if ($envLines[$i] -match "^\s*$key\s*=(.*)$") {
      if ($Force -or -not $Matches[1].Trim()) { $envLines[$i] = "$key=$value" }
      return
    }
  }
  $envLines.Add("$key=$value")
}
function Save-Env {
  # UTF-8 sem BOM: com BOM o Node nao reconhece a primeira chave do arquivo.
  [IO.File]::WriteAllLines($envFile, $envLines, (New-Object System.Text.UTF8Encoding $false))
}

# Variavel propria: $Role carrega o ValidateSet do param e recusaria um valor inesperado vindo do .env.
$mode = $Role
if (-not $mode) { $mode = Get-Env "ROLE" }
if (-not $mode) { $mode = "all" }
if ($mode -notin @("all", "worker")) { throw "ROLE=$mode no .env: este script configura 'all' (um PC so) ou 'worker'. O hub separado roda em Docker (veja o README)." }
if ("$HubUrl $WorkerToken" -match "IP_DO_HUB|SEGREDO") { throw "Troque IP_DO_HUB e SEGREDO pelos valores reais (ou rode sem parametros para usar o .env que ja existe)." }
Write-Host "Central de Cortes - configurando como '$mode' em $root"

# ---------- programas ----------
Step "Node.js"
function Node-Major { if (Has "node") { [int](node -p "process.versions.node.split('.')[0]") } else { 0 } }
function Download($url, $dest) {
  Write-Host "Baixando $url"
  curl.exe -fL --retry 3 -o $dest $url
  if ($LASTEXITCODE -ne 0) { throw "Falha ao baixar $url" }
}
if ((Node-Major) -lt 24) {
  if (Has "winget") { Winget-Install "OpenJS.NodeJS.LTS" "o Node.js" "https://nodejs.org" }
  else {
    # Sem winget: instalador oficial (.msi) da versao LTS mais nova. O Windows pede permissao de administrador.
    $lts = (Invoke-RestMethod "https://nodejs.org/dist/index.json") | Where-Object { $_.lts -and ([int]($_.version -replace "^v(\d+)\..*", '$1')) -ge 24 } | Select-Object -First 1
    if (-not $lts) { throw "Nao achei uma versao LTS do Node.js para baixar. Instale manualmente por https://nodejs.org e rode de novo." }
    $msi = Join-Path $env:TEMP "node-$($lts.version)-x64.msi"
    Download "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" $msi
    Write-Host "Instalando o Node.js $($lts.version) (confirme a janela de permissao do Windows)..."
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Wait -PassThru
    Remove-Item -Force $msi -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0) { throw "A instalacao do Node.js nao terminou (codigo $($p.ExitCode)). Instale manualmente por https://nodejs.org e rode de novo." }
    Refresh-Path
    $env:Path = "C:\Program Files\nodejs;" + $env:Path
  }
}
if ((Node-Major) -lt 24) { throw "Node.js instalado, mas esta janela ainda nao o enxerga. Abra um PowerShell novo e rode o script de novo." }
Write-Host "Node $(node -v)"

# ffmpeg e yt-dlp: versoes portateis em tools\ (nao dependem do winget nem de permissao de administrador).
$toolsDir = Join-Path $root "tools"
$ffmpegExe = $null; $ffprobeExe = $null; $ytdlpExe = $null

Step "ffmpeg"
$ffDir = Join-Path $toolsDir "ffmpeg"
function Find-Tool($dir, $name) {
  if (-not (Test-Path $dir)) { return $null }
  Get-ChildItem $dir -Recurse -Filter $name | Select-Object -First 1 -ExpandProperty FullName
}
if (-not ((Get-Env "FFMPEG_BIN") -or (Has "ffmpeg"))) {
  if (-not (Find-Tool $ffDir "ffmpeg.exe")) {
    $zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
    Download "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $zip
    New-Item -ItemType Directory -Force $ffDir | Out-Null
    Expand-Archive -Force $zip $ffDir
    Remove-Item -Force $zip
  }
  $ffmpegExe = Find-Tool $ffDir "ffmpeg.exe"
  $ffprobeExe = Find-Tool $ffDir "ffprobe.exe"
  if (-not ($ffmpegExe -and $ffprobeExe)) { throw "ffmpeg.exe/ffprobe.exe nao vieram no pacote baixado." }
  Write-Host $ffmpegExe
}

Step "yt-dlp"
if (-not ((Get-Env "YTDLP_BIN") -or (Has "yt-dlp"))) {
  $ytdlpExe = Join-Path $toolsDir "yt-dlp.exe"
  if (-not (Test-Path $ytdlpExe)) {
    New-Item -ItemType Directory -Force $toolsDir | Out-Null
    Download "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" "$ytdlpExe.part"
    Move-Item -Force "$ytdlpExe.part" $ytdlpExe
  }
  Write-Host $ytdlpExe
}

$gpu = Has "nvidia-smi"
if ($gpu) { Write-Host "`nPlaca NVIDIA detectada: transcricao e render vao usar a GPU." }

Step "whisper.cpp"
$whisperDir = Join-Path $root "tools\whisper"
function Find-Whisper { Find-Tool $whisperDir "whisper-cli.exe" }
$whisperExe = Find-Whisper
if (-not ($whisperExe -or (Get-Env "WHISPER_BIN") -or (Has "whisper-cli"))) {
  # Os nomes dos .zip mudam entre versoes: procura nas ultimas releases; se a API falhar, usa uma versao conhecida.
  $wanted = if ($gpu) { @("^whisper-cublas-12.*-bin-x64\.zip$", "^whisper-bin-x64\.zip$") } else { @("^whisper-bin-x64\.zip$") }
  $url = $null
  try {
    $releases = Invoke-RestMethod "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15" -Headers @{ "User-Agent" = "setup" }
    foreach ($pattern in $wanted) {
      foreach ($rel in $releases) {
        $asset = $rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
        if ($asset) { $url = $asset.browser_download_url; break }
      }
      if ($url) { break }
    }
  } catch { Write-Host "API do GitHub indisponivel; usando a versao v1.8.2." }
  if (-not $url) {
    $name = if ($gpu) { "whisper-cublas-12.4.0-bin-x64.zip" } else { "whisper-bin-x64.zip" }
    $url = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/$name"
  }
  Write-Host "Baixando $url"
  $zip = Join-Path $env:TEMP "whisper-cpp.zip"
  curl.exe -fL --retry 3 -o $zip $url
  if ($LASTEXITCODE -ne 0) { throw "Falha ao baixar o whisper.cpp." }
  New-Item -ItemType Directory -Force $whisperDir | Out-Null
  Expand-Archive -Force $zip $whisperDir
  Remove-Item -Force $zip
  $whisperExe = Find-Whisper
  if (-not $whisperExe) { throw "whisper-cli.exe nao veio no pacote baixado ($url)." }
}
if ($whisperExe) { Write-Host $whisperExe }

Step "Modelo do whisper ($WhisperModel)"
$modelRel = Get-Env "WHISPER_MODEL"
if (-not $modelRel) { $modelRel = "models/ggml-$WhisperModel.bin" }
$modelPath = if ([IO.Path]::IsPathRooted($modelRel)) { $modelRel } else { Join-Path $root $modelRel }
if (-not (Test-Path $modelPath)) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $modelPath) | Out-Null
  $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + (Split-Path -Leaf $modelPath)
  curl.exe -fL --retry 3 -o "$modelPath.part" $modelUrl
  if ($LASTEXITCODE -ne 0) { throw "Falha ao baixar o modelo do whisper ($modelUrl)." }
  Move-Item -Force "$modelPath.part" $modelPath
}

Step "Dependencias do projeto (npm)"
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install falhou." }

# ---------- IA ----------
Step "IA que escolhe os cortes"
if ($AnthropicKey) { Set-Env "ANTHROPIC_API_KEY" $AnthropicKey -Force }
if (-not $LocalAi -and -not (Get-Env "ANTHROPIC_API_KEY") -and (Get-Env "LOCAL_AI") -ne "always") {
  Write-Host "Chave da API da Anthropic (console.anthropic.com). Deixe vazio para usar IA local gratuita (Ollama; pede placa de video com 8 GB)."
  $key = Read-Host "ANTHROPIC_API_KEY"
  if ($key.Trim()) { Set-Env "ANTHROPIC_API_KEY" $key.Trim() -Force } else { $LocalAi = $true }
}
if ($LocalAi) {
  Set-Env "LOCAL_AI" "always" -Force
  $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (-not (Test-Path $ollama)) { Winget-Install "Ollama.Ollama" "o Ollama" "https://ollama.com/download" }
  $model = Get-Env "LOCAL_MODEL"
  if (-not $model) { $model = "qwen3:8b" }
  if (Test-Path $ollama) {
    Write-Host "Baixando o modelo $model (alguns GB na primeira vez)..."
    & $ollama pull $model
  } else { Write-Host "Ollama nao encontrado em $ollama; depois da instalacao rode: ollama pull $model" -ForegroundColor Yellow }
} else { Write-Host "Claude (chave no .env)." }

# ---------- .env ----------
Step ".env"
$newEnv = -not (Test-Path $envFile)
Set-Env "ROLE" $mode -Force
if ($mode -eq "worker") {
  if ($HubUrl) { Set-Env "HUB_URL" $HubUrl -Force }
  if ($WorkerToken) { Set-Env "WORKER_TOKEN" $WorkerToken -Force }
  if (-not (Get-Env "HUB_URL")) { Set-Env "HUB_URL" (Read-Host "Endereco do hub (ex.: http://100.x.y.z:8095)").Trim() -Force }
  if (-not (Get-Env "WORKER_TOKEN")) { Set-Env "WORKER_TOKEN" (Read-Host "WORKER_TOKEN (o mesmo do .env do hub)").Trim() -Force }
} else {
  # Um PC so: painel atende apenas esta maquina, entao nao precisa de senha.
  Set-Env "HOST" "127.0.0.1"
  Set-Env "PORT" "8080"
}
if ($whisperExe) { Set-Env "WHISPER_BIN" $whisperExe }
if ($ffmpegExe) { Set-Env "FFMPEG_BIN" $ffmpegExe; Set-Env "FFPROBE_BIN" $ffprobeExe }
if ($ytdlpExe) { Set-Env "YTDLP_BIN" $ytdlpExe }
Set-Env "WHISPER_MODEL" $modelRel
Set-Env "WHISPER_THREADS" ([Math]::Max(4, [Math]::Min(16, [Environment]::ProcessorCount - 2)))
if ($gpu) { Set-Env "FFMPEG_VCODEC" "h264_nvenc" }
if ($newEnv) { Set-Env "SUBTITLE_FONT" "Anton" } # fonte que ja vem no projeto (web\fonts)
Save-Env
Write-Host "Salvo em $envFile"

# ---------- conferencia ----------
Step "Diagnostico"
node --disable-warning=ExperimentalWarning app/doctor.ts
$healthy = $LASTEXITCODE -eq 0

if (-not $NoStartup) {
  Step "Inicializacao automatica"
  # Para o que estiver rodando (pega o .env novo) e sobe de novo, escondido, agora e a cada login.
  & (Join-Path $PSScriptRoot "uninstall-worker-startup.ps1") | Out-Null
  & (Join-Path $PSScriptRoot "install-worker-startup.ps1")
}

Write-Host ""
if (-not $healthy) { Write-Host "Ha pendencias no diagnostico acima. Corrija e rode este script de novo." -ForegroundColor Yellow }
if ($NoStartup) { Write-Host "Para iniciar manualmente: node app/main.ts" }
else { Write-Host "Rodando em segundo plano. Log: data\worker.log" }
if ($mode -eq "all") {
  $port = Get-Env "PORT"
  Write-Host "Painel: http://localhost:$port" -ForegroundColor Green
  if ($healthy -and -not $NoStartup) { Start-Sleep 4; Start-Process "http://localhost:$port" }
} else {
  Write-Host "Em ate 1 minuto o painel do hub deve mostrar este PC como online." -ForegroundColor Green
}
