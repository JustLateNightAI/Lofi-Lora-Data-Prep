@echo on
setlocal
cd /d "%~dp0"
title Lofi Data Prep - Setup

echo === Lofi Data Prep: First-time Setup ===

REM ---- Python detection ----
where py >nul 2>&1
if %errorlevel%==0 ( set "PY=py -3" ) else (
  where python >nul 2>&1 || (echo [ERROR] Python 3 not found. Install it and rerun. & goto :end)
  set "PY=python"
)

REM ---- Sidecar venv ----
set "SIDECAR_DIR=sidecar"
if not exist "%SIDECAR_DIR%\server.py" (
  set "SIDECAR_DIR=."
  if not exist "server.py" (
    echo [ERROR] Could not find server.py in sidecar\ or repo root.
    goto :end
  )
)

echo === Creating Python venv in %SIDECAR_DIR% ===
pushd "%SIDECAR_DIR%"
%PY% -m venv .venv
if errorlevel 1 (
  echo [ERROR] Failed to create venv.
  popd
  goto :end
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip

echo === Writing requirements.txt ===
>requirements.txt (
  echo flask
  echo pillow
  echo torch
  echo transformers
  echo bitsandbytes
  echo accelerate
  echo safetensors
)

echo === Installing Python deps ===
pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed.
  popd
  goto :end
)

echo === Verifying core imports ===
python -c "import flask, PIL, torch, transformers; print('Python deps OK')"
if errorlevel 1 (
  echo [ERROR] Some Python packages are missing.
  popd
  goto :end
)
popd

REM ---- Node/Electron setup ----
if exist package.json (
  where node >nul 2>&1 || (echo [ERROR] Node.js not found. Install from https://nodejs.org & goto :end)
  where npm  >nul 2>&1  || (echo [ERROR] npm not found. Fix Node install. & goto :end)

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

  echo === Checking Electron ===
  npx electron -v
  if errorlevel 1 (
    echo [ERROR] Electron not installed. Run: npm i -D electron
    goto :end
  )
  echo Node/Electron ready.
) else (
  echo (No package.json in repo root; skipping npm setup)
)

:end
echo.
echo [SETUP FINISHED] Press any key to close this window...
pause >nul

