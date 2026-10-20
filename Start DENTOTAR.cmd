@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 oder neuer installieren, dann diese Datei erneut starten.
  pause
  exit /b 1
)
start "DENTOTAR Browser" cmd /k node scripts\serve.mjs
start "" http://127.0.0.1:5173
