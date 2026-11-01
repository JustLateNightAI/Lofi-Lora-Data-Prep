@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || (echo Install Node.js 24 LTS from https://nodejs.org first. & pause & exit /b 1)
node scripts\preflight.cjs || (pause & exit /b 1)
call npm ci || (pause & exit /b 1)
call npm run install:electron || (pause & exit /b 1)
echo Setup complete. Run start.bat
pause
