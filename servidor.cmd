@echo off
rem Mantiene corriendo el servidor de To the Moon: si se cae, lo vuelve a levantar a los 5 segundos.
cd /d "%~dp0"
:loop
rem Si el log pasa de 1 MB se guarda como server.old.log (pisando el anterior) y se empieza uno nuevo
for %%F in (data\server.log) do if %%~zF GTR 1000000 move /y data\server.log data\server.old.log > nul
echo [%date% %time%] Iniciando servidor >> data\server.log
node server.js >> data\server.log 2>&1
echo [%date% %time%] El servidor se detuvo, reiniciando en 5 s >> data\server.log
timeout /t 5 /nobreak > nul
goto loop
