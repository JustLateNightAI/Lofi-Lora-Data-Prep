@echo off
setlocal
cd /d "%~dp0"
echo === Lofi Data Prep: First-time Setup ===

REM ---- Detect Python ----
where py >nul 2>&1
if %errorlevel%==0 ( set "PY=py -3" ) else (
  where python >nul 2>&1 || (echo [ERROR] Python not found. Install Python 3.x and rerun.& pause & exit /b 1)
  set "PY=python"
)

REM ---- Sidecar folder (prefer .\sidecar, else repo root) ----
set "SIDECAR_DIR=sidecar"
if not exist "%SIDECAR_DIR%\server.py" (
  set "SIDECAR_DIR=."
  if not exist "server.py" (
    echo [ERROR] Could not find server.py in sidecar\ or repo root.
    pause & exit /b 1
  )
)

REM ---- Create venv & install Python deps ----
pushd "%SIDECAR_DIR%"
%PY% -m venv .venv || (echo [ERROR] Failed to create venv.& popd & pause & exit /b 1)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip

if not exist requirements.txt (
  echo Creating minimal requirements.txt ...
  >requirements.txt echo flask
  >>requirements.txt echo pillow
  >>requirements.txt echo torch
  >>requirements.txt echo transformers
  >>requirements.txt echo bitsandbytes
  >>requirements.txt echo accelerate
  >>requirements.txt echo safetensors
)

echo Installing Python dependencies...
pip install -r requirements.txt || (
  echo.
  echo [NOTE] If PyTorch failed, install it from https://pytorch.org (matching your CUDA), then re-run setup.bat
  popd & pause & exit /b 1
)
popd

REM ---- Detect Node/NPM and install Electron deps (if package.json exists) ----
if exist package.json (
  where node >nul 2>&1 || (echo [ERROR] Node.js not found. Install from https://nodejs.org and rerun.& pause & exit /b 1)
  where npm  >nul 2>&1 || (echo [ERROR] NPM not found. Ensure Node.js installed correctly.& pause & exit /b 1)

  echo Installing npm dependencies...
  npm install || (echo [ERROR] npm install failed.& pause & exit /b 1)
) else (
  echo (No package.json in repo root; skipping npm install)
)

echo.
echo ✅ Setup complete. Use run.bat to launch the tool.
pause

