  // ---------- 版面設定面板：數字設定、預設組、記憶、匯入／匯出 ----------
  const LAYOUT_IDS = ["perRow", "fontSize", "lyricSize", "sideMargin", "barPad", "rowGap", "jpGap", "lyLine", "showTies", "showSlurs", "showLyrics", "showStaff", "firstFree"];
  const LAYOUT_DEFAULT = { perRow: 4, fontSize: 17, lyricSize: 13, sideMargin: 14, barPad: 0, rowGap: 4, jpGap: 0, lyLine: 1.35, showTies: true, showSlurs: true, showLyrics: true, showStaff: true, firstFree: false };
  const LAYOUT_PRESETS = {
    "預設": {},
    "A4 緊湊（每行 5 小節）": { perRow: 5, fontSize: 15, lyricSize: 12, sideMargin: 10, rowGap: 2 },
    "大字教學（每行 3 小節）": { perRow: 3, fontSize: 24, lyricSize: 17, sideMargin: 16, rowGap: 8, jpGap: 4 },
    "只看簡譜": { perRow: 4, showStaff: false, firstFree: true, jpGap: 0 },
  };
  function readLayout() {
    const o = {};
    LAYOUT_IDS.forEach((id) => { const el = $(id); o[id] = el.type === "checkbox" ? el.checked : parseFloat(el.value); });
    return o;
  }
  function writeLayout(o) {
    LAYOUT_IDS.forEach((id) => {
      if (!(id in o)) return;
      const el = $(id);
      if (el.type === "checkbox") el.checked = !!o[id]; else if (Number.isFinite(+o[id])) el.value = o[id];
    });
  }
  function saveLayout() { store.set("jpLayout", JSON.stringify(readLayout())); }
  function applyLayout(o, doRender) {
    writeLayout({ ...LAYOUT_DEFAULT, ...o });
    saveLayout();
    if (doRender !== false) render();
  }
  (function initLayout() {
    try { const s = store.get("jpLayout"); if (s) writeLayout(JSON.parse(s)); } catch (e) {}
    const sel = $("layPreset");
    Object.keys(LAYOUT_PRESETS).forEach((n) => { const o = document.createElement("option"); o.textContent = n; sel.appendChild(o); });
    sel.addEventListener("change", () => { applyLayout(LAYOUT_PRESETS[sel.value] || {}); });
    $("layReset").addEventListener("click", () => { sel.value = "預設"; applyLayout({}); });
    $("layExport").addEventListener("click", () => downloadBlob("版面設定.json", JSON.stringify(readLayout(), null, 2), "application/json"));
    $("layImport").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      try { applyLayout(JSON.parse(await f.text())); $("layErr").textContent = ""; } catch (er) { $("layErr").textContent = "匯入失敗：不是有效的版面設定檔"; }
    });
    LAYOUT_IDS.forEach((id) => { $(id).addEventListener("input", saveLayout); $(id).addEventListener("change", saveLayout); });
  })();
