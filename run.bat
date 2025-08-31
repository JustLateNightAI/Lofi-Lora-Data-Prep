@echo on
setlocal
cd /d "%~dp0"
title Lofi Data Prep - Start

echo === Checking sidecar venv ===
if not exist sidecar\.venv\Scripts\activate.bat (
  echo [ERROR] sidecar\.venv not found. Run setup.bat first.
  goto :end
)

echo === Activating venv ===
call sidecar\.venv\Scripts\activate.bat
echo Using Python: %PYTHONHOME% %PYTHONPATH%
python -c "import sys; print('Python exe:', sys.executable)"

echo === Checking npm ===
where npm || (echo [ERROR] npm not found. Install Node.js from https://nodejs.org & goto :end)

echo === Launching Electron (npm run dev) ===
REM run in this SAME window; if it crashes, you’ll see the error and code
call npm run dev
echo.
echo (npm exited with code %errorlevel%)

:end
echo.
echo [DONE] Press any key to close this window...
pause >nul

