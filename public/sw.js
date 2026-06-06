// ── Service Worker for English Voice Practice ────────────────────────────────
const CACHE_NAME = 'evp-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/Emma.png',
  '/Mia.png',
  '/Chloe.png',
  '/Airi.png',
  '/James.png',
];

// インストール時にアプリのファイルをキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 古いキャッシュを削除
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// リクエスト処理：キャッシュ優先、なければネットワーク
self.addEventListener('fetch', (e) => {
  // API リクエストはキャッシュしない（常にネットワーク）
  if (e.request.url.includes('/api/')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        // 成功したレスポンスをキャッシュに追加
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match('/index.html')) // オフライン時はトップページ
  );
});
