const CACHE = 'tracker-v19';
const NOTIF_CACHE = 'tracker-notif-slots'; // separate, version-independent cache for dedup keys
const OFFLINE_URL = './index.html';

// ── Periodic Background Sync tag ─────────────────────────────────────────
const PBS_TAG = 'tracker-notif-check';

// ── Core notification check — runs from SW directly ──────────────────────
// Called by both periodicsync and the SYNC_CHECK message from the page.
//
// KEY DESIGN DECISIONS:
// 1. Windowed matching: we fire if the current time is within 59 minutes
//    AFTER a slot (not exact-minute only), because PBS fires roughly hourly
//    and will almost never land exactly on 10:30/13:00/17:00.
// 2. Dedup key is per-slot-per-day (not per-minute), stored in a separate
//    cache that survives SW version upgrades.
// 3. Custom reminder time is passed in from the page alongside tasks.
async function runNotifCheck(tasks, reminderTime){
  if(!tasks||!tasks.length) return;
  const now=new Date();
  const today=new Date(now);today.setHours(0,0,0,0);
  // Local date, not toISOString() — UTC formatting shifts the date near midnight
  const todayStr=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
  const nowMins=now.getHours()*60+now.getMinutes();

  // Build named slots: fixed + custom reminder
  const namedSlots=[
    {name:'slot-1030', hhmm:'10:30', mins:10*60+30},
    {name:'slot-1300', hhmm:'13:00', mins:13*60},
    {name:'slot-1700', hhmm:'17:00', mins:17*60},
  ];
  if(reminderTime&&reminderTime.match(/^\d{2}:\d{2}$/)){
    const parts=reminderTime.split(':');
    const rMins=parseInt(parts[0])*60+parseInt(parts[1]);
    // Only add if not already one of the fixed slots (10:30 / 13:00 / 17:00)
    if(![630,780,1020].includes(rMins)){
      namedSlots.push({name:'slot-custom', hhmm:reminderTime, mins:rMins});
    }
  }

  const cache=await caches.open(NOTIF_CACHE);

  for(const slot of namedSlots){
    // Window: fire if we are between slot time and slot+59 mins
    const diff=nowMins-slot.mins;
    if(diff<0||diff>=60) continue; // outside window

    const deupKey='notif_'+todayStr+'_'+slot.name;
    const alreadyFired=await cache.match('./'+deupKey);
    if(alreadyFired) continue;

    // Mark as fired immediately to prevent double-fire from rapid SYNC_CHECK calls
    await cache.put('./'+deupKey, new Response('1'));

    try{
      const active=tasks.filter(function(t){return t.status!=='done';});
      const overdue=active.filter(function(t){return t.dueDate&&new Date(t.dueDate+'T00:00:00')<today;});
      const dueToday=active.filter(function(t){return t.dueDate===todayStr;});

      if(overdue.length){
        const names=overdue.slice(0,3).map(function(t){return t.name;}).join(', ')+(overdue.length>3?'…':'');
        await self.registration.showNotification(
          overdue.length+' overdue task'+(overdue.length>1?'s':''),
          {body:names,tag:'tracker-overdue-'+todayStr,vibrate:[100,50,100],icon:'./icon-192.png',requireInteraction:false}
        );
        await broadcastToClients({type:'NOTIF_FIRED', title:overdue.length+' overdue task'+(overdue.length>1?'s':''), body:names, taskId:overdue.length===1?overdue[0].id:null});
      }
      if(dueToday.length){
        const names=dueToday.slice(0,3).map(function(t){return t.name;}).join(', ')+(dueToday.length>3?'…':'');
        // Slight delay so two notifications don't stack at exactly the same moment
        await new Promise(function(r){setTimeout(r,overdue.length?1500:0);});
        await self.registration.showNotification(
          dueToday.length+' task'+(dueToday.length>1?'s':'')+' due today',
          {body:names,tag:'tracker-today-'+todayStr,vibrate:[100,50,100],icon:'./icon-192.png',requireInteraction:false}
        );
        await broadcastToClients({type:'NOTIF_FIRED', title:dueToday.length+' task'+(dueToday.length>1?'s':'')+' due today', body:names, taskId:dueToday.length===1?dueToday[0].id:null});
      }
    }catch(err){
      // showNotification failed — release the dedup key so a later check
      // in the same window can retry instead of burning the slot for the day
      await cache.delete('./'+deupKey);
      throw err;
    }

    // Only fire one slot per check (the earliest window we find)
    break;
  }

  // Prune old dedup keys from previous days to keep cache clean.
  // Only touch notif_* entries — the task snapshot also lives in this cache.
  const keys=await cache.keys();
  for(const req of keys){
    if(req.url.includes('notif_')&&!req.url.includes(todayStr)){
      await cache.delete(req);
    }
  }
}

