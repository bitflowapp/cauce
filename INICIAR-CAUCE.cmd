@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Hace falta Node.js 22 o posterior para iniciar CAUCE.
  pause
  exit /b 1
)
echo CAUCE - demostracion local. No envia pedidos ni realiza cobros.
echo Abrir http://127.0.0.1:4173 cuando el servidor este listo.
node scripts\server.mjs
if errorlevel 1 pause
endlocal
