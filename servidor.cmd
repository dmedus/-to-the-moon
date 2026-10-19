@echo off
rem Mantiene corriendo el servidor de To the Moon: si se cae, lo vuelve a levantar a los 5 segundos.
cd /d "%~dp0"
:loop
echo [%date% %time%] Iniciando servidor >> data\server.log
node server.js >> data\server.log 2>&1
echo [%date% %time%] El servidor se detuvo, reiniciando en 5 s >> data\server.log
timeout /t 5 /nobreak > nul
goto loop
