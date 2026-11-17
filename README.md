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
> **目前網頁上已隱藏**（`src/app.js` 的 `OMR_ENABLED = false`），先只開放 MusicXML 轉換。要啟用：改成 `true`，執行 `python3 build.py`，並照下面步驟啟動後端。
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

## 遠端使用（把辨識服務放到網路上）
Vercel 只能放靜態網頁，跑不了 homr，所以要另外一台會跑 Docker 的主機（VPS，建議 4 GB 以上記憶體）。
1. 準備一個網域，A 記錄指到主機 IP；主機裝好 Docker，開放 80、443 埠
2. 把 `backend/` 放到主機，`cp .env.example .env`，填 `DOMAIN`、`API_KEY`（自訂長密碼，可用 `openssl rand -hex 24`）、`ORIGINS`（你的網站網址）
3. `docker compose -f docker-compose.remote.yml up -d --build`（Caddy 會自動申請 HTTPS 憑證）
4. 在網頁「圖檔辨識設定」填服務位址 `https://你的網域` 和 API 金鑰，狀態顯示「已連線 ✓」就能用

安全與隱私：
- 一定要設 `API_KEY`；沒設卻對外開放時，服務啟動會印警告。金鑰錯誤回 401，`ORIGINS` 限制只有你的網站能跨網域呼叫
- 同時辨識數量預設 1，其他人排隊，排隊超過 4 人回「人太多」
- 遠端模式下圖檔會送到那台主機，辨識完即刪除，不留存
- 網址與金鑰只存在使用者自己的瀏覽器（localStorage）
- 替代方案：Cloud Run、Fly.io、Railway 等能跑 Docker 的平台，同一個映像檔可直接用，環境變數一樣是 `JIANPU_OMR_API_KEY`、`JIANPU_OMR_ORIGINS`

## 免費遠端：Google Cloud Run
Cloud Run 有「永遠免費」額度，沒人用時縮到 0 台、不計費。整頁樂譜辨識一次約用 2 vCPU × 1 分鐘、4 GiB 記憶體，粗估每月免費額度夠辨識上千次。
1. 建立 Google Cloud 專案、啟用帳單（**需要信用卡**；超過免費額度才會收費）
2. **先設預算警示**：Billing → Budgets & alerts，例如 NT$30 就通知；部署腳本已限制最多 2 個實例，避免暴衝
3. 裝 gcloud，`gcloud auth login`，`gcloud config set project 專案ID`
4. 在 `backend/` 執行 `./deploy-cloudrun.sh https://你的網站網址`（Windows 用 WSL 或 Cloud Shell）
5. 腳本最後印出服務位址與 API 金鑰，填到網頁「圖檔辨識設定」

注意：第一次呼叫（冷啟動）要多等 10–30 秒；免費額度與計價以 [Cloud Run 官方頁面](https://cloud.google.com/run/pricing) 為準。

## 免費遠端（不綁信用卡）：家裡電腦 + Cloudflare Tunnel
電腦繼續跑 Docker，再用 Cloudflare Tunnel 把它接到網路上，不用開路由器埠、不用固定 IP。缺點是**電腦要開機、Docker 要在跑**。
Cloudflare 對單一請求有約 100 秒的回應上限，整頁辨識可能超過，所以這個模式自動改成「送出工作 → 網頁每 2 秒查一次結果」，辨識多久都不會斷線。

```
cd backend
cp .env.tunnel.example .env        # 改 API_KEY（自訂長密碼）
```
**模式 A：臨時網址（免帳號，最簡單）**
```
docker compose -f docker-compose.tunnel.yml --profile quick up -d --build
docker compose -f docker-compose.tunnel.yml logs cloudflared-quick     # 找 https://xxxx.trycloudflare.com
```
把那個網址和 API 金鑰填進網頁「圖檔辨識設定」。**每次重啟網址都會變**，適合試用。

**模式 B：固定網址**（需要 Cloudflare 帳號，以及一個託管在 Cloudflare 的網域）
1. Cloudflare Zero Trust → Networks → Tunnels → 建立隧道，取得 token
2. 該隧道的 Public hostname：服務填 `http://omr:8765`
3. token 填進 `.env` 的 `TUNNEL_TOKEN`，`ORIGINS` 改成你的網站網址
4. `docker compose -f docker-compose.tunnel.yml --profile named up -d --build`

安全：一定要設 `API_KEY`（沒金鑰任何人拿到網址都能用你的電腦辨識）；圖檔會經過 Cloudflare 再到你家電腦，辨識完即刪除。

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


## 匯入 MIDI／線上編寫（v2.1）

- 選擇或拖入 `.mid`／`.midi`：選音軌、量化格（十六分／八分）、取最高／最低音、調號（可自動判斷）、拍號、速度後轉成單聲部 MusicXML，並直接載入譜面。
- 「線上編寫」：以簡譜文字輸入（`1 2 3' 5, #4 0 - _ . ~ |`），約半秒自動更新五線譜＋簡譜。
- 「下載 MusicXML」匯出不含標註的標準檔；原本的「下載標註 MusicXML」仍會加入簡譜歌詞列。
- 程式碼在 `src/compose.js`，由 `build.py` 併入 `app.js`。
