@echo off
setlocal
cd /d "%~dp0"
node scripts\preflight.cjs || (pause & exit /b 1)
call npm run dev
if errorlevel 1 pause
