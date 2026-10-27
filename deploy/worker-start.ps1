# Worker da Central de Cortes no Windows: sobe escondido com o login e reinicia sozinho se cair.
# Instalado por deploy\install-worker-startup.ps1. Log em data\worker.log.
$mutex = New-Object System.Threading.Mutex($false, "Global\CentralCortesWorker")
if (-not $mutex.WaitOne(0)) { exit } # já tem um rodando

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:Path = "C:\Program Files\nodejs;" + $env:Path
$log = Join-Path $root "data\worker.log"
New-Item -ItemType Directory -Force (Join-Path $root "data") | Out-Null

while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$log.old" }
  Add-Content -Encoding utf8 $log "[$(Get-Date -Format s)] iniciando worker"
  cmd /c "node app/main.ts >> data\worker.log 2>&1"
  Add-Content -Encoding utf8 $log "[$(Get-Date -Format s)] worker saiu (código $LASTEXITCODE); reiniciando em 15 s"
  Start-Sleep 15
}
