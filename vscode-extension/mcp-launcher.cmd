@echo off
setlocal
set "GRAPHFLOW_MCP_STDIO=1"
set "GRAPHFLOW_LOG_JSON=1"
set "EXTENSION_DIR=%~dp0"
set "LAUNCHER_JS=%EXTENSION_DIR%mcp-launcher.cjs"

if not exist "%LAUNCHER_JS%" (
  echo [GraphFlow MCP launcher] launcher not found: %LAUNCHER_JS% 1>&2
  exit /b 1
)

where node >nul 2>&1
if %ERRORLEVEL%==0 (
  node "%LAUNCHER_JS%"
  exit /b %ERRORLEVEL%
)

if defined CURSOR_PATH (
  set "ELECTRON_RUN_AS_NODE=1"
  "%CURSOR_PATH%" "%LAUNCHER_JS%"
  exit /b %ERRORLEVEL%
)

if exist "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" "%LAUNCHER_JS%"
  exit /b %ERRORLEVEL%
)

echo [GraphFlow MCP launcher] node.exe not found in PATH. Install Node.js 20+ or set CURSOR_PATH. 1>&2
exit /b 1
