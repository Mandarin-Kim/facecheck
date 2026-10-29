
// Preserve real timestamps. Gaps are boundaries, never synthetic observations.
function pipeSegments(frames, valid=x=>x.ok!==false, maxGap=.5) {
 const out=[];let seg=[];
 for(const f of frames||[]){if(!f || !Number.isFinite(f.t) || !valid(f)){if(seg.length)out.push(seg);seg=[];continue;}
 if(seg.length && (f.t<=seg.at(-1).t || f.t-seg.at(-1).t>maxGap)){out.push(seg);seg=[];}seg.push(f);}
 if(seg.length)out.push(seg);return out;
}
function pipeSegmentStats(segs){const spans=segs.map(s=>s.length>1?s.at(-1).t-s[0].t:0),seconds=spans.reduce((a,b)=>a+b,0);return {seconds,longest:Math.max(0,...spans),segments:segs.length,fps:seconds>0?segs.reduce((n,s)=>n+Math.max(0,s.length-1),0)/seconds:0};}
function pipeCollect(clock,valid,t,maxGap=.5,settle=2){
 const dt=clock.last==null?0:t-clock.last;clock.last=t;
 if(!valid || dt<0 || dt>maxGap){clock.stableAt=null;clock.active=false;return false;}
 clock.stableAt ??= t;
 if(t-clock.stableAt<settle){clock.active=false;return false;}
 if(clock.active){clock.seconds=(clock.seconds||0)+dt;clock.run=(clock.run||0)+dt;}else clock.run=0;
 clock.active=true;clock.longest=Math.max(clock.longest||0,clock.run);return true;
}
function pipeEyeFraction(tr,closed){let total=0,shut=0;for(let i=1;i<tr.length;i++){const dt=tr[i].t-tr[i-1].t;if(dt>0&&dt<=.8){total+=dt;if(closed(tr[i-1]))shut+=dt;}}return total>0?shut/total:NaN;}
function pipeAnalyzeSegments(frames,analyze){
 const segs=pipeSegments(frames,f=>f.ok && !f.recoveryExcluded && !(f.motion>2.5)), stats=pipeSegmentStats(segs),results=[];
 for(const seg of segs){if(seg.length<2 || seg.at(-1).t-seg[0].t<8)continue;seg.tsSrc=frames.tsSrc;try{const r=analyze(seg);if(!r.error)results.push(r);}catch{}}
 if(!results.length)return {error:'유효한 연속 얼굴 영상이 부족해요. 좋은 구간은 보존했어요.',segments:stats};
 const rank=r=>[r.q>=2?1:0,r.prvOK?1:0,r.q||0,r.dur||0],better=(a,b)=>{const x=rank(a),y=rank(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]>y[i];return false;};
 const selected=results.reduce((a,b)=>better(b,a)?b:a),out={...selected,segments:stats};
 const rr=results.filter(r=>Number.isFinite(r.rr)).sort((a,b)=>b.dur-a.dur)[0];
 if(rr){out.rr=rr.rr;out.rrX=rr.rrX;out.rrSnr=rr.rrSnr;out.rrWhy=null;}
 out.segmentSources={hr:{start:selected.use?.[0]?.t,end:selected.use?.at(-1)?.t},rr:rr?{start:rr.use?.[0]?.t,end:rr.use?.at(-1)?.t}:null};return out;
}
const DSP = (() => {
  const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };
  const std = a => { const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return a.length ? Math.sqrt(s / a.length) : 0; };
  const median = a => { if (!a.length) return NaN; const b = Array.from(a).sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  function resample(ts, vals, fs) {
    const n = Math.floor((ts[ts.length - 1] - ts[0]) * fs) + 1, out = new Float64Array(Math.max(0, n));
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = ts[0] + i / fs;
      while (j < ts.length - 2 && ts[j + 1] < t) j++;
      const ta = ts[j], tb = ts[j + 1] ?? ta, va = vals[j], vb = vals[j + 1] ?? va;
      const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
      out[i] = va + (vb - va) * f;
    }
    return out;
  }
  function biquad(type, f, fs, Q = Math.SQRT1_2) {
    const w = 2 * Math.PI * f / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - al) / a0];
  }
  function filt(co, x) {
    const [b0, b1, b2, a1, a2] = co, y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const xi = x[i], yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi; }
    return y;
  }
  function bandpass(x, fs, lo, hi) {
    const n = x.length; if (n < 4) return new Float64Array(n);
    const m = mean(x), pad = Math.min(n - 1, Math.round(3 * fs));
    const ext = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) ext[i] = 2 * (x[0] - m) - (x[pad - i] - m);
    for (let i = 0; i < n; i++) ext[pad + i] = x[i] - m;
    for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * (x[n - 1] - m) - (x[n - 2 - i] - m);
    const cos = [biquad('hp', lo, fs), biquad('hp', lo, fs), biquad('lp', hi, fs), biquad('lp', hi, fs)];
    let y = ext;
    for (const co of cos) { y = filt(co, y); y = filt(co, y.slice().reverse()).reverse(); }
    return y.slice(pad, pad + n);
  }
  // Plane-Orthogonal-to-Skin (Wang et al., IEEE TBME 2017)
  function pos(R, G, B, fs) {
    const N = R.length, l = Math.max(2, Math.round(1.6 * fs)), H = new Float64Array(N);
    if (N < l) return H;
    const s1 = new Float64Array(l), s2 = new Float64Array(l);
    for (let n = 0; n + l <= N; n++) {
      let mr = 0, mg = 0, mb = 0;
      for (let k = 0; k < l; k++) { mr += R[n + k]; mg += G[n + k]; mb += B[n + k]; }
      mr /= l; mg /= l; mb /= l; if (!mr || !mg || !mb) continue;
      for (let k = 0; k < l; k++) { const r = R[n + k] / mr, g = G[n + k] / mg, b = B[n + k] / mb; s1[k] = g - b; s2[k] = g + b - 2 * r; }
      const a = std(s1) / (std(s2) || 1);
      let hm = 0; for (let k = 0; k < l; k++) hm += s1[k] + a * s2[k]; hm /= l;
      for (let k = 0; k < l; k++) H[n + k] += s1[k] + a * s2[k] - hm;
    }
    return H;
  }
  function spectrum(x, fs, lo, hi, step) {
    const n = x.length, w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, n - 1)));
    const fr = [], pw = [];
    for (let f = lo; f <= hi + 1e-9; f += step) {
      const d = 2 * Math.PI * f / fs; let re = 0, im = 0;
      for (let i = 0; i < n; i++) { re += w[i] * Math.cos(d * i); im -= w[i] * Math.sin(d * i); }
      fr.push(f); pw.push(re * re + im * im);
    }
    return { fr, pw };
  }
  function spectrumPeak(x, fs, lo, hi, step, bw) {
    const { fr, pw } = spectrum(x, fs, lo, hi, step);
    let best = -1, bf = lo; pw.forEach((p, j) => { if (p > best) { best = p; bf = fr[j]; } });
    let sig = 0, tot = 0;
    for (let j = 0; j < fr.length; j++) { tot += pw[j]; if (Math.abs(fr[j] - bf) <= bw || Math.abs(fr[j] - 2 * bf) <= bw) sig += pw[j]; }
    return { f: bf, snr: 10 * Math.log10(sig / Math.max(1e-12, tot - sig)) };
  }
  function findPeaks(x, fs, hr) {
    const minD = Math.max(2, Math.round(0.6 * fs * 60 / hr)), pk = [];
    for (let i = 1; i < x.length - 1; i++) {
      if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > 0) {
        if (pk.length && i - pk[pk.length - 1] < minD) { if (x[i] > x[pk[pk.length - 1]]) pk[pk.length - 1] = i; } else pk.push(i);
      }
    }
    return pk.map(i => { const a = x[i - 1], b = x[i], c = x[i + 1], den = a - 2 * b + c; const d = den ? 0.5 * (a - c) / den : 0; return { i, t: (i + Math.max(-0.5, Math.min(0.5, d))) / fs }; });
  }
  function ibis(peaks) {
    const out = []; for (let k = 1; k < peaks.length; k++) out.push({ t: peaks[k].t, ms: (peaks[k].t - peaks[k - 1].t) * 1000 });
    const med = median(out.map(o => o.ms));
    return out.map(o => ({ ...o, ok: o.ms > 300 && o.ms < 1500 && Math.abs(o.ms - med) < 0.2 * med }));
  }
  function hrv(peaks) {
    const ib = ibis(peaks), good = ib.filter(o => o.ok).map(o => o.ms), diffs = [];
    for (let k = 1; k < ib.length; k++) if (ib[k].ok && ib[k - 1].ok) diffs.push(ib[k].ms - ib[k - 1].ms);
    return { n: good.length, sdnn: good.length > 5 ? std(good) : NaN, rmssd: diffs.length > 5 ? Math.sqrt(mean(diffs.map(d => d * d))) : NaN };
  }
  function ita(r, g, b) {
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const R = lin(r), G = lin(g), B = lin(b);
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return Math.atan2(116 * f(Y) - 16 - 50, 200 * (f(Y) - f(Z))) * 180 / Math.PI;
  }
  // systolic upstroke is shorter than the decline: pick the polarity with the smaller rise/IBI ratio
  function riseRatio(x, fs, hr) {
    const one = sig => { const pk = findPeaks(sig, fs, hr), r = [];
      for (let k = 1; k < pk.length; k++) { const ibi = pk[k].i - pk[k - 1].i; let mi = pk[k].i, mv = Infinity;
        for (let j = Math.max(pk[k - 1].i, pk[k].i - Math.round(0.6 * ibi)); j < pk[k].i; j++) if (sig[j] < mv) { mv = sig[j]; mi = j; }
        if (ibi > 0) r.push((pk[k].i - mi) / ibi); }
      return median(r); };
    const a = one(x), b = one(Array.from(x, v => -v));
    return Math.min(isNaN(a) ? 1 : a, isNaN(b) ? 1 : b);
  }
  function lagMs(x, y, fs, maxS = 0.12) {
    const n = Math.min(x.length, y.length), sx = std(x) || 1, sy = std(y) || 1; let best = -Infinity, bl = 0;
    for (let l = -maxS; l <= maxS + 1e-9; l += 1 / 400) {
      const sh = l * fs; let s = 0, c = 0;
      for (let i = 0; i < n; i++) { const p = i + sh, j = Math.floor(p); if (j < 0 || j + 1 >= n) continue; const f = p - j; s += x[i] * (y[j] * (1 - f) + y[j + 1] * f); c++; }
      const r = c ? s / c / (sx * sy) : -1; if (r > best) { best = r; bl = l; }
    }
    return { ms: bl * 1000, r: best };
  }
  // amplitude of a sinusoid at frequency f fitted to (t, v) samples
  function sineAmp(ts, vs, f) {
    const m = mean(vs); let a = 0, b = 0;
    ts.forEach((t, i) => { a += (vs[i] - m) * Math.cos(2 * Math.PI * f * t); b += (vs[i] - m) * Math.sin(2 * Math.PI * f * t); });
    return 2 * Math.hypot(a, b) / ts.length;
  }
  return { mean, std, median, resample, bandpass, pos, spectrum, spectrumPeak, findPeaks, ibis, hrv, ita, riseRatio, lagMs, sineAmp };
})();

