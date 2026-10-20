/* FaceCheck v2 시험판 — 화면·미션·상태머신. 계산은 engine.js(FCV2)가 담당
   상태머신(명세 K5): NOT_STARTED → PERMISSION_CHECK → DEVICE_CHECK → INSTRUCTION → DEMO → ALIGNING → READY → CAPTURING → QUALITY_REVIEW → ACCEPTED | RETRY_TARGETED | SKIPPED | BLOCKED */
'use strict';
const E = window.FCV2, $ = id => document.getElementById(id), sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now();
const QS = new URLSearchParams(location.search), DEV = QS.get('dev') === '1', SIM = QS.get('sim') === '1';
const APP_VER = 'FCv2-2026.10.20-t1';
const FM_VER = '0.4.1633559619', FM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${FM_VER}/`;
const FA_BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/';
const HOL_VER = '0.5.1675471629', HOL_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@${HOL_VER}/`;
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- 문구 (i18n 키 기반 · 한국어 기본, 영어 확장) ---------- */
const LANG = (QS.get('lang') || (navigator.language || 'ko')).startsWith('en') ? 'en' : 'ko';
const MSG = {
  ko: { 'state.ALIGNING': '자리 맞추는 중', 'state.READY': '준비됐어요', 'state.CAPTURING': '측정 중', 'state.QUALITY_REVIEW': '확인 중', 'state.ACCEPTED': '확보했어요', 'state.RETRY_TARGETED': '다시 필요해요', 'state.SKIPPED': '건너뜀', 'state.BLOCKED': '권한 없음',
    'btn.start': '시작', 'btn.next': '다음 미션', 'btn.retry': '이 미션만 다시 하기', 'btn.skip': '건너뛰기', 'btn.demo': '예시 보기', 'btn.done': '다 읽었어요' },
  en: { 'state.ALIGNING': 'Aligning', 'state.READY': 'Ready', 'state.CAPTURING': 'Capturing', 'state.QUALITY_REVIEW': 'Checking', 'state.ACCEPTED': 'Captured', 'state.RETRY_TARGETED': 'Retry needed', 'state.SKIPPED': 'Skipped', 'state.BLOCKED': 'No permission',
    'btn.start': 'Start', 'btn.next': 'Next mission', 'btn.retry': 'Retry this mission', 'btn.skip': 'Skip', 'btn.demo': 'Show example', 'btn.done': 'Done reading' },
};
const t = k => MSG[LANG][k] ?? MSG.ko[k] ?? k;

/* ---------- 공용 도구 ---------- */
let _toastT; function toast(m) { let el = document.querySelector('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); } el.textContent = m; el.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => el.hidden = true, 3200); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.crossOrigin = 'anonymous'; s.onload = ok; s.onerror = () => no(new Error('load ' + src)); document.head.appendChild(s); }); }
let actx = null; function beep(f = 880, ms = 140) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + ms / 1000); } catch {} }
function speak(txt) { if (!APP.voice || !txt) return Promise.resolve(); return new Promise(res => { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(txt); u.lang = LANG === 'en' ? 'en-US' : 'ko-KR'; u.rate = APP.assist ? 0.85 : 1; u.onend = u.onerror = () => res(); speechSynthesis.speak(u); setTimeout(res, 9000); } catch { res(); } }); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const fmt = (v, k = 1) => v == null || !isFinite(v) ? '—' : (+v).toFixed(k).replace(/\.0+$/, '');

/* ---------- 저장 (이 기기만 · IndexedDB) ---------- */
const DB = {
  _db: null,
  async open() { if (this._db) return this._db; this._db = await new Promise((ok, no) => { const r = indexedDB.open('fcv2', 1); r.onupgradeneeded = () => r.result.createObjectStore('sessions', { keyPath: 'id' }); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); return this._db; },
  async put(s) { try { const db = await this.open(); await new Promise((ok, no) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(JSON.parse(E.exportJSON(s))); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); } catch (e) { console.warn('save', e); } },
  async all() { try { const db = await this.open(); return await new Promise((ok, no) => { const r = db.transaction('sessions').objectStore('sessions').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => no(r.error); }); } catch { return []; } },
  async clear() { try { const db = await this.open(); await new Promise(ok => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').clear(); tx.oncomplete = ok; }); } catch {} },
};
const PKEY = 'fcv2.profile';
const loadProfile = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch { return {}; } };
const saveProfile = p => { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch {} };

/* ---------- 앱 상태 ---------- */
const APP = { session: null, plan: null, hold: 'hand', assist: false, voice: true, attempts: {}, consent: {}, abort: false, curMission: null, device: null, history: [] };
const ASSIST_KEY = 'fcv2.assist';
function setAssist(on) { APP.assist = on; document.documentElement.classList.toggle('assist', on); $('assistBtn').setAttribute('aria-pressed', String(on)); try { localStorage.setItem(ASSIST_KEY, on ? '1' : '0'); } catch {} }
try { setAssist(localStorage.getItem(ASSIST_KEY) === '1'); } catch {}
$('assistBtn').onclick = () => { setAssist(!APP.assist); toast(APP.assist ? '큰 글씨·느린 진행·음성 안내를 켰어요' : '기본 화면으로 돌아왔어요'); };
if (SIM) $('simPill').hidden = false; if (DEV) { $('devPill').hidden = false; $('devp').hidden = false; }

function show(name) { document.querySelectorAll('section[data-screen]').forEach(s => s.classList.toggle('on', s.dataset.screen === name)); APP.screen = name; scrollTo(0, 0); dev(); }
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));

/* ---------- 도움말 / 보조 모드 ---------- */
function sheet(html) { const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}<button class="cta quiet" style="margin-top:16px" data-close>닫기</button></div>`; document.body.appendChild(m); const close = () => m.remove(); m.querySelector('[data-close]').onclick = close; m.onclick = e => { if (e.target === m) close(); }; m.querySelector('[data-close]').focus(); return m; }
$('helpBtn').onclick = () => { if (APP.curMission) APP.attempts[APP.curMission]?.cur && (APP.attempts[APP.curMission].cur.help_opened = true);
  sheet(`<h2>도움말</h2><p><b>큰 글씨</b>를 켜면 글자가 커지고, 진행이 느려지며, 음성 안내가 나와요. 가족이 도와줄 때도 켜 두세요(도와주는 분의 얼굴은 화면에 나오지 않게 해 주세요).</p>
  <p><b>잘 안 될 때</b> 미션마다 두 번 실패하면 예시와 건너뛰기를 보여 드려요. 억지로 반복하지 않아도 돼요.</p>
  <p><b>저장</b> 영상·소리는 저장하지 않고, 계산한 숫자만 이 기기에 저장해요.</p>
  <div class="row"><button class="cta quiet" id="hVoice">${APP.voice ? '음성 안내 끄기' : '음성 안내 켜기'}</button><button class="cta quiet" id="hClear">이 기기 기록 지우기</button></div>`);
  $('hVoice').onclick = e => { APP.voice = !APP.voice; e.target.textContent = APP.voice ? '음성 안내 끄기' : '음성 안내 켜기'; };
  $('hClear').onclick = async () => { await DB.clear(); toast('이 기기의 v2 기록을 지웠어요'); renderHistory(); }; };

/* ======================= 1. Welcome ======================= */
async function renderHistory() {
  const all = (await DB.all()).sort((a, b) => b.created_at.localeCompare(a.created_at)); APP.history = all.filter(s => !s.sim);
  $('wHist').innerHTML = all.length ? all.slice(0, 6).map(s => { const ok = (s.assessments || []).filter(a => a.status !== 'insufficient' && a.status !== 'held').length;
    return `<div class="card" style="padding:12px 16px">${new Date(s.created_at).toLocaleString('ko-KR')} · 결과 ${ok}개${s.sim ? ' · <b>시뮬레이션</b>' : ''}</div>`; }).join('') : '없어요';
}
$('wStart').onclick = () => show('consent');

/* ======================= 2. Consent ======================= */
const cons = () => { APP.consent = { cam: $('cCam').checked, mic: $('cMic').checked, health: $('cHealth').checked }; $('cNext').disabled = !(APP.consent.cam && APP.consent.health); };
['cCam', 'cMic', 'cHealth'].forEach(id => $(id).onchange = cons);
$('cNext').onclick = () => { cons(); show('device'); if (SIM) simDeviceCheck(); };

// 화면 프레임 시각(다음 그리기 직전) / 누르는 순간(pointerdown) — 키보드(Enter·Space)는 click으로 대체
const nextFrame = () => new Promise(r => requestAnimationFrame(ts => r(ts)));
function onPress(el, fn) { let done = false; const go = e => { if (done) return; done = true; fn(e); }; el.onpointerdown = e => { if (e.button === 0 || e.pointerType !== 'mouse') go(e); }; el.onclick = e => { if (e.detail === 0) go(e); }; }
/* ======================= 3. Device check ======================= */
const dcSet = (k, st, msg) => { const r = document.querySelector(`.dc[data-k="${k}"]`); if (!r) return; const s = r.querySelector('[data-s]'); s.className = 'st ' + st; s.textContent = { pass: '통과', fix: '확인 필요', wait: '대기', opt: '선택' }[st] || st; if (msg) r.querySelector('[data-m]').textContent = msg; };
document.querySelectorAll('#holdSeg button').forEach(b => b.onclick = () => { APP.hold = b.dataset.v; document.querySelectorAll('#holdSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); dcSet('hold', APP.hold === 'stand' ? 'pass' : 'opt', APP.hold === 'stand' ? '거치대에 세워 두었어요' : '손에 들고 측정해요 (팔꿈치를 몸에 붙이면 덜 흔들려요)'); });
function deviceProfile(extra = {}) { return { device_model: navigator.userAgent.slice(0, 160), os: navigator.platform || '', viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio || 1}`, language: navigator.language, text_scale: APP.assist ? 1.2 : 1, reduce_motion: REDUCE, mirroring: true, ...extra }; }
$('dcCheck').onclick = async () => {
  $('dcCheck').disabled = true; dcSet('cam', 'wait', '카메라를 켜는 중…');
  const r = await CAM.open('user'); if (!r.ok) { dcSet('cam', 'fix', r.err === 'NotAllowedError' ? '카메라 권한이 거부됐어요. 브라우저 설정에서 카메라를 허용한 뒤 다시 눌러 주세요.' : '카메라를 열 수 없어요: ' + r.err); $('dcCheck').disabled = false; return; }
  dcSet('cam', 'pass', `앞 카메라 ${CAM.video.videoWidth}×${CAM.video.videoHeight}`); $('dcStage').hidden = false; const dv = $('dcVid'); dv.srcObject = CAM.stream; dv.play().catch(() => {});
  // 조명·속도: 2초 동안 화면 밝기와 초당 장면 수
  const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true }); c.width = 64; c.height = 48; let n = 0, lum = []; const t0 = now();
  while (now() - t0 < 2000) { await new Promise(r => requestAnimationFrame(r)); g.drawImage(CAM.video, 0, 0, 64, 48); const d = g.getImageData(16, 8, 32, 32).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; lum.push(s / (d.length / 4)); n++; }
  const fps = await CAM.measureFps(1200), L = lum.reduce((a, b) => a + b, 0) / lum.length;
  dcSet('light', L < 60 ? 'fix' : L > 220 ? 'fix' : 'pass', L < 60 ? '어두워요. 창가나 밝은 조명 쪽으로 옮겨 주세요.' : L > 220 ? '너무 밝아요. 직사광선을 피해 주세요.' : `화면 밝기 ${Math.round(L)} (적정)`);
  dcSet('fps', fps >= 15 ? 'pass' : 'fix', fps >= 15 ? `초당 ${Math.round(fps)}장` : `초당 ${Math.round(fps)}장 · 다른 앱을 닫아 주세요`);
  APP.device = deviceProfile({ camera_fps: Math.round(fps), video: `${CAM.video.videoWidth}x${CAM.video.videoHeight}`, lum: Math.round(L) });
  $('dcNext').disabled = false; $('dcCheck').disabled = false; $('dcCheck').textContent = '다시 점검';
};
function simDeviceCheck() { ['cam', 'light', 'fps'].forEach(k => dcSet(k, 'pass', '시뮬레이션: 카메라 없이 원시 신호를 만들어 같은 계산을 거쳐요')); APP.device = deviceProfile({ sim: true }); $('dcNext').disabled = false; }
$('dcNext').onclick = () => { $('dcStage').hidden = true; buildPlan(); show('overview'); };

/* ======================= 4. Overview ======================= */
const DEFAULT_ASSESS = Object.keys(E.ASSESSMENTS).filter(id => E.ASSESSMENTS[id].release !== 'held');
let SELECTED = new Set(DEFAULT_ASSESS);
function buildPlan() {
  const stand = APP.hold === 'stand';
  const req = [...SELECTED].filter(id => stand || !E.ASSESSMENTS[id].inputs.includes('F-MOTOR-01'));
  const { missions, uncovered } = E.chooseMissions(req, { stand });
  const list = [...missions.filter(m => m !== 'M08'), ...(missions.includes('M08') ? ['M08'] : [])];   // 기본 정보는 마지막(명세 카탈로그 순서)
  APP.plan = { missions: list, requested: req, uncovered };
  const lo = list.reduce((a, m) => a + E.MISSIONS[m].min_s, 0), hi = list.reduce((a, m) => a + E.MISSIONS[m].max_s, 0);
  $('ovTime').textContent = `미션 ${list.length}개 · 순수 측정 시간 약 ${Math.round(lo / 60 * 10) / 10}~${Math.round(hi / 60 * 10) / 10}분 (설계 범위, 안내·재시도 제외)`;
  $('ovList').innerHTML = list.map((m, i) => { const M = E.MISSIONS[m]; return `<li><span class="no">${i + 1}</span><span><b>${esc(M.title)}</b><br><span class="small muted">${esc(M.action)}</span></span><span class="small muted">${M.min_s ? `${M.min_s}~${M.max_s}초` : '입력'}</span></li>`; }).join('')
    + (!stand ? `<li class="off"><span class="no">–</span><span><b>상반신·손 동작</b><br><span class="small muted">거치대에 세워 둘 때만 해요 (환경 점검에서 바꿀 수 있어요)</span></span><span></span></li>` : '');
  $('ovAssess').innerHTML = DEFAULT_ASSESS.map(id => { const A = E.ASSESSMENTS[id]; return `<label class="check"><input type="checkbox" data-a="${id}" ${SELECTED.has(id) ? 'checked' : ''}><span><b>${esc(A.name)}</b> <span class="tag ${A.release}">${E.STATUS_KO[A.release]}</span><br><span class="small muted">필요: ${A.inputs.map(f => E.FEATURE_TYPES[f].name).join(', ')}</span></span></label>`; }).join('');
  $('ovAssess').querySelectorAll('input').forEach(i => i.onchange = () => { i.checked ? SELECTED.add(i.dataset.a) : SELECTED.delete(i.dataset.a); buildPlan(); });
  $('ovStart').disabled = !list.length;
}
$('ovStart').onclick = () => startSession();

