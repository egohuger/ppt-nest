@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ============================================
echo   PPT Nest - 环境安装
echo ============================================
echo.

REM --- 1. Check Node.js ---
echo [1/3] 检查 Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 未检测到 Node.js!
    echo.
    echo 请从 https://nodejs.org 下载安装 Node.js (LTS 版本)
    echo 安装完成后重新运行本脚本。
    echo.
    pause
    exit /b 1
)
node --version
echo Node.js 已就绪
echo.

REM --- 2. Install npm dependencies ---
echo [2/3] 安装 npm 依赖...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [错误] npm install 失败
    echo 请检查网络连接后重试
    pause
    exit /b 1
)
echo npm 依赖安装完成
echo.

REM --- 3. Check Python and install deps ---
echo [3/3] 安装 Python 依赖...

REM Find Python
set "PYTHON_EXE="
if exist "venv\Scripts\python.exe" set "PYTHON_EXE=venv\Scripts\python.exe"
if "%PYTHON_EXE%"=="" if exist "%LocalAppData%\hermes\hermes-agent\venv\Scripts\python.exe" set "PYTHON_EXE=%LocalAppData%\hermes\hermes-agent\venv\Scripts\python.exe"
if "%PYTHON_EXE%"=="" (
    where python >nul 2>&1 && set "PYTHON_EXE=python"
)

if "%PYTHON_EXE%"=="" (
    echo.
    echo [错误] 未检测到 Python
    echo 请确保已安装 Python 3.10+
    pause
    exit /b 1
)

echo Python: %PYTHON_EXE%
"%PYTHON_EXE%" -m pip install -r backend\requirements.txt -q
if %errorlevel% neq 0 (
    echo [错误] Python 依赖安装失败
    pause
    exit /b 1
)
echo Python 依赖安装完成

echo.
echo ============================================
echo   环境安装完成！现在可以双击运行
echo   "启动素材库.bat"
echo ============================================
pause