/* ===== Face localisation without an ML model =====
   skin mask -> largest central skin blob -> cut at the neck -> eye line from the darkest row band
   -> forehead / cheek regions placed relative to the eye line. */
const Face = (() => {
  function isSkin(r, g, b) {
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return r > 60 && r > g && r > b && r - Math.min(g, b) > 12 && cr > 133 && cr < 178 && cb > 77 && cb < 130;
  }
  function locate(d, W, H, prev) {
    const N = W * H, m = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const k = i * 4; m[i] = isSkin(d[k], d[k + 1], d[k + 2]) ? 1 : 0; }
    // connected components (4-neighbour), pick the blob with most pixels weighted by closeness to the expected face spot
    const lab = new Int32Array(N), stack = new Int32Array(N); let nl = 0, best = null;
    const ex = prev ? prev.cx : W / 2, ey = prev ? prev.cy : H * 0.4;
    for (let s = 0; s < N; s++) {
      if (!m[s] || lab[s]) continue;
      nl++; let sp = 0, cnt = 0, sx = 0, sy = 0; stack[sp++] = s; lab[s] = nl;
      while (sp) { const p = stack[--sp], x = p % W, y = (p - x) / W; cnt++; sx += x; sy += y;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = nl; stack[sp++] = p - 1; }
        if (x < W - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = nl; stack[sp++] = p + 1; }
        if (y > 0 && m[p - W] && !lab[p - W]) { lab[p - W] = nl; stack[sp++] = p - W; }
        if (y < H - 1 && m[p + W] && !lab[p + W]) { lab[p + W] = nl; stack[sp++] = p + W; } }
      if (cnt < N * 0.02) continue;
      const cx = sx / cnt, cy = sy / cnt, dist = Math.hypot((cx - ex) / W, (cy - ey) / H);
      const score = cnt * Math.exp(-dist * dist / 0.08);
      if (!best || score > best.score) best = { id: nl, score, cnt };
    }
    if (!best) return null;
    // per-row extent of the chosen blob
    const rows = []; let maxW = 0;
    for (let y = 0; y < H; y++) { let x0 = -1, x1 = -1, c = 0; for (let x = 0; x < W; x++) if (lab[y * W + x] === best.id) { if (x0 < 0) x0 = x; x1 = x; c++; } rows.push({ x0, x1, c }); }
    let top = rows.findIndex(r => r.c > 3); if (top < 0) return null;
    let fw = 0, bottom = H - 1;
    for (let y = top; y < H; y++) {
      const r = rows[y]; fw = Math.max(fw, r.c);
      if (y > top + 0.9 * fw && r.c < 0.62 * fw) { bottom = y; break; }
      if (y > top + 1.55 * fw) { bottom = y; break; }
    }
    // the first rows can be a thin hair-line; start where the blob is reasonably wide
    while (top < bottom && rows[top].c < 0.35 * fw) top++;
    const xs = []; for (let y = top; y < bottom; y++) if (rows[y].c) { xs.push(rows[y].x0, rows[y].x1); }
    xs.sort((a, b) => a - b);
    const x0 = xs[Math.floor(xs.length * 0.1)], x1 = xs[Math.floor(xs.length * 0.9)], w = x1 - x0, h = bottom - top;
    if (w < W * 0.12 || h < w * 0.7) return null;
    // eye line: darkest smoothed row band in the central strip of the upper face
    const lum = []; for (let y = top; y < bottom; y++) { let s = 0, c = 0; for (let x = Math.round(x0 + w * 0.15); x < x1 - w * 0.15; x++) { const k = (y * W + x) * 4; s += 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; c++; } lum.push(c ? s / c : 255); }
    let eye = top + Math.round(h * 0.38), bl = Infinity;
    for (let i = Math.round(h * 0.22); i < Math.round(h * 0.55); i++) { const v = (lum[i - 1] + 2 * lum[i] + lum[i + 1]) / 4; if (v < bl) { bl = v; eye = top + i; } }
    return { x: x0, y: top, w, h, eye, cx: (x0 + x1) / 2, cy: (top + bottom) / 2, lab, id: best.id };
  }
  function regions(f) {
    const brow = f.eye - 0.09 * f.h;
    const r = (fx0, fx1, y0, y1) => ({ x0: Math.round(f.x + f.w * fx0), x1: Math.round(f.x + f.w * fx1), y0: Math.round(y0), y1: Math.round(y1) });
    return {
      fh: [r(0.3, 0.7, f.y + (brow - f.y) * 0.25, brow - 0.03 * f.h)],
      ck: [r(0.14, 0.36, f.eye + 0.1 * f.h, f.eye + 0.27 * f.h), r(0.64, 0.86, f.eye + 0.1 * f.h, f.eye + 0.27 * f.h)],
      eye: r(0.18, 0.82, f.eye - 0.04 * f.h, f.eye + 0.04 * f.h),
    };
  }
  // one frame -> features
  function frameFeatures(d, W, H, state) {
    const f = locate(d, W, H, state.prev);
    if (!f) return { ok: false };
    const sm = state.box;
    const k = sm ? 0.35 : 1;
    state.box = sm ? { x: sm.x + (f.x - sm.x) * k, y: sm.y + (f.y - sm.y) * k, w: sm.w + (f.w - sm.w) * k, h: sm.h + (f.h - sm.h) * k, eye: sm.eye + (f.eye - sm.eye) * k } : { x: f.x, y: f.y, w: f.w, h: f.h, eye: f.eye };
    const motion = state.prev ? Math.hypot(f.cx - state.prev.cx, f.cy - state.prev.cy) / f.w * 100 : 0;
    state.prev = { cx: f.cx, cy: f.cy };
    const R = regions(state.box);
    const avg = list => { let r = 0, g = 0, b = 0, c = 0, cl = 0;
      for (const q of list) for (let y = Math.max(0, q.y0); y < Math.min(H, q.y1); y++) for (let x = Math.max(0, q.x0); x < Math.min(W, q.x1); x++) {
        const p = y * W + x; if (f.lab[p] !== f.id) continue; const k4 = p * 4; r += d[k4]; g += d[k4 + 1]; b += d[k4 + 2]; c++; if (d[k4] >= 250 || d[k4 + 1] >= 250 || d[k4 + 2] >= 250) cl++; }
      return c > 8 ? [r / c, g / c, b / c, c, cl] : null; };
    const fh = avg(R.fh), ck = avg(R.ck);
    if (!fh && !ck) return { ok: false };
    const parts = [fh, ck].filter(Boolean), tot = parts.reduce((s, p) => s + p[3], 0);
    const all = [0, 1, 2].map(c => parts.reduce((s, p) => s + p[c] * p[3], 0) / tot);
    let ey = 0, ec = 0; const e = R.eye;
    for (let y = Math.max(0, e.y0); y < Math.min(H, e.y1); y++) for (let x = Math.max(0, e.x0); x < Math.min(W, e.x1); x++) { const k4 = (y * W + x) * 4; ey += d[k4] + d[k4 + 1] + d[k4 + 2]; ec++; }
    return { ok: true, all, fh: (fh || ck).slice(0, 3), ck: (ck || fh).slice(0, 3), fhOK: !!fh, ckOK: !!ck, cy: f.cy / H, motion, eye: ec ? ey / ec / 3 : 0,
      lum: 0.299 * all[0] + 0.587 * all[1] + 0.114 * all[2], clip: parts.reduce((s2, q) => s2 + q[4], 0) / tot, box: { ...state.box }, R };
  }
  return { locate, regions, frameFeatures, isSkin };
})();

