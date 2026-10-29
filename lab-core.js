function fingerFrame(d, W, H) {
  let r = 0, g = 0, b = 0, n = 0, l2 = 0, l1 = 0;
  const x0 = Math.floor(W * 0.2), x1 = Math.ceil(W * 0.8), y0 = Math.floor(H * 0.2), y1 = Math.ceil(H * 0.8);
  let sat = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 4, L = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; r += d[k]; g += d[k + 1]; b += d[k + 2]; l1 += L; l2 += L * L; n++; if (d[k] >= 250) sat++; }
  r /= n; g /= n; b /= n; const lm = l1 / n, cv = Math.sqrt(Math.max(0, l2 / n - lm * lm)) / (lm || 1);
  const on = r > 35 && r > 1.6 * g && r > 1.6 * b && cv < 0.35;
  return { r, g, b, on, cv, sat: sat / n };
}

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

const LAB_BUILD='phone-lab-20261029-1';
const LAB_PROTOCOLS={A:{name:'첫 마디=렌즈 · 둘째 마디=플래시',torch:true},B:{name:'렌즈만 덮기 · 플래시 켬',torch:true},C:{name:'렌즈만 덮기 · 플래시 끔',torch:false}};
function labPacket(trials,errors){return {privacyNotice:'건강정보 포함. 검토 담당자 외 공유 금지. 선택한 경우 손 부위 사진 포함.',schema:'facecheck-phone-lab-v1',build:LAB_BUILD,exportedAt:new Date().toISOString(),purpose:'촬영 자세·광학 신호·기존 평가 엔진의 개발 비교. 임상 정확도 확인 자료 아님.',thresholds:{coverage:'r>35,r>1.6g,r>1.6b,cv<.35',targetUsableSeconds:60,wallLimitSeconds:150,recoverySeconds:2,minHRSeconds:20,minHRVSeconds:40,minHRVFps:24,minACPercent:.3},errors,trials};}
function labExpired(at,now=Date.now()){const ms=Date.parse(at);return !Number.isFinite(ms)||now-ms>7*86400000;}