/* ======================= 카메라 · 얼굴 인식 ======================= */
const CAM = {
  stream: null, facing: null, video: $('vid'),
  async open(facing = 'user') {
    if (this.stream && this.facing === facing && this.stream.getVideoTracks()[0]?.readyState === 'live') return { ok: true };
    this.close();
    try { this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (e) { return { ok: false, err: e.name || 'error' }; }
    this.facing = facing; this.video.srcObject = this.stream; try { await this.video.play(); } catch {}
    for (let i = 0; i < 60 && !this.video.videoWidth; i++) await sleep(50);
    return { ok: true };
  },
  close() { try { this.stream?.getTracks().forEach(x => x.stop()); } catch {} this.stream = null; },
  async measureFps(ms) { const v = this.video; let n = 0; const t0 = now(); if (v.requestVideoFrameCallback) { await new Promise(res => { const cb = () => { n++; if (now() - t0 < ms) v.requestVideoFrameCallback(cb); else res(); }; v.requestVideoFrameCallback(cb); }); return n / ((now() - t0) / 1000); } await sleep(ms); return 30; },
};
const FM = { fm: null, ready: false, err: '', last: null, running: false, n: 0, t0: 0, fps: 0, prev: null };
async function loadFM() {
  if (FM.ready) return true;
  try { if (!window.FaceMesh) await loadScript(FM_BASE + 'face_mesh.js');
    const fm = new window.FaceMesh({ locateFile: f => FM_BASE + f });
    fm.setOptions({ maxNumFaces: 2, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    fm.onResults(r => { const L = r.multiFaceLandmarks || []; FM.n++; const tt = now(); FM.fps = FM.t0 ? 1000 * FM.n / (tt - FM.t0) : 0; if (!FM.t0) FM.t0 = tt;
      const W = CAM.video.videoWidth, H = CAM.video.videoHeight; FM.last = { t: tt, faces: L.length, lm: L[0] || null, W, H }; FM.last.g = FM.last.lm ? geo(FM.last.lm, W, H) : null; onFace(FM.last); });
    await fm.initialize(); FM.fm = fm; FM.ready = true; return true;
  } catch (e) { FM.err = String(e.message || e); return false; }
}
// 얼굴 인식 반복. FM.throttle(ms)이 있으면 인식 간격을 벌려 화면 색 측정(맥파)에 시간을 양보 — 인식이 느린 기기에서 맥파 장면이 모자라지 않게
async function fmLoop() { if (FM.running) return; FM.running = true; FM.n = 0; FM.t0 = 0; while (FM.running) { const v = CAM.video; if (FM.ready && v.readyState >= 2 && v.videoWidth) { const ts = now(); try { await FM.fm.send({ image: v }); } catch (e) { FM.err = String(e); await sleep(100); } FM.cost = now() - ts; if (FM.throttle) await sleep(Math.max(0, FM.throttle - FM.cost)); } else await sleep(60); await sleep(0); } }
const fmStop = () => { FM.running = false; };
let faceCb = null; function onFace(r) { try { faceCb && faceCb(r); } catch (e) { console.error(e); } drawOverlay(r); dev(); }

/* ---------- 얼굴 기하 (MediaPipe FaceMesh 478점, 원본 좌표 = 미러 전) ---------- */
const IDX = { rEye: [33, 160, 158, 133, 153, 144], lEye: [362, 385, 387, 263, 373, 380], rIris: 468, lIris: 473, rRing: [469, 470, 471, 472], lRing: [474, 475, 476, 477], mouthR: 61, mouthL: 291, nose: 1, chin: 152, top: 10, cheekR: 205, cheekL: 425, faceR: 234, faceL: 454, forehead: 151,
  rPoly: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], lPoly: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466], rLow: [145, 153, 144], lLow: [374, 380, 373] };
const P = (lm, i, W, H) => ({ x: lm[i].x * W, y: lm[i].y * H });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function geo(lm, W, H) {
  const p = i => P(lm, i, W, H), ear = ids => { const [a, b, c, d, e, f] = ids.map(p); return (dist(b, f) + dist(c, e)) / (2 * dist(a, d) || 1); };
  const rC = mid(p(33), p(133)), lC = mid(p(263), p(362)), iod = dist(rC, lC), fw = dist(p(IDX.faceR), p(IDX.faceL)), em = mid(rC, lC);
  let ir = lm.length > 473 ? { c: p(IDX.rIris), r: IDX.rRing.reduce((a, i) => a + dist(p(i), p(IDX.rIris)), 0) / 4 } : null, il = lm.length > 473 ? { c: p(IDX.lIris), r: IDX.lRing.reduce((a, i) => a + dist(p(i), p(IDX.lIris)), 0) / 4 } : null;
  if (ir && il && dist(ir.c, rC) > dist(ir.c, lC)) [ir, il] = [il, ir];   // 홍채를 가까운 눈에 배정
  const rel = (iris, a, b) => { if (!iris) return null; const x0 = Math.min(a.x, b.x), w = Math.abs(a.x - b.x) || 1, cy = (a.y + b.y) / 2; return { x: (iris.c.x - x0) / w, y: (iris.c.y - cy) / w + 0.5 }; };
  const gr = rel(ir, p(33), p(133)), gl = rel(il, p(263), p(362));
  const nose = p(IDX.nose), fc = mid(p(IDX.faceR), p(IDX.faceL)), roll = Math.atan2(lC.y - rC.y, lC.x - rC.x) * 180 / Math.PI;
  const xs = lm.map(q => q.x * W), ys = lm.map(q => q.y * H), box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  return { W, H, p, rC, lC, em, iod, fw, ear: [ear(IDX.lEye), ear(IDX.rEye)], ir, il, gaze: gr && gl ? { x: 1 - (gr.x + gl.x) / 2, y: (gr.y + gl.y) / 2 } : null,   // 시선 x는 화면(미러) 기준으로 바꿔 저장
    yaw: -(nose.x - fc.x) / fw * 100, pitch: (nose.y - em.y) / fw * 100, roll, size: fw / Math.min(W, H), cx: (box.x0 + box.x1) / 2 / W, cy: (box.y0 + box.y1) / 2 / H, box,
    mouthR: p(IDX.mouthR), mouthL: p(IDX.mouthL), chin: p(IDX.chin) };
}
// 관심 영역 (원본 픽셀 좌표, 사각형)
function rois(g) {
  const fw = g.fw, R = (c, w, h) => ({ x: c.x - w / 2, y: c.y - h / 2, w, h });
  return { forehead: R({ x: g.p(IDX.forehead).x, y: g.p(IDX.forehead).y }, 0.32 * fw, 0.12 * fw), cheekR: R(g.p(IDX.cheekR), 0.15 * fw, 0.13 * fw), cheekL: R(g.p(IDX.cheekL), 0.15 * fw, 0.13 * fw), nose: R(g.p(4), 0.1 * fw, 0.14 * fw),
    neck: R({ x: g.chin.x, y: g.chin.y + 0.2 * fw }, 0.34 * fw, 0.2 * fw) };
}
// 정면 조건 (명세 K4 M01 · 수치는 기종별 데이터로 다시 맞출 시작값)
function faceCond(r, opt = {}) {
  if (!r || !r.faces) return { ok: false, code: 'Q-001', msg: '얼굴이 보이지 않아요. 화면 가운데에 얼굴을 맞춰 주세요' };
  if (r.faces > 1) return { ok: false, code: 'Q-001', msg: '한 사람만 화면에 나오게 해 주세요' };
  const g = r.g, smin = opt.smin ?? 0.32, smax = opt.smax ?? 0.78;
  if (g.size < smin) return { ok: false, code: 'Q-001', msg: '조금 더 가까이 와 주세요' };
  if (g.size > smax) return { ok: false, code: 'Q-001', msg: '조금 멀리 해 주세요' };
  if (Math.abs(g.cx - 0.5) > 0.16 || Math.abs(g.cy - 0.5) > 0.2) return { ok: false, code: 'Q-001', msg: '얼굴을 화면 가운데로 옮겨 주세요' };
  if (Math.abs(g.roll) > 12 || Math.abs(g.yaw) > (opt.yaw ?? 14)) return { ok: false, code: 'Q-001', msg: '고개를 똑바로 하고 정면을 봐 주세요' };
  if (r.lum != null && r.lum < 55) return { ok: false, code: 'Q-003', msg: '밝은 곳으로 옮겨 주세요' };
  if (r.lum != null && r.lum > 225) return { ok: false, code: 'Q-003', msg: '빛이 너무 세요. 직사광선을 피해 주세요' };
  if (r.motion != null && r.motion > (opt.motion ?? 3)) return { ok: false, code: 'Q-002', msg: '움직이지 말고 잠시 그대로 있어 주세요' };
  return { ok: true, msg: opt.okMsg || '위치가 좋아요' };
}

/* ---------- 픽셀 측정 ---------- */
const WORK = document.createElement('canvas'), WG = WORK.getContext('2d', { willReadFrequently: true });
const FULL = document.createElement('canvas'), FG = FULL.getContext('2d', { willReadFrequently: true });
function workFrame() { const v = CAM.video, W = v.videoWidth, H = v.videoHeight; if (!W) return null; const s = 320 / W; WORK.width = 320; WORK.height = Math.round(H * s); WG.drawImage(v, 0, 0, WORK.width, WORK.height); return s; }
function meanRGB(g, rc, s) { const x = Math.max(0, Math.round(rc.x * s)), y = Math.max(0, Math.round(rc.y * s)), w = Math.max(1, Math.round(rc.w * s)), h = Math.max(1, Math.round(rc.h * s)); const d = g.getImageData(x, y, w, h).data; let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } return n ? [r / n, gg / n, b / n] : [NaN, NaN, NaN]; }
// 장면 1장의 이마·볼 평균색 (맥파 원자료). 전체 = (이마 + 볼×2)/3. 신뢰성 시험에서도 같은 함수를 씀
// 관심 영역 흔들림 줄이기: 얼굴 점이 1px 안팎으로 떨리면 영역이 피부 결 위를 오가며 평균색이 바뀌어 맥파 잡음이 됨 → 천천히 따라가게(지수 평활),
// 크게 움직이면(폭의 10% 이상) 바로 새 위치로. (신뢰성 시험: 박동 시각 흔들림의 주원인)
function smoothRois(R, st) { if (!st) return R; const out = {};
  for (const k of Object.keys(R)) { const c = R[k], p = st[k];
    out[k] = st[k] = !p || Math.abs(c.x - p.x) > 0.1 * c.w || Math.abs(c.y - p.y) > 0.1 * c.h || Math.abs(c.w - p.w) > 0.1 * c.w ? { ...c } : { x: p.x + 0.1 * (c.x - p.x), y: p.y + 0.1 * (c.y - p.y), w: p.w + 0.1 * (c.w - p.w), h: p.h + 0.1 * (c.h - p.h) }; }
  return out; }
function sampleColors(gg, ctx2d, s, st) { const R = smoothRois(rois(gg), st), fh = meanRGB(ctx2d, R.forehead, s), ck = [meanRGB(ctx2d, R.cheekR, s), meanRGB(ctx2d, R.cheekL, s)].reduce((a, b) => a.map((x, i) => (x + b[i]) / 2));
  const all = [0, 1, 2].map(i => (fh[i] + 2 * ck[i]) / 3); return { all, fh, ck, lum: 0.299 * all[0] + 0.587 * all[1] + 0.114 * all[2] }; }