/* ===== Recording analysis ===== */
function pulseOf(frames, FS = 30) {
  const ts = frames.map(f => f.t);
  const [R, G, B] = [0, 1, 2].map(c => DSP.resample(ts, frames.map(f => f.all[c]), FS));
  return { R, G, B, p: DSP.bandpass(DSP.pos(R, G, B, FS), FS, 0.7, 3.2), FS };
}
function cleanFrames(F) {
  const n = F.length, bad = new Uint8Array(n);
  F.forEach((f, i) => { if (f.motion > 2.5) for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) bad[k] = 1; });
  // v3 깜빡임 (v2 신뢰성 검토 반영): 눈 부위 밝기의 흔들림 크기를 재서 문턱을 정하고(최소 7%), 내려갔다 돌아온 뒤에만 끝난 것으로 보며(히스테리시스),
  // 0.35초 안에 다시 시작한 것은 같은 깜빡임으로 봄(불응기) → 잡음으로 한 번을 두 번 세던 과대 계수를 막음
  const rel = new Float64Array(n);
  for (let i = 0; i < n; i++) { const md = DSP.median(F.slice(Math.max(0, i - 15), Math.min(n, i + 16)).map(f => f.eye)); rel[i] = (F[i].eye - md) / (md || 1); }
  const dd = []; for (let i = 1; i < n; i++) dd.push(rel[i] - rel[i - 1]);
  const dm = dd.length ? DSP.median(dd) : 0, noise = dd.length ? 1.4826 * DSP.median(dd.map(x => Math.abs(x - dm))) / Math.SQRT2 : 0;
  const th = Math.max(0.07, 4 * noise), up = Math.max(0.035, 2 * noise);
  let blinks = 0, inBlink = false, lastStart = -9;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(rel[i]);
    if (a > th) { if (!inBlink && !(F[i].t - lastStart < 0.35)) { blinks++; lastStart = F[i].t; } inBlink = true; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) bad[k] = 1; }
    else if (a < up) inBlink = false;
  }
  const keep = F.filter((_, i) => !bad[i]);
  return { use: keep.length > n * 0.6 ? keep : F, excl: bad.reduce((a, b) => a + b, 0), blinks };
}
// instantaneous heart rate track (sliding 8 s windows)
function hrTrack(frames, win = 8, step = 1) {
  const { p, FS } = pulseOf(frames), out = [], t0 = frames[0].t;
  for (let s = 0; s + win * FS <= p.length; s += step * FS) {
    const pk = DSP.spectrumPeak(p.slice(s, s + win * FS), FS, 0.7, 3.2, 0.02, 0.08);
    out.push({ t: t0 + (s / FS) + win / 2, hr: pk.f * 60, snr: pk.snr });
  }
  return out;
}
// 심박변이(스트레스)용 정밀 박동 시각.
// 이전 방식(30Hz 신호의 꼭대기)은 꼭대기가 넓고 평평해 작은 잡음에도 박동 시각이 ±50~80ms 흔들려 RMSSD가 2~3배 부풀었음
// (실제 40ms → 100ms 이상) → 기준(120ms 이하)을 넘어 '스트레스 측정 안 됨'이 자주 났고, 통과해도 스트레스가 낮게 나왔음.
// 새 방식: 원래 프레임 시각으로 120Hz 촘촘한 신호를 만들고, 심박 근처(±0.6Hz)만 남긴 뒤, 맥파가 가장 가파르게 올라가는 지점을 박동 시각으로 씀.
// 움직임 구간은 끊어서 따로 계산(끊긴 곳을 잇지 않음). 눈 깜빡임은 피부 색에 영향이 거의 없어 빼지 않음.
// 녹색 신호와 POS(색 조합) 중 이번 측정에서 맥이 더 또렷한 쪽을 씀.
function precisePeaks(F, hr) {
  if (!(hr > 35 && hr < 200) || F.length < 60) return [];
  const n = F.length, bad = new Uint8Array(n);
  F.forEach((f, i) => { if (f.motion > 2.5) for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) bad[k] = 1; });
  const segs = []; let cur = [];
  F.forEach((f, i) => { if (bad[i]) { if (cur.length) segs.push(cur); cur = []; return; } if (cur.length && f.t - cur[cur.length - 1].t > 0.35) { segs.push(cur); cur = []; } cur.push(f); });
  if (cur.length) segs.push(cur);
  const use = segs.filter(g => g[g.length - 1].t - g[0].t >= 5); if (!use.length) return [];
  const big = use.reduce((a, g) => g.length > a.length ? g : a), bts = big.map(f => f.t);
  const snrOf = x => DSP.spectrumPeak(DSP.bandpass(x, 30, 0.7, 3.2), 30, 0.7, 3.2, 0.01, 0.08).snr;
  const gSnr = snrOf(DSP.resample(bts, big.map(f => -f.all[1]), 30)), pSnr = snrOf(pulseOf(big, 30).p);
  const mode = pSnr > gSnr ? 'pos' : 'g', FS = 120, hz = hr / 60, out = [];
  for (const g of use) {
    const ts = g.map(f => f.t), sig = mode === 'pos' ? pulseOf(g, FS).p : DSP.resample(ts, g.map(f => -f.all[1]), FS);
    const bp = DSP.bandpass(sig, FS, Math.max(0.6, hz - 0.6), hz + 0.6), dv = bp.map((x, i) => i ? x - bp[i - 1] : 0);
    DSP.findPeaks(dv, FS, hr).forEach(x => out.push({ i: x.i, t: ts[0] + x.t }));
  }
  out.mode = mode; return out;
}
/* ===== v3: v2 신뢰성 검토에서 검증한 맥파 계산 (2026-10-20 검토, 합성 정답 데이터 1,500건+) =====
   v1의 측정 흐름은 그대로 두고, 값을 믿을 수 있는지 판단하는 객관적 기준으로만 덧붙임.
   ① 저심박(45~52bpm)을 2·3배로 읽던 고조파 오류 → 1/2·1/3 주파수 확인
   ② 박동 시각: 3차 보간 + 평균 박동 모양(템플릿) 정합 (한 점이 아닌 박동 전체 모양을 써서 잡음에 강함)
   ③ PRV(RMSSD): 이마·볼 두 영역의 박동 시각 차이로 잡음 크기를 직접 재서 빼고, 녹색·POS 두 방식이 30% 안으로 맞을 때만 인정
   ④ 장면 시각이 카메라 촬영 시각이 아니면(콜백 시각) PRV·리듬은 믿지 않음 */
