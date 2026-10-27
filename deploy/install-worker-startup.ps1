# Faz o worker subir sozinho com o Windows (atalho na pasta Inicializar do usuário) e já o inicia.
# Para desfazer: deploy\uninstall-worker-startup.ps1
$start = Join-Path $PSScriptRoot "worker-start.ps1"
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "Central de Cortes - worker.vbs"
# .vbs abre o PowerShell sem janela nenhuma.
Set-Content -Encoding ascii $vbs "CreateObject(""WScript.Shell"").Run ""powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$start"""""", 0, False"
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Output "Instalado: $vbs"
