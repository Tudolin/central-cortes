# Para o worker em segundo plano e tira ele da inicialização do Windows.
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "Central de Cortes - worker.vbs"
Remove-Item -Force -ErrorAction SilentlyContinue $vbs
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match "worker-start\.ps1" -or ($_.Name -eq "node.exe" -and $_.CommandLine -match "app/main\.ts") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output "Worker parado e removido da inicialização."
