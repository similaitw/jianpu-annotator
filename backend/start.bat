@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo 第一次執行：建立虛擬環境並安裝套件（需要一些時間）...
  py -3 -m venv .venv || python -m venv .venv
  call .venv\Scripts\activate.bat
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate.bat
)
python server.py
pause
