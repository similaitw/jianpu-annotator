(function () {
  const VF = Vex.Flow;
  const $ = (id) => document.getElementById(id);
  const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
  const STEP_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  const STEP_SEMI = [0, 2, 4, 5, 7, 9, 11];
  const MAJOR_BY_FIFTHS = { "-7": "Cb", "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb", "-2": "Bb", "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#" };
  const MINOR_BY_FIFTHS = { "-7": "Ab", "-6": "Eb", "-5": "Bb", "-4": "F", "-3": "C", "-2": "G", "-1": "D", 0: "A", 1: "E", 2: "B", 3: "F#", 4: "C#", 5: "G#", 6: "D#", 7: "A#" };
  const TONIC_MAJOR_STEP = { "-7": ["C", -1], "-6": ["G", -1], "-5": ["D", -1], "-4": ["A", -1], "-3": ["E", -1], "-2": ["B", -1], "-1": ["F", 0], 0: ["C", 0], 1: ["G", 0], 2: ["D", 0], 3: ["A", 0], 4: ["E", 0], 5: ["B", 0], 6: ["F", 1], 7: ["C", 1] };
  const DURS = [[6, "wd"], [4, "w"], [3, "hd"], [2, "h"], [1.5, "qd"], [1, "q"], [0.75, "8d"], [0.5, "8"], [0.375, "16d"], [0.25, "16"], [0.125, "32"]];

  function keyName(f, minor) {
    const t = (minor ? MINOR_BY_FIFTHS : MAJOR_BY_FIFTHS)[f];
    const zh = t.replace("#", "♯").replace(/b$/, "♭");
    return zh + (minor ? " 小調" : " 大調");
  }

  // ---------- MusicXML parsing ----------
  async function readFileText(file) {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x50 && u8[1] === 0x4b) return unzipMxl(u8);
    return new TextDecoder("utf-8").decode(u8);
  }

  async function inflateRaw(data) {
    const ds = new DecompressionStream("deflate-raw");
    const w = ds.writable.getWriter();
    w.write(data);
    w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  async function unzipMxl(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const files = [];
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("無法解析 .mxl 壓縮檔");
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let k = 0; k < n; k++) {
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      files.push({ name, method, csize, off });
      p += 46 + nlen + elen + clen;
    }
    async function get(f) {
      const nlen = dv.getUint16(f.off + 26, true), elen = dv.getUint16(f.off + 28, true);
      const raw = u8.subarray(f.off + 30 + nlen + elen, f.off + 30 + nlen + elen + f.csize);
      return f.method === 0 ? raw : await inflateRaw(raw);
    }
    let target = null;
    const cont = files.find((f) => f.name === "META-INF/container.xml");
    if (cont) {
      const x = dec.decode(await get(cont));
      const m = x.match(/full-path="([^"]+)"/);
      if (m) target = files.find((f) => f.name === m[1]);
    }
    if (!target) target = files.find((f) => /\.(xml|musicxml)$/i.test(f.name) && !f.name.startsWith("META-INF"));
    if (!target) throw new Error(".mxl 內找不到樂譜檔");
    return dec.decode(await get(target));
  }

  function parseScore(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("這不是有效的 MusicXML 檔案");
    if (doc.querySelector("score-timewise")) throw new Error("暫不支援 timewise 格式，請匯出為 partwise");
    const txt = (sel) => { const e = doc.querySelector(sel); return e ? e.textContent.trim() : ""; };
    const part = doc.querySelector("part");
    if (!part) throw new Error("找不到聲部資料");
    const info = {
      title: txt("work-title") || txt("movement-title") || "",
      composer: (doc.querySelector('creator[type="composer"]') || {}).textContent || "",
      lyricist: (doc.querySelector('creator[type="lyricist"]') || {}).textContent || "",
      fifths: 0, minor: false, beats: 4, beatType: 4, tempo: null, clef: "treble",
    };
    const tempoEl = doc.querySelector("sound[tempo]");
    if (tempoEl) info.tempo = Math.round(parseFloat(tempoEl.getAttribute("tempo")));
    else {
      const pm = doc.querySelector("metronome per-minute");
      if (pm) info.tempo = Math.round(parseFloat(pm.textContent));
    }
    let divisions = 1, first = true;
    const measures = [];
    const keyNow = { fifths: 0 };
    const mEls = [...part.children].filter((c) => c.tagName === "measure");
    for (const m of mEls) {
      const at = m.querySelector("attributes");
      for (const a of m.querySelectorAll("attributes")) {
        const d = a.querySelector("divisions");
        if (d) divisions = parseFloat(d.textContent);
        const k = a.querySelector("key fifths");
        if (k) { keyNow.fifths = parseInt(k.textContent); if (first) { info.fifths = keyNow.fifths; const md = a.querySelector("key mode"); info.minor = !!(md && md.textContent.trim() === "minor"); } }
        const t = a.querySelector("time");
        if (t) {
          const b = parseInt(t.querySelector("beats").textContent), bt = parseInt(t.querySelector("beat-type").textContent);
          info.beats = b; info.beatType = bt;
        }
        const c = a.querySelector("clef sign");
        if (c && first) info.clef = c.textContent.trim() === "F" ? "bass" : "treble";
      }
      const notes = [];
      let t = 0, lastStart = 0;
      for (const el of m.children) {
        if (el.tagName === "backup") { t -= parseFloat(el.querySelector("duration").textContent) / divisions; continue; }
        if (el.tagName === "forward") { t += parseFloat(el.querySelector("duration").textContent) / divisions; continue; }
        if (el.tagName !== "note") continue;
        if (el.querySelector("grace")) continue;
        const voice = (el.querySelector("voice") || {}).textContent || "1";
        const dur = parseFloat((el.querySelector("duration") || { textContent: "0" }).textContent) / divisions;
        const isChord = !!el.querySelector("chord");
        const start = isChord ? lastStart : t;
        if (!isChord) { lastStart = t; t += dur; }
        if (voice !== "1") continue; // 只取第一聲部
        const rest = !!el.querySelector("rest");
        let pitch = null;
        if (!rest) {
          const p = el.querySelector("pitch");
          if (!p) continue;
          pitch = { step: p.querySelector("step").textContent, alter: p.querySelector("alter") ? Math.round(parseFloat(p.querySelector("alter").textContent)) : 0, octave: parseInt(p.querySelector("octave").textContent) };
        }
        if (isChord) {
          const prev = notes[notes.length - 1];
          if (prev && pitch && prev.pitch) { // 和弦：保留最高音
            const v = (q) => q.octave * 7 + STEP_IDX[q.step];
            if (v(pitch) > v(prev.pitch)) prev.pitch = pitch;
          }
          continue;
        }
        const tie = el.querySelector('tie[type="stop"]') ? "stop" : "";
        const fileLy = [];
        el.querySelectorAll("lyric").forEach((ly, li) => {
          const num = parseInt(ly.getAttribute("number")) || li + 1;
          let text = "";
          ly.querySelectorAll("text").forEach((t) => (text += t.textContent));
          const syl = (ly.querySelector("syllabic") || { textContent: "single" }).textContent.trim();
          if (text.trim() === "" && !ly.querySelector("extend")) return;
          fileLy[num - 1] = { text: text.trim(), hy: syl === "begin" || syl === "middle", ext: !!ly.querySelector("extend") };
        });
        const tieStart = !!(el.querySelector('tie[type="start"]') || el.querySelector('notations tied[type="start"]'));
        const tieStopB = !!(el.querySelector('tie[type="stop"]') || el.querySelector('notations tied[type="stop"]'));
        const slurs = [];
        el.querySelectorAll("notations slur").forEach((sl) => slurs.push({ type: sl.getAttribute("type"), num: sl.getAttribute("number") || "1" }));
        notes.push({ rest, pitch, dur, start, tieStart, tieStop: tieStopB || !!tie, slurs, fileLy, el });
      }
      const keyEl = m.querySelector("attributes key fifths");
      measures.push({ notes, fifths: keyNow.fifths, hasAttr: !!at });
    }
    return { info, measures, doc };
  }

  // ---------- label conversion (簡譜／唱名／音名) ----------
  const SOLFEGE = ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"];
  function tonicFor(fifths, minor, minorMode) {
    if (minor && minorMode === "do") {
      const nm = MINOR_BY_FIFTHS[fifths];
      return [nm[0], nm.length > 1 ? (nm[1] === "#" ? 1 : -1) : 0];
    }
    return TONIC_MAJOR_STEP[String(fifths)];
  }
  function tonicName(fifths, minor, minorMode) {
    const [st, al] = tonicFor(fifths, minor, minorMode);
    return st + (al > 0 ? "♯" : al < 0 ? "♭" : "");
  }
  // 回傳 { text, acc, oct }；text 是數字／唱名／音名本體，acc 為 ♯♭ 前綴，oct 為八度點數（正＝高、負＝低）
  function labelOf(p, kind, mode, fifths, minor, minorMode) {
    const accOf = (a) => (a > 0 ? "♯" : a < 0 ? "♭" : "");
    if (kind === "name") return { text: p.step, acc: accOf(p.alter), oct: p.octave - 4 };
    const pick = (i) => (kind === "solfege" ? SOLFEGE[i] : String(i + 1));
    if (mode === "fixed") return { text: pick(STEP_IDX[p.step]), acc: accOf(p.alter), oct: p.octave - 4 };
    const [tstep, talter] = tonicFor(fifths, minor, minorMode);
    const tAbs = STEP_IDX[tstep] + 28;
    const nAbs = STEP_IDX[p.step] + 7 * p.octave;
    const diff = nAbs - tAbs;
    const deg = ((diff % 7) + 7) % 7;
    const oct = Math.floor(diff / 7);
    const tMidi = 12 * 5 + STEP_SEMI[STEP_IDX[tstep]] + talter;
    const nMidi = 12 * (p.octave + 1) + STEP_SEMI[STEP_IDX[p.step]] + p.alter;
    const a = nMidi - tMidi - oct * 12 - STEP_SEMI[deg];
    return { text: pick(deg), acc: accOf(a), oct };
  }

  // ---------- lyrics ----------
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  function tokenizeLyricLine(line) {
    const clean = line.replace(/[，。、；：！？「」『』（）〈〉《》“”‘’…,.;:!?"()]/g, " ");
    const out = [];
    for (const word of clean.split(/\s+/)) {
      if (!word) continue;
      let buf = "";
      const flush = (hy) => { if (buf) { out.push({ text: buf, hy: !!hy, ext: false }); buf = ""; } };
      for (const ch of word) {
        if (CJK.test(ch)) { flush(false); out.push({ text: ch, hy: false, ext: false }); }
        else if (ch === "-" || ch === "‐") flush(true);
        else if (ch === "_" || ch === "—" || ch === "－") { flush(false); out.push({ skip: true }); }
        else buf += ch;
      }
      flush(false);
    }
    return out;
  }
  function assignLyrics(measures) {
    const all = [];
    measures.forEach((m) => m.notes.forEach((n) => { n.ly = []; all.push(n); }));
    const raw = $("lyricText").value.trim();
    if (raw) {
      const sung = all.filter((n) => !n.rest);
      raw.split(/\n+/).forEach((line, vi) => {
        const toks = tokenizeLyricLine(line);
        let ni = 0;
        toks.forEach((tk) => {
          if (ni >= sung.length) return;
          if (!tk.skip) sung[ni].ly[vi] = tk;
          ni++;
        });
      });
    } else {
      all.forEach((n) => { n.ly = n.fileLy || []; });
    }
  }

  // ---------- 連結線（tie）與圓滑線（slur） ----------
  function buildArcs(measures) {
    const all = [];
    measures.forEach((m) => m.notes.forEach((n) => { n.gi = all.length; all.push(n); }));
    const arcs = [];
    const open = {};
    all.forEach((n) => {
      (n.slurs || []).forEach((sl) => {
        if (sl.type === "stop" && open[sl.num] != null) {
          const a = all[open[sl.num]];
          arcs.push({ kind: "slur", a, b: n, span: all.slice(a.gi, n.gi + 1).filter((x) => !x.rest) });
          delete open[sl.num];
        }
      });
      (n.slurs || []).forEach((sl) => { if (sl.type === "start") open[sl.num] = n.gi; });
    });
    all.forEach((n) => {
      if (!n.tieStart || n.rest) return;
      for (let j = n.gi + 1; j < all.length; j++) {
        if (all[j].rest) break;
        if (all[j].tieStop) { arcs.push({ kind: "tie", a: n, b: all[j], span: [n, all[j]] }); break; }
        break;
      }
    });
    return arcs;
  }

  function toVfDur(d) {
    let best = DURS[0], bd = 1e9;
    for (const x of DURS) { const e = Math.abs(x[0] - d); if (e < bd) { bd = e; best = x; } }
    return best[1];
  }

  // ---------- rendering ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(parent, name, attrs, text) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    parent.appendChild(e);
    return e;
  }

  let parsed = null;

  const num = (id, d, lo, hi) => { const v = parseFloat($(id).value); return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : d)); };

  function render() {
    stopPlay();
    const out = $("sheet");
    out.innerHTML = "";
    if (!parsed) return;
    const { info, measures } = parsed;
    const mode = $("mode").value;
    const perRow = Math.max(1, Math.min(8, parseInt($("perRow").value) || 4));
    const showStaff = $("showStaff").checked;
    const fifthsForJp = info.fifths;

    const showLyrics = $("showLyrics").checked;
    const LFS = Math.max(8, Math.min(30, parseFloat($("lyricSize").value) || 13));
    assignLyrics(measures);
    const arcs = buildArcs(measures);
    const showTies = $("showTies").checked, showSlurs = $("showSlurs").checked;
    const kind = $("kind").value, minorMode = $("minorMode").value;
    const keyStr = keyName(info.fifths, info.minor);
    const tempoStr = info.tempo ? `　速度每分鐘 ${info.tempo} 拍` : "";
    const kindZh = { jianpu: "簡譜", solfege: "唱名", name: "音名" }[kind];
    let modeStr;
    if (kind === "name") modeStr = `音名（${keyStr}）`;
    else if (mode === "fixed") modeStr = kind === "jianpu" ? `絕對音 C=1（原調 ${keyStr}）` : `${kindZh} 固定唱名（原調 ${keyStr}）`;
    else modeStr = `首調 1=${tonicName(info.fifths, info.minor, minorMode)}（${keyStr}）`;
    const subtitle = $("subtitle").value.trim() || `五線譜・${kindZh}對照　${modeStr}　${info.beats}/${info.beatType} 拍${tempoStr}`;

    const h = document.createElement("div");
    h.className = "head";
    h.innerHTML = `<h1></h1><p class="sub"></p><p class="by"></p>`;
    h.querySelector("h1").textContent = $("title").value.trim() || info.title || "（未命名）";
    h.querySelector(".sub").textContent = subtitle;
    const by = [];
    const comp = $("composer").value.trim(), orig = $("singer").value.trim();
    if (comp) by.push("作曲：" + comp);
    if (orig) by.push("演唱：" + orig);
    h.querySelector(".by").innerHTML = by.map((s) => `<span></span>`).join("");
    [...h.querySelectorAll(".by span")].forEach((s, i) => (s.textContent = by[i]));
    out.appendChild(h);

    const W = 760;
    const beatLen = (info.beatType === 8 && info.beats % 3 === 0 && info.beats > 3) ? 1.5 : 4 / info.beatType;
    const measLen = info.beats * 4 / info.beatType;
    const vfKey = (MAJOR_BY_FIFTHS[info.fifths]);
    const minorKey = info.minor ? MINOR_BY_FIFTHS[info.fifths] + "m" : vfKey;

    for (let r = 0; r * perRow < measures.length; r++) {
      const row = measures.slice(r * perRow, r * perRow + perRow);
      const div = document.createElement("div");
      div.className = "row";
      div.style.marginBottom = num("rowGap", 4, 0, 60) + "px";
      out.appendChild(div);
      const H = showStaff ? 175 : 95;
      const renderer = new VF.Renderer(div, VF.Renderer.Backends.SVG);
      renderer.resize(W, H);
      const ctx = renderer.getContext();
      const svg = div.querySelector("svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.removeAttribute("width"); svg.removeAttribute("height");
      svg.style.width = "100%"; svg.style.height = "auto";

      const left = num("sideMargin", 14, 0, 60), usable = W - 2 * left;
      const firstExtra = 60;
      const unit = (usable - firstExtra) / row.length;
      const staveY = 38;
      const FS = Math.max(10, Math.min(36, parseFloat($("fontSize").value) || 17));
      const k = FS / 17;
      // 依簡譜字級決定每小節所需寬度，字大時自動加寬該小節
      row.forEach((m) => m.notes.forEach((n) => {
        n.lab = n.rest ? { text: "0", acc: "", oct: 0 } : labelOf(n.pitch, kind, mode, m.fifths, info.minor, minorMode);
        n.hw = n.lab.text.length * 0.28 * FS;
        n.wd = 2 * n.hw + (n.lab.acc ? 0.4 * FS : 0);
        n.lw = 0;
        if (showLyrics) (n.ly || []).forEach((l) => { if (l && l.text) { let w = 0; for (const ch of l.text) w += CJK.test(ch) ? LFS : 0.55 * LFS; n.lw = Math.max(n.lw, w + (l.hy ? 0.5 * LFS : 0)); } });
      }));
      const gapFor = (a, b2) => Math.max((a.dur < 1 - 1e-9 ? 0.95 : 0.9) * FS, Math.max(a.wd, a.lw) / 2 + Math.max(b2.wd, b2.lw) / 2 + 0.3 * FS);
      const need = row.map((m, mi) => {
        let t = FS * 1.6 + (mi === 0 ? firstExtra : 0);
        m.notes.forEach((n, i) => { if (i > 0) t += gapFor(m.notes[i - 1], n); });
        return t;
      });
      let wArr = row.map((m, mi) => Math.max(unit + (mi === 0 ? firstExtra : 0), need[mi]));
      const tot = wArr.reduce((a, b2) => a + b2, 0);
      wArr = wArr.map((v) => (v * (usable)) / tot);
      let x = left;
      let lowY = staveY + 40;
      const bars = [];
      const FONT = "'Noto Sans TC','Noto Sans CJK TC','Microsoft JhengHei','PingFang TC',sans-serif";

      row.forEach((m, mi) => {
        const gi = r * perRow + mi;
        const w = wArr[mi];
        const stave = new VF.Stave(x, staveY, w);
        const barPad = num("barPad", 0, 0, 40);
        if (barPad) stave.setNoteStartX(stave.getNoteStartX() + barPad);
        if (mi === 0) {
          stave.addClef(info.clef);
          stave.addKeySignature(minorKey);
          if (r === 0) { stave.addTimeSignature(`${info.beats}/${info.beatType}`); }
          if (r === 0 && info.tempo) stave.setTempo({ duration: "q", bpm: info.tempo }, -22);
        } else if (gi > 0 && m.fifths !== measures[gi - 1].fifths) {
          stave.addKeySignature(MAJOR_BY_FIFTHS[m.fifths]);
        }
        if (gi === measures.length - 1) stave.setEndBarType(VF.Barline.type.END);
        if (showStaff) stave.setContext(ctx).draw();

        // notes
        const clefName = info.clef;
        const vfNotes = m.notes.map((n) => {
          const dur = toVfDur(n.dur);
          let sn;
          if (n.rest) {
            sn = new VF.StaveNote({ clef: clefName, keys: [clefName === "bass" ? "d/3" : "b/4"], duration: dur + "r" });
          } else {
            const key = `${n.pitch.step.toLowerCase()}/${n.pitch.octave}`;
            sn = new VF.StaveNote({ clef: clefName, keys: [key], duration: dur, auto_stem: true });
          }
          const dots = dur.endsWith("d") ? 1 : 0;
          if (dots) VF.Dot.buildAndAttach([sn], { all: true });
          return sn;
        });
        // accidentals from pitch spelling (measure-local state)
        const seen = {};
        const keySig = new Set();
        const sharpsOrder = ["F", "C", "G", "D", "A", "E", "B"], flatsOrder = ["B", "E", "A", "D", "G", "C", "F"];
        const keyAlter = {};
        if (m.fifths > 0) sharpsOrder.slice(0, m.fifths).forEach((s) => (keyAlter[s] = 1));
        if (m.fifths < 0) flatsOrder.slice(0, -m.fifths).forEach((s) => (keyAlter[s] = -1));
        m.notes.forEach((n, i) => {
          if (n.rest) return;
          const id = n.pitch.step + n.pitch.octave;
          const cur = id in seen ? seen[id] : keyAlter[n.pitch.step] || 0;
          if (n.pitch.alter !== cur) {
            const sym = n.pitch.alter === 1 ? "#" : n.pitch.alter === -1 ? "b" : n.pitch.alter === 2 ? "##" : n.pitch.alter === -2 ? "bb" : "n";
            vfNotes[i].addModifier(new VF.Accidental(sym), 0);
          }
          seen[id] = n.pitch.alter;
        });
        const beams = VF.Beam.generateBeams(vfNotes, { beam_rests: false });
        const voice = new VF.Voice({ num_beats: info.beats, beat_value: info.beatType }).setMode(VF.Voice.Mode.SOFT);
        voice.addTickables(vfNotes);
        m.notes.forEach((n, i) => { n.vf = vfNotes[i]; n.row = r; });
        const fmt = new VF.Formatter();
        fmt.joinVoices([voice]);
        const startX = stave.getNoteStartX();
        const avail = x + w - startX - 12;
        let availW = Math.max(40, avail);
        fmt.format([voice], availW);
        // 讓小節前後留白相等：第一個音距離小節線＝最後一個音距離下一條小節線（長音結尾除外）
        vfNotes.forEach((sn) => sn.setStave(stave));
        const ctrX = (sn) => (sn.getNoteHeadBeginX() + sn.getNoteHeadEndX()) / 2;
        for (let it = 0; it < 3; it++) {
          const lead = ctrX(vfNotes[0]) - (startX - 5 - barPad), trail = x + w - ctrX(vfNotes[vfNotes.length - 1]);
          const d = lead - trail;
          if (trail > 40 || Math.abs(d) < 0.8) break;
          availW = Math.max(40, availW - d);
          fmt.format([voice], availW);
        }
        if (showStaff) {
          voice.draw(ctx, stave);
          beams.forEach((b) => b.setContext(ctx).draw());
          lowY = Math.max(lowY, stave.getYForLine(4));
          vfNotes.forEach((sn) => {
            sn.getYs().forEach((y) => (lowY = Math.max(lowY, y + 6)));
            if (sn.hasStem && sn.hasStem()) {
              const ex = sn.getStemExtents();
              lowY = Math.max(lowY, ex.topY, ex.baseY);
            }
          });
        } else {
          vfNotes.forEach((sn) => sn.setStave(stave));
        }
        // note centers
        const xs = vfNotes.map((sn) => {
          if (showStaff) return (sn.getNoteHeadBeginX() + sn.getNoteHeadEndX()) / 2;
          return sn.getAbsoluteX() + 5;
        });
        bars.push({ x0: x, x1: x + w, startX, notes: m.notes, xs });
        x += w;
      });

      // jianpu line ----------------------------------------------------
      const jpTop = showStaff ? Math.max(staveY + 78, lowY + 18) + num("jpGap", 0, -20, 80) : 8; // 簡譜行頂端：避開五線譜最低處
            const baseY = jpTop + 10 + FS * 1.0 + 4 * k; // 數字基線
      const barTop = baseY - FS * 1.3, barBot = baseY + 10 * k;
      const nVerse = showLyrics ? Math.max(0, ...row.flatMap((m) => m.notes.map((n) => (n.ly || []).length))) : 0;
      const lyTop = baseY + 24 * k + LFS * 0.2;
      const H2 = baseY + 24 * k + (nVerse ? nVerse * LFS * num("lyLine", 1.35, 1, 2.5) + 8 : 0);
      svg.setAttribute("viewBox", `0 0 ${W} ${H2}`);
      // 五線譜上的連結線／圓滑線
      if (showStaff) {
        arcs.forEach((arc) => {
          const inA = arc.a.row === r, inB = arc.b.row === r;
          if (!inA && !inB) return;
          if (arc.kind === "tie" && showTies) {
            new VF.StaveTie({ first_note: inA ? arc.a.vf : null, last_note: inB ? arc.b.vf : null, first_indices: [0], last_indices: [0] }).setContext(ctx).draw();
          } else if (arc.kind === "slur" && showSlurs && inA && inB) {
            new VF.Curve(arc.a.vf, arc.b.vf, { cps: [{ x: 0, y: 10 }, { x: 0, y: 10 }] }).setContext(ctx).draw();
          }
        });
      }
      const g = svgEl(svg, "g", {});
      const line = (x1, y1, x2, y2, wd) => svgEl(g, "line", { x1, y1, x2, y2, stroke: "#000", "stroke-width": wd || 1.2, "stroke-linecap": "butt" });
      const dot = (cx, cy) => svgEl(g, "circle", { cx, cy, r: 1.6 * k, fill: "#000" });
      // 起始小節線與各小節線（只畫在簡譜行，與五線譜分開）
      line(left + 0.6, barTop, left + 0.6, barBot, 1.2);
      bars.forEach((b, bi) => {
        const last = r * perRow + bi === measures.length - 1;
        if (last) { line(b.x1 - 4.5, barTop, b.x1 - 4.5, barBot, 1.2); line(b.x1 - 0.8, barTop, b.x1 - 0.8, barBot, 3); }
        else line(b.x1, barTop, b.x1, barBot, 1.2);
      });

      bars.forEach((b, bi) => {
        const notes = b.notes, xs = b.xs.slice();
        // 每行第一小節（前面有譜號、調號）：可選擇讓簡譜不對齊五線譜，改成與小節線前後等距
        if (bi === 0 && $("firstFree").checked && xs.length > 1) {
          const pad = b.x1 - xs[xs.length - 1], a0 = xs[0], a1 = xs[xs.length - 1];
          const n0 = b.x0 + pad, n1 = b.x1 - pad;
          if (a1 > a0) for (let q = 0; q < xs.length; q++) xs[q] = n0 + ((xs[q] - a0) * (n1 - n0)) / (a1 - a0);
        }
        for (let q = 1; q < xs.length; q++) { const mg = gapFor(notes[q - 1], notes[q]); if (xs[q] - xs[q - 1] < mg) xs[q] = xs[q - 1] + mg; }
        { const over = xs[xs.length - 1] - (b.x1 - FS * 0.65); if (over > 0) { const room = Math.max(0, xs[0] - (b.startX - FS * 0.2)); const sh = Math.min(over, room); for (let q = 0; q < xs.length; q++) xs[q] -= sh; } }
        notes.forEach((n, i) => {
          n.cx = xs[i];
          const rc = document.createElementNS(SVGNS, "rect");
          const y0 = showStaff ? staveY - 14 : barTop - 6;
          rc.setAttribute("x", xs[i] - Math.max(n.hw, 6 * k) - 4);
          rc.setAttribute("y", y0);
          rc.setAttribute("width", 2 * Math.max(n.hw, 6 * k) + 8);
          rc.setAttribute("height", Math.max(10, H2 - y0 - 2));
          rc.setAttribute("rx", 4);
          rc.setAttribute("stroke", "none");
          rc.setAttribute("fill", "none");
          svg.insertBefore(rc, g);
          n.hl = rc;
        });
        const gm = measures[r * perRow + bi];
        const fif = gm.fifths;
        const levelsOf = (n) => (n.dur >= 1 - 1e-9 ? 0 : n.dur <= 0.25 + 1e-9 ? 2 : 1);
        // digits
        notes.forEach((n, i) => {
          const cx = xs[i];
          const numTxt = n.lab.text, acc = n.lab.acc, oct = n.lab.oct;
          svgEl(g, "text", { x: cx, y: baseY, "text-anchor": "middle", "font-size": FS, "font-family": FONT, "font-weight": 500 }, numTxt);
          if (acc) svgEl(g, "text", { x: cx - n.hw - 1.5 * k, y: baseY - 6 * k, "text-anchor": "end", "font-size": FS * 0.62, "font-family": FONT }, acc);
          const lv = levelsOf(n);
          if (oct > 0) for (let kk = 0; kk < oct; kk++) dot(cx, baseY - FS * 0.78 - 4 * k - kk * 4.2 * k);
          if (oct < 0) for (let kk = 0; kk < -oct; kk++) dot(cx, baseY + (6 + lv * 3.4 + 2.4 + kk * 4.2) * k);
          // 附點與延長線
          const nextX = i + 1 < notes.length ? xs[i + 1] : b.x1 - 8;
          let dashes = 0, dotted = false;
          if (n.dur >= 2 - 1e-9) {
            dashes = Math.floor(n.dur + 1e-9) - 1;
            dotted = n.dur - Math.floor(n.dur + 1e-9) > 0.2;
          } else if (n.dur > 1 + 1e-9 || Math.abs(n.dur - 0.75) < 1e-9 || Math.abs(n.dur - 0.375) < 1e-9) dotted = true;
          if (dotted && dashes === 0) svgEl(g, "circle", { cx: cx + n.hw + 3 * k, cy: baseY - 5 * k, r: 1.5 * k, fill: "#000" });
          if (dashes > 0) {
            const span = Math.max(24 * k, nextX - cx);
            for (let d = 1; d <= dashes; d++) {
              const dx = cx + (span * d) / (dashes + 1);
              if (n.rest) svgEl(g, "text", { x: dx, y: baseY, "text-anchor": "middle", "font-size": FS, "font-family": FONT, "font-weight": 500 }, "0");
              else line(dx - 4.5 * k, baseY - 5.5 * k, dx + 4.5 * k, baseY - 5.5 * k, 1.3);
            }
            if (dotted) svgEl(g, "circle", { cx: cx + (span * (dashes + 0.55)) / (dashes + 1), cy: baseY - 5 * k, r: 1.5 * k, fill: "#000" });
          }
        });
        // underlines per beat
        const U1 = baseY + 5 * k, U2 = baseY + 8.4 * k, HALF0 = 6 * k;
        const hwOf = (q) => Math.max(HALF0, notes[q].hw + 1.2 * k);
        let i = 0;
        while (i < notes.length) {
          if (notes[i].dur >= 1 - 1e-9) { i++; continue; }
          const beat = Math.floor(notes[i].start / beatLen + 1e-9);
          const grp = [];
          while (i < notes.length && notes[i].dur < 1 - 1e-9 && Math.floor(notes[i].start / beatLen + 1e-9) === beat) { grp.push(i); i++; }
          line(xs[grp[0]] - hwOf(grp[0]), U1, xs[grp[grp.length - 1]] + hwOf(grp[grp.length - 1]), U1, 1.2);
          let k = 0;
          while (k < grp.length) {
            if (notes[grp[k]].dur <= 0.25 + 1e-9) {
              let e = k;
              while (e + 1 < grp.length && notes[grp[e + 1]].dur <= 0.25 + 1e-9) e++;
              line(xs[grp[k]] - hwOf(grp[k]), U2, xs[grp[e]] + hwOf(grp[e]), U2, 1.2);
              k = e + 1;
            } else k++;
          }
        }
        // lyrics
        if (nVerse) {
          notes.forEach((n, i) => {
            (n.ly || []).forEach((l, vi) => {
              if (!l || !l.text) return;
              const y = lyTop + LFS + vi * LFS * num("lyLine", 1.35, 1, 2.5);
              const label = nVerse > 1 ? "" : "";
              svgEl(g, "text", { x: xs[i], y, "text-anchor": "middle", "font-size": LFS, "font-family": FONT }, l.text + label);
              if (l.hy) {
                const nx = i + 1 < notes.length ? xs[i + 1] : b.x1 - 6;
                const hx = (xs[i] + n.lw / 2 + nx - ((notes[i + 1] && notes[i + 1].lw) || 0) / 2) / 2;
                if (nx - xs[i] > 0) svgEl(g, "text", { x: hx, y, "text-anchor": "middle", "font-size": LFS, "font-family": FONT }, "-");
              }
            });
          });
        }
      });
      // 簡譜行的連結線／圓滑線（弧線畫在數字上方）
      arcs.forEach((arc) => {
        if (!(arc.kind === "tie" ? showTies : showSlurs)) return;
        const a = arc.a, b2 = arc.b;
        const inA = a.row === r, inB = b2.row === r;
        if (!inA && !inB) return;
        const x1 = inA ? a.cx + a.hw * 0.55 : left + 2;
        const x2 = inB ? b2.cx - b2.hw * 0.55 : W - left - 2;
        if (x2 <= x1) return;
        let top = Infinity;
        arc.span.forEach((n) => {
          if (n.row !== r) return;
          const o = n.lab.oct > 0 ? n.lab.oct : 0;
          top = Math.min(top, o ? baseY - FS * 0.78 - 4 * k - (o - 1) * 4.2 * k - 4 * k : baseY - FS * 0.8 - 3 * k);
        });
        if (!isFinite(top)) return;
        const h = Math.min(FS * 0.5, 4 * k + (x2 - x1) * 0.06);
        svgEl(g, "path", { d: `M${x1} ${top} Q${(x1 + x2) / 2} ${top - 2 * h} ${x2} ${top}`, fill: "none", stroke: "#000", "stroke-width": 1.1, "stroke-linecap": "round" });
      });
    }
  }

  // ---------- 播放與匯出 ----------
  const midiOf = (p) => (p.octave + 1) * 12 + STEP_SEMI[STEP_IDX[p.step]] + p.alter;
  function timeline() {
    // 回傳 { notes:[{n,t,dur}], audio:[{midi,t,dur}], total }（單位：四分音符）
    const { info, measures } = parsed;
    const full = (info.beats * 4) / info.beatType;
    let off = 0;
    const ns = [], audio = [];
    measures.forEach((m) => {
      let end = 0;
      m.notes.forEach((n) => (end = Math.max(end, n.start + n.dur)));
      const len = end > 0 ? Math.max(end, 0) : full;
      m.notes.forEach((n) => {
        if (n.rest) return;
        const t = off + n.start;
        ns.push({ n, t, dur: n.dur });
        const prev = audio[audio.length - 1];
        if (n.tieStop && prev && prev.midi === midiOf(n.pitch) && Math.abs(prev.t + prev.dur - t) < 1e-6) prev.dur += n.dur;
        else audio.push({ midi: midiOf(n.pitch), t, dur: n.dur });
      });
      off += len;
    });
    return { notes: ns, audio, total: off };
  }

  let actx = null, playing = false, raf = 0, curHl = null, t0 = 0, spq = 0.6, tl = null;
  function stopPlay() {
    playing = false;
    cancelAnimationFrame(raf);
    if (actx) { try { actx.close(); } catch (e) {} actx = null; }
    if (curHl) { curHl.setAttribute("fill", "none"); curHl = null; }
    $("play").textContent = "▶ 播放";
  }
  function startPlay() {
    if (!parsed) return;
    stopPlay();
    tl = timeline();
    const bpm = (parsed.info.tempo || 90) * ((parseFloat($("speed").value) || 100) / 100);
    spq = 60 / bpm;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = actx;
    t0 = ctx.currentTime + 0.15;
    const master = ctx.createGain();
    master.gain.value = 0.28;
    master.connect(ctx.destination);
    tl.audio.forEach((e) => {
      const f = 440 * Math.pow(2, (e.midi - 69) / 12);
      const st = t0 + e.t * spq, du = Math.max(0.08, e.dur * spq * 0.97);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(1, st + 0.012);
      g.gain.exponentialRampToValueAtTime(0.35, st + Math.min(0.25, du * 0.5));
      g.gain.setValueAtTime(0.35, st + du);
      g.gain.exponentialRampToValueAtTime(0.0008, st + du + 0.18);
      g.connect(master);
      [["triangle", f, 1], ["sine", f * 2, 0.25]].forEach(([type, fr, vol]) => {
        const o = ctx.createOscillator();
        const gg = ctx.createGain();
        gg.gain.value = vol;
        o.type = type; o.frequency.value = fr;
        o.connect(gg); gg.connect(g);
        o.start(st); o.stop(st + du + 0.25);
      });
    });
    playing = true;
    $("play").textContent = "⏸ 停止";
    const tick = () => {
      if (!playing) return;
      const q = (ctx.currentTime - t0) / spq;
      if (q > tl.total + 0.3) { stopPlay(); return; }
      let hit = null;
      for (const e of tl.notes) if (q >= e.t - 1e-6 && q < e.t + e.dur - 1e-6) { hit = e.n; break; }
      const rc = hit && hit.hl;
      if (rc !== curHl) {
        if (curHl) curHl.setAttribute("fill", "none");
        curHl = rc || null;
        if (curHl) {
          curHl.setAttribute("fill", "rgba(255,193,7,0.38)");
          const r = curHl.getBoundingClientRect();
          if (r.top < 90 || r.bottom > window.innerHeight - 20) curHl.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function downloadBlob(name, data, mime) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function fileBase() { return ($("title").value.trim() || (parsed && parsed.info.title) || "score").replace(/[\\/:*?"<>|]/g, "_"); }

  function buildMidi() {
    const t = timeline();
    const PPQ = 480;
    const vlq = (v) => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
    const ev = [];
    t.audio.forEach((e) => {
      const on = Math.round(e.t * PPQ), off = Math.round((e.t + e.dur) * PPQ);
      ev.push([on, 1, [0x90, e.midi, 90]], [Math.max(on + 1, off - 4), 0, [0x80, e.midi, 0]]);
    });
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const bpm = parsed.info.tempo || 90;
    const mpq = Math.round(60000000 / bpm);
    const bytes = [0, 0xff, 0x51, 3, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255,
      0, 0xff, 0x58, 4, parsed.info.beats, Math.round(Math.log2(parsed.info.beatType)), 24, 8,
      0, 0xc0, 0];
    let last = 0;
    ev.forEach(([tk, , msg]) => { bytes.push(...vlq(tk - last), ...msg); last = tk; });
    bytes.push(0, 0xff, 0x2f, 0);
    const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255];
    const len = bytes.length;
    const trk = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    return new Uint8Array([...hdr, ...trk, ...bytes]);
  }

  function annotatedXml() {
    const ms = parsed.measures;
    const kindZh = { jianpu: "簡譜", solfege: "唱名", name: "音名" }[$("kind").value];
    ms.forEach((m) => m.notes.forEach((n) => {
      if (!n.el || n.rest || !n.lab) return;
      const dot = (n.lab.oct > 0 ? "\u0307".repeat(Math.min(3, n.lab.oct)) : "") + (n.lab.oct < 0 ? "\u0323".repeat(Math.min(3, -n.lab.oct)) : "");
      const doc = n.el.ownerDocument;
      const ly = doc.createElement("lyric");
      ly.setAttribute("name", kindZh);
      ly.setAttribute("number", "jp");
      const sy = doc.createElement("syllabic"); sy.textContent = "single"; ly.appendChild(sy);
      const tx = doc.createElement("text"); tx.textContent = n.lab.acc + n.lab.text + dot; ly.appendChild(tx);
      n.el.appendChild(ly);
    }));
    const out = new XMLSerializer().serializeToString(parsed.doc);
    // 還原，避免重複匯出時累積
    ms.forEach((m) => m.notes.forEach((n) => { if (n.el) n.el.querySelectorAll('lyric[number="jp"]').forEach((x) => x.remove()); }));
    return out;
  }

  const store = { get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  /* @@include compose.js */
  /* @@include layout.js */

  // ---------- UI ----------
  function applyInfoToFields() {
    const { info } = parsed;
    if (!$("title").dataset.touched) $("title").value = info.title;
    if (!$("composer").dataset.touched) $("composer").value = info.composer.trim();
  }

  async function loadText(text, fromSample) {
    try {
      parsed = parseScore(text);
      $("err").textContent = "";
      
      $("title").dataset.touched = ""; $("composer").dataset.touched = "";
      applyInfoToFields();
      $("meta").textContent = `共 ${parsed.measures.length} 小節　${parsed.info.beats}/${parsed.info.beatType}　${keyName(parsed.info.fifths, parsed.info.minor)}` + (parsed.info.tempo ? `　♩=${parsed.info.tempo}` : "");
      render();
    } catch (e) {
      $("err").textContent = "讀取失敗：" + e.message;
    }
  }

  $("file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try { await openAnyFile(f); } catch (e) { $("err").textContent = "讀取失敗：" + e.message; }
  });
  $("sample").addEventListener("click", () => loadText(window.SAMPLE_XML, true));
  ["kind", "mode", "minorMode", "perRow", "fontSize", "showLyrics", "showTies", "showSlurs", "lyricSize", "lyricText", "showStaff", "firstFree", "sideMargin", "barPad", "rowGap", "jpGap", "lyLine", "title", "composer", "singer", "subtitle"].forEach((id) => {
    $(id).addEventListener("input", (e) => { if (id === "title" || id === "composer") e.target.dataset.touched = "1"; render(); });
    $(id).addEventListener("change", render);
  });
  $("print").addEventListener("click", () => window.print());
  $("play").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
  $("speed").addEventListener("input", () => { $("speedv").textContent = $("speed").value + "%"; });
  $("dlMidi").addEventListener("click", () => { if (parsed) downloadBlob(fileBase() + ".mid", buildMidi(), "audio/midi"); });
  $("dlXmlPlain").addEventListener("click", () => {
    if (!parsed) return;
    downloadBlob(fileBase() + ".musicxml", '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(parsed.doc.documentElement), "application/vnd.recordare.musicxml+xml");
  });
  $("dlXml").addEventListener("click", () => { if (parsed) downloadBlob(fileBase() + "_標註.musicxml", annotatedXml(), "application/vnd.recordare.musicxml+xml"); });

  // ---------- 圖檔辨識（連到後端 backend/server.py） ----------
  // 目前先不開放圖檔辨識：改成 true 並重新 python3 build.py 即可啟用（後端程式都在 backend/）
  const OMR_ENABLED = false;
  if (!OMR_ENABLED) document.querySelectorAll(".omr-only").forEach((e) => (e.style.display = "none"));
  const omrBase = () => ($("omrUrl").value.trim() || "http://127.0.0.1:8765").replace(/\/+$/, "");
  let omrJobs = false;
  const omrHeaders = () => { const k = $("omrKey").value.trim(); return k ? { "X-API-Key": k } : {}; };
  async function omrPing() {
    const st = $("omrStatus");
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(omrBase() + "/health", { signal: ctl.signal });
      const j = await r.json();
      omrJobs = !!j.jobs;
      let keyOk = true;
      if (j.auth) {
        const c = await fetch(omrBase() + "/check", { headers: omrHeaders(), signal: ctl.signal });
        keyOk = c.ok;
      }
      clearTimeout(to);
      if (!j.homr) { st.textContent = "辨識服務已連線，但找不到 homr"; st.style.color = "#b42318"; return false; }
      if (!keyOk) { st.textContent = $("omrKey").value.trim() ? "辨識服務已連線，但 API 金鑰不正確" : "辨識服務已連線，需要填 API 金鑰"; st.style.color = "#b42318"; return false; }
      st.textContent = "辨識服務：已連線 ✓";
      st.style.color = "#157347";
      return true;
    } catch (e) {
      st.textContent = "辨識服務：未連線（本機請先啟動 backend；遠端請檢查網址）";
      st.style.color = "#b42318";
      return false;
    }
  }
  async function recognizeImage(file) {
    const st = $("omrStatus");
    $("err").textContent = "";
    if (!(await omrPing())) { $("err").textContent = "連不上辨識服務。本機版請先啟動 backend（docker-start 或 start.bat）；遠端版請到「圖檔辨識設定」確認網址與 API 金鑰。"; return; }
    st.textContent = "辨識中…（小圖約數秒，整頁樂譜可能要 1–3 分鐘，第一次還要下載模型）";
    st.style.color = "#555";
    $("omrBtn").disabled = true;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("page", $("omrPage").value || "1");
    try {
      let j;
      if (omrJobs) {
        // 通道（如 Cloudflare）有回應時間上限：先送出工作，再每 2 秒查一次結果
        const r0 = await fetch(omrBase() + "/jobs", { method: "POST", body: fd, headers: omrHeaders() });
        const j0 = await r0.json();
        if (!r0.ok) throw new Error(j0.detail || r0.statusText);
        const t0 = Date.now();
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000));
          const r1 = await fetch(omrBase() + "/jobs/" + j0.id, { headers: omrHeaders() });
          j = await r1.json();
          if (!r1.ok) throw new Error(j.detail || r1.statusText);
          if (j.status === "done") break;
          if (j.status === "error") throw new Error(j.detail || "辨識失敗");
          const sec = Math.round((Date.now() - t0) / 1000);
          st.textContent = (j.status === "queued" ? "排隊中…" : "辨識中…") + `（已等 ${sec} 秒）`;
          if (sec > 1200) throw new Error("等待超過 20 分鐘，已放棄");
        }
      } else {
        const r = await fetch(omrBase() + "/recognize", { method: "POST", body: fd, headers: omrHeaders() });
        j = await r.json();
        if (!r.ok) throw new Error(j.detail || r.statusText);
      }
      showOriginal(file);
      await loadText(j.musicxml, false);
      $("title").value = file.name.replace(/\.[^.]+$/, "");
      render();
      st.textContent = "辨識完成。請對照原圖檢查音高與節奏，辨識結果可能有誤。";
      st.style.color = "#157347";
    } catch (e) {
      st.textContent = "";
      $("err").textContent = "辨識失敗：" + e.message;
    } finally {
      $("omrBtn").disabled = false;
    }
  }
  function showOriginal(file) {
    const box = $("origBox");
    if (/^image\//.test(file.type)) {
      const url = URL.createObjectURL(file);
      box.innerHTML = '<details open><summary>原圖（對照用，不會列印）</summary><img alt="原圖"></details>';
      box.querySelector("img").src = url;
    } else {
      box.innerHTML = "";
    }
  }
  $("omrFile").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) recognizeImage(f); ev.target.value = ""; });
  $("omrUrl").value = store.get("omrUrl") || $("omrUrl").value;
  $("omrKey").value = store.get("omrKey");
  $("omrUrl").addEventListener("change", () => { store.set("omrUrl", $("omrUrl").value.trim()); omrPing(); });
  $("omrKey").addEventListener("change", () => { store.set("omrKey", $("omrKey").value.trim()); omrPing(); });
  if (OMR_ENABLED) omrPing();

  // drag & drop
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && (/^image\//.test(f.type) || /\.pdf$/i.test(f.name))) {
      if (OMR_ENABLED) recognizeImage(f);
      else $("err").textContent = "目前尚未開放圖檔辨識，請拖入 MusicXML（.musicxml／.xml／.mxl）檔。";
      return;
    }
    if (f) { try { await openAnyFile(f); } catch (er) { $("err").textContent = "讀取失敗：" + er.message; } }
  });

  if (window.SAMPLE_XML) loadText(window.SAMPLE_XML, true); else $("sample").style.display = "none";
})();
