const CACHE = 'tracker-v5';
const OFFLINE_URL = '/index.html';

// Handle notification messages from the page
self.addEventListener('message', function(e){
  if(e.data&&e.data.type==='SHOW_NOTIF'){
    self.registration.showNotification(e.data.title,{
      body: e.data.body,
      tag:  e.data.tag||'tracker',
      icon: '/manifest.json',
      badge:'/manifest.json',
      vibrate:[100,50,100],
      requireInteraction: false,
    });
  }
});

// Handle notification click — focus the app
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
      for(var i=0;i<list.length;i++){
        if(list[i].url.indexOf(self.location.origin)===0&&'focus' in list[i])
          return list[i].focus();
      }
      if(clients.openWindow) return clients.openWindow('/');
    })
  );
});

// Files to pre-cache on install
const PRE_CACHE = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // Cache what we can — ignore failures for external resources
      return Promise.allSettled(PRE_CACHE.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET requests
  if(e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // For navigation requests (HTML pages) — serve from cache, fallback to network
  if(e.request.mode === 'navigate'){
    e.respondWith(
      caches.match(OFFLINE_URL).then(cached => {
        return fetch(e.request)
          .then(res => {
            // Update cache with fresh version
            if(res && res.status === 200){
              const clone = res.clone();
              caches.open(CACHE).then(cache => cache.put(OFFLINE_URL, clone));
            }
            return res;
          })
          .catch(() => cached || new Response('Offline', {status: 503}));
      })
    );
    return;
  }

  // For same-origin static assets — cache first
  if(url.origin === self.location.origin){
    e.respondWith(
      caches.match(e.request).then(cached => {
        return cached || fetch(e.request).then(res => {
          if(res && res.status === 200){
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // For external resources (CDN fonts, chart.js) — network first, cache fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if(res && res.status === 200){
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
