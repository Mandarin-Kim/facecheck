/* =====================================================================
   FaceCheck v2 엔진 (시험판) — 공통 원천 데이터 기반 멀티평가
   Mission → Capture → Feature → Assessment → Evidence → Report
   · 한 번 수집한 Capture는 바꿀 수 없음(동결 + 내용 해시). 여러 Feature·Assessment가 같은 Capture를 재사용
   · 평가(Assessment)는 저장된 Feature만 읽음 → 분석 중 재촬영을 부를 수 없음
   · 공개 상태 4가지: 결과 제공 / 참고용 / 연구 중 / 측정 불가. '보류' 모델은 공개 결과에서 제외
   · 검증 안 된 기준값(cutoff)으로 사용자 판정 문구를 내지 않음(엔진이 강제로 지움)
   · 원시 신호가 없으면 점수를 만들지 않음(시뮬레이션도 원시 신호를 만들어 같은 계산을 거침)
   브라우저: window.FCV2 · Node(테스트): module.exports
   ===================================================================== */
(function (root) {
'use strict';
const ENGINE_VERSION = 'fcv2-engine-0.1.0';

/* ---------- 신호 처리 (v1 r17 DSP 그대로) ---------- */
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

/* ---------- 색 공간 ---------- */
function rgb2lab(r, g, b) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return { L: 116 * f(Y) - 16, a: 500 * (f(X) - f(Y)), b: 200 * (f(Y) - f(Z)) };
}

/* ---------- 해시 (동기 SHA-256, 계보 무결성용) ---------- */
function sha256(str) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const bytes = []; for (const ch of unescape(encodeURIComponent(str))) bytes.push(ch.charCodeAt(0));
  const l = bytes.length * 8; bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (l >>> (i * 8)) & 0xff);
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) { const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = h.map((x, i) => (x + [a, b, c, d, e, f, g, hh][i]) | 0);
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
// 키 순서와 무관하게 같은 내용이면 같은 문자열 (해시용)
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(typeof v === 'number' && !isFinite(v) ? null : v);
  if (ArrayBuffer.isView(v)) return stable(Array.from(v));
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const r = (x, k = 1) => x == null || !isFinite(x) ? null : +(+x).toFixed(k);
const median = a => DSP.median(a.filter(x => x != null && isFinite(x)));
let _seq = 0;
const newId = p => `${p}_${Date.now().toString(36)}${(++_seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ======================= 레지스트리 ======================= */
// 품질 실패 코드 (명세 H + M07 상세)
const QCODES = {
  'Q-001': '얼굴 영역이 충분히 보이지 않았어요', 'Q-002': '움직임이 많았어요', 'Q-003': '조명이 너무 어둡거나 밝거나 색이 치우쳤어요', 'Q-004': '카메라 프레임 수가 부족했어요',
  'Q-005': '유효한 측정 시간이 부족했어요', 'Q-006': '눈 흰자가 충분히 보이지 않았어요', 'Q-007': '눈꺼풀 안쪽(결막)이 확보되지 않았어요', 'Q-008': '주변 소리가 커서 목소리를 구분하기 어려웠어요',
  'Q-009': '이 기종에서는 아직 검증되지 않았어요', 'Q-010': '필수 입력값이 빠졌어요', 'Q-011': '권한이 없어 측정하지 않았어요', 'Q-012': '건너뛴 미션이에요', 'Q-013': '눈이 화면 목표를 따라 움직인 것이 확인되지 않았어요',
  'Q-014': '동작(미소·눈 감기)이 확인되지 않았어요', 'Q-015': '두 계산 방식의 결과가 서로 달라 신뢰할 수 없어요',
};
const M07_CODES = { NO_EYE: '눈이 화면에 보이지 않아요', LOWER_LID_NOT_EXPOSED: '눈 아래 분홍색 부분이 아직 보이지 않아요', CONJUNCTIVA_OCCLUDED: '손가락이 분홍색 부분을 가리고 있어요', BLUR: '흔들려서 흐릿해요', GLARE: '빛이 반사돼 하얗게 날아갔어요', TOO_DARK: '너무 어두워요', UNSAFE_ATTEMPT: '눈을 직접 만지지 마세요', OK: '분홍색 부분이 잘 보여요' };

// 미션 카탈로그 (명세 B). 시간은 설계 제안값 — 검증된 최소 시간이 아님
const MISSIONS = {
  M01: { id: 'M01', version: '1.0.0', title: '정면 보기', action: '휴대폰을 눈높이에 두고 정면을 바라봐 주세요.', sub: '편하게 숨 쉬고 잠시 움직이지 마세요.', min_s: 40, max_s: 60, devices: ['camera'], produces: ['F-PULSE-01', 'F-RESP-01', 'F-FACE-01', 'F-EYE-01', 'F-SCLERA-01'], order: 1 },
  M02: { id: 'M02', version: '1.0.0', title: '눈으로 점 따라가기', action: '고개는 고정하고, 눈으로만 점을 따라가세요.', sub: '점이 멈추면 점을 바라봐 주세요.', min_s: 12, max_s: 20, devices: ['camera'], produces: ['F-GAZE-01', 'F-SCLERA-01', 'F-EYE-01'], order: 2 },
  M03: { id: 'M03', version: '1.0.0', title: '표정 움직이기', action: '안내에 따라 웃고, 눈을 감아 주세요.', sub: '한 번에 한 동작씩 보여 드려요.', min_s: 10, max_s: 20, devices: ['camera'], produces: ['F-EXPR-01', 'F-EYE-01', 'F-FACE-01'], order: 3 },
  M04: { id: 'M04', version: '1.0.0', title: '문장 소리 내어 읽기', action: '화면의 문장을 평소 속도로 소리 내어 읽어 주세요.', sub: '다 읽으면 "다 읽었어요"를 눌러 주세요.', min_s: 5, max_s: 20, devices: ['microphone'], produces: ['F-VOICE-01'], order: 4 },
  M05: { id: 'M05', version: '1.0.0', title: '기억·주의 과제', action: '단어를 기억하고, 글자 색 맞히기와 반응 과제를 해 주세요.', sub: '연습 문제부터 시작해요.', min_s: 45, max_s: 120, devices: ['touch'], produces: ['F-COG-01'], order: 5 },
  M06: { id: 'M06', version: '1.0.0', title: '상반신·손 동작', action: '휴대폰을 세워 두고 한 걸음 물러나 상반신이 보이게 해 주세요.', sub: '거치대가 없으면 건너뛰어도 돼요.', min_s: 35, max_s: 90, devices: ['camera', 'stand'], produces: ['F-MOTOR-01', 'F-RESP-01'], order: 6, optional: true },
  M07: { id: 'M07', version: '1.0.0', title: '눈꺼풀 안쪽·손톱·목 촬영', action: '안내 그림을 보고 따라 해 주세요.', sub: '렌즈 착용·눈 자극·통증이 있으면 건너뛰세요.', min_s: 20, max_s: 90, devices: ['camera'], produces: ['F-CONJ-01', 'F-NAIL-01', 'F-NECK-01'], order: 7, optional: true },
  M08: { id: 'M08', version: '1.0.0', title: '기본 정보·짧은 문진', action: '알고 있는 값만 입력해 주세요.', sub: '모르는 값은 비워 두면 그 결과만 계산하지 않아요.', min_s: 0, max_s: 300, devices: [], produces: ['F-PROFILE-01'], order: 0 },
};

// 특징(Feature) 종류 — 한 번 확보하면 여러 평가가 재사용 (명세 C)
const FEATURE_TYPES = {
  'F-PULSE-01': { name: '얼굴 맥파', from: ['M01'], method_version: 'pulse-1.1.0', note: '정면 안정 구간만. 말하기·표정 미션 영상은 쓰지 않음' },
  'F-RESP-01': { name: '호흡 리듬 후보', from: ['M01', 'M06'], method_version: 'resp-1.0.0' },
  'F-FACE-01': { name: '얼굴 피부색·질감·형태', from: ['M01', 'M03'], method_version: 'face-1.0.0' },
  'F-EYE-01': { name: '눈꺼풀 열림·깜빡임', from: ['M01', 'M02', 'M03'], method_version: 'eye-1.0.0' },
  'F-SCLERA-01': { name: '눈 흰자 색', from: ['M02', 'M01'], method_version: 'sclera-1.0.0' },
  'F-CONJ-01': { name: '눈꺼풀 안쪽(결막) 색', from: ['M07'], method_version: 'conj-0.1.0' },
  'F-NAIL-01': { name: '손톱 색', from: ['M07'], method_version: 'nail-0.1.0' },
  'F-NECK-01': { name: '목 피부 밝기', from: ['M07'], method_version: 'neck-0.1.0' },
  'F-GAZE-01': { name: '시선 따라가기', from: ['M02'], method_version: 'gaze-0.1.0' },
  'F-EXPR-01': { name: '표정 움직임', from: ['M03'], method_version: 'expr-1.0.0' },
  'F-VOICE-01': { name: '발화 특징', from: ['M04'], method_version: 'voice-1.0.0' },
  'F-COG-01': { name: '과제 수행 기록', from: ['M05'], method_version: 'cog-1.0.0' },
  'F-MOTOR-01': { name: '상지 동작', from: ['M06'], method_version: 'motor-1.0.0' },
  'F-PROFILE-01': { name: '기본 정보·문진', from: ['M08'], method_version: 'profile-1.0.0' },
};

// 근거 레지스트리 (명세 E). supports: sensing_principle | biomarker_association | cutoff_validation | device_validation
const EVIDENCE = {
  'EV-001': { title: 'Algorithmic Principles of Remote PPG', authors: 'Wang et al. 2017, IEEE TBME', doi: '10.1109/TBME.2016.2609282', population: '실험실 촬영 성인', endpoint: '카메라 맥파 신호 추출', reference_standard: '접촉식 PPG', supported_claim: '카메라 영상에서 맥파를 뽑는 신호 처리 원리', limits: '임상 정확도를 보증하지 않음' },
  'EV-002': { title: 'Prediction of anemia in real-time using a smartphone camera processing conjunctival images', authors: 'Zhao et al. 2024, PLOS ONE', doi: '10.1371/journal.pone.0302883', population: '연구 참여자', endpoint: '혈색소(Hb)', reference_standard: '혈액검사(CBC)', supported_claim: '결막 영상과 혈색소의 연관', limits: '연구용 기기·모델에 한정' },
  'EV-003': { title: 'Non-Invasive Detection of Anaemia Using Digital Photographs of the Conjunctiva', authors: 'Mannino et al. 2016, PLOS ONE', doi: '10.1371/journal.pone.0153286', population: '연구 참여자', endpoint: '빈혈', reference_standard: '혈액검사', supported_claim: '결막 사진 색과 빈혈의 연관, 색보정·기종별 기준 차이', limits: '색보정 카드 사용 조건' },
  'EV-004': { title: 'BiliScreen', authors: 'Mariakakis et al. 2017, IMWUT', doi: '10.1145/3090085', population: '연구 참여자', endpoint: '빌리루빈', reference_standard: '혈액검사', supported_claim: '흰자 영상과 황달 관련 연구', limits: '간 기능 전체를 대신하지 않음, 전용 보조 장치 사용' },
  'EV-005': { title: 'STOP-Bang Questionnaire', authors: 'Chung et al. 2016, CHEST', doi: '10.1378/chest.15-0903', population: '수술 전·수면클리닉 환자 등', endpoint: '폐쇄성 수면무호흡', reference_standard: '수면다원검사', supported_claim: '8문항 합산, 3점 이상 선별 양성', limits: '집단마다 민감도·특이도 다름, 수면검사(AHI)가 아님' },
  'EV-006': { title: 'General cardiovascular risk profile for use in primary care', authors: "D'Agostino et al. 2008, Circulation", doi: '10.1161/CIRCULATIONAHA.107.699579', population: 'Framingham 코호트 30~74세, 심혈관질환 없음', endpoint: '10년 심혈관질환 발생', reference_standard: '추적 관찰', supported_claim: '체질량지수형 10년 위험 공식', limits: '한국인에서는 위험을 높게 예측하는 경향, 재보정 논의 필요' },
  'EV-007': { title: 'PERCLOS-based technologies for detecting drowsiness', authors: 'SLEEP Advances 2023', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10108649/', population: '운전·실험실', endpoint: '졸음', reference_standard: '각성 검사 등', supported_claim: '눈 감김 시간 비율 정의', limits: '짧은 측정·노년층 한계' },
};
// 기종·알고리즘 검증 기록 (명세 F Validation). 비어 있으면 '결과 제공'으로 올라가지 못함
const VALIDATIONS = [];

const KIND_KO = { measured: '측정값', estimated: '추정값', screening: '위험 선별', research_score: '연구 점수', observation: '외관 관찰', task: '과제 결과', entertainment: '오락·외관' };
const STATUS_KO = { released: '결과 제공', reference: '참고용', research: '연구 중', insufficient: '측정 불가', held: '보류' };

/* ---------- 특징 추출기 (Capture 1개 → Feature 여러 개) ---------- */
// M01 프레임 관찰값: { t, ok, all:[r,g,b], fh:[...], ck:[...], cy, motion, lum, ear:[l,r], faces }
/* 맥파 처리 pulse-1.2.0 (신뢰성 시험 결과 반영)
   - 저심박(≤52bpm)에서 2·3배 고조파를 심박으로 잡던 문제 → 대역 하한 0.5Hz + 1/2·1/3 주파수 확인
   - 선형 보간 꺾임·좁은 대역 필터 때문에 박동 시각이 흔들려 RMSSD가 2~3배 부풀던 문제 → 3차 보간 + 평균 박동 모양(템플릿) 정합
   - 이마·볼 두 영역에서 따로 잡은 박동 시각 차이로 '박동 시각 흔들림'을 직접 추정 → 그만큼 RMSSD에서 빼고, 흔들림이 크면 PRV를 내지 않음 */
function resampleCubic(ts, v, fs) {
  const n = Math.max(0, Math.floor((ts[ts.length - 1] - ts[0]) * fs) + 1), out = new Float64Array(n); let j = 0;
  for (let i = 0; i < n; i++) { const t = ts[0] + i / fs; while (j < ts.length - 2 && ts[j + 1] < t) j++;
    const t1 = ts[j], t2 = ts[j + 1] ?? t1, u = t2 > t1 ? Math.min(1, Math.max(0, (t - t1) / (t2 - t1))) : 0;
    const p0 = v[Math.max(0, j - 1)], p1 = v[j], p2 = v[Math.min(v.length - 1, j + 1)], p3 = v[Math.min(v.length - 1, j + 2)];
    out[i] = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u); }
  return out;
}
const parab = (a, b, c) => { const den = a - 2 * b + c; return den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0; };
// 움직임 큰 프레임(앞뒤 3장 포함)을 빼고, 0.35초 넘게 끊기면 구간을 나눔. 5초 이상 구간만 사용
function cleanSegments(F) {
  const n = F.length, bad = new Uint8Array(n);
  F.forEach((f, i) => { if (f.motion > 2.5) for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) bad[k] = 1; });
  const segs = []; let cur = [];
  F.forEach((f, i) => { if (bad[i]) { if (cur.length) segs.push(cur); cur = []; return; } if (cur.length && f.t - cur[cur.length - 1].t > 0.35) { segs.push(cur); cur = []; } cur.push(f); });
  if (cur.length) segs.push(cur);
  return { segs: segs.filter(g => g[g.length - 1].t - g[0].t >= 5), bad };
}
function chanSig(g, key, mode, FS) {
  const ts = g.map(f => f.t), ch = [0, 1, 2].map(c => resampleCubic(ts, g.map(f => f[key][c]), FS));
  return mode === 'pos' ? DSP.pos(ch[0], ch[1], ch[2], FS) : ch[1].map(x => -x);
}
// 평균 박동 모양(템플릿)과 가장 잘 맞는 위치를 박동 시각으로 (한 점이 아니라 박동 전체 모양을 쓰므로 잡음에 강함)
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
  const med = DSP.median(out.map(o => o.ms)); return out.map(o => ({ ...o, ok: o.ms > 300 && o.ms < 1700 && Math.abs(o.ms - med) < 0.2 * med }));
}
// 두 영역(이마·볼)의 박동 시각 차이 → 한 영역의 박동 시각 흔들림(ms). 잡음이 서로 독립이라는 가정 (조명·움직임처럼 함께 생기는 오차는 못 잡음)
function roiJitter(a, b, ibi) {
  if (!a.length || !b.length) return null; const d = []; let j = 0;
  for (const x of a) { while (j < b.length - 1 && Math.abs(b[j + 1].t - x.t) < Math.abs(b[j].t - x.t)) j++; if (Math.abs(b[j].t - x.t) < 0.25 * ibi) d.push((x.t - b[j].t) * 1000); }
  if (d.length < 15) return null; const md = DSP.median(d), mad = DSP.median(d.map(x => Math.abs(x - md)));
  return { sd_diff_ms: 1.4826 * mad, n: d.length };
}
function pulseFeature(frames, meta) {
  const F = (frames || []).filter(f => f && f.ok && Array.isArray(f.all));
  const span = F.length > 1 ? F[F.length - 1].t - F[0].t : 0, fps = span > 0 ? F.length / span : 0;
  if (!F.length) return { valid: false, failure_code: 'Q-001' };
  if (fps < 7) return { valid: false, failure_code: 'Q-004', value: { fps: r(fps) } };   // 심박 대역 상한 3.2Hz의 2배 이상
  const { segs, bad } = cleanSegments(F), n = F.length;
  const use = F.filter((_, i) => !bad[i]); let valid_s = 0; for (let i = 1; i < use.length; i++) { const d = use[i].t - use[i - 1].t; if (d < 0.35) valid_s += d; }
  if (valid_s < 20 || use.length < 120 || !segs.length) return { valid: false, failure_code: bad.reduce((a, b) => a + b, 0) > n * 0.3 ? 'Q-002' : 'Q-005', value: { valid_s: r(valid_s), fps: r(fps) } };
  // 1) 평균 심박: 스펙트럼 최고점 → 그 1/2·1/3 주파수에도 힘이 충분하면 그쪽이 기본 박동 (고조파 오인 방지)
  const FS = 30, ts = use.map(f => f.t), [R, G, B] = [0, 1, 2].map(c => DSP.resample(ts, use.map(f => f.all[c]), FS));
  const p = DSP.bandpass(DSP.pos(R, G, B, FS), FS, 0.5, 3.3), SP = DSP.spectrum(p, FS, 0.65, 3.2, 0.01);
  const powAt = f => { let m = 0; SP.fr.forEach((x, j) => { if (Math.abs(x - f) <= 0.05) m = Math.max(m, SP.pw[j]); }); return m; };
  let fPk = SP.fr[SP.pw.indexOf(Math.max(...SP.pw))], f0 = fPk;
  for (const dv of [3, 2]) { const fc = fPk / dv; if (fc >= 0.65 && powAt(fc) >= 0.3 * powAt(fPk)) { f0 = fc; break; } }
  let sig = 0, tot = 0; SP.fr.forEach((x, j) => { tot += SP.pw[j]; if (Math.abs(x - f0) <= 0.08 || Math.abs(x - 2 * f0) <= 0.08) sig += SP.pw[j]; });
  const snr = 10 * Math.log10(sig / Math.max(1e-12, tot - sig)), hrSpec = f0 * 60;
  // 2) 박동 시각: 녹색 vs POS 중 신호가 깨끗한 쪽, 템플릿 정합
  const big = segs.reduce((a, g) => g.length > a.length ? g : a), bts = big.map(f => f.t);
  const snrOf = x => { const b2 = DSP.bandpass(x, 30, 0.5, 3.3); return DSP.spectrumPeak(b2, 30, Math.max(0.65, f0 - 0.3), Math.min(3.2, f0 + 0.3), 0.01, 0.08).snr; };
  const gSnr = snrOf(DSP.resample(bts, big.map(f => -f.all[1]), 30)), pSnr = snrOf(DSP.pos(...[0, 1, 2].map(c => DSP.resample(bts, big.map(f => f.all[c]), 30)), 30));
  const mode = pSnr > gSnr ? 'pos' : 'g';
  const hasRoi = use.every(f => Array.isArray(f.fh) && Array.isArray(f.ck)) && use.some(f => f.fh[1] !== f.ck[1]);
  // 박동 간격 계산 (모드별). 흔들림 보정: 연속 간격 차이에 더해지는 잡음 분산 = 6·σ²(전체 영역) = 1.5·var(이마−볼 차이)
  const prvFor = md => {
    const beats = beatTimes(segs, 'all', md, hrSpec), ib = ibiList(beats);
    const good = ib.filter(x => x.ok).map(x => x.ms), diffs = []; for (let k = 1; k < ib.length; k++) if (ib[k].ok && ib[k - 1].ok && ib[k].k === ib[k - 1].k + 1) diffs.push(ib[k].ms - ib[k - 1].ms);
    const raw = diffs.length > 5 ? Math.sqrt(DSP.mean(diffs.map(d => d * d))) : NaN;
    const jit = hasRoi && isFinite(hrSpec) ? roiJitter(beatTimes(segs, 'fh', md, hrSpec), beatTimes(segs, 'ck', md, hrSpec), 60 / hrSpec) : null;
    const nv = jit ? 1.5 * jit.sd_diff_ms ** 2 : null, nf = jit && raw > 0 ? nv / raw ** 2 : null;
    return { ib, good, raw, jitterMs: jit ? jit.sd_diff_ms / 2 : null, nf, rmssd: nf != null ? Math.sqrt(Math.max(0, raw ** 2 - nv)) : NaN };
  };
  const P = prvFor(mode), Q = prvFor(mode === 'pos' ? 'g' : 'pos'), Pg = mode === 'g' ? P : Q, Pp = mode === 'pos' ? P : Q;
  // 박동 간격(심박 확인용)은 두 방식 중 박동 시각 흔들림이 작은 쪽을 씀 (스펙트럼 SNR만으로 고르면 가끔 덜 정확한 쪽을 고름)
  const M = P.jitterMs != null && Q.jitterMs != null && Q.jitterMs < P.jitterMs ? Q : P, usedMode = M === P ? mode : (mode === 'pos' ? 'g' : 'pos');
  const ib = M.ib, good = M.good;
  const hrIbi = good.length >= 5 ? 60000 / DSP.median(good) : NaN, rmssdRaw = M.raw, jitterMs = M.jitterMs;
  // 두 계산 방식(녹색·POS)은 오차 원인이 다름: 녹색은 조명 밝기 변화에, POS는 색 채널 잡음에 약함 → 둘이 맞을 때만 신뢰
  const both = [Pg, Pp].every(x => x.nf != null && isFinite(x.rmssd));
  const prvNoise = both ? Math.max(Pg.nf, Pp.nf) : null, prvAgree = both ? Math.abs(Pg.rmssd - Pp.rmssd) / Math.max(1e-6, (Pg.rmssd + Pp.rmssd) / 2) : null;
  const rmssd = both ? (Pg.rmssd + Pp.rmssd) / 2 : NaN;
  const allIb = ib.map(x => x.ms).filter(ms => ms > 300 && ms < 1700), m = DSP.mean(allIb), d2 = allIb.slice(1).map((x, i) => x - allIb[i]);
  const nrmssd = allIb.length >= 10 ? Math.sqrt(DSP.mean(d2.map(x => x * x))) / m : NaN, pBig = allIb.length >= 10 ? d2.filter(x => Math.abs(x) > 0.15 * m).length / d2.length : NaN;
  const lum = DSP.mean(use.map(f => f.lum)), okFrac = ib.length ? good.length / ib.length : 0;
  // 신호 품질 지표(SQI) — 이 알고리즘 버전의 정의일 뿐 공용 절대척도가 아님 (명세 H)
  const sqi = { def: 'sqi-pulse-2', spec_snr_db: r(snr), ok_beat_frac: r(okFrac, 2), lum: r(lum), hr_agree_bpm: isFinite(hrIbi) ? r(Math.abs(hrIbi - hrSpec)) : null, valid_s: r(valid_s), fps: r(fps), harmonic_fix: f0 !== fPk, beat_jitter_ms: r(jitterMs, 1), prv_noise_frac: r(prvNoise, 2), prv_mode_diff: r(prvAgree, 2) };
  const pass = snr > 0 && lum > 60 && lum < 230 && okFrac >= 0.7;
  return { valid: true, quality: pass ? 'pass' : 'low', value: { hr_spec: r(hrSpec), hr_ibi: r(hrIbi), ibi_ms: good.map(x => Math.round(x)), beats: good.length, ts_src: meta?.ts_src ?? null, rmssd_raw_ms: r(rmssdRaw), rmssd_ms: r(rmssd), rmssd_g_ms: r(Pg.rmssd), rmssd_pos_ms: r(Pp.rmssd), beat_jitter_ms: r(jitterMs, 1), prv_noise_frac: r(prvNoise, 2), prv_mode_diff: r(prvAgree, 2), nrmssd: r(nrmssd, 3), pbig: r(pBig, 3), peak_method: usedMode + '+tpl', sqi }, uncertainty: isFinite(hrIbi) ? { hr_bpm_disagree: r(Math.abs(hrIbi - hrSpec)) } : null };
}
function respFeatureFace(frames) {
  const F = (frames || []).filter(f => f && f.ok && Array.isArray(f.all) && isFinite(f.cy)); if (F.length < 100) return null;
  const ts = F.map(f => f.t), dur = ts[ts.length - 1] - ts[0]; if (dur < 20) return null;
  const RFS = 10, cy = DSP.bandpass(DSP.resample(ts, F.map(f => f.cy), RFS), RFS, 0.1, 0.6), gi = DSP.bandpass(DSP.resample(ts, F.map(f => f.all[1]), RFS), RFS, 0.1, 0.6);
  const ra = DSP.spectrumPeak(cy, RFS, 0.1, 0.6, 0.005, 0.03), rb = DSP.spectrumPeak(gi, RFS, 0.1, 0.6, 0.005, 0.03);
  return { motion_rpm: r(ra.f * 60), color_rpm: r(rb.f * 60), motion_snr: r(ra.snr), color_snr: r(rb.snr), dur_s: r(dur) };
}
function eyeFeature(frames) {
  const F0 = (frames || []).filter(f => f && f.ok && Array.isArray(f.ear) && f.ear.every(isFinite)); if (F0.length < 30) return { valid: false, failure_code: 'Q-001' };
  const ts0 = F0.map(f => f.t), dur = ts0[ts0.length - 1] - ts0[0]; if (dur < 10) return { valid: false, failure_code: 'Q-005' };
  // eye-1.1.0 (신뢰성 시험 반영): 얼굴 점이 실제로 새로 계산된 프레임만 사용 (느린 폰에서는 같은 값이 반복됨)
  const F = F0.filter((f, i) => !i || f.ear[0] !== F0[i - 1].ear[0] || f.ear[1] !== F0[i - 1].ear[1]);
  const lmFps = F.length / dur, ts = F.map(f => f.t), e = F.map(f => (f.ear[0] + f.ear[1]) / 2);
  const sm = e;   // 중앙값 평활은 0.1초짜리 깜빡임을 지워 버려 쓰지 않음 (시험에서 15fps 기준 −27% 과소)
  // 평소 열림 정도는 앞뒤 3초 구간의 중앙값 (깜빡임은 시간의 10% 미만이라 영향 적음. 상위 10% 값은 잡음만큼 부풀어 헛깜빡임을 셈)
  const openAt = i => { const w = []; for (let j = i; j >= 0 && ts[i] - ts[j] <= 3; j--) w.push(sm[j]); for (let j = i + 1; j < sm.length && ts[j] - ts[i] <= 3; j++) w.push(sm[j]); w.sort((a, b) => a - b); return w[Math.floor(w.length * 0.5)]; };
  const open = F.map((_, i) => openAt(i)), openMed = median(open);
  // 측정 잡음 (얼굴 점 흔들림): 연속 차이의 중앙 절대 편차
  const dif = e.slice(1).map((v, i) => v - e[i]), md = median(dif), noise = 1.4826 * median(dif.map(x => Math.abs(x - md))) / Math.SQRT2;
  // 감김 판정에 히스테리시스 + 불응기(0.35초 안에 새 깜빡임 시작 불가: 잡음으로 한 번을 두 번 세는 것 방지)
  let blinks = 0, inB = false, lastStart = -9;
  sm.forEach((v, i) => { const o = open[i], down = o - Math.max(0.35 * o, 4 * noise), up = o - Math.max(0.15 * o, 2 * noise);
    if (v < down) { if (!inB && ts[i] - lastStart >= 0.35) { blinks++; lastStart = ts[i]; } inB = true; } else if (v > up) inB = false; });
  // PERCLOS(명세 D): 80% 이상 감김(열림 20% 이하)의 시간 비율
  let closedT = 0; for (let i = 1; i < F.length; i++) { const dt = Math.min(0.25, ts[i] - ts[i - 1]); if (sm[i] <= 0.2 * open[i]) closedT += dt; }
  const oL = median(F0.map(f => f.ear[0])), oR = median(F0.map(f => f.ear[1]));
  const quality = lmFps >= 10 && noise < 0.2 * openMed ? 'pass' : 'low';
  return { valid: true, quality, value: { blink_per_min: r(blinks / dur * 60), blinks, perclos_pct: r(100 * closedT / dur), open_ear: r(openMed, 3), ear_l: r(oL, 3), ear_r: r(oR, 3), lid_asym_pct: r(100 * Math.abs(oL - oR) / Math.max(oL, oR)), dur_s: r(dur), landmark_fps: r(lmFps), ear_noise: r(noise, 4) } };
}
// 정지 장면 색 측정값: { cheek:{L,a,b,sd}, forehead:{...}, sclera:{L,a,b,px,uniform}, gloss_pct, texture, ages:[] , lum, cast }
function faceFeature(stills) {
  const S = (stills || []).filter(s => s && s.cheek); if (!S.length) return { valid: false, failure_code: 'Q-001' };
  const m = k => median(S.map(s => s.cheek[k])), fm = k => median(S.map(s => s.forehead?.[k]));
  const lum = median(S.map(s => s.lum)), cast = median(S.map(s => s.cast));
  const q = lum < 60 || lum > 230 || Math.abs(cast) > 8 ? 'low' : 'pass';
  const ages = S.flatMap(s => s.ages || []).filter(isFinite);
  return { valid: true, quality: q, value: { cheek_L: r(m('L')), cheek_a: r(m('a')), cheek_b: r(m('b')), forehead_L: r(fm('L')), forehead_a: r(fm('a')), tone_sd: r(median(S.map(s => s.cheek.sd))), gloss_pct: r(median(S.map(s => s.gloss_pct))), texture: r(median(S.map(s => s.texture)), 2), appearance_age_model: ages.length ? r(median(ages)) : null, age_n: ages.length, lum: r(lum), cast: r(cast), n_stills: S.length } };
}
function scleraFeature(stills) {
  const S = (stills || []).filter(s => s && s.sclera && s.sclera.px >= 15); if (!S.length) return { valid: false, failure_code: 'Q-006' };
  const castV = median(S.map(s => s.cast)), b = median(S.map(s => s.sclera.b)), a = median(S.map(s => s.sclera.a));
  return { valid: true, quality: Math.abs(castV) > 8 ? 'low' : 'pass', value: { sclera_b: r(b, 1), sclera_b_cast_adj: r(b - 0.5 * Math.max(0, castV || 0), 1), sclera_a: r(a, 1), uniformity_sd: r(median(S.map(s => s.sclera.sd)), 1), px: Math.round(median(S.map(s => s.sclera.px))), n: S.length } };
}
// M02 표본: { t, target:{x,y,state}, iris:{x,y} (눈 안에서의 상대 위치, 좌우 평균), head:{yaw,pitch}, conf }
function gazeFeature(samples) {
  const S = (samples || []).filter(s => s && s.target && s.iris && isFinite(s.iris.x) && (s.conf ?? 1) >= 0.5);
  if (S.length < 40) return { valid: false, failure_code: 'Q-001' };
  const dur = S[S.length - 1].t - S[0].t; if (dur < 8) return { valid: false, failure_code: 'Q-005' };
  const corr = (a, b) => { const ma = DSP.mean(a), mb = DSP.mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sa && sb ? s / Math.sqrt(sa * sb) : 0; };
  const H = S.filter(s => s.target.axis !== 'v'), V = S.filter(s => s.target.axis !== 'h');
  const hx = corr(H.map(s => s.target.x), H.map(s => s.iris.x)), vy = corr(V.map(s => s.target.y), V.map(s => s.iris.y));
  // 머리를 같이 돌렸는지: 머리 각도와 목표의 상관
  const headCorr = corr(H.map(s => s.target.x), H.map(s => s.head?.yaw ?? 0));
  // 지연: 목표가 옮겨 간 뒤 눈동자가 새 위치 쪽으로 절반 이상 이동하는 데 걸린 시간 (각 이동마다)
  const moves = []; let prev = null;
  S.forEach(s => { if (prev && s.target.state === 'moving' && prev.target.state !== 'moving') moves.push({ t: s.t, dir: Math.sign((s.target.dx ?? 0) || (s.target.dy ?? 0)), axis: s.target.axis }); prev = s; });
  const lat = [];
  moves.forEach(mv => { const before = S.filter(s => s.t < mv.t && s.t > mv.t - 0.6), after = S.filter(s => s.t >= mv.t && s.t < mv.t + 1.5); if (before.length < 3 || after.length < 5) return;
    const k = mv.axis === 'v' ? 'y' : 'x', b0 = DSP.median(before.map(s => s.iris[k])), end = DSP.median(after.slice(-4).map(s => s.iris[k])), half = (b0 + end) / 2;
    if (Math.abs(end - b0) < 0.02) return; const hit = after.find(s => (end > b0 ? s.iris[k] >= half : s.iris[k] <= half)); if (hit) lat.push((hit.t - mv.t) * 1000); });
  const ampL = DSP.median(H.filter(s => s.target.x < 0.4 && s.target.state === 'hold').map(s => s.iris.x)), ampR = DSP.median(H.filter(s => s.target.x > 0.6 && s.target.state === 'hold').map(s => s.iris.x)), mid = DSP.median(H.filter(s => Math.abs(s.target.x - 0.5) < 0.1 && s.target.state === 'hold').map(s => s.iris.x));
  const exL = Math.abs(mid - ampL), exR = Math.abs(ampR - mid), excursion = (exL + exR) / 2;
  // 실제로 눈이 움직였는지 (목표만 움직이고 눈은 그대로인 경우 성공 처리 금지 — 명세 K9)
  const eyesMoved = isFinite(excursion) && excursion >= 0.04 && hx >= 0.3;
  if (!eyesMoved) return { valid: false, failure_code: 'Q-013', value: { follow_h: r(hx, 2), excursion: r(excursion, 3) } };
  return { valid: true, quality: Math.abs(headCorr) > 0.6 ? 'low' : 'pass', value: { follow_h: r(hx, 2), follow_v: r(vy, 2), latency_ms: lat.length ? Math.round(DSP.median(lat)) : null, n_moves: lat.length, excursion: r(excursion, 3), lr_asym: r(Math.abs(exL - exR) / Math.max(exL, exR, 1e-6), 2), head_follow_corr: r(headCorr, 2), n: S.length } };
}
// M03: { phases: { neutral:[{t, mL:{x,y}, mR:{x,y}, mw, ear:[l,r]}], smile:[...], closed:[...] }, iod } — 좌표는 눈 사이 거리 단위
function exprFeature(cap) {
  const P = cap?.phases || {}, N = P.neutral || [], Sm = P.smile || [], C = P.closed || [];
  if (N.length < 5) return { valid: false, failure_code: 'Q-001' };
  const med = (A, f) => DSP.median(A.map(f).filter(isFinite));
  const n = { lx: med(N, s => s.mL.x), ly: med(N, s => s.mL.y), rx: med(N, s => s.mR.x), ry: med(N, s => s.mR.y), w: med(N, s => s.mw), e: med(N, s => (s.ear[0] + s.ear[1]) / 2) };
  const out = { neutral_n: N.length };
  let ok = true;
  if (Sm.length >= 5) {
    const top = [...Sm].sort((a, b) => b.mw - a.mw).slice(0, Math.max(3, Sm.length >> 2));
    const dL = Math.hypot(med(top, s => s.mL.x) - n.lx, med(top, s => s.mL.y) - n.ly), dR = Math.hypot(med(top, s => s.mR.x) - n.rx, med(top, s => s.mR.y) - n.ry);
    out.smile_widen = r(med(top, s => s.mw) / n.w, 3); out.smile_move_l = r(dL, 3); out.smile_move_r = r(dR, 3); out.smile_asym_pct = r(100 * Math.abs(dL - dR) / Math.max(dL, dR, 1e-6));
    if (!(out.smile_widen >= 1.04)) ok = false;
  } else ok = false;
  if (C.length >= 3) { const ce = med(C, s => (s.ear[0] + s.ear[1]) / 2); out.close_ratio = r(ce / n.e, 2); out.close_l = r(med(C, s => s.ear[0]) / med(N, s => s.ear[0]), 2); out.close_r = r(med(C, s => s.ear[1]) / med(N, s => s.ear[1]), 2); if (!(out.close_ratio <= 0.5)) ok = false; } else ok = false;
  if (!ok) return { valid: false, failure_code: 'Q-014', value: out };
  return { valid: true, quality: 'pass', value: out };
}
// M04: { env:[...], dt, syllables, mic:true }
function voiceFeature(cap) {
  if (!cap || cap.mic === false) return { valid: false, failure_code: 'Q-011' };
  const env = cap.env || []; if (env.length < 50) return { valid: false, failure_code: 'Q-005' };
  const sorted = Array.from(env).sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.1)] || 0, peak = sorted[Math.floor(sorted.length * 0.98)] || 0;
  const th = floor + (peak - floor) * 0.18, dt = cap.dt || 0.02, segs = []; let st = -1, last = -1;
  env.forEach((v, i) => { if (v > th) { if (st < 0) st = i; last = i; } else if (st >= 0 && (i - last) * dt > 0.25) { segs.push([st * dt, (last + 1) * dt]); st = -1; } });
  if (st >= 0) segs.push([st * dt, (last + 1) * dt]);
  const S = segs.filter(s => s[1] - s[0] >= 0.15), snr = 20 * Math.log10((peak || 1e-9) / (floor || 1e-9));
  if (!S.length || snr < 10) return { valid: false, failure_code: 'Q-008', value: { snr_db: r(snr) } };
  const span = S[S.length - 1][1] - S[0][0]; let pauses = 0, pauseT = 0;
  for (let k = 1; k < S.length; k++) { const g = S[k][0] - S[k - 1][1]; if (g > 0.35) { pauses++; pauseT += g; } }
  if (span < 2) return { valid: false, failure_code: 'Q-005', value: { span_s: r(span) } };
  return { valid: true, quality: snr >= 15 ? 'pass' : 'low', value: { syll_per_s: r(cap.syllables / span, 2), artic_syll_per_s: span - pauseT > 1 ? r(cap.syllables / (span - pauseT), 2) : null, pauses, pause_s: r(pauseT), span_s: r(span), snr_db: r(snr), completed: cap.completed !== false } };
}
// M05: { events:[{task:'stroop'|'rt'|'recall', practice, congruent, correct, rt_ms, timeout}], recall:{shown:[], chosen:[], correct:n, of:n}, frame_ms }
function cogFeature(cap) {
  const E = (cap?.events || []).filter(e => !e.practice); if (!E.length && !cap?.recall) return { valid: false, failure_code: 'Q-005' };
  const st = E.filter(e => e.task === 'stroop'), rt = E.filter(e => e.task === 'rt'), v = {};
  if (st.length >= 6) {
    const ok = st.filter(e => e.correct), con = ok.filter(e => e.congruent).map(e => e.rt_ms), inc = ok.filter(e => !e.congruent).map(e => e.rt_ms);
    v.stroop_n = st.length; v.stroop_acc_pct = r(100 * ok.length / st.length); v.stroop_rt_ms = ok.length ? Math.round(DSP.median(ok.map(e => e.rt_ms))) : null;
    v.stroop_interf_ms = con.length && inc.length ? Math.round(DSP.median(inc) - DSP.median(con)) : null; v.stroop_timeouts = st.filter(e => e.timeout).length;
  }
  if (rt.length >= 5) { const x = rt.filter(e => e.correct && !e.timeout).map(e => e.rt_ms); v.rt_n = rt.length; v.rt_ms = x.length ? Math.round(DSP.median(x)) : null; v.rt_cv_pct = x.length >= 3 ? r(100 * DSP.std(x) / DSP.mean(x)) : null; v.rt_early = rt.filter(e => e.early).length; }
  if (cap?.recall) { v.recall_correct = cap.recall.correct; v.recall_of = cap.recall.of; v.recall_wrong = cap.recall.wrong || 0; v.recall_delay_s = r(cap.recall.delay_s); }
  v.frame_ms = r(cap?.frame_ms); // 화면 갱신 간격(반응 시간 오차 기록)
  return { valid: Object.keys(v).length > 1, failure_code: Object.keys(v).length > 1 ? null : 'Q-005', quality: 'pass', value: v };
}
// M06: v1 r17 BODYA 그대로 (표본 형식 동일)
const BODYA = {
  // 어깨 호흡: 양어깨 평균 높이의 0.1~0.6Hz 리듬
  breath(S) {
    const F = (S || []).filter(s => s && isFinite(s.y)); if (F.length < 30) return { ok: false, why: 'frames', n: F.length };
    const ts = F.map(s => s.t), dur = ts[ts.length - 1] - ts[0]; if (dur < 20) return { ok: false, why: 'short', dur };
    const fs = 10, y = DSP.resample(ts, F.map(s => s.y), fs), bp = DSP.bandpass(y, fs, 0.1, 0.6), pk = DSP.spectrumPeak(bp, fs, 0.1, 0.6, 0.005, 0.03);
    const sw = DSP.median(F.map(s => s.sw).filter(isFinite)), tilt = DSP.median(F.map(s => s.tilt).filter(isFinite)), fps = F.length / dur;
    const rr = pk.f * 60, ok = pk.snr > -1 && fps >= 4 && rr >= 6 && rr <= 40;
    return { ok, rr: +rr.toFixed(1), snr: +pk.snr.toFixed(1), amp: sw ? +(100 * DSP.std(bp) / sw).toFixed(2) : null, tilt: isFinite(tilt) ? +tilt.toFixed(1) : null, dur: +dur.toFixed(1), fps: +fps.toFixed(1) };
  },
  // 팔 처짐: 처음(0.5~2.5초)과 마지막 2.5초의 '손목 높이 − 어깨 높이'(어깨너비 단위) 비교. 아래로 내려가면 +
  drift(S) {
    const F = (S || []).filter(Boolean); if (F.length < 8) return { ok: false, why: 'frames', n: F.length };
    const t0 = F[0].t, T = F[F.length - 1].t - t0; if (T < 6) return { ok: false, why: 'short' };
    const win = (a, b, k) => DSP.median(F.filter(s => s.t - t0 >= a && s.t - t0 <= b && isFinite(s[k])).map(s => s[k]));
    const bl = win(0.5, 2.5, 'l'), br = win(0.5, 2.5, 'r'), el = win(T - 2.5, T, 'l'), er = win(T - 2.5, T, 'r');
    if (![bl, br, el, er].every(isFinite)) return { ok: false, why: 'hands' };
    const raised = Math.abs(bl) < 0.7 && Math.abs(br) < 0.7;   // 손목이 어깨 높이 근처 = 팔을 앞으로 든 상태
    const dl = el - bl, dr = er - br;
    return { ok: raised, why: raised ? null : 'notRaised', dropL: +dl.toFixed(3), dropR: +dr.toFixed(3), asym: +Math.abs(dl - dr).toFixed(3), lower: dl > dr ? 'l' : 'r' };
  },
  // 손 떨림: 손 중심의 3~12Hz 흔들림(손 크기 대비 %, 실효값)과 가장 센 빠르기
  tremorHand(F, kx, ky, ks) {
    F = F.filter(s => isFinite(s[kx]) && isFinite(s[ky]) && isFinite(s[ks]));
    if (F.length < 40) return { ok: false, why: 'frames', n: F.length };
    const ts = F.map(s => s.t), dur = ts[ts.length - 1] - ts[0], fps = F.length / dur; if (dur < 6 || fps < 10) return { ok: false, why: fps < 10 ? 'fps' : 'short', fps: +fps.toFixed(1) };
    const fs = Math.min(30, Math.floor(fps)), hi = Math.min(12, fs / 2 - 0.5), sz = DSP.median(F.map(s => s[ks]));
    const bx = DSP.bandpass(DSP.resample(ts, F.map(s => s[kx]), fs), fs, 3, hi), by = DSP.bandpass(DSP.resample(ts, F.map(s => s[ky]), fs), fs, 3, hi);
    const rms = Math.sqrt(DSP.mean(bx.map((v, i) => v * v + by[i] * by[i])));
    const px = DSP.spectrumPeak(bx, fs, 3, hi, 0.1, 0.5), py = DSP.spectrumPeak(by, fs, 3, hi, 0.1, 0.5), pk = px.snr >= py.snr ? px : py;
    return { ok: true, amp: +(100 * rms / sz).toFixed(2), hz: +pk.f.toFixed(1), snr: +pk.snr.toFixed(1), fps: +fps.toFixed(1), n: F.length };
  },
  tremor(S) { const F = (S || []).filter(Boolean); return { l: BODYA.tremorHand(F, 'lx', 'ly', 'ls'), r: BODYA.tremorHand(F, 'rx', 'ry', 'rsz') }; },
  // 주먹 쥐었다 펴기: 손 펴짐 정도의 반복 횟수·크기·감소
  fistHand(F, k) {
    F = F.filter(s => isFinite(s[k])); if (F.length < 30) return { ok: false, why: 'frames', n: F.length };
    const ts = F.map(s => s.t), dur = ts[ts.length - 1] - ts[0]; if (dur < 6) return { ok: false, why: 'short' };
    const v = F.map(s => s[k]), sm = v.map((_, i) => DSP.mean(v.slice(Math.max(0, i - 1), i + 2)));
    const lo = DSP.median([...sm].sort((a, b) => a - b).slice(0, Math.max(1, sm.length >> 2))), hi = DSP.median([...sm].sort((a, b) => b - a).slice(0, Math.max(1, sm.length >> 2)));
    const rng = hi - lo; if (!(rng > 0.25)) return { ok: true, cycles: 0, rate: 0, amp: +rng.toFixed(2), dec: null, dur: +dur.toFixed(1) };
    const thL = lo + 0.3 * rng, thH = lo + 0.7 * rng; let state = sm[0] > thH ? 'open' : 'closed', cyc = [], cur = { mn: Infinity, mx: -Infinity, t: ts[0] };
    for (let i = 0; i < sm.length; i++) { cur.mn = Math.min(cur.mn, sm[i]); cur.mx = Math.max(cur.mx, sm[i]);
      if (state === 'open' && sm[i] < thL) state = 'closed';
      else if (state === 'closed' && sm[i] > thH) { state = 'open'; cyc.push({ amp: cur.mx - cur.mn, t: ts[i] }); cur = { mn: sm[i], mx: sm[i], t: ts[i] }; } }
    const amps = cyc.map(c => c.amp), m3 = a => a.length ? DSP.mean(a) : NaN, dec = amps.length >= 6 ? m3(amps.slice(-3)) / m3(amps.slice(0, 3)) : NaN;
    return { ok: true, cycles: cyc.length, rate: +(cyc.length / dur).toFixed(2), amp: +rng.toFixed(2), dec: isFinite(dec) ? +dec.toFixed(2) : null, dur: +dur.toFixed(1) };
  },
  fist(S) { const F = (S || []).filter(Boolean); return { l: BODYA.fistHand(F, 'l'), r: BODYA.fistHand(F, 'r') }; },
  all(B) {
    if (!B) return null;
    return { fit: B.fit, err: B.err || null, breath: BODYA.breath(B.breath), drift: BODYA.drift(B.drift), tremor: BODYA.tremor(B.tremor), fist: BODYA.fist(B.fist),
      n: { breath: B.breath.length, drift: B.drift.length, tremor: B.tremor.length, fist: B.fist.length } };
  },
};
function motorFeature(cap) {
  if (!cap || cap.err) return { valid: false, failure_code: cap?.err === 'perm' ? 'Q-011' : 'Q-001' };
  const A = BODYA.all(cap); const v = {};
  if (A.drift.ok) { v.drift_asym = A.drift.asym; v.drift_drop_l = A.drift.dropL; v.drift_drop_r = A.drift.dropR; }
  const tw = [A.tremor.l, A.tremor.r].filter(x => x && x.ok); if (tw.length) { v.tremor_amp_pct = Math.max(...tw.map(x => x.amp)); v.tremor_hz = tw.find(x => x.amp === v.tremor_amp_pct).hz; }
  const fw = [A.fist.l, A.fist.r].filter(x => x && x.ok); if (fw.length) { v.fist_rate_min = Math.min(...fw.map(x => x.rate)); const d = fw.map(x => x.dec).filter(x => x != null); v.fist_dec_min = d.length ? Math.min(...d) : null; }
  if (A.breath.ok) { v.shoulder_rr = A.breath.rr; v.shoulder_tilt_deg = A.breath.tilt; }
  if (!Object.keys(v).length) return { valid: false, failure_code: 'Q-001', value: { why: [A.drift.why, A.breath.why].filter(Boolean) } };
  return { valid: true, quality: 'pass', value: v, raw: A };
}
// M07: { conj:{eye:'L'|'R', display_mirrored, roi:{L,a,b,px,ei}, skin:{L,a,b}, sharp, glare, state}, nail:{nail:{L,a,b}, skin:{L,a,b}, px}, neck:{neck:{L}, cheek:{L}, px} }
function conjFeature(c) {
  if (!c || c.skipped) return { valid: false, failure_code: c?.skipped ? 'Q-012' : 'Q-007' };
  if (!c.roi || c.roi.px < 150 || c.state !== 'OK') return { valid: false, failure_code: 'Q-007', value: { state: c.state || null } };
  return { valid: true, quality: c.glare > 0.05 || c.sharp < 0.5 ? 'low' : 'pass', value: { conj_a: r(c.roi.a), conj_L: r(c.roi.L), conj_b: r(c.roi.b), erythema_idx: r(c.roi.ei, 3), skin_a: r(c.skin?.a), eye: c.eye, display_mirrored: !!c.display_mirrored, px: c.roi.px, sharp: r(c.sharp, 2) } };
}
function nailFeature(c) {
  if (!c || c.skipped || !c.nail || (c.px ?? 0) < 80) return { valid: false, failure_code: c?.skipped ? 'Q-012' : 'Q-001' };
  return { valid: true, quality: 'pass', value: { nail_a: r(c.nail.a), nail_L: r(c.nail.L), skin_a: r(c.skin?.a), rel_a: r(c.nail.a - (c.skin?.a ?? NaN)), polish_suspect: !!c.polish } };
}
function neckFeature(c) {
  if (!c || c.skipped || !c.neck || (c.px ?? 0) < 80) return { valid: false, failure_code: c?.skipped ? 'Q-012' : 'Q-001' };
  return { valid: true, quality: 'pass', value: { neck_L: r(c.neck.L), cheek_L: r(c.cheek?.L), dL: r((c.cheek?.L ?? NaN) - c.neck.L) } };
}
// M08: 답변 그대로 (출처: 사용자 입력 — 기기가 잰 값인 척하지 않음)
function profileFeature(a) {
  if (!a) return { valid: false, failure_code: 'Q-010' };
  const v = { ...a }; if (isFinite(a.height_cm) && isFinite(a.weight_kg)) v.bmi = r(a.weight_kg / (a.height_cm / 100) ** 2, 1);
  return { valid: true, quality: 'pass', value: v, source: 'user_input' };
}

// 미션별로 어떤 특징을 뽑는지. 같은 Capture 하나에서 여러 특징을 뽑음 (재촬영 없음)
const EXTRACT = {
  M01: cap => [['F-PULSE-01', pulseFeature(cap.frames, cap)], ['F-RESP-01', (() => { const x = respFeatureFace(cap.frames); return x ? { valid: true, quality: 'pass', value: { face: x } } : { valid: false, failure_code: 'Q-005' }; })()],
    ['F-EYE-01', eyeFeature(cap.frames)], ['F-FACE-01', faceFeature(cap.stills)], ['F-SCLERA-01', scleraFeature(cap.stills)]],
  M02: cap => [['F-GAZE-01', gazeFeature(cap.samples)], ['F-SCLERA-01', scleraFeature(cap.stills)]],
  M03: cap => [['F-EXPR-01', exprFeature(cap)]],
  M04: cap => [['F-VOICE-01', voiceFeature(cap)]],
  M05: cap => [['F-COG-01', cogFeature(cap)]],
  M06: cap => { const m = motorFeature(cap); const out = [['F-MOTOR-01', m]]; if (m.valid && m.value.shoulder_rr != null) out.push(['F-RESP-01', { valid: true, quality: 'pass', value: { shoulder: { rpm: m.value.shoulder_rr } } }]); return out; },
  M07: cap => [['F-CONJ-01', conjFeature(cap.conj)], ['F-NAIL-01', nailFeature(cap.nail)], ['F-NECK-01', neckFeature(cap.neck)]],
  M08: cap => [['F-PROFILE-01', profileFeature(cap.answers)]],
};

/* ---------- 평가 규칙 (버전별 순수 함수 · 과거 결과 재현용으로 옛 버전도 보관) ---------- */
function framingham(age, sex, bmi, sbp, treated, smoker, dm) {
  const C = sex === 'm' ? { a: 3.11296, b: 0.79277, su: 1.85508, st: 1.92672, s: 0.70953, d: 0.53160, m: 23.9388, s0: 0.88431 }
    : { a: 2.72107, b: 0.51125, su: 2.81291, st: 2.88267, s: 0.61868, d: 0.77763, m: 26.0145, s0: 0.94833 };
  const L = C.a * Math.log(age) + C.b * Math.log(bmi) + (treated ? C.st : C.su) * Math.log(sbp) + C.s * (smoker ? 1 : 0) + C.d * (dm ? 1 : 0);
  return 100 * (1 - Math.pow(C.s0, Math.exp(L - C.m)));
}
const NA = (code, extra) => ({ status: 'insufficient', code, reason: QCODES[code] || code, ...extra });
const need = (F, t) => F[t] && F[t].valid ? F[t] : null;

const ASSESSMENTS = {
  'A-HR-01': { name: '안정 심박수', kind: 'measured', release: 'reference', target_release: 'released', inputs: ['F-PULSE-01'], evidence: [['EV-001', 'sensing_principle']], reference_population: '없음 (기기별 정확도 검증 전)',
    limits: '파일럿 QA(기준 기기 비교) 통과 전까지 참고용. 50/100 bpm은 의료 판정이 아닌 화면 안내 경계.', algorithm_version: 'pulse-1.2.0',
    rules: { '1.0.0': F => { const p = need(F, 'F-PULSE-01'); if (!p) return NA(F['F-PULSE-01']?.failure_code || 'Q-005');
      const v = p.value; if (!(v.sqi.spec_snr_db > 0) || v.sqi.ok_beat_frac < 0.7) return NA('Q-002', { detail: v.sqi });
      if (v.hr_ibi == null || Math.abs(v.hr_ibi - v.hr_spec) > 5) return NA('Q-015', { detail: { hr_spec: v.hr_spec, hr_ibi: v.hr_ibi } });
      return { status: 'ok', value: Math.round((v.hr_spec + v.hr_ibi) / 2), unit: 'bpm', uncertainty: { two_method_diff_bpm: r(Math.abs(v.hr_ibi - v.hr_spec)) } }; } } },
  'A-PRV-01': { name: '맥파 간격 변동 (PRV)', kind: 'research_score', release: 'research', inputs: ['F-PULSE-01'], evidence: [['EV-001', 'sensing_principle']], reference_population: '없음',
    limits: '카메라 맥파 간격 변동(PRV)이며 심전도 심박변이(HRV)와 같지 않음. 짧은 측정의 안정성 미검증.', algorithm_version: 'pulse-1.2.0',
    rules: { '1.0.0': F => { const p = need(F, 'F-PULSE-01'); if (!p) return NA(F['F-PULSE-01']?.failure_code || 'Q-005'); const v = p.value;
      if (v.beats < 20 || v.rmssd_ms == null) return NA('Q-005'); if (v.rmssd_ms < 5 || v.rmssd_ms > 200) return NA('Q-002', { detail: { rmssd_ms: v.rmssd_ms } });
      return { status: 'ok', value: v.rmssd_ms, unit: 'ms (RMSSD)', uncertainty: { beats: v.beats } }; },
      // 1.1.0: 박동 시각 흔들림을 두 영역 비교로 추정해 빼고, 잡음이 실제 변동의 절반을 넘으면 값을 내지 않음
      '1.1.0': F => { const p = need(F, 'F-PULSE-01'); if (!p) return NA(F['F-PULSE-01']?.failure_code || 'Q-005'); const v = p.value;
        if (v.beats < 20 || v.rmssd_raw_ms == null) return NA('Q-005');
        if (v.prv_noise_frac == null) return NA('Q-005', { reason: '이마·볼 두 영역 비교가 안 되어 간격 정확도를 확인할 수 없어요' });
        if (v.ts_src === 'callback') return NA('Q-004', { reason: '이 기기·브라우저는 영상 장면의 촬영 시각을 알려 주지 않아 박동 간격을 정확히 잴 수 없어요' });
        if (v.pbig != null && v.pbig > 0.25) return NA('Q-015', { reason: '맥박 간격이 불규칙해 PRV(RMSSD)를 계산하지 않아요', detail: { pbig: v.pbig } });   // 불규칙 리듬에선 간격 걸러내기가 실제 변동을 깎아 과소 추정(시험: −20~−33%)
        if (v.prv_noise_frac > 0.15) return NA('Q-002', { detail: { beat_jitter_ms: v.beat_jitter_ms, prv_noise_frac: v.prv_noise_frac } });
        if (v.prv_mode_diff == null || v.prv_mode_diff > 0.3) return NA('Q-015', { detail: { rmssd_g_ms: v.rmssd_g_ms, rmssd_pos_ms: v.rmssd_pos_ms } });
        if (v.rmssd_ms < 5 || v.rmssd_ms > 200) return NA('Q-002', { detail: { rmssd_ms: v.rmssd_ms } });
        return { status: 'ok', value: v.rmssd_ms, unit: 'ms (RMSSD)', uncertainty: { beats: v.beats, beat_jitter_ms: v.beat_jitter_ms, noise_share_pct: Math.round(v.prv_noise_frac * 100) } }; } } },
  'A-STRESS-01': { name: '스트레스 점수', kind: 'research_score', release: 'held', inputs: ['F-PULSE-01', 'F-PROFILE-01'], evidence: [], reference_population: '없음',
    limits: 'r17의 100−백분위 변환은 자체 변환. 외부 기준 척도와 전향 검증 전 계산·공개 금지.', algorithm_version: '-', rules: { '1.0.0': () => ({ status: 'held' }) } },
  'A-RHYTHM-01': { name: '맥박 간격 불규칙 신호', kind: 'research_score', release: 'research', inputs: ['F-PULSE-01'], evidence: [['EV-001', 'sensing_principle']], reference_population: '없음',
    limits: '심방세동 진단·배제에 쓰지 않음. 심전도 대조 검증 필요. 판정 문구 없이 값만.', algorithm_version: 'pulse-1.2.0',
    rules: { '1.0.0': F => { const p = need(F, 'F-PULSE-01'); if (!p) return NA(F['F-PULSE-01']?.failure_code || 'Q-005'); const v = p.value;
      if (v.nrmssd == null) return NA('Q-005'); return { status: 'ok', value: r(v.nrmssd * 100), unit: '% (간격 변동)', extra: { pbig_pct: r(v.pbig * 100) } }; },
      '1.1.0': F => { const p = need(F, 'F-PULSE-01'); if (!p) return NA(F['F-PULSE-01']?.failure_code || 'Q-005'); const v = p.value;
        if (v.nrmssd == null) return NA('Q-005');
        // 초당 10~15장에선 정상 리듬도 값이 2~4배로 부풀어(시험) 불규칙과 겹침
        if (v.ts_src === 'callback' || (v.sqi && v.sqi.fps < 24)) return NA('Q-004', { detail: { fps: v.sqi && v.sqi.fps } });
        // 박동 시각 잡음이 실제 변동의 15%를 넘으면 정상 리듬도 불규칙처럼 보임(시험: 잡음 큰 정상 리듬이 최대 41%)
        if (v.prv_noise_frac == null || v.prv_noise_frac > 0.15) return NA('Q-002', { detail: { prv_noise_frac: v.prv_noise_frac } });
        return { status: 'ok', value: r(v.nrmssd * 100), unit: '% (간격 변동)', extra: { pbig_pct: r(v.pbig * 100), beat_jitter_ms: v.beat_jitter_ms } }; } } },
  'A-RR-01': { name: '호흡수 추정', kind: 'estimated', release: 'research', inputs: ['F-RESP-01'], evidence: [], reference_population: '없음',
    limits: '독립 추정값 2개 이상이 3회/분 안으로 맞을 때만 값 표시. 기준 호흡 측정기 비교 전 정상 범위 판정 없음.', algorithm_version: 'resp-1.0.0',
    rules: { '1.0.0': F => { const f = need(F, 'F-RESP-01'); if (!f) return NA('Q-005'); const ests = [];
      if (f.value.face) { if (f.value.face.motion_snr > -1) ests.push(['얼굴 움직임', f.value.face.motion_rpm]); if (f.value.face.color_snr > -1) ests.push(['피부색', f.value.face.color_rpm]); }
      if (f.value.shoulder) ests.push(['어깨', f.value.shoulder.rpm]);
      const vals = ests.map(e => e[1]).filter(x => isFinite(x) && x >= 6 && x <= 40); if (vals.length < 2) return NA('Q-005', { detail: { estimates: ests } });
      const spread = Math.max(...vals) - Math.min(...vals); if (spread > 3) return NA('Q-015', { detail: { estimates: ests } });
      return { status: 'ok', value: r(DSP.mean(vals)), unit: '회/분', uncertainty: { estimates: ests, spread_rpm: r(spread) } }; } } },
  'A-BLINK-01': { name: '눈 깜빡임 횟수', kind: 'measured', release: 'reference', inputs: ['F-EYE-01'], evidence: [], reference_population: '없음',
    limits: '화면을 보는 동안의 횟수. 건조·피로 판정 기준 없음.', algorithm_version: 'eye-1.1.0',
    rules: { '1.0.0': F => { const e = need(F, 'F-EYE-01'); if (!e) return NA(F['F-EYE-01']?.failure_code || 'Q-005'); return { status: 'ok', value: e.value.blink_per_min, unit: '회/분', uncertainty: { dur_s: e.value.dur_s } }; },
      // 1.1.0: 얼굴 점 갱신이 초당 10회 미만이면 짧은 깜빡임(0.1~0.2초)을 놓치므로 값을 내지 않음
      '1.1.0': F => { const e = need(F, 'F-EYE-01'); if (!e) return NA(F['F-EYE-01']?.failure_code || 'Q-005'); const v = e.value;
        if (v.landmark_fps != null && v.landmark_fps < 10) return NA('Q-004', { detail: { landmark_fps: v.landmark_fps } });
        if (v.ear_noise != null && v.ear_noise >= 0.2 * v.open_ear) return NA('Q-003', { detail: { ear_noise: v.ear_noise } });
        return { status: 'ok', value: v.blink_per_min, unit: '회/분', uncertainty: { dur_s: v.dur_s, landmark_fps: v.landmark_fps } }; } } },
  'A-PERCLOS-01': { name: '눈 감김 시간 비율 (PERCLOS)', kind: 'measured', release: 'research', inputs: ['F-EYE-01'], evidence: [['EV-007', 'biomarker_association']], reference_population: '없음',
    limits: '짧은 측정. 기존 15% 경계는 검증 전이라 판정하지 않음.', algorithm_version: 'eye-1.1.0',
    rules: { '1.0.0': F => { const e = need(F, 'F-EYE-01'); if (!e) return NA(F['F-EYE-01']?.failure_code || 'Q-005'); return { status: 'ok', value: e.value.perclos_pct, unit: '%' }; },
      '1.1.0': F => { const e = need(F, 'F-EYE-01'); if (!e) return NA(F['F-EYE-01']?.failure_code || 'Q-005'); if (e.value.landmark_fps != null && e.value.landmark_fps < 10) return NA('Q-004', { detail: { landmark_fps: e.value.landmark_fps } }); return { status: 'ok', value: e.value.perclos_pct, unit: '%' }; } } },
  'A-EYELID-01': { name: '눈꺼풀 열림 좌우 차', kind: 'observation', release: 'reference', inputs: ['F-EYE-01'], evidence: [], reference_population: '없음',
    limits: '눈 모양 비율(EAR)의 좌우 차. 안검하수 판정 아님.', algorithm_version: 'eye-1.1.0',
    rules: { '1.0.0': F => { const e = need(F, 'F-EYE-01'); if (!e) return NA(F['F-EYE-01']?.failure_code || 'Q-005'); return { status: 'ok', value: e.value.lid_asym_pct, unit: '%' }; } } },
  'A-SCLERA-01': { name: '흰자 노란기', kind: 'observation', release: 'reference', inputs: ['F-SCLERA-01'], evidence: [['EV-004', 'biomarker_association']], reference_population: '없음',
    limits: '조명·화이트밸런스 영향이 큼. 빌리루빈·간 기능 진단 아님. 내 이전 측정과의 변화만 참고.', algorithm_version: 'sclera-1.0.0',
    rules: { '1.0.0': (F, ctx) => { const s = need(F, 'F-SCLERA-01'); if (!s) return NA(F['F-SCLERA-01']?.failure_code || 'Q-006');
      const hist = (ctx.history || []).map(h => h['A-SCLERA-01']).filter(isFinite), base = hist.length >= 2 ? DSP.median(hist) : null;
      return { status: 'ok', value: s.value.sclera_b_cast_adj, unit: 'b* (노란기)', extra: { my_baseline: r(base), change: base != null ? r(s.value.sclera_b_cast_adj - base) : null } }; } } },
  'A-ANEMIA-01': { name: '눈꺼풀 안쪽 혈색', kind: 'observation', release: 'research', inputs: ['F-CONJ-01'], evidence: [['EV-002', 'biomarker_association'], ['EV-003', 'biomarker_association']], reference_population: '없음',
    limits: '혈색소(Hb) 예측 아님. 색보정 없는 휴대폰 사진. 혈액검사 대조·기종별 외부 검증 필요.', algorithm_version: 'conj-0.1.0',
    rules: { '1.0.0': F => { const c = need(F, 'F-CONJ-01'); if (!c) return NA(F['F-CONJ-01']?.failure_code || 'Q-007'); return { status: 'ok', value: c.value.conj_a, unit: 'a* (붉은기)', extra: { erythema_idx: c.value.erythema_idx, eye: c.value.eye } }; } } },
  'A-NAIL-01': { name: '손톱 혈색', kind: 'observation', release: 'research', inputs: ['F-NAIL-01'], evidence: [], reference_population: '없음', limits: '조명·매니큐어 영향. 빈혈 판정 아님.', algorithm_version: 'nail-0.1.0',
    rules: { '1.0.0': F => { const c = need(F, 'F-NAIL-01'); if (!c) return NA(F['F-NAIL-01']?.failure_code || 'Q-001'); return { status: 'ok', value: c.value.rel_a, unit: '손가락 피부 대비 a*' }; } } },
  'A-NECK-01': { name: '목·얼굴 밝기 차', kind: 'observation', release: 'research', inputs: ['F-NECK-01'], evidence: [], reference_population: '없음', limits: '그림자 영향. 인슐린 저항성 판정 아님.', algorithm_version: 'neck-0.1.0',
    rules: { '1.0.0': F => { const c = need(F, 'F-NECK-01'); if (!c) return NA(F['F-NECK-01']?.failure_code || 'Q-001'); return { status: 'ok', value: c.value.dL, unit: 'ΔL*' }; } } },
  'A-SMILE-01': { name: '표정 좌우 대칭', kind: 'observation', release: 'reference', inputs: ['F-EXPR-01'], evidence: [], reference_population: '없음',
    limits: '입꼬리 이동량의 좌우 차. 뇌졸중 선별에 단독 사용 금지. 평소 측정과 비교 권장.', algorithm_version: 'expr-1.0.0',
    rules: { '1.0.0': F => { const x = need(F, 'F-EXPR-01'); if (!x) return NA(F['F-EXPR-01']?.failure_code || 'Q-014'); return { status: 'ok', value: x.value.smile_asym_pct, unit: '% (좌우 차)', extra: { widen: x.value.smile_widen, close_ratio: x.value.close_ratio } }; } } },
  'A-GAZE-01': { name: '시선 따라가기', kind: 'research_score', release: 'research', inputs: ['F-GAZE-01'], evidence: [], reference_population: '없음',
    limits: '전면 카메라로는 의료 수준 안구운동 측정을 보장할 수 없음.', algorithm_version: 'gaze-0.1.0',
    rules: { '1.0.0': F => { const g = need(F, 'F-GAZE-01'); if (!g) return NA(F['F-GAZE-01']?.failure_code || 'Q-013'); return { status: 'ok', value: g.value.follow_h, unit: '따라감 상관 (0~1)', extra: { latency_ms: g.value.latency_ms, lr_asym: g.value.lr_asym } }; } } },
  'A-SPEECH-01': { name: '발화 수행 특징', kind: 'research_score', release: 'research', inputs: ['F-VOICE-01'], evidence: [], reference_population: '없음',
    limits: '언어·억양·마이크·잡음 영향. 우울·뇌졸중 판정 금지. 한국어 기준 데이터 필요.', algorithm_version: 'voice-1.0.0',
    rules: { '1.0.0': F => { const v = need(F, 'F-VOICE-01'); if (!v) return NA(F['F-VOICE-01']?.failure_code || 'Q-008'); return { status: 'ok', value: v.value.syll_per_s, unit: '음절/초', extra: { pauses: v.value.pauses, artic: v.value.artic_syll_per_s } }; } } },
  'A-COG-01': { name: '기억·주의·반응 과제 결과', kind: 'task', release: 'released', release_basis: 'task_score', inputs: ['F-COG-01'], evidence: [], reference_population: '없음 (나이 표준화 전)',
    limits: '과제 정답 수와 반응 시간 그대로. 나이 표준화 전이라 정상·이상 판정 없음.', algorithm_version: 'cog-1.0.0',
    rules: { '1.0.0': F => { const c = need(F, 'F-COG-01'); if (!c) return NA(F['F-COG-01']?.failure_code || 'Q-005'); const v = c.value;
      return { status: 'ok', value: v.recall_correct != null ? `${v.recall_correct}/${v.recall_of}` : null, unit: '단어 기억', extra: { stroop_acc_pct: v.stroop_acc_pct, stroop_rt_ms: v.stroop_rt_ms, stroop_interf_ms: v.stroop_interf_ms, rt_ms: v.rt_ms, rt_cv_pct: v.rt_cv_pct } }; } } },
  'A-BRAINAGE-01': { name: '인지 수행 나이', kind: 'research_score', release: 'held', inputs: ['F-COG-01', 'F-PROFILE-01'], evidence: [], reference_population: '없음',
    limits: '종단·외부 검증된 회귀와 신뢰구간 확보 전 계산·공개 금지.', algorithm_version: '-', rules: { '1.0.0': () => ({ status: 'held' }) } },
  'A-MOTOR-01': { name: '상지 동작 특징', kind: 'research_score', release: 'research', inputs: ['F-MOTOR-01'], evidence: [], reference_population: '없음',
    limits: '화면 비율 단위(실제 mm 아님). 자세·거리 영향. 판정 없음.', algorithm_version: 'motor-1.0.0',
    rules: { '1.0.0': F => { const m = need(F, 'F-MOTOR-01'); if (!m) return NA(F['F-MOTOR-01']?.failure_code || 'Q-001'); const v = m.value;
      return { status: 'ok', value: v.drift_asym ?? null, unit: '팔 처짐 좌우 차 (어깨너비 대비)', extra: { tremor_amp_pct: v.tremor_amp_pct, tremor_hz: v.tremor_hz, fist_rate_min: v.fist_rate_min, fist_dec_min: v.fist_dec_min } }; } } },
  'A-STOPBANG-01': { name: '수면무호흡 위험 설문 (STOP-Bang)', kind: 'screening', release: 'reference', inputs: ['F-PROFILE-01'], evidence: [['EV-005', 'cutoff_validation']], reference_population: 'EV-005 연구 집단',
    limits: '설문 선별 점수. 수면다원검사(AHI) 결과가 아님. 집단마다 정확도가 다름.', algorithm_version: 'stopbang-1.0.0',
    rules: { '1.0.0': F => { const p = need(F, 'F-PROFILE-01'); if (!p) return NA('Q-010'); const a = p.value;
      const items = { S: a.snore, T: a.tired, O: a.apnea_seen, P: a.htn === true || a.sbp >= 140 ? true : a.htn, B: isFinite(a.bmi) ? a.bmi > 35 : null, A: isFinite(a.age) ? a.age > 50 : null, N: a.neck_gt40, G: a.sex ? a.sex === 'm' : null };
      const miss = Object.entries(items).filter(([, v]) => v == null).map(([k]) => k); if (miss.length) return NA('Q-010', { detail: { missing: miss } });
      const score = Object.values(items).filter(Boolean).length; return { status: 'ok', value: score, unit: '/8점', label: score >= 3 ? '선별 기준(3점 이상) 해당' : '선별 기준 미만', label_cutoff: '≥3 (EV-005)', extra: { items } }; } } },
  'A-FRAMINGHAM-01': { name: '10년 심혈관질환 위험 (Framingham)', kind: 'screening', release: 'reference', inputs: ['F-PROFILE-01'], evidence: [['EV-006', 'biomarker_association']], reference_population: 'Framingham 코호트 (미국)',
    limits: '30~74세·심혈관질환 없는 경우만. 한국인 재보정 전. 위험 구간 문구는 표시하지 않음.', algorithm_version: 'frs-bmi-2008',
    rules: { '1.0.0': F => { const p = need(F, 'F-PROFILE-01'); if (!p) return NA('Q-010'); const a = p.value;
      const miss = ['age', 'sex', 'bmi', 'sbp', 'bp_treated', 'smoker', 'diabetes', 'prior_cvd'].filter(k => a[k] == null); if (miss.length) return NA('Q-010', { detail: { missing: miss } });
      if (a.prior_cvd) return NA('Q-010', { reason: '심혈관질환이 이미 있으면 이 공식을 쓰지 않아요' }); if (a.age < 30 || a.age > 74) return NA('Q-010', { reason: '30~74세에만 쓰는 공식이에요' });
      const v = framingham(a.age, a.sex, a.bmi, a.sbp, !!a.bp_treated, !!a.smoker, !!a.diabetes);
      return { status: 'ok', value: r(v, 1), unit: '% (10년)', label: v >= 20 ? '높음' : v >= 10 ? '중간' : '낮음' }; } } },
  'A-SKIN-01': { name: '피부 톤·결·광택', kind: 'observation', release: 'reference', inputs: ['F-FACE-01'], evidence: [], reference_population: '없음',
    limits: '색 편차·질감·반사 면적만 측정. 수분량·유분량을 직접 재는 것이 아님.', algorithm_version: 'face-1.0.0',
    rules: { '1.0.0': F => { const f = need(F, 'F-FACE-01'); if (!f) return NA(F['F-FACE-01']?.failure_code || 'Q-001'); if (f.quality === 'low') return NA('Q-003'); const v = f.value;
      return { status: 'ok', value: v.cheek_L, unit: '볼 밝기 L*', extra: { cheek_a: v.cheek_a, cheek_b: v.cheek_b, tone_sd: v.tone_sd, gloss_pct: v.gloss_pct, texture: v.texture } }; } } },
  'A-APPEARANCEAGE-01': { name: '외관상 추정 나이', kind: 'entertainment', release: 'reference', inputs: ['F-FACE-01'], evidence: [], reference_population: '공개 얼굴 나이 모델 학습 데이터',
    limits: '오락·외관 전용. 건강 나이가 아님. v1의 실제 나이 섞기(0.6·0.4)와 ±12 제한은 쓰지 않고 모델 추정값만 보여 줌.', algorithm_version: 'face-api-age-1.7.13',
    rules: { '1.0.0': F => { const f = need(F, 'F-FACE-01'); if (!f || f.value.appearance_age_model == null) return NA('Q-001'); return { status: 'ok', value: Math.round(f.value.appearance_age_model), unit: '세', uncertainty: { n_frames: f.value.age_n } }; } } },
};
// 버전: 각 평가의 현재 규칙 버전 = rules 중 가장 높은 버전
const latestRule = A => Object.keys(A.rules).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();

/* ---------- r17(v1) 항목 정규화 (명세 I-1). 기존 이름·기준·상태는 legacy로 보존 ---------- */
const LEGACY_R17 = [
  ['hr', '안정 심박수', '50 미만·100 초과 관찰(품질 3 이상)', 'A-HR-01'], ['hrv', '심박변이 / 스트레스', '100−백분위, 35/65 구간', 'A-PRV-01 · A-STRESS-01(보류)'], ['rhythm', '심장 리듬(불규칙 맥박)', 'nRMSSD>12% AND pBig>35% 관찰', 'A-RHYTHM-01'],
  ['rr', '호흡수', '두 방식 3회/분 이내 일치', 'A-RR-01'], ['blink', '눈 깜빡임', '6 미만·32 초과 관찰', 'A-BLINK-01'], ['drowsy', '졸음 신호', '눈 감긴 시간 15% 이상 관찰', 'A-PERCLOS-01'],
  ['sclera', '눈 흰자 노란기', 'b* 10/15', 'A-SCLERA-01'], ['conj', '눈꺼풀 안쪽 혈색', 'a* 22/16', 'A-ANEMIA-01'], ['nail', '손톱 혈색', 'a*<7 AND 대비<−4', 'A-NAIL-01'], ['neck', '목 피부 착색', 'ΔL* 13/18', 'A-NECK-01'],
  ['smile', '미소 좌우 대칭', '35%/60%', 'A-SMILE-01'], ['ptosis', '눈꺼풀 처짐', 'MRD1 2.8/1.8mm', 'A-EYELID-01 (형태만, MRD1 환산 안 함)'], ['pursuit', 'BE-FAST E 시선', 'follow<0.3, asym>0.6', 'A-GAZE-01'],
  ['speech', 'BE-FAST S 말', '1.8/2.5 음절/초, 멈춤 3회', 'A-SPEECH-01'], ['recall', '단어 기억', 'Mini-Cog 방식', 'A-COG-01'], ['stroop', '스트룹', '난이도별 정답률', 'A-COG-01'], ['rt', '반응 속도', '기대값+30%, CV 40%', 'A-COG-01'],
  ['brainAge', '두뇌 나이', '나이별 기대 반응시간', 'A-BRAINAGE-01(보류)'], ['bDrift', '팔 처짐', '0.18/0.30', 'A-MOTOR-01'], ['bTremor', '손 떨림', '1% + SNR>3', 'A-MOTOR-01'], ['bFist', '주먹 쥐었다 펴기', '0.6회/초 등', 'A-MOTOR-01'],
  ['bBreath', '어깨 호흡', '10/24회', 'A-RR-01'], ['osa', '수면무호흡(STOP-Bang)', '3/5점', 'A-STOPBANG-01'], ['frs', '10년 심뇌혈관 위험', '10/20%', 'A-FRAMINGHAM-01'],
  ['skin', '피부 점수(수분·유분 등)', '점수 구간', 'A-SKIN-01 (이름 변경: 수분·유분 → 결·광택)'], ['faceAge', '얼굴 나이', '0.6 추정+0.4 실제, ±12', 'A-APPEARANCEAGE-01 (모델값만)'],
  ['skinY', '피부 노란기', 'b* 24', null], ['lip', '입술 색', 'a*<12 AND b*<4', null], ['xan', '황색판종', 'b* 10/15', null], ['gray', '흰머리 비율', '30%', null], ['swell', '얼굴 붓기', '+3/+6%', null],
  ['adip', '얼굴 살집', '±5%', null], ['malar', '나비 모양 붉은기', 'a* 4/7', null], ['retract', '흰자 노출', '0.12', null], ['redeye', '눈 충혈', 'a* 10', null], ['tiredface', '얼굴 피로도', '55점', null],
  ['mood', '마음 건강', '즐거움·우울 1~5', null], ['expressive', '표정 움직임 크기', '1.06배+깜빡임 8', null], ['tap', '손가락 두드리기', '3.5회/초, 75%', null], ['scd', '기억력 자가 체크', '1/2개', null],
  ['risk', '뇌혈관 위험 요인', '2/3개', null], ['coronary', '협심증·심근경색 위험 신호', '문진+요인+카메라 보조', null], ['stroke', '뇌졸중 위험 신호', '문진→BE-FAST→CHA2DS2-VA', null], ['eyeAge', '눈가 나이', '실제 ±10', null], ['bTilt', '어깨 기울기', '5°', null],
].map(([legacy_id, legacy_name, legacy_criteria, v2]) => ({ legacy_id, legacy_name, legacy_criteria, legacy_status: 'r17 사용 중', v2_assessment: v2, v2_note: v2 ? '' : 'v2 시험판 범위 밖 (다음 단계에서 레지스트리 규칙으로 옮길 예정)' }));

/* ======================= 세션 · 계보 ======================= */
function createSession(opts = {}) {
  return { id: newId('S'), created_at: new Date().toISOString(), engine_version: ENGINE_VERSION, sim: !!opts.sim, device: opts.device || null, consent: opts.consent || null,
    captures: [], features: [], assessments: [], attempts: [], active: {}, log: [] };
}
// Capture는 한 번 만들면 바꿀 수 없음 (동결 + 내용 해시)
function addCapture(session, missionId, payload, meta = {}) {
  const M = MISSIONS[missionId]; if (!M) throw new Error('unknown mission ' + missionId);
  const body = { mission_id: missionId, mission_version: M.version, payload };
  const cap = deepFreeze({ id: newId('C'), session_id: session.id, mission_id: missionId, mission_version: M.version, timestamp_start: meta.t_start || new Date().toISOString(), timestamp_end: meta.t_end || new Date().toISOString(),
    device_id: meta.device_id || null, display_mirrored: meta.display_mirrored ?? null, consent_scope: meta.consent_scope || 'features_on_device', retention_policy_id: meta.retention || 'RP-LOCAL-FEATURES', calibration_id: meta.calibration_id || null,
    media_uri_encrypted: null, sim: !!session.sim || !!meta.sim, attempt_no: meta.attempt_no || 1, payload_hash: sha256(stable(body)), payload });
  session.captures.push(cap); session.active[missionId] = cap.id; session.log.push({ at: Date.now(), ev: 'capture', mission: missionId, capture_id: cap.id });
  return cap;
}
function verifyCapture(cap) { return sha256(stable({ mission_id: cap.mission_id, mission_version: cap.mission_version, payload: cap.payload })) === cap.payload_hash; }
// Capture 1개 → Feature 여러 개 (각 Feature는 동결)
function extractFeatures(session, cap) {
  const fx = EXTRACT[cap.mission_id]; if (!fx) return [];
  const out = fx(cap.payload).map(([type, res]) => deepFreeze({ id: newId('F'), feature_type: type, capture_id: cap.id, mission_id: cap.mission_id, method_version: FEATURE_TYPES[type].method_version,
    valid: !!res.valid, failure_code: res.valid ? null : res.failure_code || 'Q-005', quality: res.quality || (res.valid ? 'pass' : 'fail'), value: res.value ?? null, uncertainty: res.uncertainty ?? null, source: res.source || 'sensor', created_at: new Date().toISOString() }));
  session.features.push(...out); return out;
}
// 평가에 쓸 특징 고르기: 유효한 것 중 '현재 활성 Capture'에서 나온 것 우선, 같은 종류가 여러 미션에서 나오면 미션 우선순위(FEATURE_TYPES.from 순서)
function pickFeatures(session, types) {
  const F = {};
  for (const t of types) {
    const pri = FEATURE_TYPES[t].from, act = new Set(Object.values(session.active));
    const cand = session.features.filter(f => f.feature_type === t && act.has(f.capture_id));
    cand.sort((a, b) => (b.valid - a.valid) || (pri.indexOf(a.mission_id) - pri.indexOf(b.mission_id)));
    // 호흡: 얼굴·어깨 등 서로 다른 출처를 합침 (같은 수집을 다시 쓰는 것이지 재촬영 아님)
    if (t === 'F-RESP-01' && cand.filter(f => f.valid).length > 1) { const v = Object.assign({}, ...cand.filter(f => f.valid).map(f => f.value)); F[t] = { ...cand[0], value: v, _merged: cand.filter(f => f.valid).map(f => f.id) }; continue; }
    F[t] = cand[0] || null;
  }
  return F;
}
function evidenceAllowsLabel(A) { return (A.evidence || []).some(([, sup]) => sup === 'cutoff_validation'); }
function releaseOf(A, aver) {
  if (A.release === 'held') return 'held';
  if (A.release === 'released' && A.release_basis !== 'task_score' && !VALIDATIONS.some(v => v.assessment_type === A.id && v.algorithm_version === aver)) return 'reference';
  return A.release;
}
function runRule(id, F, ctx, ver) {
  const A = ASSESSMENTS[id], v = ver || latestRule(A), fn = A.rules[v]; if (!fn) throw new Error(`rule ${id}@${v} 없음`);
  const res = fn(F, ctx || {}) || NA('Q-005'); const exclusions = [];
  // 검증 안 된 기준값으로 사용자 판정 문구를 내지 않음
  if (res.label && !evidenceAllowsLabel(A)) { exclusions.push('label_blocked_unvalidated_cutoff'); delete res.label; }
  return { res, rule_version: v, exclusions };
}
// 저장된 특징만 읽어 평가 (여기서 Capture를 만들 수 없음 → 재촬영 불가)
function evaluate(session, requested, ctx = {}) {
  const ids = requested || Object.keys(ASSESSMENTS), out = [];
  for (const id of ids) {
    const A = ASSESSMENTS[id]; if (!A) continue;
    const F = pickFeatures(session, A.inputs), { res, rule_version, exclusions } = runRule(id, F, ctx);
    // 특징이 하나도 없고 그 미션을 건너뛰었거나 권한이 없었으면 그 이유로 표시 (데이터 부족과 구분)
    if (res.status === 'insufficient' && A.inputs.every(t => !F[t])) { const sk = ctx.skipped || {}, m = A.inputs.flatMap(t => FEATURE_TYPES[t].from).find(x => sk[x]); if (m) { const c = sk[m] === 'Q-011' ? 'Q-011' : 'Q-012'; res.code = c; res.reason = QCODES[c]; } else if (!A.inputs.some(t => FEATURE_TYPES[t].from.some(x => session.captures.some(c => c.mission_id === x)))) { res.code = 'Q-012'; res.reason = '이 항목에 필요한 미션을 하지 않았어요'; } }
    const used = Object.values(F).filter(Boolean), fids = used.flatMap(f => f._merged || [f.id]);
    const capIds = [...new Set(session.features.filter(f => fids.includes(f.id)).map(f => f.capture_id))];
    const status = res.status === 'held' ? 'held' : res.status === 'insufficient' ? 'insufficient' : releaseOf(A, A.algorithm_version);
    const rec = deepFreeze({ id: newId('A'), assessment_type: id, name: A.name, kind: A.kind, status, status_ko: STATUS_KO[status], feature_ids: fids, capture_ids: capIds,
      rule_version, algorithm_version: A.algorithm_version, engine_version: ENGINE_VERSION, evidence_ids: (A.evidence || []).map(e => e[0]), evidence_supports: Object.fromEntries((A.evidence || []).map(e => [e[0], e[1]])),
      output_value: res.status === 'ok' ? res.value ?? null : null, unit: res.unit || null, label: res.label || null, extra: res.extra || null, uncertainty: res.uncertainty || null,
      failure_code: res.status === 'insufficient' ? res.code : null, failure_reason: res.status === 'insufficient' ? (res.reason || QCODES[res.code]) : null, failure_detail: res.detail || null,
      quality: used.length ? (used.some(f => !f.valid) ? 'fail' : used.some(f => f.quality === 'low') ? 'low' : 'pass') : 'none',
      reference_population: A.reference_population, limits: A.limits, exclusions, sim: session.sim, executed_at: new Date().toISOString() });
    out.push(rec);
  }
  session.assessments.push(...out); return out;
}
// 과거 결과 재현: 저장된 규칙 버전 + 저장된 특징으로 다시 계산 (명세 I-8)
function reproduce(session, rec) {
  const feats = session.features.filter(f => rec.feature_ids.includes(f.id)), F = {};
  for (const f of feats) { if (F[f.feature_type] && f.feature_type === 'F-RESP-01') F[f.feature_type] = { ...F[f.feature_type], value: { ...F[f.feature_type].value, ...f.value } }; else F[f.feature_type] = f; }
  const { res } = runRule(rec.assessment_type, F, {}, rec.rule_version);
  return { output_value: res.status === 'ok' ? res.value ?? null : null, same: (res.status === 'ok' ? res.value ?? null : null) === rec.output_value };
}
// 공개 보기: 보류(held)는 제외
function publicView(session) {
  const latest = {}; session.assessments.forEach(a => { latest[a.assessment_type] = a; });
  const L = Object.values(latest).filter(a => a.status !== 'held');
  return { released: L.filter(a => a.status === 'released'), reference: L.filter(a => a.status === 'reference'), research: L.filter(a => a.status === 'research'), insufficient: L.filter(a => a.status === 'insufficient') };
}
// 요청한 평가를 덮는 최소 미션 (명세 G set cover). 정면 안정 맥파(M01)는 다른 미션으로 대체하지 않음
function chooseMissions(requested, opts = {}) {
  const need = new Set(); (requested || Object.keys(ASSESSMENTS)).forEach(id => (ASSESSMENTS[id]?.inputs || []).forEach(t => need.add(t)));
  if (ASSESSMENTS['A-HR-01'] && (requested || []).some(id => ['A-HR-01', 'A-PRV-01', 'A-RHYTHM-01'].includes(id))) need.add('F-PULSE-01');
  const avail = Object.values(MISSIONS).filter(m => !(opts.exclude || []).includes(m.id) && !(m.devices.includes('stand') && !opts.stand));
  const chosen = [], cover = new Set();
  // 1) 하나의 미션에서만 얻는 특징(hard)은 그 미션을 반드시 넣음
  for (const t of need) { const src = FEATURE_TYPES[t].from.filter(id => avail.some(m => m.id === id)); if (src.length === 1 && !chosen.includes(src[0])) chosen.push(src[0]); }
  chosen.forEach(id => MISSIONS[id].produces.forEach(t => cover.add(t)));
  // 2) 남은 특징: 시간 대비 덮는 개수가 큰 미션부터
  while ([...need].some(t => !cover.has(t))) {
    const left = [...need].filter(t => !cover.has(t)); let best = null, bs = 0;
    for (const m of avail) { if (chosen.includes(m.id)) continue; const c = m.produces.filter(t => left.includes(t)).length; const s = c / Math.max(10, m.min_s); if (c && s > bs) { bs = s; best = m; } }
    if (!best) break; chosen.push(best.id); best.produces.forEach(t => cover.add(t));
  }
  const uncovered = [...need].filter(t => !cover.has(t));
  return { missions: chosen.sort((a, b) => MISSIONS[a].order - MISSIONS[b].order), uncovered };
}
// 미션 하나만 다시 수집할 때: 그 미션의 특징만 새로 뽑고, 다른 미션 Capture는 그대로 재사용
function retarget(session, missionId, payload, meta) {
  const prev = session.active[missionId]; const cap = addCapture(session, missionId, payload, { ...meta, attempt_no: (session.captures.filter(c => c.mission_id === missionId).length) });
  extractFeatures(session, cap); session.log.push({ at: Date.now(), ev: 'retry', mission: missionId, replaced: prev || null, capture_id: cap.id }); return cap;
}
function exportJSON(session) { return JSON.stringify({ format: 'facecheck-v2-session', engine_version: ENGINE_VERSION, ...session }, (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v, 1); }
function exportCSV(session) {
  const q = v => { let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (typeof v !== 'number' && s !== '-' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['assessment_id', 'name', 'status', 'value', 'unit', 'label', 'quality', 'failure_code', 'rule_version', 'algorithm_version', 'feature_ids', 'capture_ids', 'evidence_ids', 'reference_population', 'sim', 'executed_at']];
  session.assessments.forEach(a => rows.push([a.assessment_type, a.name, a.status, a.output_value, a.unit, a.label, a.quality, a.failure_code, a.rule_version, a.algorithm_version, a.feature_ids.join(' '), a.capture_ids.join(' '), a.evidence_ids.join(' '), a.reference_population, a.sim, a.executed_at]));
  return rows.map(r => r.map(q).join(',')).join('\n');
}

/* ======================= 시뮬레이션 (원시 신호를 만들어 같은 계산을 거침) ======================= */
function rng(seed) { let s = seed >>> 0 || 7; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
const SIM = {
  M01(seed = 1, o = {}) {
    const R = rng(seed), fs = 30, n = (o.sec || 45) * fs, frames = []; let ph = 0, blinkLeft = 0;
    const hrB = o.hr ?? 68, rsa = o.rsa ?? 4, nz = o.noise ?? 0.15, br = (o.rr ?? 15) / 60;
    for (let i = 0; i < n; i++) { const t = i / fs, hr = hrB + rsa * Math.sin(2 * Math.PI * br * t); ph += hr / 60 / fs; const q = ph % 1, p = q < 0.15 ? q / 0.15 : Math.exp(-(q - 0.15) * 4), b = Math.sin(2 * Math.PI * br * t);
      if (blinkLeft <= 0 && R() > 0.495) blinkLeft = 5; const blinking = blinkLeft-- > 0;
      const g = 120 - 0.8 * p + 0.6 * b + nz * R() * 2, rr = 170 - 0.4 * p + 0.5 * b + nz * R() * 2, bb = 100 - 0.2 * p + nz * R() * 2;
      const e = [R(), R(), R()].map(x => x * nz * 0.6); frames.push({ t, ok: true, all: [rr, g, bb], fh: [rr + e[0], g + e[1], bb + e[2]], ck: [rr - e[0], g - e[1], bb - e[2]], cy: 0.47 + 0.004 * b, motion: o.moving && i % 90 < 10 ? 4 : 0, lum: 140, ear: blinking ? [0.08, 0.08] : [0.3 + 0.004 * R(), 0.29 + 0.004 * R()], faces: 1 }); }
    const stills = [0, 1, 2].map(k => ({ cheek: { L: 62 + R(), a: 13 + R(), b: 16 + R(), sd: 2.2 }, forehead: { L: 64, a: 11, b: 17 }, gloss_pct: 3.1, texture: 4.2, lum: 140, cast: 1.5, ages: o.noAge ? [] : [38 + 2 * R()], sclera: { L: 78, a: 3.5, b: 9 + R(), sd: 2, px: 220 } }));
    return { frames, stills, fps: fs };
  },
  M02(seed = 2, o = {}) {
    const R = rng(seed), seq = [[0.5, 0.5, 'h'], [0.1, 0.5, 'h'], [0.5, 0.5, 'h'], [0.9, 0.5, 'h'], [0.5, 0.5, 'h'], [0.5, 0.15, 'v'], [0.5, 0.5, 'v'], [0.5, 0.85, 'v'], [0.5, 0.5, 'v']], S = []; let t = 0;
    seq.forEach(([x, y, axis], k) => { const prev = k ? seq[k - 1] : seq[0];
      for (let i = 0; i < 12; i++) { const f = i / 11, tx = prev[0] + (x - prev[0]) * f, ty = prev[1] + (y - prev[1]) * f; S.push(mk(t, tx, ty, 'moving', axis, x - prev[0], y - prev[1])); t += 1 / 30; }
      for (let i = 0; i < 36; i++) { S.push(mk(t, x, y, 'hold', axis, 0, 0)); t += 1 / 30; } });
    function mk(tt, tx, ty, state, axis, dx, dy) { const lag = o.still ? 0 : 1; const ix = o.still ? 0.5 : 0.5 + (tx - 0.5) * 0.18 * lag, iy = o.still ? 0.5 : 0.5 + (ty - 0.5) * 0.12;
      return { t: tt, target: { x: tx, y: ty, state, axis, dx, dy }, iris: { x: ix + 0.005 * R(), y: iy + 0.005 * R() }, head: { yaw: o.headTurn ? (tx - 0.5) * 20 : R() }, conf: 0.9 }; }
    return { samples: S, stills: [{ cheek: { L: 62, a: 13, b: 16, sd: 2 }, lum: 140, cast: 1.5, sclera: { L: 79, a: 3.2, b: 8.6, sd: 2, px: 260 } }] };
  },
  M03(seed = 3) {
    const R = rng(seed), mk = (n, w, dy, ear) => Array.from({ length: n }, (_, i) => ({ t: i / 15, mL: { x: -0.5 * w + 0.002 * R(), y: 0.9 - dy + 0.002 * R() }, mR: { x: 0.5 * w + 0.002 * R(), y: 0.9 - dy * 0.95 + 0.002 * R() }, mw: w, ear: [ear, ear] }));
    return { phases: { neutral: mk(20, 1.0, 0, 0.3), smile: mk(20, 1.18, 0.08, 0.26), closed: mk(15, 1.0, 0, 0.06) }, iod: 1 };
  },
  M04(seed = 4, o = {}) { const R = rng(seed), env = []; const dt = 0.02, syl = 24;
    for (let i = 0; i < 400; i++) { const t = i * dt, speaking = t > 0.8 && t < 6.8 && !(t > 3.5 && t < 4.0), sy = Math.max(0, Math.sin(2 * Math.PI * 4 * t)); env.push(o.silent ? 0.002 + 0.001 * R() : speaking ? 0.05 + 0.15 * sy + 0.01 * R() : 0.003 + 0.002 * Math.abs(R())); }
    return { env, dt, syllables: syl, mic: true, completed: true }; },
  M05(seed = 5) { const R = rng(seed), ev = [];
    for (let i = 0; i < 2; i++) ev.push({ task: 'stroop', practice: true, congruent: true, correct: true, rt_ms: 900 });
    for (let i = 0; i < 12; i++) { const con = i % 2 === 0; ev.push({ task: 'stroop', practice: false, congruent: con, correct: R() > -0.42, rt_ms: Math.round((con ? 780 : 900) + 120 * R()) }); }
    for (let i = 0; i < 8; i++) ev.push({ task: 'rt', practice: false, correct: true, rt_ms: Math.round(330 + 60 * R()) });
    return { events: ev, recall: { shown: ['사과', '바다', '연필'], chosen: ['사과', '바다', '연필'], correct: 3, of: 3, wrong: 0, delay_s: 52 }, frame_ms: 16.7 }; },
  M07(seed = 7) { return { conj: { eye: 'R', display_mirrored: true, roi: { L: 52, a: 24, b: 9, px: 640, ei: 0.62 }, skin: { L: 63, a: 13, b: 16 }, sharp: 0.8, glare: 0.01, state: 'OK' }, nail: { nail: { L: 70, a: 11, b: 8 }, skin: { L: 66, a: 13, b: 15 }, px: 300 }, neck: { neck: { L: 58 }, cheek: { L: 63 }, px: 400 } }; },
  M08() { return { answers: { age: 52, sex: 'f', height_cm: 160, weight_kg: 58, sbp: 128, bp_treated: false, smoker: false, diabetes: false, prior_cvd: false, htn: false, snore: true, tired: true, apnea_seen: false, neck_gt40: false } }; },
};

const api = { ENGINE_VERSION, DSP, rgb2lab, sha256, stable, deepFreeze, QCODES, M07_CODES, MISSIONS, FEATURE_TYPES, EVIDENCE, VALIDATIONS, ASSESSMENTS, LEGACY_R17, KIND_KO, STATUS_KO, BODYA,
  extractors: { pulseFeature, respFeatureFace, eyeFeature, faceFeature, scleraFeature, gazeFeature, exprFeature, voiceFeature, cogFeature, motorFeature, conjFeature, nailFeature, neckFeature, profileFeature, beatTimes, roiJitter, resampleCubic },
  framingham, latestRule, createSession, addCapture, verifyCapture, extractFeatures, pickFeatures, evaluate, reproduce, publicView, chooseMissions, retarget, exportJSON, exportCSV, SIM };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FCV2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