const PV3 = (() => {
  function resampleCubic(ts, v, fs) {
    const n = Math.max(0, Math.floor((ts[ts.length - 1] - ts[0]) * fs) + 1), out = new Float64Array(n); let j = 0;
    for (let i = 0; i < n; i++) { const t = ts[0] + i / fs; while (j < ts.length - 2 && ts[j + 1] < t) j++;
      const t1 = ts[j], t2 = ts[j + 1] ?? t1, u = t2 > t1 ? Math.min(1, Math.max(0, (t - t1) / (t2 - t1))) : 0;
      const p0 = v[Math.max(0, j - 1)], p1 = v[j], p2 = v[Math.min(v.length - 1, j + 1)], p3 = v[Math.min(v.length - 1, j + 2)];
      out[i] = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u); }
    return out;
  }
  const parab = (a, b, c) => { const den = a - 2 * b + c; return den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0; };
  function segments(F) {
    const n = F.length, bad = new Uint8Array(n);
    F.forEach((f, i) => { if (f.motion > 2.5) for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) bad[k] = 1; });
    const segs = []; let cur = [];
    F.forEach((f, i) => { if (bad[i]) { if (cur.length) segs.push(cur); cur = []; return; } if (cur.length && f.t - cur[cur.length - 1].t > 0.35) { segs.push(cur); cur = []; } cur.push(f); });
    if (cur.length) segs.push(cur);
    return segs.filter(g => g[g.length - 1].t - g[0].t >= 5);
  }
  function chanSig(g, key, mode, FS) { const ts = g.map(f => f.t), ch = [0, 1, 2].map(c => resampleCubic(ts, g.map(f => f[key][c]), FS)); return mode === 'pos' ? DSP.pos(ch[0], ch[1], ch[2], FS) : ch[1].map(x => -x); }
  function beatTimes(segs, key, mode, hr) {
    const FS = 60, ibi = 60 / hr, L = Math.round(0.3 * ibi * FS), Rr = Math.round(0.5 * ibi * FS), W = Math.max(2, Math.round(Math.min(0.15, 0.2 * ibi) * FS));
    const per = segs.map((g, si) => { const bp = DSP.bandpass(chanSig(g, key, mode, FS), FS, 0.5, Math.min(4, 3 * hr / 60));
      return { si, t0: g[0].t, bp, pk: DSP.findPeaks(bp, FS, hr).map(p => p.i).filter(i => i - L - W >= 0 && i + Rr + W < bp.length) }; });
    const tpl = new Float64Array(L + Rr + 1); let n = 0;
    per.forEach(s => s.pk.forEach(i => { for (let k = -L; k <= Rr; k++) tpl[k + L] += s.bp[i + k]; n++; }));
    if (n < 8) return [];
    const tm = DSP.mean(tpl); for (let k = 0; k < tpl.length; k++) tpl[k] -= tm;
    const out = [];
    per.forEach(s => { let last = -Infinity;
      s.pk.forEach(i0 => { const cc = new Float64Array(2 * W + 1); let bj = 0;
        for (let j = 0; j <= 2 * W; j++) { const i = i0 + j - W; let v = 0; for (let k = -L; k <= Rr; k++) v += tpl[k + L] * s.bp[i + k]; cc[j] = v; if (v > cc[bj]) bj = j; }
        let off = bj - W; if (bj > 0 && bj < 2 * W) off += parab(cc[bj - 1], cc[bj], cc[bj + 1]);
        const t = s.t0 + (i0 + off) / FS; if (t - last < 0.5 * ibi) return; last = t; out.push({ t, seg: s.si }); }); });
    return out;
  }
  function ibiList(beats) {
    const out = []; for (let k = 1; k < beats.length; k++) if (beats[k].seg === beats[k - 1].seg) out.push({ k, t: beats[k].t, ms: (beats[k].t - beats[k - 1].t) * 1000 });
    const md = DSP.median(out.map(o => o.ms)); return out.map(o => ({ ...o, ok: o.ms > 300 && o.ms < 1700 && Math.abs(o.ms - md) < 0.2 * md }));
  }
  function roiJitter(a, b, ibi) {
    if (!a.length || !b.length) return null; const d = []; let j = 0;
    for (const x of a) { while (j < b.length - 1 && Math.abs(b[j + 1].t - x.t) < Math.abs(b[j].t - x.t)) j++; if (Math.abs(b[j].t - x.t) < 0.25 * ibi) d.push((x.t - b[j].t) * 1000); }
    if (d.length < 15) return null; const md = DSP.median(d); return 1.4826 * DSP.median(d.map(x => Math.abs(x - md)));
  }
  // F: 얼굴 장면 [{t, ok, all, fh, ck, motion}] → 심박·박동·PRV 판단
  function analyze(F, tsSrc) {
    const segs = segments(F); if (!segs.length) return null;
    const use = segs.flat(), FS = 30, ts = use.map(f => f.t), [R, G, B] = [0, 1, 2].map(c => DSP.resample(ts, use.map(f => f.all[c]), FS));
    const p = DSP.bandpass(DSP.pos(R, G, B, FS), FS, 0.5, 3.3), SP = DSP.spectrum(p, FS, 0.65, 3.2, 0.01);
    const powAt = f => { let m = 0; SP.fr.forEach((x, j) => { if (Math.abs(x - f) <= 0.05) m = Math.max(m, SP.pw[j]); }); return m; };
    const fPk = SP.fr[SP.pw.indexOf(Math.max(...SP.pw))]; let f0 = fPk;
    for (const dv of [3, 2]) { const fc = fPk / dv; if (fc >= 0.65 && powAt(fc) >= 0.3 * powAt(fPk)) { f0 = fc; break; } }
    let sig = 0, tot = 0; SP.fr.forEach((x, j) => { tot += SP.pw[j]; if (Math.abs(x - f0) <= 0.08 || Math.abs(x - 2 * f0) <= 0.08) sig += SP.pw[j]; });
    const snr = 10 * Math.log10(sig / Math.max(1e-12, tot - sig)), hrSpec = f0 * 60;
    const hasRoi = use.every(f => f.fhOK !== false && f.ckOK !== false && Array.isArray(f.fh) && Array.isArray(f.ck)) && use.some(f => f.fh[1] !== f.ck[1]);
    const one = md => { const beats = beatTimes(segs, 'all', md, hrSpec), ib = ibiList(beats), good = ib.filter(x => x.ok).map(x => x.ms), diffs = [];
      for (let k = 1; k < ib.length; k++) if (ib[k].ok && ib[k - 1].ok && ib[k].k === ib[k - 1].k + 1) diffs.push(ib[k].ms - ib[k - 1].ms);
      const raw = diffs.length > 5 ? Math.sqrt(DSP.mean(diffs.map(d => d * d))) : NaN;
      const sd = hasRoi ? roiJitter(beatTimes(segs, 'fh', md, hrSpec), beatTimes(segs, 'ck', md, hrSpec), 60 / hrSpec) : null;
      const nv = sd != null ? 1.5 * sd * sd : null, nf = nv != null && raw > 0 ? nv / raw ** 2 : null;
      return { md, beats, ib, good, raw, jitter: sd != null ? sd / 2 : null, nf, rmssd: nf != null ? Math.sqrt(Math.max(0, raw ** 2 - nv)) : NaN }; };
    const Pg = one('g'), Pp = one('pos'), M = Pg.jitter != null && Pp.jitter != null ? (Pp.jitter < Pg.jitter ? Pp : Pg) : (Pg.good.length >= Pp.good.length ? Pg : Pp);
    const hrIbi = M.good.length >= 5 ? 60000 / DSP.median(M.good) : NaN, okFrac = M.ib.length ? M.good.length / M.ib.length : 0;
    const allIb = M.ib.map(x => x.ms).filter(ms => ms > 300 && ms < 1700), m = DSP.mean(allIb), d2 = allIb.slice(1).map((x, i) => x - allIb[i]);
    const pBig = allIb.length >= 10 ? d2.filter(x => Math.abs(x) > 0.15 * m).length / d2.length : NaN;
    const both = [Pg, Pp].every(x => x.nf != null && isFinite(x.rmssd));
    const nfMax = both ? Math.max(Pg.nf, Pp.nf) : null, mdiff = both ? Math.abs(Pg.rmssd - Pp.rmssd) / Math.max(1e-6, (Pg.rmssd + Pp.rmssd) / 2) : null;
    const span = F.length > 1 ? F[F.length - 1].t - F[0].t : 0, fps = span > 0 ? F.length / span : 0, tsOK = tsSrc !== 'callback';
    const hrAgree = isFinite(hrIbi) && Math.abs(hrIbi - hrSpec) <= 5;
    // 판단 기준 (v2 신뢰성 검토 수치)
    const prvWhy = !tsOK ? 'timestamp' : !hasRoi ? 'roi' : nfMax == null ? 'beats' : pBig > 0.25 ? 'irregular' : nfMax > 0.15 ? 'noise' : mdiff > 0.3 ? 'method' : null;
    return { nGood: M.good.length, hrSpec, hrIbi, hr: hrAgree ? (hrSpec + hrIbi) / 2 : hrSpec, snr, harmonic: f0 !== fPk, hrAgree, okFrac, fps, tsSrc, beats: M.beats, mode: M.md,
      rmssdRaw: M.raw, rmssd: both ? (Pg.rmssd + Pp.rmssd) / 2 : NaN, rmssdG: Pg.rmssd, rmssdPos: Pp.rmssd, jitter: M.jitter, nf: nfMax, mdiff, pBig,
      prvOK: !prvWhy, prvWhy, rhythmOK: tsOK && fps >= 24 && nfMax != null && nfMax <= 0.15 };
  }
  // 5초 이상 끊김 없는 구간이 없을 때(움직임·처리 지연) 심박만이라도: 전체 장면으로 주파수 심박 + 고조파 확인
  function hrOnly(F) {
    const use = F.filter(f => !(f.motion > 2.5)); if (use.length < 120) return null;
    const FS = 30, ts = use.map(f => f.t), [R, G, B] = [0, 1, 2].map(c => DSP.resample(ts, use.map(f => f.all[c]), FS));
    const p = DSP.bandpass(DSP.pos(R, G, B, FS), FS, 0.5, 3.3), SP = DSP.spectrum(p, FS, 0.65, 3.2, 0.01);
    const powAt = f => { let m = 0; SP.fr.forEach((x, j) => { if (Math.abs(x - f) <= 0.05) m = Math.max(m, SP.pw[j]); }); return m; };
    const fPk = SP.fr[SP.pw.indexOf(Math.max(...SP.pw))]; let f0 = fPk;
    for (const dv of [3, 2]) { const fc = fPk / dv; if (fc >= 0.65 && powAt(fc) >= 0.3 * powAt(fPk)) { f0 = fc; break; } }
    let sig = 0, tot = 0; SP.fr.forEach((x, j) => { tot += SP.pw[j]; if (Math.abs(x - f0) <= 0.08 || Math.abs(x - 2 * f0) <= 0.08) sig += SP.pw[j]; });
    return { hr: f0 * 60, snr: 10 * Math.log10(sig / Math.max(1e-12, tot - sig)), harmonic: f0 !== fPk };
  }
  return { analyze, hrOnly, resampleCubic, beatTimes, roiJitter };
})();
/* v3.1 호흡수: 네 가지 호흡 신호를 함께 보고, 2개 이상이 분당 2회 폭 안에서 맞을 때만 인정
   ① 얼굴 위아래 움직임 ② 피부 밝기 출렁임(RIIV) ③ 숨 쉴 때 박동 간격이 빨라졌다 느려지는 정도(RIFV) ④ 맥파 크기 출렁임(RIAV)
   근거: Karlen 외 (IEEE TBME 2013) 여러 호흡 신호 융합 · Charlton 외 (Physiol Meas 2016) 호흡수 추정 방법 비교.
   허용폭·범위는 FaceHeart 호흡수 FDA 허가(K243966: 60초 · 분당 5~36회 · ±2회)와 맞춤. 40초 이상일 때만 분당 5회까지 봄(짧으면 숨이 너무 적게 잡힘) */
const RRF = (() => {
  const TOL = 2;
  // 합격 기준은 기록 길이별로 합성 정답 시험(tests/v31_rr.js)에서 '분당 2회 넘게 틀린 값이 0건'이 되도록 정함.
  // 20초는 숨이 4~7번뿐이라 잡음 봉우리와 진짜 호흡을 거의 구분 못 함 → 세 신호가 강하게 맞을 때만. 60초는 두 신호로 충분 (FaceHeart도 60초)
  const RULE = d => d >= 55 ? { snr: 0, need: 2 } : d >= 40 ? { snr: 2, need: 2 } : { snr: 6, need: 3 };
  function est(ts, vals, fs, lo, hi) {
    if (ts.length < 8 || ts[ts.length - 1] - ts[0] < 12) return null;
    const x = DSP.bandpass(DSP.resample(ts, vals, fs), fs, lo, hi);
    const st = 0.0025, span = ts[ts.length - 1] - ts[0], pk = DSP.spectrumPeak(x, fs, lo, hi, st, Math.max(0.02, 1 / span));   // 봉우리 폭은 기록 길이에 반비례 → 짧은 기록도 같은 기준으로 비교
    const edge = pk.f <= lo + 2 * st || pk.f >= hi - 2 * st;   // 띠 가장자리 봉우리 = 느린 표류·잡음
    return { rr: +(pk.f * 60).toFixed(2), snr: +pk.snr.toFixed(2), edge };
  }
  function estimate(use, peaks, p, FS, dur) {
    const lo = dur >= 40 ? 5 / 60 : 0.1, hi = 0.6, ts = use.map(f => f.t), src = {};
    src.motion = est(ts, use.map(f => f.cy), 10, lo, hi);
    src.riiv = est(ts, use.map(f => f.all[1]), 10, lo, hi);
    if (peaks && peaks.length >= 12) {
      const ib = DSP.ibis(peaks), okb = ib.filter(o => o.ok);
      if (okb.length >= 10) src.rifv = est(okb.map(o => o.t), okb.map(o => 60000 / o.ms), 4, lo, hi);
      const am = []; for (let k = 1; k < peaks.length; k++) { if (!ib[k - 1]?.ok) continue; const a = peaks[k - 1].i, b = peaks[k].i; if (!(a >= 0 && b < p.length && b > a)) continue; let mn = Infinity; for (let j = a; j <= b; j++) if (p[j] < mn) mn = p[j]; am.push({ t: peaks[k].t, v: p[b] - mn }); }
      if (am.length >= 10) { const md = DSP.median(am.map(x => x.v)), mad = 1.4826 * DSP.median(am.map(x => Math.abs(x.v - md))) || 1e-9; const cl = am.filter(x => Math.abs(x.v - md) <= 3 * mad); if (cl.length >= 10) src.riav = est(cl.map(x => x.t), cl.map(x => x.v), 4, lo, hi); }
    }
    const rule = RULE(dur), c = Object.entries(src).filter(([, v]) => v && !v.edge && v.snr >= rule.snr).map(([k, v]) => ({ k, ...v })).sort((a, b) => a.rr - b.rr);
    let best = null;
    for (let i = 0; i < c.length; i++) { const m = c.filter(x => x.rr >= c[i].rr && x.rr - c[i].rr <= TOL), s = m.reduce((a, x) => a + x.snr, 0); if (!best || m.length > best.m.length || (m.length === best.m.length && s > best.s)) best = { m, s }; }
    const agree = best && best.m.length >= rule.need ? best.m : null;
    return { rr: agree ? +DSP.median(agree.map(x => x.rr)).toFixed(1) : NaN, snr: agree ? Math.max(...agree.map(x => x.snr)) : -99, n: agree ? agree.length : 0, used: agree ? agree.map(x => x.k) : [], src, lo: +(lo * 60).toFixed(1), rule };
  }
  return { estimate, TOL };
})();
/* v3.2 밤새 소리로 보는 수면 중 숨 멈춤 (선별용 · 진단 아님)
   AASM 판독 규칙: 무호흡 = 숨(기류)이 90% 이상 줄어든 상태가 10초 이상. 수면무호흡 정도는 시간당 횟수(AHI) 5·15·30 기준.
   휴대폰 마이크는 기류·호흡 노력·산소포화도를 못 재므로 AHI가 아니라 '코골이 중 10초 이상 소리가 끊겼다가 크게 다시 시작한 횟수'를 셈.
   저호흡(숨이 30% 줄어듦)은 소리로 못 잡아 실제보다 적게 나올 수 있음 → 낮게 나와도 '없다'고 하지 않음.
   입력: 0.25초마다 소리 크기(dB)와 낮은 음(800Hz 아래) 크기. 소리 자체는 저장하지 않음 */
