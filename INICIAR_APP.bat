@echo off
chcp 65001 > nul
cd /d "%~dp0"
title Advocacia Bot Oficial
if not exist "node_modules\" (
    echo [INFO] Instalando dependencias limpas do zero... Aguarde finalizar!
    call npm install
)
echo [INFO] Iniciando aplicativo...
call npm start
pause