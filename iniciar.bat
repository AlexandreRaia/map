@echo off
setlocal EnableExtensions
title MapBairros
cd /d "%~dp0"

set "PYTHON_LOCAL=%CD%\.venv\Scripts\python.exe"
set "ETAPA=preparacao do ambiente Python"

if not exist "%PYTHON_LOCAL%" (
  echo Preparando o MapBairros pela primeira vez...
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3 -m venv ".venv"
  ) else (
    where python >nul 2>&1
    if errorlevel 1 goto :python_ausente
    python -m venv ".venv"
  )
  if errorlevel 1 goto :erro
)

set "ETAPA=instalacao das dependencias"
"%PYTHON_LOCAL%" -c "import fastapi, uvicorn, jinja2" >nul 2>&1
if errorlevel 1 (
  echo Instalando os componentes necessarios...
  "%PYTHON_LOCAL%" -m pip install -r "requirements.txt"
  if errorlevel 1 goto :erro
)

set "ETAPA=preparacao da base CNEFE"
if not exist "cnefe.sqlite" (
  echo Importando a base CNEFE. Isso pode levar alguns segundos...
  "%PYTHON_LOCAL%" "importar_dados.py"
  if errorlevel 1 goto :erro
)

rem Reaproveita apenas um servidor da versao atual. Encerra uma versao antiga do proprio MapBairros.
powershell.exe -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/saude' -TimeoutSec 2; if ($r.status -eq 'ok' -and $r.versao -eq 2) { exit 0 }; if ($r.status -eq 'ok') { $pidMapa = (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction Stop).OwningProcess; Stop-Process -Id $pidMapa -Force; Start-Sleep -Milliseconds 500 } }; exit 1" >nul 2>&1
if not errorlevel 1 (
  echo O MapBairros ja esta em execucao.
  if not defined MAPBAIRROS_NO_BROWSER start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process 'http://127.0.0.1:8000'"
  goto :fim
)

echo.
echo MapBairros iniciado em http://127.0.0.1:8000
echo Mantenha esta janela aberta durante o uso.
echo Para encerrar, pressione Ctrl+C.
echo.

rem O navegador abre depois que o servidor teve tempo para iniciar.
if not defined MAPBAIRROS_NO_BROWSER start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8000'"

set "ETAPA=inicializacao do servidor"
"%PYTHON_LOCAL%" -m uvicorn app:app --host 127.0.0.1 --port 8000
if errorlevel 1 goto :erro
goto :fim

:python_ausente
echo.
echo Python nao foi encontrado neste computador.
echo Instale o Python 3 e marque a opcao "Add Python to PATH".
pause
goto :fim

:erro
echo.
echo Falha durante: %ETAPA%.
echo Revise a mensagem exibida acima e tente novamente.
pause

:fim
endlocal