function fullFrame() { const v = CAM.video; FULL.width = v.videoWidth; FULL.height = v.videoHeight; FG.drawImage(v, 0, 0); return FG; }
function labStats(g, rc, step = 2, filter) {
  const x = Math.max(0, Math.round(rc.x)), y = Math.max(0, Math.round(rc.y)), w = Math.max(1, Math.round(rc.w)), h = Math.max(1, Math.round(rc.h)); const d = g.getImageData(x, y, w, h).data, Ls = [], as = [], bs = [];
  for (let j = 0; j < h; j += step) for (let i = 0; i < w; i += step) { const k = (j * w + i) * 4, lab = E.rgb2lab(d[k], d[k + 1], d[k + 2]); if (filter && !filter(lab, i + x, j + y)) continue; Ls.push(lab.L); as.push(lab.a); bs.push(lab.b); }
  const med = a => E.DSP.median(a); return { L: med(Ls), a: med(as), b: med(bs), sd: E.DSP.std(Ls), n: Ls.length };
}
function inPoly(pt, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; }
// 흰자: 눈 윤곽 안, 홍채 밖, 밝고 채도 낮은 화소
function scleraStats(g, gg) {
  const out = []; for (const [poly, iris] of [[IDX.rPoly, gg.ir], [IDX.lPoly, gg.il]]) { if (!iris) continue; const pts = poly.map(i => gg.p(i)), xs = pts.map(q => q.x), ys = pts.map(q => q.y);
    const rc = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; if (rc.w < 12) continue;
    const st = labStats(g, rc, 1, (lab, x, y) => inPoly({ x, y }, pts) && Math.hypot(x - iris.c.x, y - iris.c.y) > iris.r * 1.15 && lab.L > 45 && Math.hypot(lab.a, lab.b) < 30); if (st.n) out.push(st); }
  if (!out.length) return { px: 0 }; const n = out.reduce((a, s) => a + s.n, 0); return { L: out.reduce((a, s) => a + s.L * s.n, 0) / n, a: out.reduce((a, s) => a + s.a * s.n, 0) / n, b: out.reduce((a, s) => a + s.b * s.n, 0) / n, sd: out.reduce((a, s) => a + s.sd * s.n, 0) / n, px: n };
}
// 정지 장면 측정 (원본 해상도): 피부색·질감·광택·흰자·조명 치우침 (+외관 나이 모델이 있으면)
async function stillMeasure(gg, withAge = true) {
  const g = fullFrame(), R = rois(gg), cR = labStats(g, R.cheekR), cL = labStats(g, R.cheekL), fh = labStats(g, R.forehead);
  const cheek = { L: (cR.L + cL.L) / 2, a: (cR.a + cL.a) / 2, b: (cR.b + cL.b) / 2, sd: (cR.sd + cL.sd) / 2 };
  // 광택: T존(이마·코)에서 아주 밝고 채도 낮은 화소 비율
  let gl = 0, gn = 0; for (const rc of [R.forehead, R.nose]) { const x = Math.max(0, Math.round(rc.x)), y = Math.max(0, Math.round(rc.y)), w = Math.round(rc.w), h = Math.round(rc.h); if (w < 2 || h < 2) continue; const d = g.getImageData(x, y, w, h).data;
    for (let k = 0; k < d.length; k += 8) { const lab = E.rgb2lab(d[k], d[k + 1], d[k + 2]); gn++; if (lab.L > 82 && Math.hypot(lab.a, lab.b) < 14) gl++; } }
  // 질감: 볼의 밝기 2차 미분(라플라시안) 평균 / 평균 밝기
  const tex = (() => { const rc = R.cheekR, x = Math.max(1, Math.round(rc.x)), y = Math.max(1, Math.round(rc.y)), w = Math.round(rc.w), h = Math.round(rc.h); if (w < 6 || h < 6) return NaN; const d = g.getImageData(x, y, w, h).data, Y = (i, j) => { const k = (j * w + i) * 4; return 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; };
    let s = 0, m = 0, n = 0; for (let j = 1; j < h - 1; j += 2) for (let i = 1; i < w - 1; i += 2) { const c = Y(i, j); s += Math.abs(4 * c - Y(i - 1, j) - Y(i + 1, j) - Y(i, j - 1) - Y(i, j + 1)); m += c; n++; } return n ? 100 * s / m : NaN; })();
  // 조명 치우침: 화면 전체 평균의 b*(+면 노란 조명)
  const s = workFrame(), all = labStats(WG, { x: 0, y: 0, w: WORK.width, h: WORK.height }, 6);
  const out = { cheek, forehead: { L: fh.L, a: fh.a, b: fh.b }, gloss_pct: gn ? 100 * gl / gn : NaN, texture: tex, lum: cheek.L * 2.55, cast: all.b, sclera: scleraStats(g, gg), ages: [] };
  if (withAge && AGE.ready) { try { const det = await faceapi.detectSingleFace(FULL, new faceapi.TinyFaceDetectorOptions({ inputSize: 416 })).withAgeAndGender(); if (det && isFinite(det.age)) out.ages.push(det.age); } catch {} }
  return out;
}
const AGE = { ready: false };
async function loadAge() { if (AGE.ready || AGE.loading) return; AGE.loading = true; try { if (!window.faceapi) await loadScript(FA_BASE + 'dist/face-api.js'); await faceapi.nets.tinyFaceDetector.loadFromUri(FA_BASE + 'model'); await faceapi.nets.ageGenderNet.loadFromUri(FA_BASE + 'model'); AGE.ready = true; } catch (e) { AGE.err = String(e); } AGE.loading = false; }

/* ---------- 오버레이 (화면은 미러, 데이터는 원본 좌표 · display_mirrored 기록) ---------- */
let OVL = { guide: 'face', extra: null };
function drawOverlay(r) {
  const c = $('ov'); if (APP.screen !== 'mission' || c.hidden) return; const box = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (c.width !== Math.round(box.width * dpr)) { c.width = Math.round(box.width * dpr); c.height = Math.round(box.height * dpr); }
  const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); const W = CAM.video.videoWidth, H = CAM.video.videoHeight; if (!W) return;
  const sc = Math.max(c.width / W, c.height / H), ox = (c.width - W * sc) / 2, oy = (c.height - H * sc) / 2, X = x => ox + x * sc, Y = y => oy + y * sc;
  const ok = OVL.ok;
  if (OVL.guide === 'face') { // 얼굴 타원 + 두 눈 기준선
    const cx = c.width / 2, cy = c.height * 0.48, ry = Math.min(c.height * 0.3, c.width * 0.5), rx = ry * 0.74;
    g.lineWidth = 4 * dpr; g.strokeStyle = ok ? 'rgba(56,210,122,.95)' : 'rgba(255,255,255,.9)'; g.setLineDash(ok ? [] : [12 * dpr, 8 * dpr]); g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 7); g.stroke(); g.setLineDash([]);
    g.lineWidth = 2 * dpr; g.strokeStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.moveTo(cx - rx * 0.62, cy - ry * 0.12); g.lineTo(cx + rx * 0.62, cy - ry * 0.12); g.stroke();
  }
  if (OVL.extra) OVL.extra(g, X, Y, sc, dpr);
  if (DEV && r && r.g) { const gg = r.g; g.fillStyle = 'rgba(0,255,200,.8)'; for (let i = 0; i < r.lm.length; i += 6) { const q = r.lm[i]; g.fillRect(X(q.x * W) - dpr, Y(q.y * H) - dpr, 2 * dpr, 2 * dpr); }
    const R = rois(gg); g.strokeStyle = 'rgba(255,200,0,.9)'; g.lineWidth = 2 * dpr; Object.values(R).forEach(rc => g.strokeRect(X(rc.x), Y(rc.y), rc.w * sc, rc.h * sc));
    [gg.ir, gg.il].filter(Boolean).forEach(ii => { g.strokeStyle = 'rgba(255,60,120,.95)'; g.beginPath(); g.arc(X(ii.c.x), Y(ii.c.y), ii.r * sc, 0, 7); g.stroke(); }); }
}

/* ======================= 5. 미션 실행 ======================= */
function newAttempt(mid) { const A = APP.attempts[mid] = APP.attempts[mid] || { n: 0, list: [] }; A.n++; A.cur = { session_id: APP.session.id, mission_id: mid, attempt_no: A.n, state_history: [], help_opened: false, demo_played: false, assisted_mode: APP.assist, skip_reason: null, t0: now(), outcome: null, failure_code: null, instruction_events: [], detection_events: [] }; A.list.push(A.cur); APP.session.attempts.push(A.cur); return A.cur; }
function setState(s, msg, kind) {
  const a = APP.attempts[APP.curMission]?.cur; if (a && a.state_history[a.state_history.length - 1]?.s !== s) a.state_history.push({ s, t: Math.round(now() - a.t0) });
  const st = $('mStatus'); st.className = 'mstatus ' + (kind || (s === 'READY' || s === 'ACCEPTED' ? 'ok' : s === 'CAPTURING' ? 'go' : s === 'RETRY_TARGETED' || s === 'BLOCKED' ? 'bad' : ''));
  $('mMsg').textContent = msg || t('state.' + s); st.dataset.state = s; dev();
}
let _lastMsg = ''; function say1(msg, kind) { if (msg === _lastMsg) return; _lastMsg = msg; $('mMsg').textContent = msg; if (kind) $('mStatus').className = 'mstatus ' + kind; const a = APP.attempts[APP.curMission]?.cur; a && a.instruction_events.push({ cue: msg, t: Math.round(now() - a.t0) }); }
const prog = (p, txt) => { $('mBar').style.width = `${Math.max(0, Math.min(100, p * 100))}%`; $('mTime').textContent = txt ?? ''; };
function head(mid, idx, total, instr, sub, safety) { $('mStep').textContent = `${idx}/${total} · ${E.MISSIONS[mid].title}`; $('mInstr').textContent = instr; $('mSub').textContent = sub || ''; $('mSafety').textContent = safety || ''; }
// 버튼 대기: 누른 버튼 이름을 돌려줌
function buttons(cfg) {
  const B = { primary: $('mPrimary'), retry: $('mRetry'), demo: $('mDemo'), skip: $('mSkip') };
  B.primary.hidden = !cfg.primary; if (cfg.primary) { B.primary.textContent = cfg.primary; B.primary.disabled = !!cfg.primaryDisabled; }
  B.retry.hidden = !cfg.retry; if (cfg.retry) B.retry.textContent = cfg.retry;
  B.demo.hidden = cfg.demo === false; B.skip.hidden = cfg.skip === false;
  return new Promise(res => { const done = k => { Object.values(B).forEach(b => b.onclick = null); res(k); };
    B.primary.onclick = () => done('primary'); B.retry.onclick = () => done('retry'); B.skip.onclick = () => done('skip'); B.demo.onclick = () => { showDemo(APP.curMission); }; });
}
let ABORT = false, SUBSKIP = false; $('mSkip').addEventListener('click', () => { if (APP.subStep) SUBSKIP = true; else if (APP.capturing) ABORT = 'skip'; });
const KEY_FEATURE = { M01: ['F-PULSE-01'], M02: ['F-GAZE-01'], M03: ['F-EXPR-01'], M04: ['F-VOICE-01'], M05: ['F-COG-01'], M06: ['F-MOTOR-01'], M07: ['F-CONJ-01', 'F-NAIL-01', 'F-NECK-01'], M08: ['F-PROFILE-01'] };
const SAFETY = { M01: '어지럽거나 불편하면 언제든 멈춰도 돼요.', M02: '눈이 피로하면 잠시 쉬었다 해도 돼요.', M07: '손을 깨끗이 씻고, 눈동자는 만지지 마세요. 렌즈 착용·눈 자극·통증이 있으면 건너뛰세요.', M06: '주변에 부딪힐 물건이 없는지 확인해 주세요.' };

