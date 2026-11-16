#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "第一次執行：建立虛擬環境並安裝套件..."
  python3 -m venv .venv && . .venv/bin/activate && pip install --upgrade pip && pip install -r requirements.txt
else
  . .venv/bin/activate
fi
python server.py
