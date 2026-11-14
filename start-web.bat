@echo off
rem PDF2PPT Web one-click launcher (Windows CMD / double-click).
rem Usage: start-web.bat [port]        start on a port, then open the browser
rem        start-web.bat stop [port]   stop the service listening on that port
rem Env:   NO_BROWSER=1               skip opening the browser (automation)
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PY=%CD%\.venv\Scripts\python.exe"
set "PORT=5000"
if /i "%~1"=="stop" goto STOP
if not "%~1"=="" set "PORT=%~1"
set "HEALTH=http://127.0.0.1:%PORT%/api/health"
set "URL=http://127.0.0.1:%PORT%/?demo=1"
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=%NO_PROXY%"
set "PYTHONIOENCODING=utf-8"

if not exist "%PY%" (
  echo [ERROR] Virtual env not found: %PY%
  echo Run: uv venv --python 3.12 ^&^& uv pip install -r requirements.txt
  pause
  exit /b 1
)

echo [1/3] Checking port %PORT% ...
curl -fsS --noproxy "*" -o NUL "%HEALTH%" >nul 2>&1
if %errorlevel%==0 (
  echo Service already running - reusing it.
  goto OPEN
)

echo [2/3] Starting web service ^(minimized window^) ...
start "PDF2PPT Web Service" /MIN "%PY%" webapp.py --port %PORT%

set /a TRIES=0
:WAIT
curl -fsS --noproxy "*" -o NUL "%HEALTH%" >nul 2>&1
if %errorlevel%==0 goto OPEN
set /a TRIES+=1
if !TRIES! GEQ 25 (
  echo [ERROR] Timeout. Check the "PDF2PPT Web Service" window.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto WAIT

:OPEN
echo [3/3] Opening browser ...
if defined NO_BROWSER goto DONE
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --no-proxy-server "%URL%"
) else (
  start "" "%URL%"
)

:DONE
echo.
echo   URL  : %URL%
echo   Stop : close the "PDF2PPT Web Service" window, or run "start-web.bat stop"
echo.
if defined NO_BROWSER exit /b 0
pause
exit /b 0

:STOP
if not "%~2"=="" set "PORT=%~2"
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"127.0.0.1:%PORT%" ^| findstr /c:"LISTENING"') do set "FOUND=%%p"
if not defined FOUND (
  echo No service listening on port %PORT%.
  exit /b 0
)
echo Stopping service PID !FOUND! ...
taskkill /PID !FOUND! /F >nul 2>&1
if %errorlevel%==0 (echo Stopped.) else (echo [ERROR] Failed. Stop it manually.)
exit /b 0