async function startSession() {
  APP.session = E.createSession({ sim: SIM, device: APP.device, consent: { ...APP.consent, scope: 'features_on_device', at: new Date().toISOString(), text_version: 'v2-test-2026-10-20' } });
  APP.session.app_version = APP_VER; APP.session.requested = APP.plan.requested; APP.attempts = {};
  if (!SIM) { loadAge(); }
  const list = APP.plan.missions;
  for (let i = 0; i < list.length; i++) { const r = await runMission(list[i], i + 1, list.length); if (r === 'quit') break; }
  finish();
}
async function runMission(mid, idx, total) {
  APP.curMission = mid; ABORT = false; show('mission'); resetStage();
  const M = E.MISSIONS[mid]; let fails = 0;
  while (true) {
    const att = newAttempt(mid); setState('NOT_STARTED');
    head(mid, idx, total, M.action, M.sub, SAFETY[mid]); prog(0, '');
    setState('INSTRUCTION', '준비되면 시작을 눌러 주세요');
    if (fails >= 2) { say1('두 번 잘 안 됐어요. 예시를 보거나 건너뛰어도 괜찮아요.', 'bad'); }
    const b = await buttons({ primary: t('btn.start'), demo: true, skip: true });
    if (b === 'skip') { att.outcome = 'SKIPPED'; att.skip_reason = 'user'; setState('SKIPPED'); recordSkip(mid, 'Q-012'); return 'skip'; }
    $('mPrimary').hidden = true; $('mRetry').hidden = true; $('mDemo').hidden = true;   // 측정 중에는 건너뛰기만
    let res; APP.capturing = true; ABORT = false;
    try { res = SIM ? await simMission(mid) : await MISSION[mid](att); } catch (e) { console.error(e); res = { error: String(e.message || e) }; }
    APP.capturing = false; stopTracking();
    if (ABORT === 'skip' || res?.skipped) { att.outcome = 'SKIPPED'; att.skip_reason = res?.reason || 'user'; setState('SKIPPED'); recordSkip(mid, 'Q-012'); return 'skip'; }
    if (res?.blocked) { att.outcome = 'BLOCKED'; att.failure_code = 'Q-011'; setState('BLOCKED', res.msg || '권한이 없어 이 미션은 건너뛸게요'); recordSkip(mid, 'Q-011');
      const b2 = await buttons({ primary: t('btn.next'), demo: false, skip: false }); return 'blocked'; }
    if (res?.error) { att.outcome = 'RETRY_TARGETED'; att.failure_code = 'ERR'; setState('RETRY_TARGETED', '문제가 생겼어요: ' + res.error); fails++; }
    else {
      setState('QUALITY_REVIEW');
      const meta = { display_mirrored: true, device_id: APP.device?.device_model || null, sim: SIM, attempt_no: att.attempt_no };
      const cap = APP.session.active[mid] ? E.retarget(APP.session, mid, res.payload, meta) : (() => { const c = E.addCapture(APP.session, mid, res.payload, meta); E.extractFeatures(APP.session, c); return c; })();
      att.capture_id = cap.id;
      const feats = APP.session.features.filter(f => f.capture_id === cap.id && KEY_FEATURE[mid].includes(f.feature_type));
      const good = feats.some(f => f.valid);
      if (good) { att.outcome = 'ACCEPTED'; att.duration_ms = Math.round(now() - att.t0); setState('ACCEPTED'); beep(1046, 120); await successScreen(mid, feats); return 'ok'; }
      const fc = feats.find(f => !f.valid)?.failure_code || 'Q-005'; att.outcome = 'RETRY_TARGETED'; att.failure_code = fc; fails++;
      setState('RETRY_TARGETED', `${E.QCODES[fc] || fc}. ${RETRY_TIP[mid]?.[fc] || RETRY_TIP[mid]?.default || ''}`);
    }
    att.duration_ms = Math.round(now() - att.t0);
    const b3 = await buttons({ primary: t('btn.retry'), demo: true, skip: true });
    if (b3 === 'skip') { att.skip_reason = 'after_fail'; recordSkip(mid, att.failure_code); return 'skip'; }
  }
}
const RETRY_TIP = {
  M01: { 'Q-002': '휴대폰을 세워 두고 몸을 움직이지 말아 주세요.', 'Q-003': '얼굴 정면에 고른 빛이 오게 해 주세요.', 'Q-005': '얼굴이 화면 가운데에 계속 보이게 해 주세요.', 'Q-015': '말하지 말고 편하게 숨 쉬며 정면을 봐 주세요.', default: '밝은 곳에서 휴대폰을 고정하고 다시 해 주세요.' },
  M02: { 'Q-013': '고개는 그대로 두고 눈만 점을 따라 움직여 주세요.', default: '얼굴이 작은 화면 안에 보이게 해 주세요.' },
  M03: { 'Q-014': '입꼬리가 더 잘 보이도록 크게 웃고, 눈은 꼭 감아 주세요.', default: '' },
  M04: { 'Q-008': '조용한 곳에서 휴대폰을 입 가까이 두고 또박또박 읽어 주세요.', 'Q-005': '문장을 끝까지 읽어 주세요.', default: '' },
  M07: { 'Q-007': '안내 그림처럼 아래 눈꺼풀을 살짝 내려 분홍색 부분이 보이게 해 주세요.', default: '' },
};
function recordSkip(mid, code) { /* 건너뛴 미션은 Capture를 만들지 않음 → 그 미션 특징에 기대는 평가는 '측정 불가(건너뜀)' */ APP.session.log.push({ at: Date.now(), ev: 'skip', mission: mid, code }); APP.session.skipped = { ...(APP.session.skipped || {}), [mid]: code }; }
async function successScreen(mid, feats) {
  show('success'); const used = Object.values(E.ASSESSMENTS).filter(A => A.inputs.some(t => E.MISSIONS[mid].produces.includes(t)) && A.release !== 'held').map(A => A.name);
  $('sTitle').textContent = '측정 데이터를 확보했어요'; $('sSub').textContent = `이 수집 1회를 ${used.length}개 항목에 함께 써요: ${used.slice(0, 6).join(', ')}${used.length > 6 ? ' 등' : ''}. 점수는 마지막에 한 번에 계산해요.`;
  await new Promise(res => { $('sNext').onclick = res; if (APP.autoNext) setTimeout(res, 50); });
  show('mission');
}
function resetStage() {
  const st = $('stage'); st.className = 'stage'; $('vid').hidden = false; $('ov').hidden = false; $('gz').hidden = true; $('zoom').hidden = true; $('scrim').hidden = true; $('panel').innerHTML = ''; OVL = { guide: 'face', extra: null };
  _lastMsg = ''; prog(0, '');
}
function stopTracking() { faceCb = null; }
// 얼굴 미션 공통: 카메라·인식 준비 → 정렬(조건이 연속 유지될 때만 READY, 깜빡임 방지)
async function prepFace(att, opt = {}) {
  setState('PERMISSION_CHECK', '카메라 권한 확인 중'); const r = await CAM.open('user'); $('mPerm').textContent = r.ok ? '카메라: 허용됨' : '카메라: ' + r.err;
  if (!r.ok) return { blocked: true, msg: r.err === 'NotAllowedError' ? '카메라 권한이 거부됐어요. 설정에서 허용하면 다시 할 수 있어요.' : '카메라를 열 수 없어요' };
  setState('DEVICE_CHECK', '얼굴 인식을 준비하는 중… (처음 한 번 약 10MB 내려받기)');
  const ok = await Promise.race([loadFM(), sleep(60000).then(() => false)]); if (!ok) return { error: '얼굴 인식을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' };
  fmLoop();
  setState('ALIGNING'); let since = null, lastBad = null; const t0 = now(), hold = APP.assist ? 1500 : 1000;
  while (!ABORT) {
    await sleep(80); const L = FM.last; if (!L) continue; const r2 = { ...L, lum: APP._lum, motion: APP._motion };
    const c = opt.cond ? opt.cond(r2) : faceCond(r2, opt); OVL.ok = c.ok;
    if (c.ok) { since = since ?? now(); lastBad = null; say1(c.msg, 'ok'); if (now() - since >= hold) { setState('READY'); return { ok: true }; } }
    else { lastBad = lastBad ?? now(); if (!since || now() - lastBad > 400) { since = null; say1(c.msg, 'bad'); } }   // 0.4초 넘게 틀어질 때만 READY 취소 (히스테리시스)
    att.detection_events.length < 400 && att.detection_events.push({ t: Math.round(now() - att.t0), ok: c.ok, code: c.code || null, size: L.g ? +L.g.size.toFixed(2) : null, yaw: L.g ? +L.g.yaw.toFixed(1) : null, faces: L.faces });
    if (now() - t0 > (opt.alignMax || 45000)) return { error: '자리를 맞추지 못했어요' };
  }
  return { skipped: true };
}
// 얼굴 결과마다 밝기·움직임 계산 (정렬 조건과 M01 프레임에 같이 씀)
function trackLumMotion(r) {
  if (!r.g) return; const g = r.g;
  if (FM.prev) { const dt = Math.max(1, r.t - FM.prev.t) / 33.3, d = (dist(g.p(IDX.nose), FM.prev.nose) + dist(g.em, FM.prev.em)) / 2; APP._motion = 100 * d / g.fw / dt; }
  FM.prev = { t: r.t, nose: g.p(IDX.nose), em: g.em };
  const s = workFrame(); if (s) { const R = rois(g), a = meanRGB(WG, R.cheekR, s), b = meanRGB(WG, R.cheekL, s); APP._lum = (0.299 * (a[0] + b[0]) + 0.587 * (a[1] + b[1]) + 0.114 * (a[2] + b[2])) / 2; }
}

/* ---------- M01 정면 · 맥파 ---------- */
const MISSION = {};
MISSION.M01 = async att => {
  faceCb = trackLumMotion; const p = await prepFace(att); if (!p.ok) return p;
  speak('편하게 숨 쉬고 정면을 봐 주세요. 측정을 시작합니다.');
  // 인식 한 번이 80ms를 넘는 느린 기기면, 측정 중에는 인식을 0.7초 간격으로 (얼굴은 가만히 있으므로 위치 추적에 충분)
  FM.throttle = DEV && QS.get('fmth') ? +QS.get('fmth') : FM.cost > 80 ? 700 : 0;   // fmth: 개발자 시험용(느린 테스트 환경)
  setState('CAPTURING', '위치가 좋아요. 측정을 시작합니다'); const frames = [], stills = [], need = (APP.assist ? 50 : 45), maxT = E.MISSIONS.M01.max_s + 15; let valid = 0, lastT = null; const t0 = now(), stillAt = [6, 18, 32];
  // 영상 장면마다(가능하면) 색을 뽑음. 얼굴 위치는 가장 최근 인식 결과 사용
  let stopV = false; const v = CAM.video;
  // 장면 시각: 카메라가 찍은 시각(captureTime) → 없으면 화면 표시 예정 시각 → 없으면 콜백 시각.
  // 콜백 시각은 얼굴 인식 등으로 메인 스레드가 바쁘면 늦게 찍혀 박동 간격이 흔들림(신뢰성 시험에서 PRV 4배 과대) → 쓰지 않는 게 원칙
  const tsSrc = {}, roiSt = {};
  const onVF = (_n, md) => { if (stopV) return; const L = FM.last; const src = md && md.captureTime ? 'capture' : md && md.expectedDisplayTime ? 'display' : 'callback'; tsSrc[src] = (tsSrc[src] || 0) + 1;
    const tt = ((src === 'capture' ? md.captureTime : src === 'display' ? md.expectedDisplayTime : now()) - t0) / 1000;
    // 얼굴 인식이 느린 기기: 움직임이 작으면 0.7초 안의 최근 위치를 그대로 씀 (영상 장면마다 색은 새로 읽음)
    if (L && L.g && L.faces === 1 && (now() - L.t < 250 || (now() - L.t < Math.max(1200, (FM.throttle || 0) + 700) && (APP._motion ?? 9) < 1))) { const s = workFrame();
      frames.push({ t: +tt.toFixed(4), ok: true, ...sampleColors(L.g, WG, s, roiSt), cy: L.g.em.y / L.g.H, motion: APP._motion ?? 0, ear: L.g.ear, faces: 1 }); }
    else frames.push({ t: +tt.toFixed(4), ok: false, faces: L?.faces ?? 0 });
    v.requestVideoFrameCallback ? v.requestVideoFrameCallback(onVF) : requestAnimationFrame(onVF); };
  v.requestVideoFrameCallback ? v.requestVideoFrameCallback(onVF) : requestAnimationFrame(onVF);
  try {
    while (!ABORT) {
      await sleep(200); const tt = (now() - t0) / 1000, L = FM.last, c = faceCond({ ...L, lum: APP._lum, motion: APP._motion });
      if (c.ok) { if (lastT != null) valid += Math.min(0.5, tt - lastT); say1('측정 중이에요. 그대로 편하게 숨 쉬세요', 'go'); } else say1(c.msg, 'bad');   // 유효한 구간에만 타이머가 흐름
      lastT = tt; prog(valid / need, `${Math.max(0, Math.ceil(need - valid))}초`);
      if (stills.length < stillAt.length && valid >= stillAt[stills.length] && c.ok && L.g) stills.push(await stillMeasure(L.g));
      if (valid >= need || tt > maxT) break;
    }
  } finally { stopV = true; FM.throttle = 0; }
  if (ABORT) return { skipped: true };
  return { payload: { frames, stills, fps: FM.fps, video: `${v.videoWidth}x${v.videoHeight}`, valid_s: +valid.toFixed(1), display_mirrored: true, roi_version: 'roi-fm-2-smooth', ts_src: Object.entries(tsSrc).sort((a, b) => b[1] - a[1])[0]?.[0] || 'callback', ts_src_counts: tsSrc } };
};