const SLEEPA = (() => {
  const FS = 4;
  const pct = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const med = a => pct(a, 0.5);
  // 방 소음 바닥: 30초 구간의 하위 10% 값 → 앞뒤 2분의 중앙값 (선풍기·에어컨처럼 천천히 바뀌는 소음은 따라감)
  function floorOf(db) {
    const B = 30 * FS, nb = Math.ceil(db.length / B), bp = [];
    for (let b = 0; b < nb; b++) bp.push(pct(Array.from(db.slice(b * B, (b + 1) * B)), 0.1));
    const out = new Float32Array(db.length);
    for (let b = 0; b < nb; b++) { const w = []; for (let k = b - 2; k <= b + 2; k++) if (k >= 0 && k < nb && isFinite(bp[k])) w.push(bp[k]); const v = w.length ? med(w) : NaN; for (let i = b * B; i < Math.min(db.length, (b + 1) * B); i++) out[i] = v; }
    return out;
  }
  function bursts(db, lo, fl) {
    const out = []; let s = -1, off = 0;
    const close = e => { const n = e - s; if (n >= 1) { let pk = -99, lr = 0, c = 0; for (let i = s; i < e; i++) { const a = db[i] - fl[i]; if (a > pk) pk = a; if (isFinite(lo[i])) { lr += lo[i] - db[i]; c++; } } out.push({ s, e, dur: n / FS, pk, lr: c ? lr / c : 0 }); } s = -1; off = 0; };
    for (let i = 0; i < db.length; i++) {
      const on = isFinite(db[i]) && db[i] - fl[i] >= 6;
      if (on) { if (s < 0) s = i; off = 0; }
      else if (s >= 0) { if (!isFinite(db[i])) close(i); else if (++off >= 2) close(i - off + 1); }
    }
    if (s >= 0) close(db.length);
    for (const b of out) b.kind = b.dur > 6 ? 'noise' : b.lr < -10 ? 'noise' : b.pk >= 12 && b.dur >= 0.3 && b.dur <= 4 ? 'snore' : b.dur >= 0.3 && b.dur <= 4 ? 'breath' : 'noise';
    return out;
  }
  function analyze(db, lo, opt = {}) {
    const n = db.length, valid = db.reduce((a, x) => a + (isFinite(x) ? 1 : 0), 0), validH = valid / FS / 3600;
    const fl = floorOf(db), B = bursts(db, lo, fl), sn = B.filter(b => b.kind === 'snore'), snPk = sn.length ? med(sn.map(b => b.pk)) : NaN;
    // 코골이 분: 1분에 코골이 소리 6번 이상
    const nMin = Math.ceil(n / (60 * FS)), snPerMin = new Uint16Array(nMin), vMin = new Uint16Array(nMin);
    for (const b of sn) snPerMin[Math.floor(b.s / (60 * FS))]++;
    for (let i = 0; i < n; i++) if (isFinite(db[i])) vMin[Math.floor(i / (60 * FS))]++;
    let snoreMin = 0, validMin = 0; for (let m = 0; m < nMin; m++) { if (vMin[m] >= 50 * FS) { validMin++; if (snPerMin[m] >= 6) snoreMin++; } }
    // 숨 멈춤 의심: 리듬 있는 코골이(앞 40초에 코골이 3번 이상, 간격 2~10초) → 10~90초 조용 → 평소 코골이보다 3dB 이상 큰 소리나 연달은 코골이로 다시 시작 → 30초 안에 코골이 2번 이상 이어짐
    const ev = [];
    for (let k = 0; k + 1 < B.length; k++) {
      const a = B[k], b = B[k + 1], gap = (b.s - a.e) / FS;
      const why = r => { if (opt.dbg) opt.dbg.push({ t: b.s / FS, gap, r, ak: a.kind, bk: b.kind }); };
      if (gap < 10) continue; if (gap > 90 || a.dur > 6 || b.dur > 6) { why('kind/long'); continue; }
      let gapOK = true; for (let i = a.e; i < b.s; i++) if (!isFinite(db[i])) { gapOK = false; break; } if (!gapOK) { why('invalid'); continue; }
      // 앞 40초: 숨소리·코골이가 리듬 있게(간격 2~10초) 3번 이상, 그중 코골이 1번 이상 (뒤척임 소리는 빼고 봄)
      const before = B.slice(Math.max(0, k - 14), k + 1).filter(x => x.kind !== 'noise' && x.e > a.e - 40 * FS);
      const iv = []; for (let j = 1; j < before.length; j++) iv.push((before[j].s - before[j - 1].s) / FS);
      if (before.length < 3 || !before.some(x => x.kind === 'snore') || iv.filter(x => x >= 2 && x <= 10).length < before.length - 2) { why('ctx'); continue; }
      // 다시 시작: 바로 앞 숨소리들보다 3dB 이상 큰 소리(헐떡임·몸 움직임 포함), 또는 3초 안에 연달은 소리 → 30초 안에 숨소리·코골이 2번 이상 이어짐
      const after = B.slice(k + 1, k + 14).filter(x => x.s < b.s + 30 * FS), afterBr = after.filter(x => x.kind !== 'noise');
      const ref = med(before.slice(-4).map(x => x.pk));
      const loud = b.pk >= ref + 3 || (after[1] && (after[1].s - b.e) / FS <= 3);
      if (!loud || afterBr.length < 2 || !afterBr.some(x => x.kind === 'snore')) { why(!loud ? 'quiet' : 'after'); continue; }
      ev.push({ t: +(a.e / FS).toFixed(1), len: +gap.toFixed(1) });
    }
    const idx = validH > 0 ? ev.length / validH : NaN, snorePct = validMin ? snoreMin / validMin : 0;
    const bins = []; for (let s0 = 0; s0 < n; s0 += 600 * FS) { const m0 = Math.floor(s0 / (60 * FS)); let sm = 0, vm = 0; for (let m = m0; m < Math.min(nMin, m0 + 10); m++) if (vMin[m] >= 50 * FS) { vm++; if (snPerMin[m] >= 6) sm++; } bins.push({ s: vm ? +(sm / vm).toFixed(2) : null, e: ev.filter(x => x.t * FS >= s0 && x.t * FS < s0 + 600 * FS).length }); }
    let why = null; if (validH < 4) why = 'short'; if (!snoreMin && !ev.length) why = why || 'nosnore'; if (validMin > 30 && B.filter(b => b.kind === 'noise').length / (valid / FS / 3600) > 120) why = why || 'noisy';
    const tier = !isFinite(idx) ? 'na' : idx >= 15 ? 'check' : idx >= 5 ? 'watch' : why === 'nosnore' ? 'na' : 'ok';
    return { validH: +validH.toFixed(2), snorePct: +snorePct.toFixed(3), events: ev.length, idx: isFinite(idx) ? +idx.toFixed(1) : null, tier, why, longest: ev.length ? Math.max(...ev.map(x => x.len)) : null,
      nSnore: sn.length, nNoise: B.filter(b => b.kind === 'noise').length, snPk: isFinite(snPk) ? +snPk.toFixed(1) : null, bins, ev: opt.keepEv ? ev : ev.slice(0, 300) };
  }
  return { analyze, FS };
})();
function analyzeBasic(frames) { return pipeAnalyzeSegments(frames, analyzeBasicContinuous); }
function analyzeBasicContinuous(frames) {
  const F = frames.filter(f => f.ok);
  if (!frames.tsSrc) { const c = {}; F.forEach(f => { if (f.tsrc) c[f.tsrc] = (c[f.tsrc] || 0) + 1; }); const k = Object.keys(c).sort((a, b) => c[b] - c[a])[0]; if (k) frames.tsSrc = k; }
  const span = F.length > 1 ? F[F.length - 1].t - F[0].t : 0;
  if (span < 8 || F.length / span < 8) return { error: span < 8 ? '얼굴이 8초 이상 잡히지 않았어요. 얼굴이 화면 가운데에 크게 오도록 하고 다시 측정해 주세요.' : '카메라 프레임이 너무 적게 들어왔어요(초당 8장 미만). 다른 앱을 닫고 다시 해 주세요.' };
  const { use, excl, blinks } = cleanFrames(F);
  const { R, G, B, p, FS } = pulseOf(use);
  const dur = use[use.length - 1].t - use[0].t;
  const pk = DSP.spectrumPeak(p, FS, 0.7, 3.2, 0.01, 0.08);
  let hr = pk.f * 60, snr = pk.snr;
  // v3: 고조파 확인·템플릿 박동·PRV 잡음 검사 (PV3). 기존 계산은 비교용으로 남김
  let P3 = null; try { P3 = PV3.analyze(F, frames.tsSrc); } catch (e) { P3 = null; }
  let H0 = null;
  if (P3) { hr = P3.hr; snr = P3.snr; }
  else { try { H0 = PV3.hrOnly(F); } catch (e) { H0 = null; } if (H0) { hr = H0.hr; snr = H0.snr; } }
  const pp = P3 && P3.beats.length >= 8 ? Object.assign(P3.beats.map(b => ({ t: b.t, i: Math.max(0, Math.min(p.length - 1, Math.round((b.t - use[0].t) * FS))) })), { mode: 'tpl-' + P3.mode }) : precisePeaks(F, hr);
  const peaks = pp.length >= 8 ? pp : DSP.findPeaks(p, FS, hr), v = DSP.hrv(peaks);
  const rmssdLegacy = v.rmssd;
  // PRV는 v2 기준(잡음이 변동의 15% 이하 · 두 방식 30% 이내 · 촬영 시각 정확 · 규칙 맥박)을 통과할 때만 인정
  if (P3) { v.rmssd = P3.prvOK ? P3.rmssd : NaN; v.n = P3.nGood; } else v.rmssd = NaN;
  let stress = NaN;
  if (dur >= 14 && !isNaN(v.rmssd) && v.rmssd > 5 && v.rmssd < 150) stress = Math.max(0, Math.min(100, Math.round(100 * (4.5 - Math.log(v.rmssd)) / 2)));
  let rr = NaN, rrSnr = -99, rrX = null;
  if (dur >= 14) { rrX = RRF.estimate(use, peaks, p, FS, dur); rr = rrX.rr; rrSnr = rrX.snr; }
  const rt = DSP.riseRatio(DSP.bandpass(DSP.pos(R, G, B, FS), FS, 0.5, 8), FS, hr);
  const ts2 = use.map(f => f.t);
  const pf = DSP.bandpass(DSP.pos(...[0, 1, 2].map(c => DSP.resample(ts2, use.map(f => f.fh[c]), FS)), FS), FS, 0.7, 3.2);
  const pc = DSP.bandpass(DSP.pos(...[0, 1, 2].map(c => DSP.resample(ts2, use.map(f => f.ck[c]), FS)), FS), FS, 0.7, 3.2);
  const lag = DSP.lagMs(pf, pc, FS);
  const acR = DSP.std(DSP.bandpass(R, FS, 0.7, 3.2)), acB = DSP.std(DSP.bandpass(B, FS, 0.7, 3.2));
  const ror = (acR / DSP.mean(R)) / ((acB / DSP.mean(B)) || 1e-9);
  // research-only pulse-shape / colour-ratio features (blood pressure & SpO2 pilot calibration; never shown to customers)
  const acG = DSP.std(DSP.bandpass(G, FS, 0.7, 3.2)), piR = 100 * acR / DSP.mean(R), piG = 100 * acG / DSP.mean(G), piB = 100 * acB / DSP.mean(B);
  const amps = []; for (let k = 1; k < peaks.length; k++) { let mn = Infinity; for (let j = peaks[k - 1].i; j < peaks[k].i; j++) if (p[j] < mn) mn = p[j]; if (isFinite(mn)) amps.push(p[peaks[k].i] - mn); }
  const ampCV = amps.length >= 5 ? DSP.std(amps) / (DSP.mean(amps) || 1) : NaN;
  const track = dur >= 12 ? hrTrack(use) : [];
  const spread = track.length > 2 ? DSP.std(track.map(x => x.hr)) : NaN;
  const lum = DSP.mean(use.map(f => f.lum)), mot = DSP.median(F.map(f => f.motion));
  // v3.1 촬영 조건: FaceHeart FDA 허가(K223622·K243966) 사용 조건을 참고 — 얼굴 100×100화소 이상 · 초당 15~30장 · 밝은 곳(300lux 이상) · 가만히.
  // 휴대폰 웹에서는 lux를 직접 못 재므로 피부 밝기(너무 어둡거나 밝음)와 빛 포화(하얗게 날아간 피부 화소 비율)로 대신 판단
  const fpxL = use.map(f => f.fpx).filter(x => x > 0), fpx = fpxL.length ? DSP.median(fpxL) : NaN, clip = DSP.mean(use.map(f => f.clip || 0)), fpsE = F.length / span;
  const condWhy = []; if (fpx < 100) condWhy.push('small'); if (clip > 0.05) condWhy.push('glare'); if (lum < 70) condWhy.push('dark'); if (lum > 225) condWhy.push('bright'); if (fpsE < 13.5) condWhy.push('fps');   // 초당 15장 기준에서 장면 누락 10%까지 허용
  const itaDeg = DSP.ita(DSP.mean(R), DSP.mean(G), DSP.mean(B));
  let q = 0;
  if (snr > -1) q++; if (snr > 2.5) q++;
  if (lum > 70 && lum < 225) q++;
  if (dur >= 25) q++;
  if (!isNaN(spread) && spread < 6) q++;
  // v3: 두 심박 계산(주파수·박동 간격)이 5bpm 안으로 맞지 않거나 박동의 70% 미만만 고르면 심박을 믿지 않음 (품질 1로 낮춤 → 심박 '측정 안 됨')
  // 박동 간격으로 다시 센 심박이 주파수 심박과 5bpm 넘게 다르거나 박동의 70% 미만만 고르면 심박을 믿지 않음.
  // 5초 이상 끊김 없는 구간이 없으면(P3 없음) 박동 검증은 못 하므로 주파수 심박(고조파 확인)만 쓰고 품질을 1단계 낮춤
  if (P3 && (!P3.hrAgree || P3.okFrac < 0.7)) q = Math.min(q, 1);
  if (!P3) q = Math.max(0, Math.min(q, H0 ? q - 1 : 1));
  if (condWhy.includes('small')) q = Math.min(q, 1);              // 얼굴이 100화소보다 작게 찍힘 → 심박을 믿지 않음
  if (condWhy.includes('glare') || condWhy.includes('fps')) q = Math.max(0, q - 1);
  const r3 = x => x != null && isFinite(x) ? +(+x).toFixed(4) : null;
  const pfx = { piR: r3(piR), piG: r3(piG), piB: r3(piB), rorRB: r3(ror), rorRG: r3(piR / (piG || 1e-9)), rise: r3(rt), ptt: r3(lag.ms), pttR: r3(lag.r), ampCV: r3(ampCV), lum: r3(lum), ita: r3(itaDeg) };
  const p3 = P3 ? { hrSpec: r3(P3.hrSpec), hrIbi: r3(P3.hrIbi), harmonic: P3.harmonic, hrAgree: P3.hrAgree, okFrac: r3(P3.okFrac), fps: r3(P3.fps), tsSrc: P3.tsSrc || null,
    rmssdRaw: r3(P3.rmssdRaw), rmssdG: r3(P3.rmssdG), rmssdPos: r3(P3.rmssdPos), jitter: r3(P3.jitter), nf: r3(P3.nf), mdiff: r3(P3.mdiff), pBig: r3(P3.pBig), prvWhy: P3.prvWhy, rmssdLegacy: r3(rmssdLegacy), ver: 'pv3-1.0' } : H0 ? { hrOnly: true, hrSpec: r3(H0.hr), harmonic: H0.harmonic, ver: 'pv3-1.0' } : null;
  return { pfx, p3, prvOK: P3 ? P3.prvOK : false, prvWhy: P3 ? P3.prvWhy : 'segment', rhythmOK: P3 ? P3.rhythmOK : false, tsSrc: frames.tsSrc || null,
    hr, snr, beats: v.n, sdnn: v.sdnn, rmssd: v.rmssd, stress, rr, rrSnr, rrX, rrWhy: Number.isFinite(rr) ? null : dur < 40 ? 'short' : 'agree', cond: { fpx: isFinite(fpx) ? fpx : null, clip: +clip.toFixed(4), fps: +fpsE.toFixed(1), lum: +lum.toFixed(1), why: condWhy }, hrInRange: hr >= 50 && hr <= 180, dur, ror, rt, ptt: lag.ms, pttR: lag.r, lum, mot, blinks,
    blinkRate: dur > 0 ? blinks / dur * 60 : NaN, excl, n: F.length, ita: itaDeg, q, spread, track, peaks, peakMode: peaks.mode || 'old', use };
}
// paced breathing: how much the heart rate swings with each breath (respiratory sinus arrhythmia)
function analyzeBreath(frames) {
  const r = analyzeBasic(frames); if (r.error) return r;
  if (r.dur < 40) return { ...r, error: '호흡 리듬 테스트는 40초 이상 필요해요. 60초 동안 촬영해 주세요.' };
  const ib = DSP.ibis(r.peaks).filter(o => o.ok);
  const f = r.rr >= 4 && r.rr <= 9 ? r.rr / 60 : 0.1;
  const amp = ib.length > 20 ? DSP.sineAmp(ib.map(o => o.t), ib.map(o => 60000 / o.ms), f) : NaN;
  return { ...r, rsa: 2 * amp, paced: r.rr >= 4.5 && r.rr <= 7.5, ibN: ib.length };
}
// breath hold: hold window from taps (live) or from the two spoken cues (video audio)
function analyzeHold(frames, holdStart, holdEnd) {
  const F = frames.filter(f => f.ok);
  if (F.length < 30 * 15) return { error: '얼굴이 충분히 잡히지 않았어요.' };
  if (!(holdEnd > holdStart)) return { error: '숨 참기 시작과 끝을 찾지 못했어요. "시작"과 "끝"을 또렷하게 말해 주세요.' };
  const tr = hrTrack(cleanFrames(F).use, 6, 1);
  const avg = (a, b) => { const v = tr.filter(x => x.t >= a && x.t <= b).map(x => x.hr); return v.length ? DSP.mean(v) : NaN; };
  return { hold: holdEnd - holdStart, hrStart: avg(holdStart + 3, holdStart + 8), hrEnd: avg(holdEnd - 8, holdEnd - 3), hrAfter: avg(holdEnd + 4, holdEnd + 12), track: tr };
}
function analyzeRecovery(frames) {
  const F = frames.filter(f => f.ok);
  if (F.length < 30 * 30) return { error: '30초 이상 얼굴이 잡혀야 해요. 운동 직후 60초 동안 촬영해 주세요.' };
  const tr = hrTrack(cleanFrames(F).use, 8, 1);
  const first = DSP.mean(tr.slice(0, 3).map(x => x.hr)), last = DSP.mean(tr.slice(-3).map(x => x.hr));
  const span = tr[tr.length - 1].t - tr[0].t;
  return { hr0: first, hr1: last, span, perMin: (first - last) * 60 / Math.max(20, span), track: tr };
}

