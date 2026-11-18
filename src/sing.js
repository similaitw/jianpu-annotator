  // =====================================================================
  //  唱歌輸入（第一階段）：節拍器 → 錄音＋即時音高 → 切音 → 拍子量化 → 音高校正 → MusicXML
  //  全部在瀏覽器內執行；音高偵測採 McLeod Pitch Method（與 pitchy 同一演算法，內建免套件）
  // =====================================================================
  const SG_JP = ["1", "1♯", "2", "2♯", "3", "4", "4♯", "5", "5♯", "6", "6♯", "7"];
  const SG_HOP = 0.02; // 取樣間隔（秒）
  let sgRec = null; // 目前錄音狀態
  let sgLast = null; // 最近一次錄音資料，可用不同設定重新轉換

  // ---- 音高偵測（McLeod NSDF） ----
  function sgPitch(x, sr) {
    let n = x.length, y = x, rate = sr;
    if (sr >= 32000) {
      const m = n >> 1;
      y = new Float32Array(m);
      for (let i = 0; i < m; i++) y[i] = (x[2 * i] + x[2 * i + 1]) * 0.5;
      n = m; rate = sr / 2;
    }
    const maxLag = Math.min(n - 2, Math.floor(rate / 70)), minLag = Math.max(2, Math.floor(rate / 1100));
    const pre = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) pre[j + 1] = pre[j] + y[j] * y[j];
    const nsdf = new Float32Array(maxLag + 1);
    for (let t = 0; t <= maxLag; t++) {
      const mp = pre[n - t] + (pre[n] - pre[t]);
      let r = 0;
      for (let j = 0, e = n - t; j < e; j++) r += y[j] * y[j + t];
      nsdf[t] = mp > 1e-9 ? (2 * r) / mp : 0;
    }
    let t = 1;
    while (t < maxLag && nsdf[t] > 0) t++;
    const peaks = [];
    while (t < maxLag) {
      while (t < maxLag && nsdf[t] <= 0) t++;
      let best = -1, bv = -2;
      while (t < maxLag && nsdf[t] > 0) { if (nsdf[t] > bv) { bv = nsdf[t]; best = t; } t++; }
      if (best >= minLag) peaks.push(best);
    }
    if (!peaks.length) return null;
    let mx = 0;
    peaks.forEach((p) => (mx = Math.max(mx, nsdf[p])));
    const p = peaks.find((q) => nsdf[q] >= 0.9 * mx);
    const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1], d = a - 2 * b + c;
    const sh = d !== 0 ? (0.5 * (a - c)) / d : 0;
    return { f: rate / (p + sh), clarity: nsdf[p] };
  }
  const sgMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const sgMedian = (arr) => { const s = arr.slice().sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

  // ---- 轉換：取樣序列 → 音符事件 ----
  // frames: [{t, midi|null}]（t：相對於第 1 小節開頭的秒數，固定間隔 SG_HOP）
  // 切音：以「滯後 + 音量起伏」取代逐格四捨五入，長音顫動不會被切碎，同音重複靠音量下凹分開
  function sgSegment(frames, stab) {
    stab = Math.max(1, Math.min(5, stab || 3));
    const n = frames.length;
    const sm = frames.map((f, i) => {
      if (f.midi == null) return null;
      const w = [];
      for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < n && frames[k].midi != null) w.push(frames[k].midi);
      return sgMedian(w);
    });
    const sr = frames.map((f, i) => { let a = 0, c = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n) { a += frames[k].rms || 0; c++; } return a / c; });
    const th = 0.55 + 0.1 * stab;                 // 偏離目前音多少半音才算換音
    const minF = Math.round(2 + 1.5 * stab);      // 新音至少維持幾格（每格 20 ms）
    const gapMax = 6 + 2 * stab;                  // 音高偵測不到多久才算休止
    const dip = Math.max(0.3, Math.min(0.75, 0.55 - 0.07 * (stab - 3))); // 音量掉到最大值的幾成算「斷開」
    const out = [];
    const close = (c, e) => { if (e > c.s) out.push({ s: c.s, e, midi: sgMedian(c.vals) }); };
    let cur = null, pend = [], gap = 0;
    const mk = (s, vals, r) => ({ s, vals, rmsMax: r, low: 0 });
    for (let i = 0; i < n; i++) {
      const m = sm[i];
      if (m == null) {
        if (cur && ++gap > gapMax) { close(cur, i - gap + 1 - cur.low); cur = null; pend = []; gap = 0; }
        continue;
      }
      gap = 0;
      if (!cur) { cur = mk(i, [m], sr[i]); continue; }
      const c = sgMedian(cur.vals.slice(-20));
      if (Math.abs(m - c) > th) {
        pend.push(i);
        if (pend.length >= minF) {
          const pv = pend.map((k) => sm[k]), pm = sgMedian(pv);
          if (pv.every((v) => Math.abs(v - pm) <= th)) {
            close(cur, pend[0]);
            cur = mk(pend[0], pv, Math.max(...pend.map((k) => sr[k])));
            pend = [];
          } else pend.shift();
        }
        continue;
      }
      pend = [];
      if (sr[i] > cur.rmsMax) cur.rmsMax = sr[i];
      if (sr[i] < cur.rmsMax * dip) cur.low++;
      else if (cur.low >= 3) {
        if (sr[i] > cur.rmsMax * Math.min(0.9, dip + 0.25)) { close(cur, i - cur.low); cur = mk(i, [m], sr[i]); continue; }
      } else cur.low = 0;
      cur.vals.push(m);
    }
    if (cur) close(cur, n - gap - cur.low);
    // 過短的碎音：併入前一個音（間隔很小時），否則丟掉
    const res = [];
    out.forEach((o) => {
      if (o.e - o.s < Math.max(3, minF - 2)) { const p = res[res.length - 1]; if (p && o.s - p.e <= 3) p.e = o.e; return; }
      res.push(o);
    });
    return res.map((r) => ({ start: frames[r.s].t, end: frames[Math.min(n, r.e) - 1].t + SG_HOP, midi: r.midi }));
  }

  const sgScalePcs = (fifths) => { const tonic = (((fifths * 7) % 12) + 12) % 12; return new Set([0, 2, 4, 5, 7, 9, 11].map((d) => (d + tonic) % 12)); };

  function sgBuild(frames, cfg) {
    const notes = sgSegment(frames, cfg.stab);
    if (!notes.length) throw new Error("沒有偵測到歌聲：請靠近麥克風、環境安靜，音量大一點再試一次");
    // 整體音準偏移校正（中位數）
    const off = sgMedian(notes.map((n) => n.midi - Math.round(n.midi)));
    notes.forEach((n) => (n.midi += cfg.octave - (Math.abs(off) < 0.45 ? off : 0)));
    // 調性
    let fifths, minor = false;
    if (cfg.key === "auto") {
      const pcs = new Array(12).fill(0);
      notes.forEach((n) => (pcs[((Math.round(n.midi) % 12) + 12) % 12] += n.end - n.start));
      const k = estimateKey(pcs);
      fifths = k.sf; minor = k.minor;
    } else { fifths = parseInt(cfg.key); minor = cfg.key.endsWith("m"); }
    // 吸附到調內音
    const scale = sgScalePcs(fifths);
    notes.forEach((n) => {
      let r = Math.round(n.midi);
      if (cfg.snap && !scale.has(((r % 12) + 12) % 12)) {
        let best = r, bd = 99;
        for (let c = r - 2; c <= r + 2; c++) if (scale.has(((c % 12) + 12) % 12) && Math.abs(c - n.midi) < bd) { bd = Math.abs(c - n.midi); best = c; }
        r = best;
      }
      n.p = r;
    });
    // 拍子量化（單位：十六分音符）
    const u16 = 60 / cfg.bpm / 4, minU = cfg.minUnit;
    const events = [];
    let cur = 0;
    notes.forEach((n) => {
      let s = Math.round(n.start / u16 / minU) * minU, e = Math.round(n.end / u16 / minU) * minU;
      if (e <= 0) return;
      s = Math.max(s, cur, 0);
      if (e <= s) { if ((n.end - n.start) >= 0.6 * minU * u16) e = s + minU; else return; }
      if (s > cur) events.push({ rest: true, units: s - cur });
      const last = events[events.length - 1];
      events.push({ pitch: spellMidi(n.p, fifths), units: e - s });
      cur = e;
    });
    if (!events.length) throw new Error("量化後沒有音符，試試較短的最短音符或較慢的速度");
    const mean = notes.reduce((a, n) => a + n.p, 0) / notes.length;
    return { events, fifths, minor, clef: mean < 55 ? "bass" : "treble", notes };
  }

  function sgConvert() {
    const err = $("sgErr");
    err.textContent = "";
    if (!sgLast) { err.textContent = "還沒有錄音"; return; }
    try {
      const cfg = sgCfg();
      // 以固定間隔重取樣
      const raw = sgLast.samples, t0 = sgLast.t0 + cfg.lat / 1000;
      const frames = [];
      let k = 0;
      const tEnd = raw.length ? raw[raw.length - 1].t : 0;
      for (let t = t0; t <= tEnd; t += SG_HOP) {
        while (k + 1 < raw.length && Math.abs(raw[k + 1].t - t) <= Math.abs(raw[k].t - t)) k++;
        const s = raw[k];
        const ok = s && Math.abs(s.t - t) < 0.05;
        frames.push({ t: t - t0, midi: ok ? s.midi : null, rms: ok ? s.rms : 0 });
      }
      const r = sgBuild(frames, cfg);
      const xml = buildMusicXml({ title: $("sgTitle").value.trim(), fifths: r.fifths, minor: r.minor, beats: cfg.beats, beatType: cfg.beatType, tempo: cfg.bpm, clef: r.clef, events: r.events });
      loadGenerated(xml, $("sgTitle").value.trim());
      sgDrawResult(frames, r.notes, cfg);
      $("sgInfo").textContent = `已轉成 ${r.events.filter((e) => !e.rest).length} 個音符（${keyName(r.fifths, r.minor)}），結果已載入下方樂譜；不準的話可改設定後按「重新轉換」。`;
    } catch (e) { err.textContent = e.message; }
  }

  function sgCfg() {
    const g = (id, d, lo, hi) => Math.max(lo, Math.min(hi, parseFloat($(id).value) || d));
    return {
      beats: g("sgBeats", 4, 1, 16), beatType: parseInt($("sgBeatType").value) || 4, bpm: g("sgBpm", 80, 30, 240),
      countIn: g("sgCount", 1, 0, 4), minUnit: parseInt($("sgMin").value) || 2, key: $("sgKey").value, snap: $("sgSnap").checked,
      octave: parseInt($("sgOct").value) || 0, stab: g("sgStab", 3, 1, 5), lat: parseFloat($("sgLat").value) || 0,
    };
  }

  // ---- 畫音高曲線 ----
  function sgCanvasPrep() {
    const cv = $("sgCanvas");
    const w = cv.clientWidth || 600;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = 180; }
    const c = cv.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.fillStyle = "#f6f8fa"; c.fillRect(0, 0, cv.width, cv.height);
    return { c, W: cv.width, H: cv.height };
  }
  function sgDrawResult(frames, notes, cfg) {
    const { c, W, H } = sgCanvasPrep();
    const pts = frames.filter((f) => f.midi != null);
    if (!pts.length) return;
    const lo = Math.min(...pts.map((f) => f.midi)) - 2, hi = Math.max(...pts.map((f) => f.midi)) + 2;
    const T = Math.max(frames[frames.length - 1].t, 1);
    const X = (t) => (t / T) * W, Y = (m) => H - ((m - lo) / (hi - lo)) * H;
    const beat = (60 / cfg.bpm) * (4 / cfg.beatType);
    c.strokeStyle = "#dde3ea"; c.lineWidth = 1;
    for (let b = 0; b * beat < T; b++) { c.beginPath(); c.moveTo(X(b * beat), 0); c.lineTo(X(b * beat), H); c.strokeStyle = b % cfg.beats ? "#e8ecf0" : "#b9c3ce"; c.stroke(); }
    c.fillStyle = "rgba(37,99,235,.25)";
    notes.forEach((n) => c.fillRect(X(n.start), Y(n.p) - 5, Math.max(2, X(n.end) - X(n.start)), 10));
    c.strokeStyle = "#111"; c.lineWidth = 2; c.beginPath();
    let pen = false;
    frames.forEach((f) => { if (f.midi == null) { pen = false; return; } if (!pen) { c.moveTo(X(f.t), Y(f.midi)); pen = true; } else c.lineTo(X(f.t), Y(f.midi)); });
    c.stroke();
  }
  function sgDrawLive(samples, now) {
    const { c, W, H } = sgCanvasPrep();
    const span = 6, t1 = now, t0 = now - span;
    const v = samples.filter((s) => s.t >= t0 && s.midi != null);
    if (!v.length) return;
    const lo = Math.min(...v.map((s) => s.midi)) - 3, hi = Math.max(...v.map((s) => s.midi)) + 3;
    const r = Math.max(hi - lo, 12);
    c.strokeStyle = "#2563eb"; c.lineWidth = 2; c.beginPath();
    let pen = false, last = -9;
    samples.forEach((s) => {
      if (s.t < t0) return;
      if (s.midi == null || s.t - last > 0.1) pen = false;
      if (s.midi == null) return;
      const x = ((s.t - t0) / span) * W, y = H - ((s.midi - lo) / r) * H;
      if (!pen) { c.moveTo(x, y); pen = true; } else c.lineTo(x, y);
      last = s.t;
    });
    c.stroke();
  }

  // ---- 節拍器與錄音 ----
  function sgClick(ctx, t, accent) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.08);
  }

  async function sgStart() {
    const err = $("sgErr");
    err.textContent = ""; $("sgInfo").textContent = "";
    if (sgRec) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { err.textContent = "這個瀏覽器不支援麥克風錄音（需要 https 網址）"; return; }
    const cfg = sgCfg();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { err.textContent = "無法使用麥克風：請在瀏覽器網址列允許麥克風權限"; return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state === "suspended") await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const beatSec = (60 / cfg.bpm) * (4 / cfg.beatType);
    const start = ctx.currentTime + 0.25;
    const t0 = start + cfg.countIn * cfg.beats * beatSec; // 第 1 小節開頭
    const rec = { ctx, stream, an, cfg, t0, start, beatSec, samples: [], nextBeat: 0, beatTimes: [], timers: [] };
    sgRec = rec;
    const buf = new Float32Array(an.fftSize);
    const lag = an.fftSize / 2 / ctx.sampleRate + (ctx.baseLatency || 0);
    // 節拍器排程（預看 0.2 秒）
    rec.timers.push(setInterval(() => {
      while (start + rec.nextBeat * beatSec < ctx.currentTime + 0.2) {
        const t = start + rec.nextBeat * beatSec;
        sgClick(ctx, t, rec.nextBeat % cfg.beats === 0);
        rec.beatTimes.push(t);
        rec.nextBeat++;
      }
    }, 25));
    // 音高取樣
    rec.timers.push(setInterval(() => {
      const now = ctx.currentTime;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      let midi = null, f = 0, cl = 0;
      if (rms > 0.012) {
        const p = sgPitch(buf, ctx.sampleRate);
        if (p && p.clarity >= 0.9 && p.f > 70 && p.f < 1100) { midi = sgMidi(p.f); f = p.f; cl = p.clarity; }
      }
      rec.samples.push({ t: now - lag, midi, rms });
      sgLive(rec, now, midi, rms, cl);
    }, 16));
    $("sgGo").hidden = true; $("sgStop").hidden = false;
    $("sgState").textContent = cfg.countIn ? "預備…" : "開始唱！";
  }

  function sgLive(rec, now, midi, rms, cl) {
    const el = (id) => $(id);
    const rel = now - rec.t0;
    const bi = Math.floor((now - rec.start) / rec.beatSec);
    if (bi >= 0) {
      const inBar = bi % rec.cfg.beats;
      const dots = el("sgDots").children;
      if (dots.length !== rec.cfg.beats) { el("sgDots").innerHTML = ""; for (let i = 0; i < rec.cfg.beats; i++) el("sgDots").appendChild(document.createElement("i")); }
      [...el("sgDots").children].forEach((d, i) => d.classList.toggle("on", i === inBar));
    }
    el("sgState").textContent = rel < 0 ? `預備… ${Math.ceil(-rel / rec.beatSec)}` : `錄音中 ${rel.toFixed(1)} 秒`;
    if (midi != null) {
      const r = Math.round(midi);
      el("sgNote").textContent = midiNoteName(r);
      const cents = Math.round((midi - r) * 100);
      el("sgSub").textContent = `簡譜 ${SG_JP[((r % 12) + 12) % 12]}　${cents > 0 ? "+" : ""}${cents} 音分`;
    } else { el("sgNote").textContent = "–"; el("sgSub").textContent = rms > 0.012 ? "音高不清楚" : "沒有聲音"; }
    el("sgLevel").style.width = Math.min(100, rms * 600) + "%";
    sgDrawLive(rec.samples, now - rec.cfg.lat / 1000);
  }

  function sgStop() {
    const rec = sgRec;
    if (!rec) return;
    sgRec = null;
    rec.timers.forEach(clearInterval);
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.ctx.close();
    $("sgGo").hidden = false; $("sgStop").hidden = true;
    [...$("sgDots").children].forEach((d) => d.classList.remove("on"));
    $("sgState").textContent = "轉換中…";
    sgLast = { samples: rec.samples, t0: rec.t0 };
    setTimeout(() => { sgConvert(); $("sgState").textContent = "完成"; $("sgAgain").disabled = false; }, 30);
  }

  (function sgInit() {
    // 調號選單：自動 + 大調 + 小調
    const names = { "-7": "C♭", "-6": "G♭", "-5": "D♭", "-4": "A♭", "-3": "E♭", "-2": "B♭", "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F♯", 7: "C♯" };
    const mn = { "-7": "A♭", "-6": "E♭", "-5": "B♭", "-4": "F", "-3": "C", "-2": "G", "-1": "D", 0: "A", 1: "E", 2: "B", 3: "F♯", 4: "C♯", 5: "G♯", 6: "D♯", 7: "A♯" };
    const sel = $("sgKey");
    const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
    add("auto", "自動偵測");
    for (let f = -7; f <= 7; f++) add(f + "M", `${names[f]} 大調`);
    for (let f = -7; f <= 7; f++) add(f + "m", `${mn[f]} 小調`);
    $("sgGo").addEventListener("click", sgStart);
    $("sgStop").addEventListener("click", sgStop);
    $("sgAgain").addEventListener("click", sgConvert);
    $("sgClick").addEventListener("click", async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const cfg = sgCfg(), bs = (60 / cfg.bpm) * (4 / cfg.beatType), t = ctx.currentTime + 0.1;
      for (let i = 0; i < cfg.beats * 2; i++) sgClick(ctx, t + i * bs, i % cfg.beats === 0);
      setTimeout(() => ctx.close(), (cfg.beats * 2 * bs + 0.5) * 1000);
    });
    window.__sg = { sgBuild, sgPitch, sgSegment };
  })();