/* ---------- M02 시선 이동 (큰 목표 · 넓은 이동 · 각 위치 정착 시간) ---------- */
const GZ_SEQ = [[0.5, 0.5, 'h'], [0.1, 0.5, 'h'], [0.5, 0.5, 'h'], [0.9, 0.5, 'h'], [0.5, 0.5, 'h'], [0.5, 0.12, 'v'], [0.5, 0.5, 'v'], [0.5, 0.88, 'v'], [0.5, 0.5, 'v']];
MISSION.M02 = async att => {
  faceCb = trackLumMotion; const p = await prepFace(att, { smin: 0.26, yaw: 16, okMsg: '좋아요. 이제 화면의 점을 눈으로만 따라가세요' }); if (!p.ok) return p;
  // 화면 전체가 목표 영역, 얼굴은 오른쪽 위 작은 창에서 확인
  $('vid').hidden = true; $('ov').hidden = true; $('gz').hidden = false; const tgt = $('gzt'), area = $('gz'), pipc = $('pipc'), pg = pipc.getContext('2d');
  let stop = false; (function pip() { if (stop) return; const v = CAM.video; if (v.videoWidth) { pipc.width = 150; pipc.height = 200; const s = Math.max(150 / v.videoWidth, 200 / v.videoHeight); pg.drawImage(v, (150 - v.videoWidth * s) / 2, (200 - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s); } requestAnimationFrame(pip); })();
  const dwell = APP.assist ? 2000 : 1300, move = REDUCE ? 0 : APP.assist ? 900 : 450, samples = [], stills = [], t0 = now();
  let T = { x: 0.5, y: 0.5, state: 'hold', axis: 'h', dx: 0, dy: 0 };
  const place = (x, y) => { tgt.style.left = `${x * 100}%`; tgt.style.top = `${y * 100}%`; };
  faceCb = r => { trackLumMotion(r); if (!r.g || !r.g.gaze) return; samples.push({ t: +((r.t - t0) / 1000).toFixed(3), target: { ...T }, iris: { x: +r.g.gaze.x.toFixed(4), y: +r.g.gaze.y.toFixed(4) }, head: { yaw: +r.g.yaw.toFixed(2), pitch: +r.g.pitch.toFixed(2) }, conf: r.faces === 1 ? 0.9 : 0.2 }); };
  setState('CAPTURING', '점을 눈으로 따라가세요. 고개는 그대로'); speak('고개는 고정하고, 눈으로만 점을 따라가세요.'); place(0.5, 0.5); await sleep(1200);
  try {
    for (let k = 1; k < GZ_SEQ.length && !ABORT; k++) {
      const [x0, y0] = GZ_SEQ[k - 1], [x1, y1, axis] = GZ_SEQ[k]; T = { x: x0, y: y0, state: 'moving', axis, dx: x1 - x0, dy: y1 - y0 };
      if (move) { const ts = now(); while (now() - ts < move) { const f = (now() - ts) / move, e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2; T = { ...T, x: x0 + (x1 - x0) * e, y: y0 + (y1 - y0) * e }; place(T.x, T.y); await new Promise(r => requestAnimationFrame(r)); } }
      T = { x: x1, y: y1, state: 'hold', axis, dx: 0, dy: 0 }; place(x1, y1); prog(k / (GZ_SEQ.length - 1), `${k}/${GZ_SEQ.length - 1}`);
      const th = now(); let took = false; while (now() - th < dwell) { await sleep(50); if (!took && (x1 !== 0.5) && now() - th > dwell * 0.6 && FM.last?.g) { took = true; const gg = FM.last.g, g = fullFrame(); stills.push({ cheek: null, lum: APP._lum, cast: 0, sclera: scleraStats(g, gg) }); } }
      // 눈이 화면 밖을 보거나 얼굴이 사라지면 그 위치를 한 번 더
      if (!FM.last?.faces) { say1('얼굴이 작은 창에서 보이게 해 주세요', 'bad'); k--; await sleep(800); say1('점을 눈으로 따라가세요', 'go'); }
    }
  } finally { stop = true; }
  if (ABORT) return { skipped: true };
  const st = stills.filter(s => s.sclera && s.sclera.px >= 15).map(s => ({ ...s, cast: APP.session.features.find(f => f.feature_type === 'F-FACE-01' && f.valid)?.value?.cast ?? 0 }));
  return { payload: { samples, stills: st, target_px: 36, stage: { w: area.clientWidth, h: area.clientHeight }, dwell_ms: dwell, move_ms: move, speed_profile_version: REDUCE ? 'step-1' : APP.assist ? 'slow-1' : 'normal-1', display_mirrored: true } };
};

/* ---------- M03 표정 (기준 자세 대비 변화 확인) ---------- */
MISSION.M03 = async att => {
  faceCb = trackLumMotion; const p = await prepFace(att); if (!p.ok) return p;
  const phases = { neutral: [], smile: [], closed: [] }; let cur = 'neutral'; const t0 = now();
  faceCb = r => { trackLumMotion(r); if (!r.g || r.faces !== 1) return; const g = r.g, iod = g.iod, rel = q => ({ x: +((q.x - g.em.x) / iod).toFixed(4), y: +((q.y - g.em.y) / iod).toFixed(4) });
    phases[cur]?.push({ t: +((r.t - t0) / 1000).toFixed(3), mL: rel(g.mouthL), mR: rel(g.mouthR), mw: +(dist(g.mouthL, g.mouthR) / iod).toFixed(4), ear: g.ear.map(x => +x.toFixed(4)) }); };
  const med = (A, f) => E.DSP.median(A.map(f));
  setState('CAPTURING', '편하게 정면을 봐 주세요'); $('mInstr').textContent = '편하게 정면 보기'; await sleep(2500);
  const n = { mw: med(phases.neutral, s => s.mw), e: med(phases.neutral, s => (s.ear[0] + s.ear[1]) / 2) }; if (!(phases.neutral.length >= 5)) return { payload: { phases, iod: 1 } };
  // 미소: 입 너비가 기준보다 6% 넘게 넓어진 상태가 잠시 유지돼야 통과
  cur = 'smile'; $('mInstr').textContent = '치아가 보이도록 웃어 주세요'; speak('치아가 보이도록 웃어 주세요'); prog(0.33, '');
  let ok = await waitFor(() => { const L = phases.smile.slice(-5); return L.length >= 3 && med(L, s => s.mw) >= n.mw * 1.06; }, 700, APP.assist ? 12000 : 8000, '입꼬리가 더 잘 보이도록 웃어 주세요');
  await sleep(ok ? 900 : 0);
  // 눈 감기: 화면을 볼 수 없으니 소리로 안내
  cur = 'closed'; $('mInstr').textContent = '양쪽 눈을 부드럽게 감아 주세요'; await speak('눈을 감아 주세요. 삐 소리가 나면 뜨세요.'); prog(0.66, '');
  ok = await waitFor(() => { const L = phases.closed.slice(-4); return L.length >= 3 && med(L, s => (s.ear[0] + s.ear[1]) / 2) <= n.e * 0.5; }, 1200, APP.assist ? 12000 : 8000, '양쪽 눈을 꼭 감아 주세요');
  beep(1046, 220); cur = null; prog(1, '');
  if (ABORT) return { skipped: true };
  return { payload: { phases, iod: 1, display_mirrored: true } };
};
async function waitFor(pred, holdMs, maxMs, hint) { const t0 = now(); let since = null; while (!ABORT && now() - t0 < maxMs) { await sleep(80); if (pred()) { since = since ?? now(); say1('좋아요, 그대로', 'ok'); if (now() - since >= holdMs) return true; } else { since = null; if (now() - t0 > 2500) say1(hint, 'bad'); } } return false; }

/* ---------- M04 문장 읽기 (마이크 권한·녹음 신호·말하기 수행을 따로 판단) ---------- */
const SENTENCE = '오늘은 날씨가 맑아서 가족과 함께 공원에 산책을 다녀왔습니다';
const SYL = [...SENTENCE].filter(c => /[가-힣]/.test(c)).length;
MISSION.M04 = async att => {
  const st = $('stage'); st.className = 'stage short'; $('vid').hidden = true; $('ov').hidden = true;
  $('panel').innerHTML = `<div class="task"><p class="sentence" id="sent">${SENTENCE}</p><div class="wave" id="wave" aria-hidden="true">${'<i></i>'.repeat(28)}</div></div>`;
  if (APP.consent.mic === false) return { blocked: true, msg: '마이크 사용에 동의하지 않아 이 미션은 건너뛸게요' };
  setState('PERMISSION_CHECK', '마이크 권한 확인 중'); let ms;
  try { ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } }); $('mPerm').textContent = '마이크: 허용됨'; }
  catch (e) { $('mPerm').textContent = '마이크: ' + e.name; return { blocked: true, msg: e.name === 'NotAllowedError' ? '마이크 권한이 거부됐어요. 이 미션은 건너뛸게요(실패가 아니에요).' : '마이크를 열 수 없어요' }; }
  actx = actx || new (window.AudioContext || window.webkitAudioContext)(); try { await actx.resume(); } catch {}
  const src = actx.createMediaStreamSource(ms), an = actx.createAnalyser(); an.fftSize = 1024; src.connect(an); const buf = new Float32Array(an.fftSize), env = [], bars = [...document.querySelectorAll('#wave i')];
  const rms = () => { an.getFloatTimeDomainData(buf); let q = 0; for (let i = 0; i < buf.length; i++) q += buf[i] * buf[i]; return Math.sqrt(q / buf.length); };
  setState('DEVICE_CHECK', '1초만 조용히 해 주세요 (주변 소리 확인)'); const fl = []; for (let i = 0; i < 50; i++) { fl.push(rms()); await sleep(20); } const floor = E.DSP.median(fl);
  const noisy = floor > 0.02; if (noisy) say1('주변 소리가 커요. 조용한 곳이면 더 정확해요', 'bad');
  setState('CAPTURING', '지금 읽어 주세요'); beep(880, 120); let done = false; const t0 = now(); $('mPrimary').hidden = false; $('mPrimary').textContent = t('btn.done'); $('mPrimary').onclick = () => { done = true; };
  const iv = setInterval(() => { const v = rms(); env.push(v); bars.push(bars.shift()); const b = bars[bars.length - 1]; b.style.height = `${Math.min(100, 4 + v * 900)}%`; bars.forEach((x, i) => x.parentNode.appendChild(x)); }, 20);
  while (!done && !ABORT && now() - t0 < (APP.assist ? 30000 : 20000)) { await sleep(100); prog((now() - t0) / 20000, `${Math.ceil((now() - t0) / 1000)}초`); }
  clearInterval(iv); try { src.disconnect(); ms.getTracks().forEach(x => x.stop()); } catch {} $('mPrimary').onclick = null;
  if (ABORT) return { skipped: true };
  return { payload: { env: env.map(x => +x.toFixed(5)), dt: 0.02, syllables: SYL, sentence_id: 'ko-s1', mic: true, completed: done, ambient_floor: +floor.toFixed(5), noisy } };
};

/* ---------- M05 기억·주의 과제 (연습 문항 분리, 정답·반응시간 원본 이벤트 저장) ---------- */
const WORDS = ['사과', '바다', '연필', '구름', '기차', '장미', '시계', '호수', '나무', '우산', '버스', '모자'];
const INK = [['빨강', '#C62828'], ['파랑', '#1565C0'], ['초록', '#2E7D32'], ['노랑', '#B8860B']];
MISSION.M05 = async att => {
  const st = $('stage'); st.className = 'stage short'; $('vid').hidden = true; $('ov').hidden = true; const panel = $('panel'); setState('CAPTURING', '과제 진행 중');
  const fr = []; let lastF = now(), frOn = true; (function f() { if (!frOn) return; const n2 = now(); fr.push(n2 - lastF); lastF = n2; requestAnimationFrame(f); })();
  const pick = [...WORDS].sort(() => Math.random() - 0.5).slice(0, 3), ev = [], tShow = now();
  // 1) 단어 기억
  panel.innerHTML = `<div class="task"><p class="muted">이 단어 3개를 기억해 주세요. 나중에 물어볼게요.</p><p class="word" style="color:var(--ink)">${pick.join(' · ')}</p></div>`; speak(`단어 세 개를 기억하세요. ${pick.join(', ')}`); prog(0.05, '');
  await sleep(APP.assist ? 9000 : 6000); if (ABORT) return { skipped: true };
  // 2) 색 맞히기 (글자의 색) — 연습 2문항 + 본 문항 12
  const stroop = async (n, practice) => { for (let i = 0; i < n && !ABORT; i++) {
    const w = INK[Math.floor(Math.random() * 4)], con = i % 2 === 0, ink = con ? w : INK.filter(x => x !== w)[Math.floor(Math.random() * 3)];
    panel.innerHTML = `<div class="task"><p class="muted">${practice ? '<b>연습</b> · ' : ''}<b>글자의 색</b>을 고르세요 (글자 뜻이 아니라 색)</p><p class="word" style="color:${ink[1]}">${w[0]}</p><div class="choices">${INK.map(c => `<button data-c="${c[0]}"><i style="background:${c[1]}"></i>${c[0]}</button>`).join('')}</div></div>`;
    // 반응 시간 = (손가락이 닿은 순간의 이벤트 시각) − (문항이 화면에 그려지는 프레임 시각). click은 손을 뗄 때라 약 0.1초 늦어 쓰지 않음
    let tAns = null; const t1 = await nextFrame(); const ans = await new Promise(res => { const to = setTimeout(() => res(null), 3000); panel.querySelectorAll('[data-c]').forEach(b => onPress(b, e => { clearTimeout(to); tAns = e.timeStamp; res(b.dataset.c); })); });
    const rt = Math.round((tAns ?? now()) - t1); ev.push({ task: 'stroop', practice, congruent: con, word: w[0], ink: ink[0], answer: ans, correct: ans === ink[0], rt_ms: ans ? rt : null, timeout: !ans, at_ms: Math.round(t1 - tShow) });
    if (practice) { say1(ans === ink[0] ? '맞았어요' : `글자의 색은 ${ink[0]}이에요`, ans === ink[0] ? 'ok' : 'bad'); await sleep(900); } else await sleep(250);
    prog(0.1 + 0.5 * (ev.filter(e => e.task === 'stroop').length / 14), ''); } };
  await stroop(2, true); _lastMsg = ''; say1('이제 실제 문항이에요', 'go'); await stroop(12, false);
  // 3) 단순 반응: 초록색으로 바뀌면 누르기
  for (let i = 0; i < 8 && !ABORT; i++) {
    panel.innerHTML = `<div class="task"><p class="muted">버튼이 <b>초록색 "지금"</b>으로 바뀌면 바로 누르세요</p><button class="rtbtn" id="rtb">기다리세요…</button></div>`; const b = $('rtb');
    const wait = 1000 + Math.random() * 1500; let goAt = null, early = false; const p2 = new Promise(res => { onPress(b, e => { if (!goAt) { early = true; res(null); } else res(e.timeStamp - goAt); }); setTimeout(() => res(undefined), wait + 2500); });
    // 초록으로 바꾼 뒤 그 변화가 그려지는 프레임 시각을 기준으로 삼음 (setTimeout 시각은 실제 표시보다 이름)
    const tm = setTimeout(() => { b.classList.add('go'); b.textContent = '지금!'; goAt = now(); nextFrame().then(ts => { goAt = ts; }); }, wait); const rt = await p2; clearTimeout(tm);
    ev.push({ task: 'rt', practice: false, early, correct: !early && rt != null, rt_ms: rt ? Math.round(rt) : null, timeout: rt === undefined }); prog(0.6 + 0.3 * (i + 1) / 8, ''); await sleep(300);
  }
  // 4) 지연 회상
  const opts = [...pick, ...WORDS.filter(w => !pick.includes(w)).sort(() => Math.random() - 0.5).slice(0, 6)].sort(() => Math.random() - 0.5), chosen = new Set();
  panel.innerHTML = `<div class="task"><p class="muted">처음에 기억한 단어 3개를 고르세요</p><div class="choices" style="grid-template-columns:1fr 1fr 1fr">${opts.map(w => `<button data-w="${w}" aria-pressed="false">${w}</button>`).join('')}</div><button class="cta" id="rcOk" disabled>확인</button></div>`;
  panel.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { const w = b.dataset.w; chosen.has(w) ? chosen.delete(w) : chosen.size < 3 && chosen.add(w); panel.querySelectorAll('[data-w]').forEach(x => { const on = chosen.has(x.dataset.w); x.setAttribute('aria-pressed', String(on)); x.style.borderColor = on ? 'var(--accent)' : ''; x.style.background = on ? 'var(--accent-soft)' : ''; }); $('rcOk').disabled = chosen.size !== 3; });
  await new Promise(res => { $('rcOk').onclick = res; const iv = setInterval(() => { if (ABORT) { clearInterval(iv); res(); } }, 200); });
  frOn = false; prog(1, ''); if (ABORT) return { skipped: true };
  const corr = [...chosen].filter(w => pick.includes(w)).length;
  return { payload: { events: ev, recall: { shown: pick, chosen: [...chosen], correct: corr, of: 3, wrong: 3 - corr, delay_s: +((now() - tShow) / 1000).toFixed(1) }, frame_ms: +E.DSP.median(fr.slice(5)).toFixed(1), task_version: 'cog-ko-2', timing: 'raf-frame→pointerdown-event' } };
};

/* ---------- M06 상반신·손 (거치대일 때만, v1 r17 측정 방식 재사용) ---------- */
const BODY = { ready: false, h: null, res: null, err: '' };
async function loadBody() { if (BODY.ready) return true; try { if (!window.Holistic) await loadScript(HOL_BASE + 'holistic.js'); const h = new window.Holistic({ locateFile: f => HOL_BASE + f }); h.setOptions({ modelComplexity: 0, smoothLandmarks: true, refineFaceLandmarks: false, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }); h.onResults(x => { BODY.res = x; }); await h.initialize(); BODY.h = h; BODY.ready = true; return true; } catch (e) { BODY.err = String(e.message || e); return false; } }
async function bodyFrame(v) { BODY.res = null; try { await BODY.h.send({ image: v }); } catch { return null; } const r = BODY.res; if (!r) return null; const W = v.videoWidth, H = v.videoHeight, m = Math.min(W, H), Pp = r.poseLandmarks;
  const pt = i => Pp && Pp[i] && (Pp[i].visibility ?? 1) > 0.5 ? { x: Pp[i].x * W / m, y: Pp[i].y * H / m } : null, hand = L => L && L.length >= 21 ? L.map(p => ({ x: p.x * W / m, y: p.y * H / m })) : null;
  return { t: now() / 1000, W, H, m, nose: pt(0), ls: pt(11), rs: pt(12), le: pt(13), re: pt(14), lw: pt(15), rw: pt(16), lh: hand(r.leftHandLandmarks), rh: hand(r.rightHandLandmarks), conf: Pp ? Pp.slice(11, 17).map(q => +(q.visibility ?? 0).toFixed(2)) : [] }; }
