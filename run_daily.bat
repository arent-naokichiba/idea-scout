@echo off
REM Idea Scout Daily Run - Task Scheduler Wrapper
REM Runs run_daily.sh via Git Bash

set SCRIPT_DIR=%~dp0
set BASH_EXE=C:\Program Files\Git\usr\bin\bash.exe

echo [%date% %time%] Idea Scout starting...
"%BASH_EXE%" --login -c "cd '%SCRIPT_DIR:\=/%' && bash run_daily.sh"
echo [%date% %time%] Idea Scout finished (exit code: %ERRORLEVEL%)
