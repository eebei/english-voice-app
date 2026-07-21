@echo off
setlocal
cd /d "%~dp0"
title PITWALL Strategy Logger

if not exist "%~dp0log_strategy_timeseries.py" (
  if exist "%~dp0LOGGER-DATA-1.txt" certutil -f -decode "%~dp0LOGGER-DATA-1.txt" "%~dp0log_strategy_timeseries.py" >nul
)
if not exist "%~dp0irsdk_mem.py" (
  if exist "%~dp0LOGGER-DATA-2.txt" certutil -f -decode "%~dp0LOGGER-DATA-2.txt" "%~dp0irsdk_mem.py" >nul
)

if not exist "%~dp0log_strategy_timeseries.py" (
  echo [ERROR] LOGGER-DATA-1.txt ga arimasen.
  pause
  exit /b 1
)
if not exist "%~dp0irsdk_mem.py" (
  echo [ERROR] LOGGER-DATA-2.txt ga arimasen.
  pause
  exit /b 1
)

echo ========================================
echo   PITWALL Strategy Logger
echo ========================================
echo.
echo iRacing session wo load shita ato ni jikko shite kudasai.
echo Kiroku wo owaru toki wa Ctrl+C wo oshimasu.
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0log_strategy_timeseries.py" ai-race
  goto finished
)

where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0log_strategy_timeseries.py" ai-race
  goto finished
)

echo [ERROR] Python ga mitsukarimasen.
echo Python 3 wo install shite kara saijikko shite kudasai.
pause
exit /b 1

:finished
echo.
echo Logger ga shuryo shimashita.
echo CSV hozon saki: %~dp0
echo.
pause
endlocal
