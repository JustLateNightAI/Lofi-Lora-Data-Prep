@echo on
setlocal
cd /d "%~dp0"
title Lofi Data Prep - Setup

echo === Lofi Data Prep: First-time Setup ===

:: 1) Detect Python
where py >nul 2>&1
if %errorlevel%==0 ( set "PY=py -3" ) else (
  where python >nul 2>&1 || (echo [ERROR] Python 3 not found. Install it and rerun. & goto HALT)
  set "PY=python"
)

:: 2) Pick sidecar dir (sidecar\ preferred)
set "SIDECAR_DIR=sidecar"
if not exist "%SIDECAR_DIR%\server.py" (
  set "SIDECAR_DIR=."
  if not exist "server.py" (
    echo [ERROR] Could not find server.py in sidecar\ or repo root.
    goto HALT
  )
)
echo Using sidecar folder: %SIDECAR_DIR%

:: 3) Create venv
pushd "%SIDECAR_DIR%"
%PY% -m venv .venv || (echo [ERROR] Failed to create venv. & popd & goto HALT)
call .venv\Scripts\activate.bat
python -c "import sys; print('Python exe:', sys.executable)"
python -m pip install --upgrade pip

:: 4) Install base deps (no torch yet)
echo flask> requirements.base.txt
echo pillow>> requirements.base.txt
echo transformers>> requirements.base.txt
echo bitsandbytes>> requirements.base.txt
echo accelerate>> requirements.base.txt
echo safetensors>> requirements.base.txt

echo === Installing base Python deps ===
pip install -r requirements.base.txt || (echo [ERROR] Base pip install failed. & popd & goto HALT)

:: 5) Torch variant prompt (CPU vs CUDA 12.1)
echo.
echo === PyTorch install ===
echo   1) CPU only  (works anywhere)
echo   2) GPU (CUDA 12.1 build; requires NVIDIA GPU + driver)
set /p choice="Select 1 or 2 [default=1]: "

if "%choice%"=="2" (
  echo Installing PyTorch (CUDA 12.1)...
  pip install --index-url https://download.pytorch.org/whl/cu121 torch torchvision torchaudio
  if errorlevel 1 (
    echo.
    echo [ERROR] CUDA build failed to install.
    echo - Make sure you have an NVIDIA GPU and up-to-date NVIDIA drivers.
    echo - You can re-run setup and choose CPU build (option 1) to proceed.
    popd & goto HALT
  )
) else (
  echo Installing PyTorch (CPU)...
  pip install torch torchvision torchaudio || (echo [ERROR] CPU Torch install failed. & popd & goto HALT)
)

:: 6) Quick verify (Windows-safe)
python -c "import flask, PIL, transformers; print('Base OK')"
if errorlevel 1 ( echo [ERROR] Base import check failed. & popd & goto HALT )

python -c "import torch; print('Torch', torch.__version__, 'CUDA?', torch.cuda.is_available(), 'CUDA ver', torch.version.cuda)"
if errorlevel 1 ( echo [ERROR] Torch import failed. & popd & goto HALT )

python -c "import torch; import sys; print('Devices:', torch.cuda.device_count()); \
print([torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]) if torch.cuda.is_available() else print('No CUDA devices')"
popd

:: 7) Node/Electron (no edits to package.json)
if exist package.json (
  where node >nul 2>&1 || (echo [ERROR] Node.js not found. Install from https://nodejs.org & goto HALT)
  where npm  >nul 2>&1  || (echo [ERROR] npm not found. Fix Node install. & goto HALT)

  echo === Installing npm dependencies ===
  if exist package-lock.json (
    npm ci || (echo [WARN] npm ci failed, falling back to npm install & npm install)
  ) else (
    npm install || (echo [ERROR] npm install failed. & goto HALT)
  )

  echo === Checking Electron ===
  npx electron -v || (echo [ERROR] Electron not available. Install with: npm i -D electron & goto HALT)
) else (
  echo (No package.json in repo root; skipping npm setup)
)

echo.
echo ✅ Setup complete. Use start.bat to launch.
goto END

:HALT
echo.
echo [SETUP FAILED] See messages above. The window will stay open.
pause >nul
goto END

:END
echo.
echo [SETUP FINISHED] Press any key to close...
pause >nul

