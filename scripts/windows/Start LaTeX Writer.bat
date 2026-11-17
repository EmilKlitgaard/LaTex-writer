@echo off
rem Starts LaTeX Writer on Windows: installs dependencies and builds the interface when needed,
rem then runs the server and opens the editor in your browser. Keep this window open while you work.
rem (The Windows counterpart of scripts/launch.sh. Based on Lukas4314's Windows port.)
setlocal
title LaTeX Writer

rem In the Windows download this file sits next to package.json; in the repository it is in scripts\windows.
if exist "%~dp0package.json" (cd /d "%~dp0") else (cd /d "%~dp0..\..")

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 or newer from https://nodejs.org and start this again.
  goto :failed
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo LaTeX Writer needs Node.js 24 or newer. Update it from https://nodejs.org
  goto :failed
)
where latexmk >nul 2>nul
if errorlevel 1 echo Note: latexmk was not found on the PATH. Install MiKTeX from https://miktex.org or TeX Live to compile documents.

rem Dependencies: on the first start, and again whenever they change. A lock file that differs only
rem in LaTeX Writer's own version (every update) needs no install.
fc /b package-lock.json node_modules\.lw-package-lock.json >nul 2>nul
if errorlevel 1 if exist node_modules\.lw-package-lock.json (
  node scripts\same-deps.mjs package-lock.json node_modules\.lw-package-lock.json
  if not errorlevel 1 copy /y package-lock.json node_modules\.lw-package-lock.json >nul
)
fc /b package-lock.json node_modules\.lw-package-lock.json >nul 2>nul
if errorlevel 1 (
  echo Installing what LaTeX Writer needs. The first start takes a minute or two...
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto :failed
  copy /y package-lock.json node_modules\.lw-package-lock.json >nul
)

rem The interface: built once per version of the download, and on every start of a repository copy.
set "BUILD=%LOCALAPPDATA%\LaTeXWriter\build\web"
if defined LATEXWRITER_HOME set "BUILD=%LATEXWRITER_HOME%\build\web"
fc /b .version "%BUILD%\.built" >nul 2>nul
if errorlevel 1 (
  echo Preparing the editor...
  call npx vite build
  if errorlevel 1 goto :failed
  if exist .version copy /y .version "%BUILD%\.built" >nul
)

node server\index.ts %*
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo LaTeX Writer stopped with an error.
pause
exit /b 1