/* ===== Audio (voice tasks) ===== */
const Voice = (() => {
  // RMS envelope in 20 ms frames, then voiced segments above an adaptive threshold
  function envelope(samples, sr) {
    const hop = Math.round(sr * 0.02), env = [];
    for (let i = 0; i + hop <= samples.length; i += hop) { let s = 0; for (let k = 0; k < hop; k++) s += samples[i + k] ** 2; env.push(Math.sqrt(s / hop)); }
    return { env, dt: 0.02 };
  }
  function segments(env, dt, gapMax = 0.25, minLen = 0.15) {
    const sorted = Array.from(env).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)] || 0, peak = sorted[Math.floor(sorted.length * 0.98)] || 0;
    const th = floor + (peak - floor) * 0.18;
    const segs = []; let st = -1, last = -1;
    env.forEach((v, i) => { if (v > th) { if (st < 0) st = i; last = i; } else if (st >= 0 && (i - last) * dt > gapMax) { segs.push([st * dt, (last + 1) * dt]); st = -1; } });
    if (st >= 0) segs.push([st * dt, (last + 1) * dt]);
    return { segs: segs.filter(s => s[1] - s[0] >= minLen), th, floor, peak, snrDb: 20 * Math.log10((peak || 1e-9) / (floor || 1e-9)) };
  }
  function syllablePeaks(env, dt, a, b, th) {
    // count energy bumps (syllable nuclei) inside [a,b]
    const i0 = Math.floor(a / dt), i1 = Math.ceil(b / dt), sm = [];
    for (let i = i0; i < i1; i++) sm.push(((env[i - 1] || 0) + 2 * (env[i] || 0) + (env[i + 1] || 0)) / 4);
    let c = 0, lastPk = -99;
    for (let i = 1; i < sm.length - 1; i++) if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] > th && (i - lastPk) * dt > 0.09) { c++; lastPk = i; }
    return c;
  }
  // sustained "아~" (maximum phonation time) followed by reading a fixed sentence
  function analyzeVoice(env, dt, syllables, splitAt) {
    const S = segments(env, dt);
    if (!S.segs.length || S.snrDb < 10) return { error: '목소리를 찾지 못했어요. 조용한 곳에서 휴대폰 가까이 대고 다시 녹음해 주세요.' };
    const pool = splitAt != null ? S.segs.filter(s => s[0] < splitAt) : S.segs;
    const ah = pool.reduce((a, s) => (!a || s[1] - s[0] > a[1] - a[0] ? s : a), null);
    const mpt = ah ? ah[1] - ah[0] : NaN;
    let stab = NaN;
    if (ah && mpt > 2) { const i0 = Math.floor((ah[0] + mpt * 0.2) / dt), i1 = Math.floor((ah[1] - mpt * 0.2) / dt), v = env.slice(i0, i1); stab = Math.max(0, Math.min(100, 100 * (1 - DSP.std(v) / (DSP.mean(v) || 1)))); }
    const after = S.segs.filter(s => s[0] >= Math.max(ah ? ah[1] + 0.3 : 0, splitAt ?? 0));
    let rate = NaN, span = NaN, pauses = 0;
    if (after.length) {
      span = after[after.length - 1][1] - after[0][0];
      for (let k = 1; k < after.length; k++) if (after[k][0] - after[k - 1][1] > 0.35) pauses++;
      if (span > 2) rate = syllables / span;
    }
    return { mpt, stab, rate, span, pauses, snrDb: S.snrDb, segs: S.segs };
  }
  return { envelope, segments, syllablePeaks, analyzeVoice };
})();



