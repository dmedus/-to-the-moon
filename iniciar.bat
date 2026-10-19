@echo off
rem Abre To the Moon. Si el servidor no está corriendo, lo inicia en segundo plano.
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest http://localhost:3000/login.html -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  wscript "%~dp0iniciar-oculto.vbs"
  timeout /t 3 /nobreak > nul
)
start "" http://localhost:3000
