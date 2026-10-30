@echo off
title Snowy Music server
cd /d "%~dp0"
echo.
echo  Closing any OLD Cloudy/Snowy server that is still running...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":8765 .*LISTENING"') do taskkill /F /PID %%a >nul 2>nul
echo.
echo  Snowy Music is starting. Open this address in Microsoft Edge:
echo      http://localhost:8765
echo  (Press Ctrl+F5 on the page the first time.)
echo  Leave this window open while you use it. Close it to stop.
echo.
where py >nul 2>nul && (py serve.py) || (python serve.py)
echo.
echo  Python was not found or the server stopped. See README step 3.
pause
