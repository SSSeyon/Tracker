const CACHE = 'tracker-v7';
const OFFLINE_URL = './index.html';

// ── Periodic Background Sync tag ─────────────────────────────────────────
const PBS_TAG = 'tracker-notif-check';

// ── Helper: get tasks from all open clients via MessageChannel ────────────
function getTasksFromClient(client){
  return new Promise(function(resolve){
    const ch=new MessageChannel();
    ch.port1.onmessage=function(e){resolve(e.data||[]);};
    client.postMessage({type:'GET_TASKS'},[ ch.port2]);
    setTimeout(function(){resolve([]);},2000); // fallback if page doesn't respond
  });
}

// ── Core notification check — runs from SW directly ──────────────────────
// Called by both periodicsync and the SYNC_CHECK message from the page
async function runNotifCheck(tasks){
  if(!tasks||!tasks.length) return;
  const now=new Date();
  const hhmm=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const today=new Date(now);today.setHours(0,0,0,0);
  const todayStr=today.toISOString().split('T')[0];

  // Fire at 10:00, 13:00, 17:00 — use SW cache to deduplicate per slot per day
  const slots=['10:00','13:00','17:00'];
  const slotKey='notif_slot_'+todayStr+'_'+hhmm;
  const cache=await caches.open(CACHE);
  const alreadyFired=await cache.match('./'+slotKey);

  if(slots.includes(hhmm)&&!alreadyFired){
    await cache.put('./'+slotKey, new Response('1'));
    const active=tasks.filter(function(t){return t.status!=='done';});
    const overdue=active.filter(function(t){return t.dueDate&&new Date(t.dueDate+'T00:00:00')<today;});
    const dueToday=active.filter(function(t){return t.dueDate===todayStr;});

    if(overdue.length){
      const names=overdue.slice(0,3).map(function(t){return t.name;}).join(', ')+(overdue.length>3?'…':'');
      await self.registration.showNotification(
        overdue.length+' overdue task'+(overdue.length>1?'s':''),
        {body:names,tag:'tracker-overdue-'+todayStr,vibrate:[100,50,100],icon:'./icon-192.png'}
      );
    }
    if(dueToday.length){
      const names=dueToday.slice(0,3).map(function(t){return t.name;}).join(', ')+(dueToday.length>3?'…':'');
      await self.registration.showNotification(
        dueToday.length+' task'+(dueToday.length>1?'s':'')+' due today',
        {body:names,tag:'tracker-today-'+todayStr,vibrate:[100,50,100],icon:'./icon-192.png'}
      );
    }
  }
}

// ── Periodic Background Sync ─────────────────────────────────────────────
self.addEventListener('periodicsync', function(e){
  if(e.tag===PBS_TAG){
    e.waitUntil(
      clients.matchAll({type:'window',includeUncontrolled:true}).then(async function(list){
        let tasks=[];
        // Try to get tasks from an open page first
        if(list.length){
          tasks=await getTasksFromClient(list[0]);
        }
        // If no page open or no tasks returned, nothing we can do without a backend
        if(tasks.length) await runNotifCheck(tasks);
      })
    );
  }
});

// ── Message handler from page ─────────────────────────────────────────────
self.addEventListener('message', function(e){
  // Legacy: direct show notification
  if(e.data&&e.data.type==='SHOW_NOTIF'){
    self.registration.showNotification(e.data.title,{
      body: e.data.body,
      tag:  e.data.tag||'tracker',
      vibrate:[100,50,100],
      requireInteraction: false,
      icon: './icon-192.png',
    });
  }
  // New: page sends tasks for SW to evaluate and fire notifications
  if(e.data&&e.data.type==='SYNC_CHECK'&&e.data.tasks){
    e.waitUntil(runNotifCheck(e.data.tasks));
  }
  // New: page is requesting tasks — respond via MessageChannel port
  if(e.data&&e.data.type==='GET_TASKS'&&e.ports&&e.ports[0]){
    // We can't read localStorage from SW — page must send tasks to us
    e.ports[0].postMessage([]);
  }
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
      for(var i=0;i<list.length;i++){
        if(list[i].url.indexOf(self.location.origin)===0&&'focus' in list[i])
          return list[i].focus();
      }
      if(clients.openWindow) return clients.openWindow('./');
    })
  );
});

// ── Install ───────────────────────────────────────────────────────────────
const PRE_CACHE = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
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

// ── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if(e.request.mode === 'navigate'){
    e.respondWith(
      caches.match(OFFLINE_URL).then(cached => {
        return fetch(e.request)
          .then(res => {
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