function bodyCond(s, arms = true) { if (!s || !s.nose || !s.ls || !s.rs) return { ok: false, msg: '머리와 양어깨가 화면에 보이게 해 주세요' }; const sw = dist(s.ls, s.rs), mx = (s.ls.x + s.rs.x) / 2, cw = s.W / s.m;
  if (sw > 0.42) return { ok: false, msg: '조금 더 뒤로 물러나 주세요' }; if (sw < 0.16) return { ok: false, msg: '조금 더 앞으로 와 주세요' }; if (Math.abs(mx - cw / 2) > 0.15 * cw) return { ok: false, msg: '화면 가운데로 와 주세요' };
  if (arms && !(s.le && s.re && s.lw && s.rw)) return { ok: false, msg: '팔꿈치·손목·손끝까지 화면에 보이게 해 주세요' }; return { ok: true, msg: '좋아요, 그대로 계세요', sw }; }
const handOpen = h => { if (!h) return NaN; const sz = dist(h[0], h[9]); return sz > 0 ? [8, 12, 16, 20].reduce((a, i) => a + dist(h[i], h[0]), 0) / 4 / sz : NaN; };
const handCenter = h => { if (!h) return null; const ids = [5, 8, 9, 12, 13, 16]; return { x: ids.reduce((a, i) => a + h[i].x, 0) / ids.length, y: ids.reduce((a, i) => a + h[i].y, 0) / ids.length, sz: dist(h[0], h[9]) }; };
function bodySample(key, s) { const sw = s.ls && s.rs ? dist(s.ls, s.rs) : NaN, r4 = x => x == null || !isFinite(x) ? null : +x.toFixed(4);
  if (key === 'breath') return s.ls && s.rs ? { t: s.t, y: r4((s.ls.y + s.rs.y) / 2), sw: r4(sw), tilt: r4(Math.atan2(s.rs.y - s.ls.y, s.rs.x - s.ls.x) * 180 / Math.PI) } : null;
  if (key === 'drift') return s.ls && s.rs ? { t: s.t, l: s.lw ? r4((s.lw.y - s.ls.y) / sw) : null, r: s.rw ? r4((s.rw.y - s.rs.y) / sw) : null } : null;
  if (key === 'tremor') { const a = handCenter(s.lh), b = handCenter(s.rh); return a || b ? { t: s.t, lx: a && r4(a.x), ly: a && r4(a.y), ls: a && r4(a.sz), rx: b && r4(b.x), ry: b && r4(b.y), rsz: b && r4(b.sz) } : null; }
  if (key === 'fist') { const a = handOpen(s.lh), b = handOpen(s.rh); return isFinite(a) || isFinite(b) ? { t: s.t, l: isFinite(a) ? r4(a) : null, r: isFinite(b) ? r4(b) : null } : null; } return null; }
const BODY_STEPS = [
  { key: 'breath', t: '손은 무릎 위에 두고 30초 동안 편하게 숨 쉬세요', prep: 2, dur: 30, arms: false },
  { key: 'drift', t: '양팔을 앞으로 뻗고 손바닥을 하늘로, 눈을 감고 10초', prep: 4, dur: 10 },
  { key: 'tremor', t: '양손을 가슴 앞으로 들어 손가락을 쫙 펴고 10초', prep: 4, dur: 10, arms: false },
  { key: 'fist', t: '양손 주먹을 크게, 최대한 빠르게 쥐었다 펴기 12초', prep: 3, dur: 12, arms: false } ];
MISSION.M06 = async att => {
  if (APP.hold !== 'stand') return { skipped: true, reason: 'no_stand' };
  setState('PERMISSION_CHECK'); const r = await CAM.open('user'); if (!r.ok) return { blocked: true }; $('stage').className = 'stage wide';
  setState('DEVICE_CHECK', '상반신 인식을 준비하는 중… (처음 한 번 약 25MB)'); const ok = await Promise.race([loadBody(), sleep(90000).then(() => false)]); if (!ok) return { error: '상반신 인식을 불러오지 못했어요' };
  const B = { fit: null, breath: [], drift: [], tremor: [], fist: [] }; let s = null, cond = null;
  OVL = { guide: null, extra: (g, X, Y, sc, dpr) => { if (!s) return; const W = s.W, H = s.H; g.fillStyle = cond?.ok ? 'rgba(56,210,122,.95)' : 'rgba(255,255,255,.9)'; [s.nose, s.ls, s.rs, s.le, s.re, s.lw, s.rw].filter(Boolean).forEach(q => { g.beginPath(); g.arc(X(q.x * s.m), Y(q.y * s.m), 6 * dpr, 0, 7); g.fill(); }); } };
  setState('ALIGNING'); speak('한 걸음 뒤로 물러나, 팔꿈치와 손끝까지 화면에 보이게 해 주세요.'); let since = null; const t0 = now();
  while (!ABORT && now() - t0 < 40000) { await sleep(20); s = await bodyFrame(CAM.video); cond = bodyCond(s); drawOverlay(null); say1(cond.msg, cond.ok ? 'ok' : 'bad'); if (cond.ok) { since = since ?? now(); if (now() - since > 2000) break; } else since = null; }
  B.fit = { ok: !!cond?.ok, sw: cond?.sw ?? null }; if (!cond?.ok) return { payload: { ...B, err: 'fit' } };
  for (const [i, st] of BODY_STEPS.entries()) { if (ABORT) break; $('mInstr').textContent = st.t; await speak(st.t); setState('CAPTURING', '준비하세요');
    const pe = now() + st.prep * 1000, re = pe + st.dur * 1000; while (!ABORT && now() < re) { await sleep(20); s = await bodyFrame(CAM.video); cond = bodyCond(s, st.arms !== false); drawOverlay(null); const rec = now() >= pe;
      say1(rec ? '측정 중 · 그대로' : '준비하세요', rec ? 'go' : ''); prog((i + (rec ? (now() - pe) / (st.dur * 1000) : 0)) / BODY_STEPS.length, rec ? `${Math.ceil((re - now()) / 1000)}초` : '준비'); if (rec && s) { const x = bodySample(st.key, s); if (x) B[st.key].push(x); } } beep(660, 120); }
  if (ABORT) return { skipped: true };
  return { payload: B };
};

/* ---------- M07 결막·손톱·목 (핸즈프리 자동 촬영 · 상태별 실패 안내) ---------- */
// 결막 확보 판정 (원본 좌표). 눈만 찾았다고 결막 확보로 보지 않음 → 눈 아래 띠에서 분홍 화소 비율·노출 폭·초점·반사·밝기를 따로 봄
function conjAnalyze(g, gg, eye) {
  if (!gg) return { state: 'NO_EYE' };
  const iris = eye === 'R' ? gg.ir : gg.il, low = (eye === 'R' ? IDX.rLow : IDX.lLow).map(i => gg.p(i)), cor = eye === 'R' ? [gg.p(33), gg.p(133)] : [gg.p(263), gg.p(362)];
  if (!iris) return { state: 'NO_EYE' };
  if (dist(cor[0], cor[1]) < 28) return { state: 'NO_EYE', why: 'small' };   // 눈이 너무 작게 잡힘 → 가까이
  const r = iris.r, ew = dist(cor[0], cor[1]), lidY = Math.max(...low.map(q => q.y)), top = iris.c.y + 0.85 * r, bottom = Math.max(lidY, top) + 0.9 * r;
  const rc = { x: Math.min(cor[0].x, cor[1].x) + 0.15 * ew, y: top, w: 0.7 * ew, h: bottom - top };
  const skin = labStats(g, rois(gg)[eye === 'R' ? 'cheekR' : 'cheekL'], 3);
  const x = Math.max(0, Math.round(rc.x)), y = Math.max(0, Math.round(rc.y)), w = Math.max(2, Math.round(rc.w)), h = Math.max(2, Math.round(rc.h)), d = g.getImageData(x, y, w, h).data;
  let pink = 0, skinLike = 0, glare = 0, dark = 0, n = 0, La = [], aa = [], ba = [], eiS = 0, lap = 0, ln = 0; const Yv = k => 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = (j * w + i) * 4, lab = E.rgb2lab(d[k], d[k + 1], d[k + 2]); n++;
    if (lab.L > 96) glare++; if (lab.L < 22) dark++;
    if (lab.a >= Math.max(18, skin.a + 7) && lab.L > 28 && lab.L < 88) { pink++; La.push(lab.L); aa.push(lab.a); ba.push(lab.b); eiS += Math.log((d[k] + 1) / (d[k + 1] + 1)); }
    else if (Math.abs(lab.a - skin.a) < 5 && Math.abs(lab.L - skin.L) < 12) skinLike++;
    if (i > 0 && j > 0 && i < w - 1 && j < h - 1 && (i + j) % 2 === 0) { lap += Math.abs(4 * Yv(k) - Yv(k - 4) - Yv(k + 4) - Yv(k - 4 * w) - Yv(k + 4 * w)); ln++; } }
  const gap = (lidY - (iris.c.y + r)) / r, pf = pink / n, sf = skinLike / n, sharp = Math.min(1, (lap / Math.max(1, ln)) / 6), Lm = E.DSP.mean(La.length ? La : [0]);
  let state = 'OK';
  if (dark / n > 0.5 || skin.L < 25) state = 'TOO_DARK'; else if (glare / n > 0.08) state = 'GLARE'; else if (sharp < 0.25) state = 'BLUR';
  else if (gap < 0.45 && pf < 0.25) state = 'LOWER_LID_NOT_EXPOSED'; else if (pf < 0.2 && sf > 0.45) state = 'CONJUNCTIVA_OCCLUDED'; else if (pf < 0.25) state = 'LOWER_LID_NOT_EXPOSED';
  return { state, rc, roi: { L: Lm, a: E.DSP.median(aa), b: E.DSP.median(ba), px: pink, ei: pink ? eiS / pink : null }, skin: { L: skin.L, a: skin.a, b: skin.b }, sharp, glare: glare / n, gap: +gap.toFixed(2), pink_frac: +pf.toFixed(2), skin_frac: +sf.toFixed(2) };
}
const DEMO_SVG = [
  `<svg viewBox="0 0 120 90" role="img" aria-label="검지를 아래 눈꺼풀 바로 아래 볼에 가볍게 댐"><ellipse cx="60" cy="38" rx="40" ry="18" fill="#fff" stroke="#17212B" stroke-width="3"/><circle cx="60" cy="38" r="12" fill="#4F5D69"/><path d="M20 38 Q60 60 100 38" fill="none" stroke="#17212B" stroke-width="3"/><rect x="48" y="62" width="24" height="26" rx="10" fill="#E8B796" stroke="#17212B" stroke-width="2"/></svg>`,
  `<svg viewBox="0 0 120 90" role="img" aria-label="손가락으로 피부를 살짝 아래로 당김"><ellipse cx="60" cy="34" rx="40" ry="18" fill="#fff" stroke="#17212B" stroke-width="3"/><circle cx="60" cy="34" r="12" fill="#4F5D69"/><path d="M24 44 Q60 66 96 44 Q60 58 24 44" fill="#E86A7A" stroke="#17212B" stroke-width="2"/><path d="M20 34 Q60 72 100 34" fill="none" stroke="#17212B" stroke-width="3"/><rect x="48" y="66" width="24" height="22" rx="10" fill="#E8B796" stroke="#17212B" stroke-width="2"/><path d="M60 58 v8" stroke="#167D89" stroke-width="3" marker-end="url(#a)"/></svg>`,
  `<svg viewBox="0 0 120 90" role="img" aria-label="눈은 위를 보고 분홍색 안쪽이 보이게 그대로 멈춤"><ellipse cx="60" cy="34" rx="40" ry="18" fill="#fff" stroke="#17212B" stroke-width="3"/><circle cx="60" cy="26" r="12" fill="#4F5D69"/><path d="M24 44 Q60 66 96 44 Q60 58 24 44" fill="#E86A7A" stroke="#17212B" stroke-width="2"/><path d="M20 34 Q60 72 100 34" fill="none" stroke="#17212B" stroke-width="3"/><rect x="48" y="66" width="24" height="22" rx="10" fill="#E8B796" stroke="#17212B" stroke-width="2"/><text x="60" y="12" text-anchor="middle" font-size="10" font-weight="700" fill="#167D89">↑ 위를 봐요</text></svg>` ];
