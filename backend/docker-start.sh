#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose up -d --build && echo "已啟動：http://127.0.0.1:8765（停止：docker compose down）"
