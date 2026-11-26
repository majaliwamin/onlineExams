@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -m venv .venv
)
call ".venv\Scripts\activate.bat"
python -m pip install -r backend\requirements.txt
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8088'"
echo Demo server running at http://127.0.0.1:8088 (press Ctrl+C to stop)
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8088
pause
