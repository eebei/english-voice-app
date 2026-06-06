// ── Service Worker for English Voice Practice ────────────────────────────────
const CACHE_NAME = 'evp-v5';

// 画像とmanifestのみキャッシュ（index.htmlは常に最新を取得）
const STATIC_ASSETS = [
  '/manifest.json',
  '/Emma.png',
  '/Mia.png',
  '/Chloe.png',
  '/Airi.png',
  '/James.png',
];

// インストール時に静的ファイルのみキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
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

// リクエスト処理
self.addEventListener('fetch', (e) => {
  // APIリクエストは常にネットワーク
  if (e.request.url.includes('/api/')) {
    return;
  }

  // index.htmlは常にネットワークから取得（最新版を保証）
  if (e.request.mode === 'navigate' || e.request.url.endsWith('/') || e.request.url.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 画像・manifestはキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
