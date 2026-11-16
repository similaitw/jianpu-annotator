@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 啟動圖檔辨識服務（Docker）。第一次需要建置映像檔，約幾分鐘...
docker compose up -d --build
echo.
echo 完成後網頁就能使用「從圖檔辨識」。停止服務請執行：docker compose down
pause
