@echo off
REM opencode-lsp-bridge 安装脚本 (Windows)
REM 用法: 以管理员身份运行，或在 PowerShell 中执行: .\install.ps1

setlocal

echo =====================================
echo  opencode-lsp-bridge 安装
echo =====================================
echo.

set "PLUGIN_DIR=%~dp0"

REM Step 1: 检查 Node.js
echo [1/4] 检查 Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [错误] Node.js 未安装。请先安装 https://nodejs.org
    exit /b 1
)
echo   Node.js 已安装

REM Step 2: 安装 AS LSP 依赖
echo [2/4] 安装 AngelScript LSP 依赖...
cd /d "%PLUGIN_DIR%as-lsp"
call npm install --no-audit --no-fund 2>&1 | findstr /C:"added"
echo   AS LSP 依赖安装完成

REM Step 3: 检查 Go (可选，bridge 已预编译)
echo [3/4] 检查 bridge 二进制...
cd /d "%PLUGIN_DIR%bridge"
if exist opencode-lsp-bridge.exe (
    echo   Windows 预编译二进制已就绪
) else (
    where go >nul 2>&1
    if %errorlevel% neq 0 (
        echo   [警告] Go 未安装且无预编译二进制。请从 Release 页下载对应平台版本
    ) else (
        echo   正在编译 Go bridge...
        go build -o opencode-lsp-bridge.exe .
        echo   编译完成
    )
)

REM Step 4: 提示配置 opencode.json
echo [4/4] 配置 opencode.json
echo.
echo   请在 opencode.json 中添加以下配置:
echo.
echo   "lsp": {
echo     "angelscript": {
echo       "command": ["node", "%PLUGIN_DIR:\=\\%as-lsp\\dist\\server.js", "--stdio"],
echo       "extensions": [".as"]
echo     }
echo   },
echo   "mcp": {
echo     "lsp-bridge": {
echo       "type": "local",
echo       "command": ["%PLUGIN_DIR:\=\\%bridge\\opencode-lsp-bridge.exe"]
echo     }
echo   }
echo.
echo   然后重启 OpenCode。
echo =====================================
echo   安装完成!
echo =====================================
