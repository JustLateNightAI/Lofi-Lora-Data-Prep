@echo on
setlocal EnableExtensions

rem ---------------------------------------------------------------------------
rem Relaunch inside a persistent console so the window NEVER auto-closes
rem ---------------------------------------------------------------------------
if /i not "%~1"=="_wrapped" (
  start "" cmd /k "%~f0" _wrapped
  goto :EOF
)

cd /d "%~dp0"
title Lofi Data Prep - Setup

echo === Lofi Data Prep: First-time Setup ===

rem ---------------------------------------------------------------------------
rem 1) Detect Python
rem ---------------------------------------------------------------------------
where py >nul 2>&1
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  where python >nul 2>&1 || (echo [ERROR] Python 3 not found. Install it and rerun. & goto HALT)
  set "PY=python"
)

rem ---------------------------------------------------------------------------
rem 2) Pick sidecar dir (sidecar\ preferred)
rem ---------------------------------------------------------------------------
set "SIDECAR_DIR=sidecar"
if not exist "%SIDECAR_DIR%\server.py" (
  set "SIDECAR_DIR=."
  if not exist "server.py" (
    echo [ERROR] Could not find server.py in sidecar\ or repo root.
    goto HALT
  )
)
echo Using sidecar folder: %SIDECAR_DIR%

rem ---------------------------------------------------------------------------
rem 3) Create & activate venv
rem ---------------------------------------------------------------------------
pushd "%SIDECAR_DIR%"
%PY% -m venv .venv || (echo [ERROR] Failed to create venv. & popd & goto HALT)
call .venv\Scripts\activate.bat
python -c "import sys; print('Python exe:', sys.executable)"
python -m pip install --upgrade pip

rem ---------------------------------------------------------------------------
rem 4) Install base deps (no torch yet)
rem ---------------------------------------------------------------------------
> requirements.base.txt (
  echo flask
  echo pillow
  echo transformers
  echo accelerate
  echo safetensors
)
echo === Installing base Python deps ===
pip install -r requirements.base.txt || (echo [ERROR] Base pip install failed. & popd & goto HALT)

rem ---------------------------------------------------------------------------
rem 5) Detect NVIDIA GPU and choose Torch build (with safe fallback)
rem ---------------------------------------------------------------------------
echo.
echo === PyTorch install ===
where nvidia-smi >nul 2>&1
if %errorlevel%==0 (
  set "HAS_NVIDIA=1"
  for /f "tokens=6" %%v in ('nvidia-smi ^| findstr /r /c:"Driver Version"') do set "NVIDIA_DRIVER=%%v"
  if not defined NVIDIA_DRIVER set "NVIDIA_DRIVER=unknown"
  echo Detected NVIDIA GPU. Driver: %NVIDIA_DRIVER%
) else (
  set "HAS_NVIDIA=0"
  echo No NVIDIA GPU / nvidia-smi not found.
)

if "%HAS_NVIDIA%"=="1" (
  rem Escape parentheses inside blocks!
  echo   1^) CPU only  ^(safest^)
  echo   2^) GPU ^(CUDA 12.1 build; requires compatible NVIDIA driver^)
  set /p choice="Select 1 or 2 [default=1]: "
) else (
  set "choice=1"
)
if not defined choice set "choice=1"

if "%choice%"=="2" (
  echo Installing PyTorch ^(CUDA 12.1^)...
  python -m pip install --index-url https://download.pytorch.org/whl/cu121 torch torchvision torchaudio
  if errorlevel 1 (
    echo.
    echo [WARN] CUDA build failed to install. Falling back to CPU build...
    python -m pip install torch torchvision torchaudio
    if errorlevel 1 (
      echo [ERROR] CPU Torch install failed as well.
      popd & goto HALT
    )
    set "TORCH_CUDA=0"
  ) else (
    set "TORCH_CUDA=1"
  )
) else (
  echo Installing PyTorch ^(CPU^)...
  python -m pip install torch torchvision torchaudio
  if errorlevel 1 (
    echo [ERROR] CPU Torch install failed.
    popd & goto HALT
  )
  set "TORCH_CUDA=0"
)

rem ---------------------------------------------------------------------------
rem 6) Verify Torch; optional bitsandbytes only if CUDA Torch succeeded
rem ---------------------------------------------------------------------------
echo === Verifying Torch ===
python -c "import torch,sys; print('Torch', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('CUDA version:', getattr(torch.version,'cuda',None)); print('Device count:', torch.cuda.device_count()); print('Devices:', [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())] if torch.cuda.is_available() else 'None')"
if errorlevel 1 ( echo [ERROR] Torch import check failed. & popd & goto HALT )

if "%TORCH_CUDA%"=="1" (
  echo === Installing bitsandbytes ^(optional^) ===
  python -m pip install bitsandbytes-cuda121 || python -m pip install bitsandbytes || echo [WARN] bitsandbytes install failed ^(continuing without it^).
  python -c "import importlib; mod=importlib.import_module('bitsandbytes'); print('bitsandbytes OK:', getattr(mod,'__version__','unknown'))" 1>nul 2>nul || echo [WARN] bitsandbytes not available ^(continuing^).
)

popd

rem ---------------------------------------------------------------------------
rem 7) Node/Electron (auto-installs Electron if missing)
rem ---------------------------------------------------------------------------
if exist package.json (
  where node >nul 2>&1 || (echo [ERROR] Node.js not found. Install from https://nodejs.org & goto HALT)
  where npm  >nul 2>&1  || (echo [ERROR] npm not found. Fix Node install. & goto HALT)

  echo === Installing npm dependencies ===
  if exist package-lock.json (
    call npm ci || (echo [WARN] npm ci failed, falling back to npm install & call npm install) || (echo [ERROR] npm install failed. & goto HALT)
  ) else (
    call npm install || (echo [ERROR] npm install failed. & goto HALT)
  )

  echo === Ensuring Electron is installed ===
  if exist "node_modules\.bin\electron.cmd" (
    call node_modules\.bin\electron.cmd -v || (echo [WARN] Local electron exists but didn't run.)
  ) else (
    npx -y electron -v >nul 2>&1
    if errorlevel 1 (
      echo Installing Electron ^(as devDependency^)...
      call npm install -D electron || (echo [ERROR] Electron install failed. & goto HALT)
    )
  )

  echo Electron version:
  if exist "node_modules\.bin\electron.cmd" (
    call node_modules\.bin\electron.cmd -v
  ) else (
    npx -y electron -v || (echo [ERROR] Electron still not available after install. & goto HALT)
  )
) else (
  echo ^(No package.json in repo root; skipping npm setup^)
)

echo.
echo ✅ Setup complete. Use start.bat to launch.
goto END

:HALT
echo.
echo [SETUP FAILED] See messages above.
echo ^(This window will stay open so you can read the errors.^)
pause >nul
goto END

:END
echo.
echo [SETUP FINISHED] Press any key to close...
pause >nul

