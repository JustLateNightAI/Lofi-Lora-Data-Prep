@echo off
setlocal
cd /d "%~dp0"

REM ---- Config ----
set "HOST=127.0.0.1"
set "PORT=5057"
REM Uncomment to pick a specific GPU (0-based): set CUDA_VISIBLE_DEVICES=0

REM ---- Locate sidecar ----
set "SIDECAR_DIR=sidecar"
if not exist "%SIDECAR_DIR%\server.py" set "SIDECAR_DIR=."
if not exist "%SIDECAR_DIR%\server.py" (
  echo [ERROR] Could not find server.py in sidecar\ or repo root.
  pause & exit /b 1
)

REM ---- Start sidecar in its own window ----
if not exist "%SIDECAR_DIR%\.venv\Scripts\activate.bat" (
  echo [ERROR] Virtual environment not found. Run setup.bat first.
  pause & exit /b 1
)

echo Starting sidecar on %HOST%:%PORT% ...
start "LDP Sidecar" cmd /k "cd /d %SIDECAR_DIR% && call .venv\Scripts\activate.bat && set CUDA_VISIBLE_DEVICES=%CUDA_VISIBLE_DEVICES% && python server.py --host %HOST% --port %PORT%"

REM ---- Start Electron app (if package.json exists) ----
if exist package.json (
  echo Starting Electron app...
  start "Lofi Data Prep" cmd /k "npm run dev"
) else (
  echo (No package.json in repo root; Electron app not started)
)

echo Done. Two windows should open: Sidecar and App.

