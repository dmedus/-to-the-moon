@echo off
rem Detiene el servidor de To the Moon (y el proceso que lo reinicia).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*Acciones\app\servidor.cmd*' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' -and $_.CommandLine -notlike '*mcp*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
rem Marca para que vigilante.vbs no lo vuelva a arrancar (se borra al iniciar)
type nul > "%~dp0data\detenido"
echo Servidor detenido.
timeout /t 2 > nul