const DEMO_CAP = ['① 검지를 아래 눈꺼풀 바로 아래 볼에 가볍게 대기', '② 피부를 살짝 아래로 당기기', '③ 눈은 위를 보고, 분홍색 안쪽이 보이면 그대로'];
function showDemo(mid) {
  const a = APP.attempts[mid]?.cur; a && (a.demo_played = true);
  if (mid === 'M07') { const m = sheet(`<h2>눈꺼풀 안쪽 촬영 예시</h2><div class="demo3">${DEMO_SVG.map((s, i) => `<figure data-i="${i}">${s}<figcaption>${DEMO_CAP[i]}</figcaption></figure>`).join('')}</div><p class="small muted" style="margin-top:12px">손가락은 눈 아래 피부에만 대고, 눈동자나 분홍색 부분은 만지지 마세요. 화면을 누르지 않아도 분홍색 부분이 보이면 자동으로 찍혀요.</p>`);
    let i = 0; const iv = setInterval(() => { if (!document.body.contains(m)) return clearInterval(iv); m.querySelectorAll('figure').forEach((f, k) => f.classList.toggle('cur', k === i)); i = (i + 1) % 3; }, 1400); return; }
  const tips = { M01: '휴대폰을 눈높이에 세우고, 얼굴이 타원 안에 들어오게 한 뒤 말하지 않고 편하게 숨 쉬어요.', M02: '고개는 고정하고, 큰 점이 움직이면 눈으로만 따라가요. 점이 멈추면 그 점을 봐요.', M03: '정면 보기 → 치아가 보이게 웃기 → 눈 감기(삐 소리가 나면 뜨기) 순서예요.', M04: '문장을 평소 속도로 소리 내어 읽고 "다 읽었어요"를 눌러요.', M05: '연습 문제 2개 뒤에 실제 문제가 나와요. 글자 뜻이 아니라 글자 색을 골라요.', M06: '태블릿을 세워 두고 의자에 앉은 채 한 걸음 뒤로, 팔꿈치와 손끝까지 화면에 보이게 해요.', M08: '알고 있는 값만 입력해요. 모르면 "모름"을 고르면 그 결과만 계산하지 않아요.' };
  sheet(`<h2>${esc(E.MISSIONS[mid].title)} 예시</h2><p>${esc(tips[mid] || '')}</p>`);
}
MISSION.M07 = async att => {
  const p = await CAM.open('user'); if (!p.ok) return { blocked: true }; setState('DEVICE_CHECK', '얼굴 인식을 준비하는 중…'); if (!(await loadFM())) return { error: '얼굴 인식을 불러오지 못했어요' }; fmLoop(); faceCb = trackLumMotion;
  const out = { conj: null, nail: null, neck: null };
  // (1) 결막
  out.conj = await conjStep(att);
  if (ABORT) return { skipped: true };
  // (2) 손톱
  out.nail = await nailStep(att); if (ABORT) return { skipped: true };
  // (3) 목
  out.neck = await neckStep(att); if (ABORT) return { skipped: true };
  return { payload: out };
};
async function subChoice(text, primary = '시작', extra = []) { $('mInstr').textContent = text; return await buttons({ primary, demo: true, skip: true }); }
async function conjStep(att) {
  let eye = 'R'; $('panel').innerHTML = `<div style="position:absolute;left:8px;right:8px;top:8px;z-index:4" class="eyepick" role="group" aria-label="촬영할 눈"><button data-e="R" aria-pressed="true">오른쪽 눈<br><small>(화면에서도 오른쪽)</small></button><button data-e="L" aria-pressed="false">왼쪽 눈<br><small>(화면에서도 왼쪽)</small></button></div>`;
  $('panel').querySelectorAll('[data-e]').forEach(b => b.onclick = () => { eye = b.dataset.e; $('panel').querySelectorAll('[data-e]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
  showDemo('M07');
  const c = await subChoice('촬영할 눈을 고르고 시작을 눌러 주세요. 화면은 거울처럼 보여요.'); if (c === 'skip') return { skipped: true };
  $('panel').innerHTML = ''; $('zoom').hidden = false; OVL = { guide: null, extra: null }; const zc = $('zoomc'), zg = zc.getContext('2d');
  APP.subStep = 'conj'; SUBSKIP = false; $('mSkip').hidden = false; $('mSkip').textContent = '이 촬영 건너뛰기';
  let okSince = null, last = null, tries = 0, failSince = now(); setState('ALIGNING');
  speak('검지로 아래 눈꺼풀 바로 아래 피부를 살짝 당기고, 위를 봐 주세요. 분홍색이 보이면 자동으로 찍혀요.');
  $('mInstr').textContent = '아래 눈꺼풀을 살짝 내려 분홍색 안쪽이 보이게 해 주세요';
  while (!ABORT) {
    await sleep(140); if (SUBSKIP) { APP.subStep = null; $('zoom').hidden = true; $('mSkip').textContent = t('btn.skip'); return { skipped: true, last_state: last?.state }; }
    const L = FM.last; if (!L) continue; const g = fullFrame(), a = conjAnalyze(g, L.faces === 1 ? L.g : null, eye); last = a;
    // 확대 미리보기 (거울 방향)
    if (L.g) { const iris = eye === 'R' ? L.g.ir : L.g.il; if (iris) { const w = iris.r * 7, h = w * 0.75, sx = iris.c.x - w / 2, sy = iris.c.y - h * 0.35; zg.save(); zg.setTransform(-1, 0, 0, 1, zc.width, 0); zg.drawImage(FULL, sx, sy, w, h, 0, 0, zc.width, zc.height);
      if (a.rc) { zg.strokeStyle = a.state === 'OK' ? '#38D27A' : '#FFD15A'; zg.lineWidth = 3; zg.strokeRect((a.rc.x - sx) / w * zc.width, (a.rc.y - sy) / h * zc.height, a.rc.w / w * zc.width, a.rc.h / h * zc.height); } zg.restore(); } }
    $('zoom').classList.toggle('ok', a.state === 'OK'); say1(a.why === 'small' ? '눈이 작게 보여요. 휴대폰을 눈 가까이(약 20cm) 가져와 주세요' : (E.M07_CODES[a.state] || a.state), a.state === 'OK' ? 'ok' : 'bad');
    att.detection_events.length < 600 && att.detection_events.push({ t: Math.round(now() - att.t0), eye_roi_conf: L.faces === 1 ? 0.9 : 0, conjunctiva_roi_conf: a.pink_frac ?? 0, warning_code: a.state, motion_blur: a.sharp != null ? +(1 - a.sharp).toFixed(2) : null, exposure: L.g ? Math.round(APP._lum || 0) : null });
    if (a.state === 'OK') { okSince = okSince ?? now(); prog(Math.min(1, (now() - okSince) / 1500), ''); if (now() - okSince > 700 && now() - okSince < 760 && APP.voice) speak('그대로'); if (now() - okSince > 1500) { beep(1046, 160); break; } }
    else { okSince = null; prog(0, ''); }
    if (now() - failSince > (APP.assist ? 35000 : 25000)) { tries++; failSince = now(); if (tries >= 2) { setState('RETRY_TARGETED', '눈 아래 분홍색 부분이 아직 보이지 않아요. 예시를 다시 보거나 건너뛰어도 괜찮아요.');
      const b = await buttons({ primary: '다시 시도', demo: true, skip: true }); if (b === 'skip') { $('zoom').hidden = true; return { skipped: true, last_state: last?.state }; } tries = 0; setState('ALIGNING'); } }
  }
  APP.subStep = null; $('mSkip').textContent = t('btn.skip'); $('zoom').hidden = true; if (ABORT || !last) return null;
  return { eye, display_mirrored: true, roi: last.roi, skin: last.skin, sharp: last.sharp, glare: last.glare, state: last.state, gap: last.gap, pink_frac: last.pink_frac, detector: 'conj-heuristic-0.1' };
}
async function nailStep(att) {
  OVL = { guide: null, extra: (g, X, Y, sc, dpr) => { const c = $('ov'); g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 4 * dpr; g.setLineDash([10 * dpr, 8 * dpr]); g.strokeRect(c.width * 0.2, c.height * 0.55, c.width * 0.6, c.height * 0.22); g.setLineDash([]); } };
  const c = await subChoice('네 손가락 손톱이 아래 네모 안에 보이게 손등을 화면으로 향해 주세요 (매니큐어가 없을 때만)', '찍기'); if (c === 'skip') return { skipped: true };
  const v = CAM.video, W = v.videoWidth, H = v.videoHeight, g = fullFrame();
  // 화면 네모 → 원본 좌표 (미러·cover 보정)
  const box = $('ov').getBoundingClientRect(), sc = Math.max(box.width / W, box.height / H), ox = (box.width - W * sc) / 2, oy = (box.height - H * sc) / 2;
  const sx0 = box.width * 0.2, sy0 = box.height * 0.55, rc = { x: W - ((sx0 + box.width * 0.6) - ox) / sc, y: (sy0 - oy) / sc, w: box.width * 0.6 / sc, h: box.height * 0.22 / sc };
  // 손톱 확보 판정: 네모 안이 대부분 피부(손)이고, 피부보다 밝은 덩어리가 3개 이상 가로로 놓여야 함 (얼굴·배경만 보이면 실패)
  const x0 = Math.max(0, Math.round(rc.x)), y0 = Math.max(0, Math.round(rc.y)), w = Math.max(4, Math.round(rc.w)), h = Math.max(4, Math.round(rc.h)), d = g.getImageData(x0, y0, w, h).data, st = 2, gw = Math.ceil(w / st), gh = Math.ceil(h / st);
  const labs = new Array(gw * gh); for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const k = ((j * st) * w + i * st) * 4; labs[j * gw + i] = E.rgb2lab(d[k], d[k + 1], d[k + 2]); }
  const skinRef = { L: E.DSP.median(labs.map(q => q.L)), a: E.DSP.median(labs.map(q => q.a)) }, isSkin = q => q.a > 6 && q.a < 30 && q.b > 6 && q.L > 25, skinFrac = labs.filter(isSkin).length / labs.length;
  const mask = labs.map(q => q.L > skinRef.L + 6 && q.a > 2 && q.a < 34 && Math.hypot(q.a, q.b) < 40), seen = new Uint8Array(mask.length), blobs = [];
  for (let k = 0; k < mask.length; k++) { if (!mask[k] || seen[k]) continue; const stack = [k]; seen[k] = 1; let n = 0, sx = 0; while (stack.length) { const c = stack.pop(); n++; sx += c % gw; for (const nb of [c - 1, c + 1, c - gw, c + gw]) if (nb >= 0 && nb < mask.length && !seen[nb] && mask[nb] && Math.abs((nb % gw) - (c % gw)) <= 1) { seen[nb] = 1; stack.push(nb); } } if (n >= mask.length * 0.005) blobs.push({ n, cx: sx / n }); }
  const ok = skinFrac >= 0.5 && blobs.length >= 3 && blobs.length <= 8;
  const nail = labStats(g, rc, 2, lab => lab.L > skinRef.L + 6 && lab.a > 2 && lab.a < 34), skin = labStats(g, rc, 2, lab => isSkin(lab) && lab.L <= skinRef.L + 3);
  return { nail: ok ? { L: nail.L, a: nail.a, b: nail.b } : null, skin: { L: skin.L, a: skin.a, b: skin.b }, px: ok ? nail.n : 0, blobs: blobs.length, skin_frac: +skinFrac.toFixed(2), polish: Math.hypot(nail.a, nail.b) > 40 || nail.a > 32, rc_mirror_corrected: true };
}
async function neckStep(att) {
  OVL = { guide: 'face', extra: null };
  const c = await subChoice('턱을 살짝 들어 목이 화면에 보이게 해 주세요. 그림자가 없게 정면에서 빛이 오면 좋아요.', '찍기'); if (c === 'skip') return { skipped: true };
  const L = FM.last; if (!L || !L.g) return { px: 0 }; const g = fullFrame(), R = rois(L.g), all = labStats(g, R.neck, 2), nk = labStats(g, R.neck, 2, q => q.a > 5 && q.a < 30 && q.b > 6 && q.L > 25), ck = labStats(g, R.cheekR, 2);
  // 목 영역이 대부분 피부여야 함 (옷·그림자·배경이면 실패)
  const frac = nk.n / Math.max(1, all.n); return { neck: frac >= 0.6 ? { L: nk.L, a: nk.a, b: nk.b } : null, cheek: { L: ck.L }, px: frac >= 0.6 ? nk.n : 0, skin_frac: +frac.toFixed(2), pitch: +L.g.pitch.toFixed(1) };
}

/* ---------- M08 기본 정보·짧은 문진 (사용자 입력 — 기기가 잰 척하지 않음) ---------- */
const QUESTIONS = [
  { g: '기본 정보', items: [['age', '나이', 'num', '세'], ['sex', '성별', 'seg', [['f', '여성'], ['m', '남성']]], ['height_cm', '키', 'num', 'cm'], ['weight_kg', '몸무게', 'num', 'kg']] },
  { g: '혈압·질환', items: [['sbp', '최근 수축기 혈압 (위 숫자)', 'num', 'mmHg'], ['bp_treated', '혈압약을 먹고 있나요?', 'yn'], ['htn', '고혈압 진단을 받은 적이 있나요?', 'yn'], ['diabetes', '당뇨가 있나요?', 'yn'], ['smoker', '현재 담배를 피우나요?', 'yn'], ['prior_cvd', '심근경색·협심증·뇌졸중 진단을 받은 적이 있나요?', 'yn']] },
  { g: '수면', items: [['snore', '코를 크게 고나요? (문 닫힌 방 밖에서 들릴 정도)', 'yn'], ['tired', '낮에 자주 피곤하거나 졸린가요?', 'yn'], ['apnea_seen', '자는 동안 숨을 멈춘다는 말을 들은 적이 있나요?', 'yn'], ['neck_gt40', '목둘레가 40cm 이상인가요?', 'yn']] },
];
MISSION.M08 = async att => {
  const st = $('stage'); st.className = 'stage short'; $('vid').hidden = true; $('ov').hidden = true; const prof = loadProfile(), ans = { ...prof };
  for (const [gi, grp] of QUESTIONS.entries()) {
    $('mInstr').textContent = `${grp.g} (${gi + 1}/${QUESTIONS.length})`; setState('CAPTURING', '모르는 값은 "모름"을 골라 주세요');
    $('panel').innerHTML = `<div style="padding:16px">${grp.items.map(([k, label, type, u]) => `<div class="q"><label class="t" for="q_${k}">${label}</label>${type === 'num' ? `<div class="row" style="align-items:center"><input type="number" inputmode="decimal" id="q_${k}" value="${ans[k] ?? ''}" style="flex:1"><span class="muted">${u}</span><button class="seg" style="border:0;background:none" data-unk="${k}"><span class="pill">모름</span></button></div>`
      : `<div class="seg" role="group" aria-label="${label}">${(type === 'yn' ? [[true, '예'], [false, '아니오'], [null, '모름']] : [...u, [null, '모름']]).map(([v, l]) => `<button data-k="${k}" data-v='${JSON.stringify(v)}' aria-pressed="${ans[k] === v}">${l}</button>`).join('')}</div>`}</div>`).join('')}</div>`;
    $('panel').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { ans[b.dataset.k] = JSON.parse(b.dataset.v); $('panel').querySelectorAll(`[data-k="${b.dataset.k}"]`).forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    $('panel').querySelectorAll('[data-unk]').forEach(b => b.onclick = () => { $('q_' + b.dataset.unk).value = ''; });
    const r = await buttons({ primary: gi < QUESTIONS.length - 1 ? '다음' : '입력 마치기', demo: false, skip: true }); if (r === 'skip') return { skipped: true };
    grp.items.filter(i => i[2] === 'num').forEach(([k]) => { const v = parseFloat($('q_' + k).value); ans[k] = isFinite(v) ? v : null; });
  }
  saveProfile(ans);
  return { payload: { answers: ans, source: 'user_input', form_version: 'm08-ko-1' } };
};

/* ---------- 시뮬레이션 (카메라 없이 원시 신호 생성 → 같은 계산) ---------- */
async function simMission(mid) {
  const st = $('stage'); st.className = 'stage short'; $('vid').hidden = true; $('ov').hidden = true;
  $('panel').innerHTML = `<div class="task"><p><b>시뮬레이션</b> · ${esc(E.MISSIONS[mid].title)}</p><p class="small muted">모의 원시 신호를 만들어 실제와 같은 특징 추출·평가를 거쳐요. 이 기록에는 '시뮬레이션' 표시가 붙고 실제 기록과 섞이지 않아요.</p>
    <div class="seg" id="simOpt"><button data-o="good" aria-pressed="true">정상 신호</button><button data-o="bad" aria-pressed="false">품질 실패 신호</button></div></div>`;
  let mode = 'good'; $('simOpt').querySelectorAll('button').forEach(b => b.onclick = () => { mode = b.dataset.o; $('simOpt').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
  setState('CAPTURING', '시뮬레이션 준비'); const b = await buttons({ primary: '모의 수집', demo: false, skip: true }); if (b === 'skip') return { skipped: true };
  if (mid === 'M06') return { skipped: true, reason: 'sim_no_body' };
  const bad = { M01: () => E.SIM.M01(9, { noise: 6, sec: 15 }), M02: () => E.SIM.M02(2, { still: true }), M03: () => { const p = E.SIM.M03(); return { phases: { neutral: p.phases.neutral, smile: p.phases.neutral, closed: p.phases.neutral } }; }, M04: () => E.SIM.M04(4, { silent: true }), M05: () => ({ events: [] }), M07: () => ({ conj: { state: 'LOWER_LID_NOT_EXPOSED' } }), M08: () => ({ answers: { age: 52 } }) };
  const payload = mode === 'good' ? E.SIM[mid](Math.floor(Math.random() * 1e6)) : bad[mid]();
  prog(1, ''); return { payload };
}

/* ======================= 6. 결과 ======================= */
function ctxHistory() { return APP.history.map(s => Object.fromEntries((s.assessments || []).filter(a => a.output_value != null).map(a => [a.assessment_type, typeof a.output_value === 'number' ? a.output_value : NaN]))); }
async function finish() {
  CAM.close(); fmStop();
  const S = APP.session, req = APP.plan.requested;
  E.evaluate(S, req, { history: S.sim ? [] : ctxHistory(), skipped: S.skipped || {} });
  // 건너뛴 미션의 평가는 '측정 불가(건너뜀)'로 이미 표시됨(특징 없음). 보류 모델은 계산하지 않고 공개 결과에서 뺌
  await DB.put(S); renderResults(); show('results');
}
function resCard(a) {
  const v = a.output_value, val = v == null ? '—' : typeof v === 'number' ? fmt(v, Math.abs(v) < 10 ? 1 : 0) : esc(v);
  return `<button class="res" data-a="${a.id}" data-testid="res-${a.assessment_type}"><span class="n">${esc(a.name)}</span><span class="v">${a.status === 'insufficient' ? '<small>측정 불가</small>' : `${val}<small>${esc(a.unit || '')}</small>`}</span>
    <span class="tags"><span class="tag ${a.status}">${esc(a.status_ko)}</span><span class="tag">${esc(E.KIND_KO[a.kind] || a.kind)}</span>${a.quality === 'low' ? '<span class="tag qlow">품질 낮음</span>' : ''}${a.label ? `<span class="tag">${esc(a.label)}</span>` : ''}${a.status === 'insufficient' ? `<span class="small muted">${esc(a.failure_reason || '')}</span>` : ''}</span></button>`;
}
function renderResults() {
  const S = APP.session, V = E.publicView(S), att = Object.values(APP.attempts), okN = Object.keys(APP.attempts).filter(m => APP.attempts[m].list.some(a => a.outcome === 'ACCEPTED')).length, tot = APP.plan.missions.length;
  $('rSim').hidden = !S.sim;
  $('rSum').innerHTML = `<div><span class="small muted">수집 성공</span><b>${okN}/${tot}</b><span class="small muted">미션</span></div><div><span class="small muted">측정값·결과</span><b>${V.released.length + V.reference.filter(a => a.kind === 'measured' || a.kind === 'task' || a.kind === 'screening').length}</b></div><div><span class="small muted">참고용 관찰</span><b>${V.reference.filter(a => !['measured', 'task', 'screening'].includes(a.kind)).length}</b></div><div><span class="small muted">측정 불가</span><b>${V.insufficient.length}</b></div>`;
  const grp = (title, list, open, note) => list.length ? `<details class="grp" ${open ? 'open' : ''}><summary>${title} (${list.length})</summary>${note ? `<p class="small muted">${note}</p>` : ''}${list.map(resCard).join('')}</details>` : '';
  const ref = V.reference, measured = [...V.released, ...ref.filter(a => ['measured', 'task', 'screening'].includes(a.kind))], obs = ref.filter(a => !['measured', 'task', 'screening'].includes(a.kind));
  $('rBody').innerHTML = grp('측정값·과제 결과·위험 선별', measured, true, '측정한 숫자 그대로예요. 기기 정확도 검증 전 항목은 "참고용"으로 표시해요.')
    + grp('외관 관찰 (참고용)', obs, true, '색·모양을 잰 값이에요. 질환 판정이 아니에요.')
    + grp('연구 중 (판정 없이 값만)', V.research, false, '파일럿 데이터를 모으는 항목이에요. 정상·이상 판정을 하지 않아요.')
    + grp('측정 불가', V.insufficient, true, '필요한 데이터가 부족했어요. 해당 미션만 다시 할 수 있어요.')
    + (DEV ? grp('개발자: 보류 모델 (공개 결과에서 제외)', S.assessments.filter(a => a.status === 'held'), false) : '');
  $('rBody').querySelectorAll('[data-a]').forEach(b => b.onclick = () => evidence(b.dataset.a));
  if (V.insufficient.length) { const ms = [...new Set(V.insufficient.flatMap(a => E.ASSESSMENTS[a.assessment_type].inputs.flatMap(t => E.FEATURE_TYPES[t].from)).filter(m => APP.plan.missions.includes(m)))];
    $('rBody').insertAdjacentHTML('beforeend', `<div class="row" style="margin-bottom:12px">${ms.map(m => `<button class="cta ghost" data-rt="${m}">${esc(E.MISSIONS[m].title)}만 다시</button>`).join('')}</div>`);
    $('rBody').querySelectorAll('[data-rt]').forEach(b => b.onclick = () => retryOne(b.dataset.rt)); }
  dev();
}
// 결과 화면에서 미션 하나만 다시: 다른 미션 Capture는 그대로 재사용하고 평가만 다시 계산
async function retryOne(mid) { const i = APP.plan.missions.indexOf(mid); if (APP.session.skipped) delete APP.session.skipped[mid]; await runMission(mid, i + 1, APP.plan.missions.length); finish(); }   // 이전 평가 기록은 그대로 두고(계보), 화면은 최신 평가를 보여 줌
function evidence(aid) {
  const S = APP.session, a = S.assessments.find(x => x.id === aid); if (!a) return; const A = E.ASSESSMENTS[a.assessment_type], feats = S.features.filter(f => a.feature_ids.includes(f.id));
  $('eTitle').textContent = a.name;
  const UNC_KO = { two_method_diff_bpm: ['두 계산법 차이', 'bpm'], hr_bpm_disagree: ['두 계산법 차이', 'bpm'], beats: ['사용한 박동 수', '회'], spread_rpm: ['추정치 간 차이', '회/분'], dur_s: ['측정 시간', '초'], n_frames: ['사용한 프레임', '장'], estimates: ['개별 추정치', ''] };
  const fmtUnc = u => { if (u == null) return '—'; if (typeof u !== 'object') return String(u); return Object.entries(u).map(([k, v]) => { const m = UNC_KO[k]; const val = Array.isArray(v) ? v.join(', ') : (v && typeof v === 'object') ? Object.values(v).join(', ') : v; return m ? `${m[0]} ${val}${m[1] ? ' ' + m[1] : ''}` : `${k}: ${val}`; }).join(' · '); };
  const kv = o => `<dl class="kv">${Object.entries(o).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>`;
  $('eBody').innerHTML = `<div class="card">${kv({ '상태': a.status_ko, '종류': E.KIND_KO[a.kind] || a.kind, '값': a.output_value == null ? '—' : `${a.output_value} ${a.unit || ''}`, '측정 품질': { pass: '통과', low: '낮음', fail: '실패', none: '데이터 없음' }[a.quality], '불확실성': fmtUnc(a.uncertainty), '측정일': new Date(a.executed_at).toLocaleString('ko-KR') })}</div>
    ${a.failure_code ? `<div class="banner sim">측정 불가 이유: ${esc(a.failure_reason)} (${esc(a.failure_code)})</div>` : ''}
    <h3>쓰인 측정 데이터</h3>${feats.length ? feats.map(f => { const c = S.captures.find(c => c.id === f.capture_id); return `<div class="card small"><b>${esc(E.FEATURE_TYPES[f.feature_type].name)}</b> · ${esc(E.MISSIONS[f.mission_id].title)} 미션<br><span class="muted">수집 ${esc(f.capture_id)} · 시도 ${c?.attempt_no ?? 1}회째 · 방법 ${esc(f.method_version)} · ${f.valid ? '유효' : '무효 ' + esc(f.failure_code)}${c?.display_mirrored ? ' · 화면 미러' : ''}</span></div>`; }).join('') : '<p class="muted small">없음</p>'}
    <h3>계산 버전</h3>${kv({ '알고리즘': a.algorithm_version, '규칙': `${a.assessment_type}@${a.rule_version}`, '엔진': a.engine_version, '앱': APP_VER })}
    <h3>근거와 한계</h3><p class="small">${esc(A.limits)}</p><p class="small muted">기준 집단: ${esc(a.reference_population)}</p>
    ${a.evidence_ids.length ? a.evidence_ids.map(id => { const ev = E.EVIDENCE[id]; return `<div class="evd"><b>${esc(ev.title)}</b><br>${esc(ev.authors)} · ${ev.doi ? 'DOI ' + esc(ev.doi) : esc(ev.url || '')}<br><span class="muted">입증 범위: ${esc({ sensing_principle: '측정 원리', biomarker_association: '지표와의 연관', cutoff_validation: '판정 기준 검증', device_validation: '기기 검증' }[a.evidence_supports[id]])} · 대상: ${esc(ev.population)} · 한계: ${esc(ev.limits)}</span></div>`; }).join('') : '<p class="small muted">이 항목을 직접 뒷받침하는 검증 근거가 아직 없어요. 그래서 판정 없이 값만 보여 드려요.</p>'}
    ${a.exclusions?.length ? `<p class="small muted">적용된 제한: ${a.exclusions.map(x => x === 'label_blocked_unvalidated_cutoff' ? '검증 안 된 기준값이라 위험 구간 문구를 표시하지 않음' : x).join(', ')}</p>` : ''}
    ${DEV ? `<h3>개발자: 계보 원본</h3><pre class="json">${esc(JSON.stringify({ assessment: a, features: feats }, null, 1))}</pre>` : ''}`;
  show('evidence');
}
$('rExportJ').onclick = () => download(`facecheck_v2_${APP.session.id}.json`, E.exportJSON(APP.session), 'application/json');
$('rExportC').onclick = () => download(`facecheck_v2_${APP.session.id}.csv`, '﻿' + E.exportCSV(APP.session), 'text/csv');
$('rHome').onclick = () => { renderHistory(); show('welcome'); };

/* ======================= 7. 개발자 오버레이 ======================= */
function dev() {
  if (!DEV) return; const L = FM.last, a = APP.attempts[APP.curMission]?.cur;
  $('devp').textContent = [`screen=${APP.screen} mission=${APP.curMission || '-'} state=${$('mStatus').dataset.state || '-'} fmFps=${FM.fps.toFixed(1)} faces=${L?.faces ?? '-'}`,
    L?.g ? `size=${L.g.size.toFixed(2)} cx=${L.g.cx.toFixed(2)} cy=${L.g.cy.toFixed(2)} yaw=${L.g.yaw.toFixed(1)} roll=${L.g.roll.toFixed(1)} ear=${L.g.ear.map(x => x.toFixed(3))} gaze=${L.g.gaze ? `${L.g.gaze.x.toFixed(3)},${L.g.gaze.y.toFixed(3)}` : '-'} lum=${(APP._lum ?? 0).toFixed(0)} motion=${(APP._motion ?? 0).toFixed(2)}` : '',
    a ? `attempt#${a.attempt_no} states=${a.state_history.map(s => s.s + '@' + s.t).join('>')}` : '', $('gzt') && !$('gz').hidden ? `target=${$('gzt').style.left},${$('gzt').style.top}` : '',
    APP.session ? `captures=${APP.session.captures.length} features=${APP.session.features.length} assessments=${APP.session.assessments.length}` : ''].filter(Boolean).join('\n');
}

/* ---------- 시작 ---------- */
renderHistory(); show('welcome');
if (DEV) window.__fcv2 = { APP, E, FM, CAM, conjAnalyze, geo, sampleColors };