// ── Task snapshot persistence ─────────────────────────────────────────────
// The SW can't read localStorage, so the page pushes its task list here on
// every save. Stored in NOTIF_CACHE (survives SW upgrades and HARD_RELOAD)
// so periodicsync can evaluate notifications with ZERO pages open — this is
// what makes background notifications work when the app is closed.
const SNAPSHOT_KEY='./task-snapshot';
async function saveSnapshot(tasks, reminderTime){
  try{
    const cache=await caches.open(NOTIF_CACHE);
    await cache.put(SNAPSHOT_KEY, new Response(JSON.stringify({
      tasks:tasks, reminderTime:reminderTime||'', savedAt:Date.now()
    })));
  }catch(e){}
}
async function loadSnapshot(){
  try{
    const cache=await caches.open(NOTIF_CACHE);
    const res=await cache.match(SNAPSHOT_KEY);
    return res?await res.json():null;
  }catch(e){ return null; }
}

// ── Helper: broadcast a message to all open page clients ─────────────────
async function broadcastToClients(msg){
  const list = await clients.matchAll({type:'window', includeUncontrolled:true});
  list.forEach(function(c){ c.postMessage(msg); });
}

// ── Helper: get tasks from all open clients via MessageChannel ────────────
function getTasksFromClient(client){
  return new Promise(function(resolve){
    const ch=new MessageChannel();
    ch.port1.onmessage=function(e){resolve(e.data||[]);};
    client.postMessage({type:'GET_TASKS'},[ch.port2]);
    setTimeout(function(){resolve([]);},2000); // fallback if page doesn't respond
  });
}

// ── Periodic Background Sync ─────────────────────────────────────────────
self.addEventListener('periodicsync', function(e){
  if(e.tag===PBS_TAG){
    e.waitUntil((async function(){
      const list=await clients.matchAll({type:'window',includeUncontrolled:true});
      let tasks=[];
      let reminderTime='';
      if(list.length){
        tasks=await getTasksFromClient(list[0]);
      }
      // Page closed (or didn't answer) — use the persisted snapshot. This is
      // the path that fires notifications when the app isn't open.
      if(!tasks.length){
        const snap=await loadSnapshot();
        if(snap){ tasks=snap.tasks||[]; reminderTime=snap.reminderTime||''; }
      }
      if(tasks.length) await runNotifCheck(tasks, reminderTime);
    })());
  }
});

// ── Message handler from page ─────────────────────────────────────────────
self.addEventListener('message', function(e){
  // Hard reload — delete all app caches so next load fetches fresh from network
  if(e.data&&e.data.type==='HARD_RELOAD'){
    e.waitUntil(
      caches.keys().then(function(keys){
        return Promise.all(
          keys.filter(function(k){ return k !== 'tracker-notif-slots'; }).map(function(k){ return caches.delete(k); })
        );
      })
    );
  }
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
  // Page sends tasks + reminderTime for SW to evaluate and fire notifications;
  // also persisted as the snapshot used by periodicsync when the page is closed
  if(e.data&&e.data.type==='SYNC_CHECK'&&e.data.tasks){
    e.waitUntil(Promise.all([
      saveSnapshot(e.data.tasks, e.data.reminderTime||''),
      runNotifCheck(e.data.tasks, e.data.reminderTime||'')
    ]));
  }
  // Persist-only update of the snapshot (sent on every task save / page hide)
  if(e.data&&e.data.type==='TASKS_SNAPSHOT'&&e.data.tasks){
    e.waitUntil(saveSnapshot(e.data.tasks, e.data.reminderTime||''));
  }
  // Page requesting tasks — SW can't read localStorage so returns empty
  if(e.data&&e.data.type==='GET_TASKS'&&e.ports&&e.ports[0]){
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
  './styles.css',
  './app.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Bricolage+Grotesque:wght@500;600;700;800&display=swap',
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
    // Only delete old APP caches — preserve NOTIF_CACHE across upgrades
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== NOTIF_CACHE).map(k => caches.delete(k)))
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
