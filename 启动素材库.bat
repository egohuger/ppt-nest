@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   PPT Nest v2.1
echo ============================================
echo.

REM --- Check Node.js ---
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js or run "Install.bat" first.
    pause
    exit /b 1
)

REM --- Check node_modules ---
if not exist "node_modules\" (
    echo [INFO] First run, installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Dependency install failed. Run "Install.bat".
        pause
        exit /b 1
    )
)

REM --- Find Python ---
set "PYTHON_EXE="

REM 1. Project venv
if exist "venv\Scripts\python.exe" (
    set "PYTHON_EXE=venv\Scripts\python.exe"
    goto :found_python
)

REM 2. Hermes built-in Python
if exist "%LocalAppData%\hermes\hermes-agent\venv\Scripts\python.exe" (
    set "PYTHON_EXE=%LocalAppData%\hermes\hermes-agent\venv\Scripts\python.exe"
    goto :found_python
)

REM 3. System PATH python
where python >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_EXE=python"
    goto :found_python
)

echo [ERROR] Python not found.
echo Please install Python or run "Install.bat" first.
pause
exit /b 1

:found_python
echo Python: !PYTHON_EXE!

REM --- Check Python dependencies ---
"!PYTHON_EXE!" -c "import fastapi" >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Installing Python dependencies...
    "!PYTHON_EXE!" -m pip install -r backend\requirements.txt -q
    if %errorlevel% neq 0 (
        echo [ERROR] Python dependency install failed.
        pause
        exit /b 1
    )
)

REM --- Launch Electron ---
echo.
echo Starting PPT Nest...
echo Keep this window open (closing it stops the app).
echo ============================================
echo.

npx electron .

if %errorlevel% neq 0 (
    echo.
    echo ============================================
    echo   Launch FAILED (error code: %errorlevel%)
    echo ============================================
    echo.
    echo Possible causes:
    echo   1. Corrupted node_modules -- delete node_modules and retry
    echo   2. Electron not installed properly -- run "Install.bat"
    echo.
    pause
    exit /b %errorlevel%
)

pause
