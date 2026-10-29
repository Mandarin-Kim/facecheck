// 페이스체크 알림 도우미 (v3.2): 알림창 위젯·수면 측정 알림의 버튼을 눌렀을 때 앱을 열거나 앞으로 가져옴.
// 화면 파일을 저장(캐시)하지 않음 → 새 버전을 올리면 바로 반영됨
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  const n = e.notification, d = n.data || {}, go = e.action || d.go || 'home', base = d.base || self.registration.scope;
  if (n.tag !== 'fc-widget') n.close();   // 위젯 알림은 그대로 둠
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) if (c.url.startsWith(base)) { c.postMessage({ fc: 'go', go }); return c.focus(); }
    return self.clients.openWindow(base + '?go=' + encodeURIComponent(go));
  })());
});