const FG_MIN_HR=20,FG_MIN_HRV=40,FG_MIN_AC=.3;
const Phi = z => { const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return z >= 0 ? (1 + e) / 2 : (1 - e) / 2; };
const NORMS = {
  // NHANES 1999–2008 resting pulse, people without conditions/medication affecting pulse: [age from, p5, p50, p95]
  hr(age, sex) {
    const M = [[20, 52, 69, 89], [40, 52, 68, 90], [60, 50, 67, 91], [80, 51, 68, 94]], W = [[20, 57, 74, 95], [40, 56, 71, 92], [60, 56, 70, 92], [80, 56, 71, 93]];
    const T = sex === '남성' ? M : sex === '여성' ? W : M.map((m, i) => m.map((v, k) => k ? (v + W[i][k]) / 2 : v));
    const row = [...T].reverse().find(r => age >= r[0]) || T[0];
    return { p5: row[1], p50: row[2], p95: row[3], label: `${sex || '성인'} ${row[0]}${row[0] < 80 ? '~' + (row[0] + 19) : '+'}세` };
  },
  // heart-rate-corrected RMSSD (ms): [median, 2nd, 98th percentile] by decade
  rmssdc(age, sex) {
    const M = { 20: [51.9, 16.0, 182.7], 30: [37.7, 12.1, 134.4], 40: [29.9, 9.8, 111.5], 50: [24.1, 7.7, 102.5], 60: [20.7, 6.2, 114.6], 70: [19.0, 5.4, 157.1], 80: [17.9, 4.9, 230.1] };
    const W = { 20: [63.7, 19.8, 212.9], 30: [47.7, 15.3, 158.4], 40: [35.8, 12.1, 118.5], 50: [27.3, 9.5, 95.6], 60: [22.6, 8.0, 92.2], 70: [20.3, 7.0, 112.1], 80: [19.2, 6.3, 166.7] };
    const d = Math.max(20, Math.min(80, Math.floor(age / 10) * 10)), m = M[d], w = W[d];
    const r = sex === '남성' ? m : sex === '여성' ? w : m.map((v, i) => Math.sqrt(v * w[i]));
    return { med: r[0], p2: r[1], p98: r[2], label: `${sex || '성인'} ${d}대` };
  },
  // Korean MRD1 (mm): [age from, mean, sd]
  mrd1(age) { const T = [[0, 2.94, 0.95], [20, 3.23, 0.92], [40, 3.33, 1.09], [60, 2.42, 1.03]], r = [...T].reverse().find(x => age >= x[0]) || T[0];
    return { mean: r[1], sd: r[2], label: `한국인 ${r[0] ? r[0] + '~' : '~'}${r[0] < 60 ? (r[0] + 20) + '세' : '세 이상'}`.replace('60~세 이상', '60세 이상') }; },
};
const rmssdCorr = (rmssd, hr) => rmssd * Math.exp(-0.03243 * (60 - hr));
// percentile from (p5, p50, p95) with separate spreads below / above the median
const pctTri = (v, p5, p50, p95) => !isFinite(v) ? NaN : 100 * Phi((v - p50) / ((v < p50 ? p50 - p5 : p95 - p50) / 1.645));
// percentile from a log-normal shape given (median, p2, p98)
const pctLog = (v, med, p2, p98) => !(v > 0) ? NaN : 100 * Phi(Math.log(v / med) / (Math.log(v < med ? med / p2 : p98 / med) / 2.054));

function fingerSignal(S) {
  const pieces=pipeSegments(S); if(pieces.length>1) S=pieces.reduce((a,b)=>(b.at(-1).t-b[0].t)>(a.at(-1).t-a[0].t)?b:a);
  if (S.length < 60) return null;
  const ts = S.map(x => x.t), FS = 30, span = ts[ts.length - 1] - ts[0]; if (span < 8) return null;
  let best = ['g', 'r'].map(ch => {
    const raw = DSP.resample(ts, S.map(x => x[ch]), FS), mu = DSP.mean(raw);
    const p = DSP.bandpass(raw.map(v => -v), FS, 0.6, 3.5);   // more blood = darker frame, so invert: peaks are heartbeats
    const pk = DSP.spectrumPeak(p, FS, 0.7, 3.2, 0.01, 0.08);
    return { ch, p, FS, snr: pk.snr, f: pk.f, ac: DSP.std(p) / (mu || 1) };
  }).filter(c => isFinite(c.snr)).sort((a, b) => b.snr - a.snr);
  if (!best.length) return null;
  return { ...best[0], acMax: Math.max(...best.map(c => c.ac)) };   // pulse strength = strongest channel
}

