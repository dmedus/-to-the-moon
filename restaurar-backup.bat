@echo off
rem Restaura un backup de To the Moon: arrastra el archivo .ttmbak sobre este .bat
cd /d "%~dp0"
node restaurar-backup.js "%~1"
pause
