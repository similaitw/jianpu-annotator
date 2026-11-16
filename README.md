# 簡譜標註器

上傳 MusicXML 五線譜，產生「五線譜＋簡譜（或唱名、音名）」對照樂譜：標註在每小節正下方、小節線對齊，可列印 A4。

> v2 開發中（分支 `v2`）。舊版（OpenSheetMusicDisplay 版，含播放與 MIDI 匯出）保留為 `v1.html`，v2 功能補齊後會取代它。

## 目前功能（v2 第一階段）
- 讀取 `.musicxml`、`.xml`、`.mxl`（可拖曳檔案到視窗）
- 標註：簡譜 1 2 3／唱名 Do Re Mi／音名 C D E
- 首調（1＝主音）或絕對音／原調（C＝1，加 ♯ ♭）；小調可選 6 或 1 為主音；中途轉調會重新標示
- 高低八度點、休止 0、延長線、附點；底線依拍連線（八分兩個一組、十六分四個一組雙線）
- 標註行自動避開五線譜最低處；可調字級、每行小節數、標題、作曲、副標題
- 歌詞：讀取 MusicXML 內的歌詞，或貼上文字（一行一段；中文一字一音、英文用空格或 - 分音節、_ 表示無字），對齊在標註行下方，可調字級
- 連結線與圓滑線：五線譜和標註行都畫弧線（可各自開關），跨小節、跨行會畫到行尾／行首
- 播放（瀏覽器內建合成音色，不需連網；游標跟著音符走）、速度 50%–150%
- 下載 MIDI；下載標註後的 MusicXML（簡譜／唱名／音名寫成歌詞行）
- 列印／存成 PDF（A4）
- 單檔、內嵌 VexFlow，不需連網

## 圖檔辨識（本機後端）
網頁本身不上傳任何東西；要辨識圖檔時，網頁把圖傳到**你自己電腦上**的小服務，由它用 [homr](https://github.com/liebharc/homr)（開源 OMR）辨識成 MusicXML。

**方法 A：Docker（建議，不用裝 Python）**
1. 安裝 Docker Desktop 並啟動
2. Windows：連按兩下 `backend/docker-start.bat`；Mac／Linux：`./backend/docker-start.sh`
   （或在 `backend/` 資料夾執行 `docker compose up -d --build`）
   第一次建置約幾分鐘，辨識模型在建置時就下載好，之後離線也能用；服務會在背景常駐，電腦重開後 Docker 啟動時自動跟著起來
3. 停止：`docker compose down`

**方法 B：直接用 Python**
1. 安裝 Python 3.10 以上
2. Windows：連按兩下 `backend/start.bat`；Mac／Linux：`./backend/start.sh`
   第一次會建立虛擬環境、安裝套件，第一次辨識時再下載模型（需要連網）

**啟動後**
3. 看到「圖檔辨識服務啟動：http://127.0.0.1:8765」後，回網頁按「從圖檔辨識」，或直接把圖檔拖進視窗
4. 結果左上會顯示原圖方便對照。辨識**可能有誤**（音高、節奏、升降記號），請核對後再用

說明：服務只開放給本機（Docker 版只對 127.0.0.1 開埠）；圖太小會先放大 3 倍；PDF 可指定頁碼；整頁樂譜約 1–3 分鐘。在 Vercel 上的網頁一樣可以連本機服務（Chrome／Edge 允許 https 頁面呼叫 localhost）。

## 開發
```
python3 build.py     # src/ + vendor/ → index.html
```
- `src/app.js` 程式、`src/template.html` 版面、`src/sample.musicxml` 範例（小星星，公有領域）
- `vendor/vexflow-bravura.js` VexFlow 4.2.5（含字型）
- `index.html` 是建置結果，已提交，Vercel 直接當靜態網站部署

## 範例曲
只放公有領域或自己授權的曲子。

## 路線圖
1. ✅ 合併基礎：統一讀檔、對照譜排版、唱名／音名、小調 6／1
2. ✅ 歌詞（讀檔內歌詞或貼上，多段、英文音節 `-`、`_` 跳過）　✅ 連結線（tie）與圓滑線（slur）弧線，五線譜與簡譜都畫，跨小節、跨行也處理
3. ✅ 播放（亮色游標跟著音符走、可調速度）、下載 MIDI、下載標註後 MusicXML　⬜ 直接下載 PDF（目前用瀏覽器列印另存）
4. 進階排版：多聲部、標註與五線譜分開調字級、頁首頁尾
5. ✅ 圖檔辨識（PNG／JPG／PDF → MusicXML）：本機後端 `backend/`（FastAPI＋homr），網頁連 `127.0.0.1`　⬜ 辨識結果校正編輯器
