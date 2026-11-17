  // =====================================================================
  //  匯入 MIDI → MusicXML、線上編寫（簡譜文字輸入）→ MusicXML
  //  共用流程：事件序列 → layoutEvents（切小節、拆音值、加連結線）→ buildMusicXml → loadText
  // =====================================================================
  const UNIT_PER_QUARTER = 4; // 內部以十六分音符為單位
  const PIECES = [16, 12, 8, 6, 4, 3, 2, 1]; // 可記譜的音值（單位：十六分）：全、附點二分、二分、附點四分、四分、附點八分、八分、十六分
  const TYPE_OF = { 16: ["whole", 0], 12: ["half", 1], 8: ["half", 0], 6: ["quarter", 1], 4: ["quarter", 0], 3: ["eighth", 1], 2: ["eighth", 0], 1: ["16th", 0] };
  const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  // events: [{ rest:true, units } | { pitch:{step,alter,octave}, units, tieNext }]
  function layoutEvents(events, measUnits) {
    const measures = [[]];
    let pos = 0, prevTie = false;
    const cur = () => measures[measures.length - 1];
    events.forEach((ev) => {
      let left = ev.units, first = true;
      while (left > 0) {
        if (pos >= measUnits) { measures.push([]); pos = 0; }
        const take = Math.min(left, measUnits - pos);
        let rem = take;
        const pieces = [];
        while (rem > 0) { const p = PIECES.find((x) => x <= rem); pieces.push(p); rem -= p; }
        pieces.forEach((p, i) => {
          const lastPiece = left - take === 0 && i === pieces.length - 1;
          const n = { rest: !!ev.rest, pitch: ev.pitch || null, units: p };
          if (!ev.rest) {
            n.tieStop = !(first && i === 0) || (first && i === 0 && prevTie);
            n.tieStart = !lastPiece || (lastPiece && !!ev.tieNext);
          }
          cur().push(n);
        });
        pos += take; left -= take; first = false;
      }
      prevTie = !!ev.tieNext && !ev.rest;
    });
    if (pos < measUnits && cur().length) {
      let rem = measUnits - pos;
      while (rem > 0) { const p = PIECES.find((x) => x <= rem); cur().push({ rest: true, pitch: null, units: p }); rem -= p; }
    }
    return measures.filter((m) => m.length);
  }

  function buildMusicXml(spec) {
    const measUnits = Math.round((spec.beats * 4 * UNIT_PER_QUARTER) / spec.beatType);
    const measures = layoutEvents(spec.events, measUnits);
    if (!measures.length) throw new Error("沒有任何音符");
    const clef = spec.clef === "bass" ? "<sign>F</sign><line>4</line>" : "<sign>G</sign><line>2</line>";
    let x = `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="3.1">\n<work><work-title>${xmlEsc(spec.title || "")}</work-title></work>\n`;
    if (spec.composer) x += `<identification><creator type="composer">${xmlEsc(spec.composer)}</creator></identification>\n`;
    x += `<part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>\n<part id="P1">\n`;
    measures.forEach((m, mi) => {
      x += `<measure number="${mi + 1}">\n`;
      if (mi === 0) {
        x += `<attributes><divisions>${UNIT_PER_QUARTER}</divisions><key><fifths>${spec.fifths}</fifths><mode>${spec.minor ? "minor" : "major"}</mode></key><time><beats>${spec.beats}</beats><beat-type>${spec.beatType}</beat-type></time><clef>${clef}</clef></attributes>\n`;
        if (spec.tempo) x += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${spec.tempo}</per-minute></metronome></direction-type><sound tempo="${spec.tempo}"/></direction>\n`;
      }
      m.forEach((n) => {
        const [type, dots] = TYPE_OF[n.units];
        x += "<note>";
        if (n.rest) x += "<rest/>";
        else x += `<pitch><step>${n.pitch.step}</step>${n.pitch.alter ? `<alter>${n.pitch.alter}</alter>` : ""}<octave>${n.pitch.octave}</octave></pitch>`;
        x += `<duration>${n.units}</duration>`;
        if (n.tieStop) x += '<tie type="stop"/>';
        if (n.tieStart) x += '<tie type="start"/>';
        x += `<voice>1</voice><type>${type}</type>${dots ? "<dot/>" : ""}`;
        if (n.tieStop || n.tieStart) x += `<notations>${n.tieStop ? '<tied type="stop"/>' : ""}${n.tieStart ? '<tied type="start"/>' : ""}</notations>`;
        x += "</note>\n";
      });
      x += "</measure>\n";
    });
    return x + "</part>\n</score-partwise>\n";
  }

  async function loadGenerated(xml, title) {
    await loadText(xml, false);
    if (title) { $("title").value = title; $("title").dataset.touched = "1"; render(); }
  }

  // ---------- MIDI 解析 ----------
  function parseMidi(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
    if (str(0, 4) !== "MThd") throw new Error("不是 MIDI 檔");
    const ntrks = dv.getUint16(10), div = dv.getUint16(12);
    if (div & 0x8000) throw new Error("不支援 SMPTE 時間格式的 MIDI");
    let pos = 14;
    const out = { div, tracks: [], tempo: null, ts: null, key: null };
    const vlq = () => { let v = 0, b; do { b = u8[pos++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    for (let t = 0; t < ntrks && pos + 8 <= u8.length; t++) {
      if (str(pos, 4) !== "MTrk") break;
      const len = dv.getUint32(pos + 4);
      pos += 8;
      const end = Math.min(u8.length, pos + len);
      let tick = 0, running = 0, name = "";
      const open = {}, notes = [], chans = new Set();
      while (pos < end) {
        tick += vlq();
        let st = u8[pos];
        if (st < 0x80) st = running; else { pos++; if (st < 0xf0) running = st; }
        if (st === 0xff) {
          const type = u8[pos++], ml = vlq(), d = u8.subarray(pos, pos + ml);
          pos += ml;
          if (type === 0x03 && !name) name = new TextDecoder("utf-8").decode(d);
          else if (type === 0x51 && out.tempo == null && ml === 3) out.tempo = Math.round(60000000 / ((d[0] << 16) | (d[1] << 8) | d[2]));
          else if (type === 0x58 && !out.ts && ml >= 2) out.ts = [d[0], 1 << d[1]];
          else if (type === 0x59 && !out.key && ml >= 2) out.key = { sf: (d[0] << 24) >> 24, minor: d[1] === 1 };
          else if (type === 0x2f) { pos = end; }
        } else if (st === 0xf0 || st === 0xf7) {
          pos += vlq();
        } else {
          const kind = st & 0xf0, ch = st & 0x0f;
          const d1 = u8[pos++];
          const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : u8[pos++];
          if (kind === 0x90 && d2 > 0) { (open[ch * 128 + d1] = open[ch * 128 + d1] || []).push(tick); chans.add(ch); }
          else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
            const q = open[ch * 128 + d1];
            if (q && q.length) notes.push({ start: q.shift(), end: tick, pitch: d1, ch });
          }
        }
      }
      pos = end;
      out.tracks.push({ name, notes, chans: [...chans] });
    }
    return out;
  }

  // 調性估計（Krumhansl–Schmuckler）
  function estimateKey(pcs) {
    const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const corr = (a, b) => {
      const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
      let n = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
      return da && db ? n / Math.sqrt(da * db) : -1;
    };
    const FIFTHS_OF_MAJOR_PC = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
    let best = { r: -2, sf: 0, minor: false };
    for (let tonic = 0; tonic < 12; tonic++) {
      const rot = (prof) => Array.from({ length: 12 }, (_, i) => prof[(i - tonic + 12) % 12]);
      const rM = corr(pcs, rot(MAJ)), rm = corr(pcs, rot(MIN));
      if (rM > best.r) best = { r: rM, sf: FIFTHS_OF_MAJOR_PC[tonic], minor: false };
      if (rm > best.r) best = { r: rm, sf: FIFTHS_OF_MAJOR_PC[(tonic + 3) % 12], minor: true };
    }
    return best;
  }
  const SPELL_SHARP = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
  const SPELL_FLAT = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];
  function spellMidi(midi, fifths) {
    const [step, alter] = (fifths >= 0 ? SPELL_SHARP : SPELL_FLAT)[midi % 12];
    return { step, alter, octave: Math.floor(midi / 12) - 1 };
  }

  let midiData = null, midiName = "";
  function openMidi(u8, name) {
    midiData = parseMidi(u8);
    midiName = name.replace(/\.[^.]+$/, "");
    const cand = midiData.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.notes.length && !x.t.chans.every((c) => c === 9));
    if (!cand.length) throw new Error("這個 MIDI 檔裡沒有可轉換的音符");
    const avg = (t) => t.notes.reduce((s, n) => s + n.pitch, 0) / t.notes.length;
    cand.sort((a, b) => b.t.notes.length - a.t.notes.length || avg(b.t) - avg(a.t));
    const box = $("midiTracks");
    box.innerHTML = "";
    midiData.tracks.forEach((t, i) => {
      if (!t.notes.length) return;
      const drums = t.chans.every((c) => c === 9);
      const lo = Math.min(...t.notes.map((n) => n.pitch)), hi = Math.max(...t.notes.map((n) => n.pitch));
      const lab = document.createElement("label");
      lab.className = "trk";
      const rd = document.createElement("input");
      rd.type = "radio"; rd.name = "midiTrack"; rd.value = i; rd.disabled = drums;
      if (i === cand[0].i) rd.checked = true;
      lab.appendChild(rd);
      lab.appendChild(document.createTextNode(` 音軌 ${i + 1}${t.name ? "「" + t.name + "」" : ""}：${t.notes.length} 個音，音域 ${midiNoteName(lo)}–${midiNoteName(hi)}${drums ? "（打擊樂，無法轉換）" : ""}`));
      box.appendChild(lab);
    });
    $("midiBeats").value = midiData.ts ? midiData.ts[0] : 4;
    $("midiBeatType").value = midiData.ts ? midiData.ts[1] : 4;
    $("midiTempo").value = midiData.tempo || 90;
    $("midiKey").value = midiData.key ? String(midiData.key.sf) + (midiData.key.minor ? "m" : "M") : "auto";
    $("midiTitle").value = midiName;
    $("midiPanel").hidden = false;
    $("midiPanel").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const midiNoteName = (m) => ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][m % 12] + (Math.floor(m / 12) - 1);

  function convertMidi() {
    try {
      $("midiErr").textContent = "";
      const sel = document.querySelector('input[name="midiTrack"]:checked');
      if (!sel) throw new Error("請選一個音軌");
      const trk = midiData.tracks[parseInt(sel.value)];
      const grid = parseInt($("midiGrid").value); // 每四分音符幾格（4＝十六分、2＝八分）
      const mul = UNIT_PER_QUARTER / grid;
      const top = $("midiVoice").value === "top";
      const beats = parseInt($("midiBeats").value) || 4, beatType = parseInt($("midiBeatType").value) || 4;
      // 量化並保留單聲部
      const q = trk.notes.map((n) => ({ s: Math.round((n.start * grid) / midiData.div), e: Math.round((n.end * grid) / midiData.div), p: n.pitch }));
      q.sort((a, b) => a.s - b.s || (top ? b.p - a.p : a.p - b.p));
      const mono = [];
      q.forEach((n) => { if (!mono.length || mono[mono.length - 1].s !== n.s) mono.push({ ...n }); });
      for (let i = 0; i < mono.length; i++) { if (i + 1 < mono.length) mono[i].e = Math.min(mono[i].e, mono[i + 1].s); }
      const notes = mono.filter((n) => n.e > n.s);
      if (!notes.length) throw new Error("量化後沒有音符，試試較細的量化格");
      // 調號
      let fifths, minor = false;
      const kv = $("midiKey").value;
      if (kv === "auto") {
        const pcs = new Array(12).fill(0);
        notes.forEach((n) => (pcs[n.p % 12] += n.e - n.s));
        const k = estimateKey(pcs);
        fifths = k.sf; minor = k.minor;
      } else { fifths = parseInt(kv); minor = kv.endsWith("m"); }
      const events = [];
      let cur = 0;
      notes.forEach((n) => {
        if (n.s > cur) events.push({ rest: true, units: (n.s - cur) * mul });
        events.push({ pitch: spellMidi(n.p, fifths), units: (n.e - n.s) * mul });
        cur = n.e;
      });
      const clef = notes.reduce((s, n) => s + n.p, 0) / notes.length < 55 ? "bass" : "treble";
      const xml = buildMusicXml({ title: $("midiTitle").value.trim(), fifths, minor, beats, beatType, tempo: parseInt($("midiTempo").value) || null, clef, events });
      loadGenerated(xml, $("midiTitle").value.trim());
      $("midiPanel").hidden = true;
    } catch (e) {
      $("midiErr").textContent = "轉換失敗：" + e.message;
    }
  }

  // ---------- 線上編寫：簡譜文字輸入 ----------
  const JP_TOKEN = /^([#♯]|[b♭])?([0-7])([',’]*)(_*)(\.?)(-*)$/;
  function pitchFromJianpu(d, acc, oct, fifths, mode) {
    const [tstep, talter] = mode === "fixed" ? ["C", 0] : TONIC_MAJOR_STEP[String(fifths)];
    const MAJ = [0, 2, 4, 5, 7, 9, 11];
    const tAbs = STEP_IDX[tstep] + 28;
    const nAbs = tAbs + (d - 1) + 7 * oct;
    const letter = STEPS[((nAbs % 7) + 7) % 7];
    const octave = Math.floor(nAbs / 7);
    const target = 12 * 5 + STEP_SEMI[STEP_IDX[tstep]] + talter + MAJ[d - 1] + acc + 12 * oct;
    return { step: letter, alter: target - (12 * (octave + 1) + STEP_SEMI[STEP_IDX[letter]]), octave };
  }
  function parseJianpuText(text, fifths, mode) {
    const events = [], errors = [];
    const toks = text.replace(/[|｜]/g, " ").replace(/~/g, " ~ ").split(/\s+/).filter(Boolean);
    toks.forEach((tok, idx) => {
      if (tok === "~") { if (events.length) events[events.length - 1].tieNext = true; return; }
      if (/^-+$/.test(tok)) { if (events.length) events[events.length - 1].units += 4 * tok.length; else errors.push(`第 ${idx + 1} 個符號「${tok}」前面沒有音符`); return; }
      const m = tok.match(JP_TOKEN);
      if (!m) { errors.push(`看不懂「${tok}」（第 ${idx + 1} 個符號）`); return; }
      const [, accS, dS, octS, us, dot, dashes] = m;
      const d = parseInt(dS), under = us.length;
      if (under > 2) { errors.push(`「${tok}」底線最多兩條`); return; }
      if (under && dashes) { errors.push(`「${tok}」不能同時有底線和延長線`); return; }
      let units = (4 * (1 + dashes.length)) / Math.pow(2, under);
      if (dot) units *= 1.5;
      if (units !== Math.floor(units)) { errors.push(`「${tok}」音值太短，無法記譜`); return; }
      const oct = [...octS].reduce((s, c) => s + (c === "," ? -1 : 1), 0);
      if (d === 0) { events.push({ rest: true, units }); return; }
      const acc = accS ? (accS === "#" || accS === "♯" ? 1 : -1) : 0;
      events.push({ pitch: pitchFromJianpu(d, acc, oct, fifths, mode), units });
    });
    return { events, errors };
  }
  function applyEditor() {
    const txt = $("edText").value;
    const err = $("edErr");
    err.textContent = "";
    if (!txt.trim()) return;
    try {
      const kv = $("edKey").value;
      const fifths = parseInt(kv), minor = $("edMinor").checked;
      const { events, errors } = parseJianpuText(txt, fifths, $("edMode").value);
      if (errors.length) err.textContent = errors.slice(0, 4).join("；") + (errors.length > 4 ? `…（共 ${errors.length} 處）` : "");
      if (!events.length) return;
      const xml = buildMusicXml({
        title: $("edTitle").value.trim(), fifths, minor,
        beats: parseInt($("edBeats").value) || 4, beatType: parseInt($("edBeatType").value) || 4,
        tempo: parseInt($("edTempo").value) || null, clef: $("edClef").value, events,
      });
      loadGenerated(xml, $("edTitle").value.trim());
    } catch (e) { err.textContent = "轉換失敗：" + e.message; }
  }
  let edTimer = 0;
  const edSchedule = () => { clearTimeout(edTimer); edTimer = setTimeout(applyEditor, 350); };
  ["edText", "edTitle", "edKey", "edMinor", "edBeats", "edBeatType", "edTempo", "edClef", "edMode"].forEach((id) => {
    $(id).addEventListener("input", edSchedule);
    $(id).addEventListener("change", edSchedule);
  });
  $("edClear").addEventListener("click", () => { $("edText").value = ""; $("edErr").textContent = ""; });
  $("edExample").addEventListener("click", () => { $("edText").value = "1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 -"; $("edKey").value = "0"; $("edMode").value = "fixed"; $("edTitle").value = "輸入範例"; applyEditor(); });
  $("midiGo").addEventListener("click", convertMidi);
  $("midiCancel").addEventListener("click", () => { $("midiPanel").hidden = true; });
  (function fillKeys() {
    const names = { "-7": "C♭", "-6": "G♭", "-5": "D♭", "-4": "A♭", "-3": "E♭", "-2": "B♭", "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F♯", 7: "C♯" };
    const sel = [$("edKey")];
    sel.forEach((s) => { for (let f = -7; f <= 7; f++) { const o = document.createElement("option"); o.value = f; o.textContent = `${names[f]} 大調（${f === 0 ? "無升降" : f > 0 ? "♯" + f : "♭" + -f}）`; s.appendChild(o); } s.value = "0"; });
    const mk = $("midiKey");
    for (let f = -7; f <= 7; f++) {
      const o = document.createElement("option"); o.value = f + "M"; o.textContent = `${names[f]} 大調`; mk.appendChild(o);
    }
    const mn = { "-7": "A♭", "-6": "E♭", "-5": "B♭", "-4": "F", "-3": "C", "-2": "G", "-1": "D", 0: "A", 1: "E", 2: "B", 3: "F♯", 4: "C♯", 5: "G♯", 6: "D♯", 7: "A♯" };
    for (let f = -7; f <= 7; f++) { const o = document.createElement("option"); o.value = f + "m"; o.textContent = `${mn[f]} 小調`; mk.appendChild(o); }
  })();

  // 開啟任何檔案：MIDI／MusicXML／mxl
  async function openAnyFile(f) {
    const u8 = new Uint8Array(await f.arrayBuffer());
    if (u8[0] === 0x4d && u8[1] === 0x54 && u8[2] === 0x68 && u8[3] === 0x64) { openMidi(u8, f.name); return; }
    $("midiPanel").hidden = true;
    const text = u8[0] === 0x50 && u8[1] === 0x4b ? await unzipMxl(u8) : new TextDecoder("utf-8").decode(u8);
    await loadText(text, false);
  }
