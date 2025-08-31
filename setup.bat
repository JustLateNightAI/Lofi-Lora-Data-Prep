@echo on
setlocal
cd /d "%~dp0"
title Lofi Data Prep - Setup

echo === Lofi Data Prep: First-time Setup ===

REM ------------------------------------------------------------
REM 1) Python detection
REM ------------------------------------------------------------
where py >nul 2>&1
if %errorlevel%==0 ( set "PY=py -3" ) else (
  where python >nul 2>&1 || (echo [ERROR] Python 3 not found. Install it and rerun. & goto :end)
  set "PY=python"
)

REM ------------------------------------------------------------
REM 2) Sidecar folder (prefer sidecar\; fallback to repo root)
REM ------------------------------------------------------------
set "SIDECAR_DIR=sidecar"
if not exist "%SIDECAR_DIR%\server.py" (
  set "SIDECAR_DIR=."
  if not exist "server.py" (
    echo [ERROR] Could not find server.py in sidecar\ or repo root.
    goto :end
  )
)
echo Using sidecar folder: %SIDECAR_DIR%

REM ------------------------------------------------------------
REM 3) Create / activate venv and upgrade pip
REM ------------------------------------------------------------
pushd "%SIDECAR_DIR%"
%PY% -m venv .venv
if errorlevel 1 (
  echo [ERROR] Failed to create venv.
  popd
  goto :end
)

call .venv\Scripts\activate.bat
python -c "import sys; print('Python exe:', sys.executable)"
python -m pip install --upgrade pip

REM ------------------------------------------------------------
REM 4) Install base Python deps (exclude torch here)
REM    We'll install torch separately (CPU vs CUDA) next.
REM ------------------------------------------------------------
echo === Writing requirements.base.txt ===
>requirements.base.txt (
  echo flask
  echo pillow
  echo transformers
  echo bitsandbytes
  echo accelerate
  echo safetensors
)

echo === Installing base Python deps ===
pip install -r requirements.base.txt
if errorlevel 1 (
  echo [ERROR] Base pip install failed.
  popd
  goto :end
)

REM ------------------------------------------------------------
REM 5) Ask for PyTorch variant (CPU vs CUDA)
REM ------------------------------------------------------------
echo.
echo === PyTorch install ===
echo Choose PyTorch variant:
echo   1^) CPU only  ^(works on any machine; no GPU acceleration^)
echo   2^) GPU       ^(CUDA 12.1 build; requires NVIDIA GPU + up-to-date driver^)
set /p choice="Select 1 or 2 [default=1]: "
if "%choice%"=="2" (
  echo Installing PyTorch (CUDA 12.1)...
  pip install --index-url https://download.pytorch.org/whl/cu121 torch torchvision torchaudio
) else (
  echo Installing PyTorch (CPU)...
  pip install torch torchvision torchaudio
)
if errorlevel 1 (
  echo [ERROR] PyTorch install failed.
  echo If you chose GPU, ensure your NVIDIA driver is installed and try again.
  popd
  goto :end
)

echo === Verifying core imports ===
python - <<PY
import sys, importlib.util, torch
mods = ["flask","PIL","transformers","bitsandbytes","accelerate","safetensors"]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
print("Python exe:", sys.executable)
print("Missing base mods:", missing)
print("Torch version:", torch.__version__)
print("CUDA available:", torch.cuda.is_available(), "CUDA ver:", torch.version.cuda)
print("CUDA devices:", torch.cuda.device_count())
if torch.cuda.is_available():
    print("Device 0:", torch.cuda.get_device_name(0))
PY
if errorlevel 1 (
  echo [ERROR] Verification failed (see messages above).
  popd
  goto :end
)
popd

REM ------------------------------------------------------------
REM 6) Node / Electron deps (no edits to package.json)
REM ------------------------------------------------------------
if exist package.json (
  where node >nul 2>&1 || (echo [ERROR] Node.js not found. Install from https://nodejs.org & goto :node_end)
  where npm  >nul 2>&1  || (echo [ERROR] npm not found. Fix Node install. & goto :node_end)

  echo === Installing npm dependencies ===
  if exist package-lock.json (
    npm ci
    if errorlevel 1 (
      echo [WARN] npm ci failed, falling back to npm install
      npm install
    )
  ) else (
    npm install
  )
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    goto :node_end
  )

  echo === Verifying Electron availability ===
  npx electron -v
  if errorlevel 1 (
    echo [ERROR] Electron dev dependency not found. Install with: npm i -D electron
    goto :node_end
  )
  echo Node/Electron ready.
) else (
  echo (No package.json in repo root; skipping npm setup)
)
:node_end

:end
echo.
echo [SETUP FINISHED] Press any key to close this window...
pause >nul

