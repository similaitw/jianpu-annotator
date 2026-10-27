# 簡譜標註器

上傳 MusicXML 五線譜，自動標註簡譜、唱名或音名，可以播放，也可以匯出 MIDI 與 MusicXML。

## 功能
- 讀取 `.musicxml`、`.xml`、`.mxl`（可拖曳檔案到譜面）
- 標註：簡譜 1 2 3／唱名 Do Re Mi／音名 C D E
- 首調（1＝主音，譜頭標 1=G）或原調（1＝C，加 ♯ ♭）
- 小調可選 6 為主音或 1 為主音；中途轉調會重新標示
- 高低八度點、延音線以「–」表示
- 瀏覽器內播放（Tone.js），游標跟著音符走，可調速度
- 下載 MIDI（.mid）與加上標註的 MusicXML

## 技術
純靜態網頁，單一 `index.html`，不需要建置步驟。
函式庫由 CDN 載入：OpenSheetMusicDisplay 2.1.3、Tone.js 15.1.22、JSZip 3.10.1。

## 部署到 Vercel
1. 在 Vercel 選 **Add New → Project**，匯入這個 GitHub repo
2. Framework Preset 選 **Other**，Build Command 和 Output Directory 留空
3. 按 Deploy

## 下一階段
- 圖檔（PNG／JPG／PDF）辨識：後端以 FastAPI 包 Audiveris
- 辨識結果校正編輯器
