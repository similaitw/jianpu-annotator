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
        notes.push({ rest, pitch, dur, start, tieStop: !!tie });
      }
      const keyEl = m.querySelector("attributes key fifths");
      measures.push({ notes, fifths: keyNow.fifths, hasAttr: !!at });
    }
    return { info, measures };
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

  function render() {
    const out = $("sheet");
    out.innerHTML = "";
    if (!parsed) return;
    const { info, measures } = parsed;
    const mode = $("mode").value;
    const perRow = Math.max(1, Math.min(8, parseInt($("perRow").value) || 4));
    const showStaff = $("showStaff").checked;
    const fifthsForJp = info.fifths;

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
      out.appendChild(div);
      const H = showStaff ? 175 : 95;
      const renderer = new VF.Renderer(div, VF.Renderer.Backends.SVG);
      renderer.resize(W, H);
      const ctx = renderer.getContext();
      const svg = div.querySelector("svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.removeAttribute("width"); svg.removeAttribute("height");
      svg.style.width = "100%"; svg.style.height = "auto";

      const left = 14, usable = W - 2 * left;
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
      }));
      const gapFor = (a, b2) => Math.max((a.dur < 1 - 1e-9 ? 0.95 : 0.9) * FS, a.wd / 2 + b2.wd / 2 + 0.3 * FS);
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
        const fmt = new VF.Formatter();
        fmt.joinVoices([voice]);
        const startX = stave.getNoteStartX();
        const avail = x + w - startX - 12;
        fmt.format([voice], Math.max(40, avail));
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
      const jpTop = showStaff ? Math.max(staveY + 78, lowY + 18) : 8; // 簡譜行頂端：避開五線譜最低處
            const baseY = jpTop + 10 + FS * 1.0 + 4 * k; // 數字基線
      const barTop = baseY - FS * 1.3, barBot = baseY + 10 * k;
      const H2 = baseY + 24 * k;
      svg.setAttribute("viewBox", `0 0 ${W} ${H2}`);
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
        for (let q = 1; q < xs.length; q++) { const mg = gapFor(notes[q - 1], notes[q]); if (xs[q] - xs[q - 1] < mg) xs[q] = xs[q - 1] + mg; }
        { const over = xs[xs.length - 1] - (b.x1 - FS * 0.65); if (over > 0) { const room = Math.max(0, xs[0] - (b.startX - FS * 0.2)); const sh = Math.min(over, room); for (let q = 0; q < xs.length; q++) xs[q] -= sh; } }
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
      });
    }
  }

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
    try { await loadText(await readFileText(f), false); } catch (e) { $("err").textContent = "讀取失敗：" + e.message; }
  });
  $("sample").addEventListener("click", () => loadText(window.SAMPLE_XML, true));
  ["kind", "mode", "minorMode", "perRow", "fontSize", "showStaff", "title", "composer", "singer", "subtitle"].forEach((id) => {
    $(id).addEventListener("input", (e) => { if (id === "title" || id === "composer") e.target.dataset.touched = "1"; render(); });
    $(id).addEventListener("change", render);
  });
  $("print").addEventListener("click", () => window.print());

  // drag & drop
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) { try { await loadText(await readFileText(f), false); } catch (er) { $("err").textContent = "讀取失敗：" + er.message; } }
  });

  if (window.SAMPLE_XML) loadText(window.SAMPLE_XML, true); else $("sample").style.display = "none";
})();