function analyzeFinger(S, age, sex) {
  // split where the finger was off the lens (gap > 0.5 s): each piece is filtered and searched for beats on its own,
  // so no beat interval is ever measured across a gap
  // finger shifts / pressure changes show up as sudden jumps in brightness, far larger than a heartbeat's change:
  // drop 0.75 s on each side of every jump and treat it like a gap (beat timing near a jump is distorted)
  // a heartbeat only ever darkens the frame quickly (blood arriving) and brightens it slowly, by at most one pulse height;
  // a finger shift jumps either way. So: brightening jumps > ½ pulse height, or darkening jumps > 2× pulse height = movement
  const pp = (() => { const rawSeg=pipeSegments(S).filter(g=>g.length>1).sort((a,b)=>(b.at(-1).t-b[0].t)-(a.at(-1).t-a[0].t))[0]||[]; const ts = rawSeg.map(x => x.t); if(rawSeg.length<2)return 0; if (ts[ts.length - 1] - ts[0] < 4) return 0; const bp = DSP.bandpass(DSP.resample(ts, rawSeg.map(x => x.g), 30), 30, 0.6, 3.5); return 2.83 * DSP.std(bp); })();
  const up = Math.max(1.2, 0.5 * pp), down = Math.max(1.2, 2 * pp);   // sharp upstrokes of slow, strong pulses reach ~1.5× the estimate
  const jumpAt = i => { const dg = S[i].g - S[i - 1].g, dr = (S[i].r - S[i - 1].r) * 0.5, d = Math.abs(dg) >= Math.abs(dr) ? dg : dr; return d > up || d < -down; };
  const bad = new Uint8Array(S.length); let moves = 0, lastMove = -9;
  for (let k = 0; k + 1 < S.length; k++) if (S[k+1].t-S[k].t<=.5 && jumpAt(k + 1)) { { const t = S[k + 1].t; if (t - lastMove > 1) moves++; lastMove = t; for (let j = 0; j < S.length; j++) if (Math.abs(S[j].t - t) <= 0.75) bad[j] = 1; } }
  const segs = []; let cur = [];
  S.forEach((x, i) => { if (bad[i]) { if (cur.length) { segs.push(cur); cur = []; } return; } if (cur.length && x.t - cur[cur.length - 1].t > 0.5) { segs.push(cur); cur = []; } cur.push(x); }); if (cur.length) segs.push(cur);
  const useSeg = segs.filter(g => g.length > 1 && g[g.length - 1].t - g[0].t >= 8);
  if (!useSeg.length) {   // movement left no clean 8 s stretch: heart rate from the whole recording, no HRV
    const rawLongest=pipeSegments(S).sort((a,b)=>(b.at(-1).t-b[0].t)-(a.at(-1).t-a[0].t))[0]||[], rawDur=rawLongest.length>1?rawLongest.at(-1).t-rawLongest[0].t:0; const sw = fingerSignal(rawLongest); if (!sw || rawDur < FG_MIN_HR) return { error: '손가락 신호가 충분히 모이지 않았어요.' };
    const hr0 = sw.f * 60, r0 = x => x != null && isFinite(x) ? +(+x).toFixed(1) : null;
    return { hr: r0(hr0), hrSpec: r0(hr0), hrPeak: null, rmssd: null, rmssdc: null, sdnn: null, stress: null, hrvPct: null, beats: 0, segs: 0, okFrac: 0, snr: r0(sw.snr), ch: sw.ch, ac: r0(sw.acMax * 100), weak: false, moved: true, moves,
      notRest: hr0 > 100, dur: r0(rawDur), q: sw.snr > 4 ? 2 : sw.snr > 0 ? 1 : 0, enough: true };
  }
  const longest = useSeg.reduce((a, b) => (b[b.length - 1].t - b[0].t > a[a.length - 1].t - a[0].t ? b : a));
  const sg = fingerSignal(longest); if (!sg) return { error: '손가락 신호가 충분히 모이지 않았어요.' };
  const dur = useSeg.reduce((s2, g) => s2 + g[g.length - 1].t - g[0].t, 0), hrSpec = sg.f * 60;
  const ib = [], diffs = [], rIb = [], rD = [];   // rIb·rD: 리듬(불규칙 맥) 판단용 — 모양이 다른 박동도 그대로 둠(불규칙 맥의 특징이므로)
  useSeg.forEach(g => {
    const ts = g.map(x => x.t), raw = DSP.resample(ts, g.map(x => x[sg.ch]), sg.FS), p = DSP.bandpass(raw.map(q => -q), sg.FS, 0.6, 3.5);
    // beat-shape check: a beat much bigger or smaller than this person's typical beat was bent by a small finger
    // shift (or is a premature beat) — intervals touching it are left out, as in standard HRV artefact handling
    const pk = DSP.findPeaks(p, sg.FS, hrSpec), win = Math.round(sg.FS * 60 / hrSpec);
    const amp = pk.map((q, k) => { let mn = Infinity; for (let j = k ? pk[k - 1].i : Math.max(0, q.i - win); j < q.i; j++) mn = Math.min(mn, p[j]); return p[q.i] - mn; });
    const am = DSP.median(amp), okPk = amp.map(a => isFinite(a) && Math.abs(a - am) <= 0.35 * am);
    const e = DSP.ibis(pk);
    { const r = e.filter(x => x.ms > 300 && x.ms < 1500).map(x => x.ms); rIb.push(...r); for (let k = 1; k < r.length; k++) rD.push(r[k] - r[k - 1]); }
    e.forEach((x, k) => { x.ok = x.ok && okPk[k] && okPk[k + 1]; }); ib.push(...e);
    for (let k = 1; k < e.length; k++) if (e[k].ok && e[k - 1].ok) diffs.push(e[k].ms - e[k - 1].ms);
  });
  const good = ib.filter(x => x.ok), okFrac = ib.length ? good.length / ib.length : 0, gms = good.map(x => x.ms);
  const v = { n: good.length, sdnn: good.length > 5 ? DSP.std(gms) : NaN, rmssd: diffs.length > 5 ? Math.sqrt(DSP.mean(diffs.map(d => d * d))) : NaN };
  const hrPeak = good.length >= 5 ? 60000 / DSP.median(gms) : NaN;
  const hr = isFinite(hrPeak) && Math.abs(hrPeak - hrSpec) <= 8 ? hrPeak : hrSpec;
  // quality 0..5: spectral clarity, accepted beats, two methods agree, enough time, flash on
  let q = 0; if (sg.snr > 0) q++; if (sg.snr > 4) q++; if (okFrac >= 0.85) q++; if (isFinite(hrPeak) && Math.abs(hrPeak - hrSpec) <= 3) q++; if (dur >= FG_MIN_HRV) q++;
  const weak = sg.acMax * 100 < FG_MIN_AC && sg.snr < 4, moved = moves / Math.max(1, (S[S.length - 1].t - S[0].t) / 60) > 4;   // more than 4 shifts a minute
  const actualFps = pipeSegmentStats(useSeg).fps;
  const rmssdOK = actualFps >= 24 && !weak && !moved && dur >= FG_MIN_HRV && okFrac >= 0.8 && v.n >= 30 && isFinite(v.rmssd) && v.rmssd > 4 && v.rmssd < 200;
  const rmssdc = rmssdOK ? rmssdCorr(v.rmssd, hr) : NaN;
  const notRest = hr > 100;   // HR correction of RMSSD is only meaningful at rest
  let stress = null, hrvPct = null; if (isFinite(rmssdc) && age && !notRest) { const N = NORMS.rmssdc(age, sex); hrvPct = pctLog(rmssdc, N.med, N.p2, N.p98); stress = Math.round(100 - hrvPct); }
  const r1 = (x, k = 1) => x != null && isFinite(x) ? +(+x).toFixed(k) : null;
  // 맥박 리듬: 얼굴 측정과 같은 기준(간격 변동 12% 초과 + 큰 변동 35% 초과 = 불규칙). 손가락이 움직였거나 약하면 판단 안 함
  const rm = rIb.length ? DSP.mean(rIb) : NaN, rhythm = rIb.length >= 30 && rD.length >= 20 && !moved && !weak && dur >= FG_MIN_HRV
    ? { n: rIb.length, nrmssd: r1(Math.sqrt(DSP.mean(rD.map(d => d * d))) / rm, 3), pBig: r1(rD.filter(d => Math.abs(d) > 0.15 * rm).length / rD.length, 3) } : { n: rIb.length };
  if (rhythm.nrmssd != null) rhythm.irregular = rhythm.nrmssd > 0.12 && rhythm.pBig > 0.35;
  // 호흡수: 가장 긴 깨끗한 구간(30초 이상)에서 ① 숨 쉴 때 손가락 밝기가 천천히 출렁이는 정도 ② 숨 쉴 때 맥박 간격이 빨라졌다 느려지는 정도
  // 두 방법이 3회/분 안으로 맞을 때만 인정 (Charlton 외 2016·2018 리뷰의 '여러 호흡 성분 결합' 방식을 단순화)
  let rr = null, rrA = null, rrB = null;
  try { const seg = longest; if (seg[seg.length - 1].t - seg[0].t >= 30 && !moved) {
    const RF = 4, ts = seg.map(x => x.t), vals = seg.map(x => x[sg.ch]);
    const a = DSP.spectrumPeak(DSP.bandpass(DSP.resample(ts, vals, RF), RF, 0.1, 0.5), RF, 0.1, 0.5, 0.005, 0.03);
    const pk = DSP.findPeaks(DSP.bandpass(DSP.resample(ts, vals, sg.FS).map(q => -q), sg.FS, 0.6, 3.5), sg.FS, hrSpec), e = DSP.ibis(pk).filter(x => x.ok);
    rrA = a.f * 60;
    if (e.length >= 20) { const b = DSP.spectrumPeak(DSP.bandpass(DSP.resample(e.map(x => x.t), e.map(x => x.ms), RF), RF, 0.1, 0.5), RF, 0.1, 0.5, 0.005, 0.03); rrB = b.f * 60; }
    if (rrB != null && Math.abs(rrA - rrB) <= 3) rr = (rrA + rrB) / 2;
  } } catch {}
  return { actualFps, rhythm, rr: r1(rr), rrA: r1(rrA), rrB: r1(rrB), hr: r1(hr), hrSpec: r1(hrSpec), hrPeak: r1(hrPeak), rmssd: rmssdOK ? r1(v.rmssd) : null, rmssdc: r1(rmssdc), sdnn: rmssdOK ? r1(v.sdnn) : null, stress, hrvPct: r1(hrvPct, 0),
    beats: good.length, segs: useSeg.length, okFrac: r1(okFrac, 2), snr: r1(sg.snr, 2), ch: sg.ch, ac: r1(sg.acMax * 100, 3), weak, moved, moves, notRest, dur: r1(dur), q, enough: dur >= FG_MIN_HR };
}

function labAnalyze(samples,age,sex){let result;try{result=analyzeFinger(samples,age,sex);}catch(e){result={error:String(e.message||e)};}
result.accepted=!result.error&&result.enough&&result.q>=2&&Number.isFinite(result.hr)&&result.snr>0;
return result;}
self.onmessage=e=>{try{const {type,samples,age,sex,id}=e.data;
 if(type==='live'){const last=samples.at(-1)?.t||0,tail=samples.filter(x=>x.t>=last-12),sg=fingerSignal(tail);self.postMessage({id,type,result:sg?{hr:sg.f*60,snr:sg.snr,ac:sg.acMax*100,wave:Array.from(sg.p.slice(-150))}:null});}
 else self.postMessage({id,type,result:labAnalyze(samples,age,sex)});
}catch(e){self.postMessage({id:e.data.id,type:e.data.type,error:String(e.message||e)});}};
