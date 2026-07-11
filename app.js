const APP_VERSION='2.0.0';
const STORAGE_KEY='donezo_v4_store';
const UI_KEY='donezo_ui_v1';
// Parse JSON from localStorage without letting corrupt data crash the app
function safeParse(raw,fallback){try{const v=JSON.parse(raw);return v==null?fallback:v;}catch(e){return fallback;}}
// Escape user-entered text (task names, step text, category names) before
// injecting into innerHTML — a title like `Fix <config> bug` or one with
// quotes would otherwise break the markup
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function _uid(p){return (window.crypto&&crypto.randomUUID)?crypto.randomUUID():(p||'')+Date.now()+Math.random().toString(36).slice(2);}
// Coerce a possibly-malformed task (imported backup, hand-edited Firebase node,
// or an older schema) into a valid shape so rendering, sorting and progress
// math never hit undefined/NaN — e.g. a missing priority would make the sort
// comparator return NaN and scramble the whole list.
function normalizeTask(t){
  if(!t||typeof t!=='object') t={};
  const out={...t};
  if(!out.id) out.id=_uid('t');
  out.name=(out.name==null)?'Untitled':String(out.name);
  if(['high','medium','low'].indexOf(out.priority)<0) out.priority='medium';
  if(typeof out.status!=='string') out.status='todo';
  out.steps=Array.isArray(out.steps)?out.steps.map(function(s){
    s=(s&&typeof s==='object')?s:{};
    return {...s,
      id:s.id||_uid('s'),
      text:(s.text==null)?'':String(s.text),
      status:(typeof s.status==='string')?s.status:'not-started'};
  }):[];
  if(out.manualProgress!=null){const n=parseInt(out.manualProgress);out.manualProgress=isNaN(n)?0:n;}
  if(!Array.isArray(out.history)) out.history=[];
  const now=Date.now();
  if(typeof out.createdAt!=='number') out.createdAt=now;
  if(typeof out.updatedAt!=='number') out.updatedAt=out.createdAt||now;
  return out;
}
let _tasksRaw=safeParse(localStorage.getItem(STORAGE_KEY),[]);
let tasks=(Array.isArray(_tasksRaw)?_tasksRaw:[]).map(normalizeTask);
// Wrap the frequent full-array persist so a QuotaExceededError (localStorage is
// capped ~5MB and we serialize every task on each write) degrades gracefully
// instead of throwing mid-operation — Firebase cloud sync still succeeds.
let _quotaWarned=false;
function saveTasksLocal(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); }
  catch(e){
    console.warn('Local storage write failed (quota?):',e);
    if(!_quotaWarned){ _quotaWarned=true; try{showToast('⚠ Local storage full — changes still sync to the cloud');}catch(_){} }
  }
  // Keep the SW's snapshot fresh so background notification checks (periodic
  // sync while the app is closed) evaluate against current tasks
  try{ sendTasksToSW('TASKS_SNAPSHOT'); }catch(_){}
}

// ── Firebase ─────────────────────────────────────────────────────────
const FB_CONFIG={
  apiKey:"AIzaSyAfxfEp8LT-f_zqiRr1Mbj7RghsxulNboY",
  authDomain:"gen-lang-client-0371859680.firebaseapp.com",
  databaseURL:"https://gen-lang-client-0371859680-default-rtdb.firebaseio.com",
  projectId:"gen-lang-client-0371859680",
  storageBucket:"gen-lang-client-0371859680.firebasestorage.app",
  messagingSenderId:"847229528942",
  appId:"1:847229528942:web:64de0f558049f382822f7f"
};
let db=null,fbRef=null,fbConnected=false;
// Reconcile a local task list with a remote snapshot on first sync.
// Returns {list, toPush}: merged tasks (newer updatedAt wins per id) and the
// subset that originated locally and needs to be written back to Firebase.
function mergeTasks(local,remote){
  const byId={};
  (remote||[]).forEach(function(t){if(t&&t.id)byId[t.id]=t;});
  const toPush=[];
  (local||[]).forEach(function(t){
    if(!t||!t.id)return;
    const r=byId[t.id];
    if(!r){ byId[t.id]=t; toPush.push(t); }                       // local-only → keep + push up
    else if((t.updatedAt||0)>(r.updatedAt||0)){ byId[t.id]=t; toPush.push(t); } // local newer → keep + push up
  });
  return {list:Object.values(byId), toPush:toPush};
}
function initFirebase(){
  (window.__fbReady||Promise.resolve()).then(()=>{
  try{
    firebase.initializeApp(FB_CONFIG);
    db=firebase.database();
    fbRef=db.ref('tasks');
    archRef=db.ref('archive');
    archRef.on('value',function(snap){
      const data=snap.val();
      if(data){
        const arch=Object.values(data).filter(function(x){return (Date.now()-x.archivedAt)<30*86400000;});
        localStorage.setItem(ARCH_KEY,JSON.stringify(arch));
        if(document.getElementById('view-archive')&&document.getElementById('view-archive').style.display!=='none')renderArchive();
      }
    });
    // listen for real-time updates
    let _fbFirstLoad=true;
    fbRef.on('value',snap=>{
      const data=snap.val();
      const remote=(data?Object.values(data):[]).map(normalizeTask);
      if(_fbFirstLoad){
        _fbFirstLoad=false;
        // Merge local (possibly offline-created/edited) tasks with the first
        // remote snapshot instead of blindly overwriting — otherwise tasks
        // created or updated while offline are lost the instant Firebase
        // responds. Overlapping ids resolve to whichever has the newer
        // updatedAt; local-only tasks are kept and pushed up. (Tradeoff: a task
        // deleted on another device while this one was offline can reappear —
        // acceptable vs. silently losing unsynced work.)
        const merged=mergeTasks(tasks.map(normalizeTask),remote);
        tasks=merged.list;
        saveTasksLocal();
        render();
        merged.toPush.forEach(fbSave); // write local-only / locally-newer tasks back up
        if(Notification.permission==='granted'){
          setTimeout(checkTimeBlockNotifs,500);
          setTimeout(checkStepNotifs,1000);
          setTimeout(sendTasksToSW,1500); // push fresh tasks to SW
        }
      } else {
        // After the initial reconcile, the realtime feed is the source of truth
        tasks=remote;
        saveTasksLocal();
        render();
      }
    });
    // connection state — Firebase always fires false first on init,
    // so suppress the misleading "Offline" flash until we've connected once
    let _fbEverConnected=false;
    db.ref('.info/connected').on('value',snap=>{
      fbConnected=!!snap.val();
      const dot=document.getElementById('sync-dot-el');
      const lbl=document.getElementById('sync-lbl-el');
      if(fbConnected){
        const wasOffline=_fbEverConnected; // true means this is a reconnect, not first connect
        _fbEverConnected=true;
        if(dot){dot.style.background='#1a5c38';dot.classList.remove('pulsing');}
        if(lbl)lbl.innerText='Synced just now';
        // Keep topbar + settings sync badges in sync
        ['topbar-sync-dot','settings-sync-dot'].forEach(function(id){const d=document.getElementById(id);if(d){d.style.background='#1a5c38';d.classList.remove('pulsing');}});
        ['settings-sync-lbl'].forEach(function(id){const d=document.getElementById(id);if(d)d.innerText='Synced just now';});
        // On reconnect (not first connect — first connect is handled by fbRef.on('value'))
        // force a fresh fetch so data is always current after coming back online
        if(wasOffline) fbRef.once('value').then(function(snap){
          const data=snap.val();
          if(data){tasks=Object.values(data).map(normalizeTask);saveTasksLocal();render();}
        }).catch(function(){});
      } else {
        if(dot){dot.style.background='#9aa5b4';dot.classList.add('pulsing');}
        if(lbl)lbl.innerText=_fbEverConnected?'Offline':'Connecting…';
        // Keep topbar + settings sync badges in sync
        ['topbar-sync-dot','settings-sync-dot'].forEach(function(id){const d=document.getElementById(id);if(d){d.style.background='#9aa5b4';d.classList.add('pulsing');}});
        const _offlineLbl=_fbEverConnected?'Offline':'Connecting…';
        ['topbar-sync-lbl','settings-sync-lbl'].forEach(function(id){const d=document.getElementById(id);if(d)d.innerText=_offlineLbl;});
      }
    });
  }catch(e){console.warn('Firebase init failed:',e)}
  });
}
function forceSync(){
  forceSyncWithCallback(null);
}

// Tapping the sync badge forces a re-fetch and shows feedback
function tapSyncBadge(){
  const lbl=document.getElementById('sync-lbl-el');
  const dot=document.getElementById('sync-dot-el');
  if(lbl)lbl.innerText='Syncing…';
  if(dot)dot.classList.add('pulsing');
  ['topbar-sync-lbl','settings-sync-lbl'].forEach(function(id){const d=document.getElementById(id);if(d)d.innerText='Syncing…';});
  ['topbar-sync-dot','settings-sync-dot'].forEach(function(id){const d=document.getElementById(id);if(d)d.classList.add('pulsing');});
  forceSyncWithCallback(function(){
    if(dot){dot.classList.remove('pulsing');dot.style.background='#1a5c38';}
    if(lbl)lbl.innerText='Synced just now';
    ['topbar-sync-dot','settings-sync-dot'].forEach(function(id){const d=document.getElementById(id);if(d){d.classList.remove('pulsing');d.style.background='#1a5c38';}});
    ['settings-sync-lbl'].forEach(function(id){const d=document.getElementById(id);if(d)d.innerText='Synced just now';});
  });
}

// Hard reload — clears SW cache then reloads, forcing a fresh fetch from the network.
// This is a true hard refresh (equivalent to Ctrl+Shift+R on desktop) rather than
// a regular reload which may still serve cached content from the SW.
function hardReload(){
  if('serviceWorker' in navigator && navigator.serviceWorker.controller){
    navigator.serviceWorker.controller.postMessage({type:'HARD_RELOAD'});
    // Give the SW a moment to clear its cache before we reload
    setTimeout(function(){ window.location.reload(true); }, 400);
  } else {
    window.location.reload(true);
  }
}

function forceSyncWithCallback(cb){
  if(!fbRef){render();if(cb)cb();return;}
  // Only show Syncing label if not already connected (realtime listener manages
  // the label when live — avoid overriding it with a flash of Syncing)
  const lbl=document.getElementById('sync-lbl-el');
  if(!fbConnected&&lbl)lbl.innerText='Syncing…';
  // Timeout guard: if Firebase doesn't respond within 8s (e.g. WebSocket still
  // re-establishing after browsing data was cleared), fall back gracefully
  let _settled=false;
  const _timeout=setTimeout(function(){
    if(_settled) return;
    _settled=true;
    console.warn('Force sync timed out — Firebase WebSocket may still be reconnecting');
    render(); // render whatever is in memory
    if(lbl&&!fbConnected)lbl.innerText='Offline';
    if(cb)cb();
  },8000);
  fbRef.once('value').then(function(snap){
    if(_settled){clearTimeout(_timeout);return;}
    _settled=true;clearTimeout(_timeout);
    const data=snap.val();
    tasks=data?Object.values(data).map(normalizeTask):[];
    saveTasksLocal();
    render();
    if(Notification.permission==='granted') checkDueNotifications();
    if(cb)cb();
  }).catch(function(e){
    if(_settled){clearTimeout(_timeout);return;}
    _settled=true;clearTimeout(_timeout);
    console.warn('Force sync failed:',e);
    render();
    if(lbl&&!fbConnected)lbl.innerText='Sync failed';
    if(cb)cb();
  });
}

function fbSave(t){
  if(fbRef)fbRef.child(t.id).set(t).catch(e=>console.warn('FB write error:',e));
}

const ARCH_KEY='donezo_archive';
let archRef=null;

function loadArch(){return safeParse(localStorage.getItem(ARCH_KEY),[]);}
function saveArch(arch){
  localStorage.setItem(ARCH_KEY,JSON.stringify(arch));
  if(archRef) archRef.set(arch.reduce(function(o,t){o[t.id.replace(/[.#$\[\]]/g,'_')]=t;return o;},{})).catch(function(e){console.warn('Archive sync error:',e);});
}
function fbDelete(id){
  if(fbRef)fbRef.child(id).remove().catch(e=>console.warn('FB delete error:',e));
}
let uiSettings=safeParse(localStorage.getItem(UI_KEY),{showMatrix:true,showEmojis:true,showProgress:true,showDates:true,showSteps:true,showFab:true});
uiSettings.showMatrix=true;uiSettings.showEmojis=true;uiSettings.showProgress=true;uiSettings.showDates=true;uiSettings.showSteps=true;
let currentMode='all',currentDashboardView='list',sortMode=localStorage.getItem('donezo_sort')||'recent',currentView='dashboard';
let editingId=null,currentCalDate=new Date(),selectedDateStr='',doneCollapsed=true,taskView='cards';
window.currentModalSteps=[];
let charts={category:null,trend:null};
let renderTimer=null;
function scheduleRender(){clearTimeout(renderTimer);renderTimer=setTimeout(render,60)}

// ── Gamification ─────────────────────────────────────────────────────
const GK = 'donezo_gamify';
const XP_PER = {high:30, medium:20, low:10};
const LEVELS = [0,100,250,500,900,1500,2400,3700,5500,8000,12000];
const LEVEL_NAMES = ['Beginner','Starter','Hustler','Achiever','Pro','Expert','Master','Champion','Legend','Elite','Titan'];

const BADGE_DEFS = [
  {id:'first',  icon:'🎯', name:'First Task',    desc:'Complete your first task',        check:g=>g.totalDone>=1},
  {id:'five',   icon:'✋', name:'High Five',      desc:'Complete 5 tasks',                check:g=>g.totalDone>=5},
  {id:'twenty', icon:'🏅', name:'Score 20',       desc:'Complete 20 tasks',               check:g=>g.totalDone>=20},
  {id:'fifty',  icon:'🏆', name:'Half Century',   desc:'Complete 50 tasks',               check:g=>g.totalDone>=50},
  {id:'streak3',icon:'🔥', name:'On Fire',        desc:'3-day streak',                    check:g=>g.bestStreak>=3},
  {id:'streak7',icon:'⚡', name:'Week Warrior',   desc:'7-day streak',                    check:g=>g.bestStreak>=7},
  {id:'high5',  icon:'💎', name:'High Roller',    desc:'Complete 5 high-priority tasks',  check:g=>g.highDone>=5},
  {id:'xp500',  icon:'🌟', name:'XP Star',        desc:'Earn 500 XP',                     check:g=>g.xp>=500},
  {id:'lvl5',   icon:'👑', name:'Level 5',        desc:'Reach Level 5',                   check:g=>getLevel(g.xp)>=5},
  {id:'allclear',icon:'🧹',name:'All Clear',      desc:'Clear all active tasks once',     check:g=>g.allClearCount>=1},
  {id:'daily7', icon:'📅', name:'Goal Keeper',    desc:'Hit daily goal 7 times',          check:g=>g.dailyGoalHits>=7},
  {id:'speed',  icon:'⚡', name:'Speed Run',       desc:'Complete 3 tasks in one day',     check:g=>g.maxDoneInDay>=3},
];

const CHALLENGES = [
  {id:'c1', name:'Quick Start',    desc:'Complete 3 tasks today',         target:3,  type:'daily',   reward:50,  xpKey:'todayDone'},
  {id:'c2', name:'Work Hard',      desc:'Complete 5 work tasks this week',target:5,  type:'weekly',  reward:100, xpKey:'weekWorkDone'},
  {id:'c3', name:'Priority Push',  desc:'Complete 3 high-priority tasks', target:3,  type:'rolling', reward:80,  xpKey:'highDone'},
  {id:'c4', name:'Streak Starter', desc:'Maintain a 3-day streak',        target:3,  type:'rolling', reward:120, xpKey:'currentStreak'},
  {id:'c5', name:'Personal Best',  desc:'Complete 5 personal tasks',      target:5,  type:'rolling', reward:90,  xpKey:'personalDone'},
];

// Current progress values per challenge key, derived from gamify state
function challengeVals(g){
  const today=toLocalISO(new Date());
  const todayDone=g.lastDoneDate===today?g.todayDone:0;
  return {todayDone,weekWorkDone:g.weekWorkDone,highDone:g.highDone,
    currentStreak:g.currentStreak,personalDone:g.personalDone};
}

// Award any newly-completed challenges. Mutates g (challengeDone + xp) and
// returns true if anything changed. Called from onTaskCompleted so rewards
// land the moment a task is finished — not only when the Progress tab opens.
function checkChallenges(g){
  if(!g.challengeDone) g.challengeDone={};
  const vals=challengeVals(g);
  let changed=false;
  CHALLENGES.forEach(function(ch){
    const prog=Math.min(ch.target,vals[ch.xpKey]||0);
    if(!g.challengeDone[ch.id]&&prog>=ch.target){
      g.challengeDone[ch.id]=true;
      g.xp+=ch.reward;
      changed=true;
      setTimeout(function(){showToast('🏅 Challenge complete: '+ch.name+' +'+ch.reward+' XP');},800);
    }
  });
  return changed;
}


// ── Cross-device meta sync (sort preference) ─────────────────────────
function initMetaSync(){
  if(db){
    db.ref('meta').once('value').then(function(snap){
      const meta=snap.val()||{};
      if(meta.sort && meta.sort !== sortMode){
        sortMode=meta.sort;
        localStorage.setItem('donezo_sort',meta.sort);
        const ss=document.getElementById('sort-select');if(ss)ss.value=sortMode;
        render();
      }
    }).catch(function(){});
  }
}
function getWeekKey(){var d=new Date();var day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);var mon=new Date(d.setDate(diff));return toLocalISO(mon);}
function loadGamify(){
  const d=localStorage.getItem(GK);
  const def={xp:0,totalDone:0,highDone:0,personalDone:0,currentStreak:0,bestStreak:0,
    lastDoneDate:'',allClearCount:0,dailyGoalHits:0,maxDoneInDay:0,todayDone:0,
    weekWorkDone:0,dailyGoal:3,earnedBadges:[],weekHistory:{},challengeDone:{},challengeWeek:''};
  const g=d?{...def,...safeParse(d,{})}:def;
  // reset challenges weekly
  const thisWeek=getWeekKey();
  if(g.challengeWeek!==thisWeek){g.challengeDone={};g.challengeWeek=thisWeek;saveGamify(g);}
  return g;
}
function saveGamify(g){localStorage.setItem(GK,JSON.stringify(g))}

function getLevel(xp){
  for(let i=LEVELS.length-1;i>=0;i--) if(xp>=LEVELS[i]) return i;
  return 0;
}
function xpToNextLevel(xp){
  const lv=getLevel(xp);
  if(lv>=LEVELS.length-1) return {cur:xp-LEVELS[lv],needed:0,pct:100};
  return {cur:xp-LEVELS[lv],needed:LEVELS[lv+1]-LEVELS[lv],pct:Math.round((xp-LEVELS[lv])/(LEVELS[lv+1]-LEVELS[lv])*100)};
}

function onTaskCompleted(task){
  const g=loadGamify();
  const prevXP=g.xp; // captured before any XP is added (task, goal bonus, challenges)
  const earned=XP_PER[task.priority]||10;
  g.xp+=earned;
  g.totalDone++;
  if(task.priority==='high') g.highDone++;
  if(task.category==='personal') g.personalDone++;

  // streak — use local dates (toISOString shifts to UTC and breaks around midnight)
  const today=toLocalISO(new Date());
  const yesterday=toLocalISO(new Date(Date.now()-86400000));
  if(g.lastDoneDate===today){
    g.todayDone++;
  } else if(g.lastDoneDate===yesterday){
    g.currentStreak++;
    g.todayDone=1;
  } else {
    g.currentStreak=1;
    g.todayDone=1;
  }
  g.lastDoneDate=today;
  g.bestStreak=Math.max(g.bestStreak,g.currentStreak);
  if(g.todayDone>g.maxDoneInDay) g.maxDoneInDay=g.todayDone;

  // week history
  if(!g.weekHistory) g.weekHistory={};
  g.weekHistory[today]=(g.weekHistory[today]||0)+1;

  // week work done (rolling 7d)
  const weekAgo=toLocalISO(new Date(Date.now()-7*86400000));
  g.weekWorkDone=tasks.filter(t=>t.status==='done'&&t.category==='work'&&(t.completedAt||t.updatedAt)&&
    toLocalISO(new Date(t.completedAt||t.updatedAt))>=weekAgo).length;

  // daily goal
  if(g.todayDone>=g.dailyGoal&&(g.lastGoalHitDate!==today)){
    g.dailyGoalHits=(g.dailyGoalHits||0)+1;
    g.lastGoalHitDate=today;
    showToast('🎯 Daily goal reached! +50 XP');
    g.xp+=50;
  }

  // all clear
  const remaining=tasks.filter(t=>t.status!=='done');
  if(remaining.length===0) g.allClearCount=(g.allClearCount||0)+1;

  // challenges — award immediately on completion
  checkChallenges(g);

  // check level up
  const prevLevel=getLevel(prevXP);
  const newLevel=getLevel(g.xp);
  if(newLevel>prevLevel){
    showToast('🏆 Level up! You are now '+LEVEL_NAMES[newLevel]+' (Lvl '+newLevel+')');
  } else {
    showToast('+'+earned+' XP');
  }

  // check new badges
  const newBadges=BADGE_DEFS.filter(b=>!g.earnedBadges.includes(b.id)&&b.check(g));
  newBadges.forEach(b=>{
    g.earnedBadges.push(b.id);
    setTimeout(()=>showToast(b.icon+' Badge unlocked: '+b.name),1200);
  });

  saveGamify(g);
  updateXPBar(g);
  updateDailyRing();
}


function parseLocalDate(str){if(!str||!str.trim())return null;const p=str.split('-');if(p.length!==3)return null;const d=new Date(parseInt(p[0]),parseInt(p[1])-1,parseInt(p[2]));return isNaN(d.getTime())?null:d;}

// Shared helpers used by updateDailyRing and the ring tooltip
function mostUrgentStepDate(t){
  const dates=(t.steps||[]).filter(function(s){return s.status!=='completed'&&s.dueDate&&s.dueDate.trim();}).map(function(s){return parseLocalDate(s.dueDate);}).filter(Boolean);
  return dates.length?new Date(Math.min.apply(null,dates)):null;
}
function ringDueDate(t){
  // Only use the task's own due date — not step dates — for the task-level check.
  // Steps with their own due dates are counted separately.
  return t.dueDate&&t.dueDate.trim()?parseLocalDate(t.dueDate):null;
}
function updateDailyRing(){
  const now=new Date();now.setHours(0,0,0,0);
  const tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);

  // Counting rules:
  // Include a task/step if EITHER:
  //   (a) it is due today or overdue AND still incomplete, OR
  //   (b) it was completed TODAY (so today's effort is reflected)
  // Tasks/steps completed on previous days are excluded — they belong to those days.
  let total=0,done=0;

  function completedToday(ts){
    if(!ts)return false;
    const d=new Date(ts);d.setHours(0,0,0,0);
    return d.getTime()===now.getTime();
  }
  function taskCompletedToday(t){
    return t.status==='done'&&completedToday(t.completedAt||t.updatedAt);
  }

  tasks.forEach(function(t){
    const steps=t.steps||[];
    const taskDate=ringDueDate(t);

    // ── Task itself ────────────────────────────────────────────────────
    if(taskDate&&taskDate<tomorrow){
      const doneToday=taskCompletedToday(t);
      const incomplete=t.status!=='done';
      if(incomplete||doneToday){
        total++;
        if(doneToday)done++;
      }
    }

    // ── Steps with their own explicit due date ─────────────────────────
    steps.forEach(function(s){
      if(!s.dueDate||!s.dueDate.trim())return;
      const sd=parseLocalDate(s.dueDate);
      if(!sd||sd>=tomorrow)return;
      const doneToday=s.status==='completed'&&completedToday(s.completedAt);
      const incomplete=s.status!=='completed';
      if(incomplete||doneToday){
        total++;
        if(doneToday)done++;
      }
    });
  });

  const pct=total>0?Math.min(1,done/total):0;
  const circumference=75.4;
  const offset=circumference-(pct*circumference);
  const fill=document.getElementById('ring-fill');
  const text=document.getElementById('ring-text');
  if(fill){
    fill.setAttribute('stroke-dashoffset',offset.toFixed(1));
    fill.style.stroke=total===0?'var(--border-color)':pct>=1?'var(--green)':pct>0.5?'var(--p-med)':'var(--work-red)';
  }
  if(text) text.textContent=total>0?done+'/'+total:'—';
}
function updateXPBar(g){
  const lv=getLevel(g.xp);
  const {cur,needed,pct}=xpToNextLevel(g.xp);
  const fill=document.getElementById('xp-bar-fill');
  const label=document.getElementById('xp-label');
  const badge=document.getElementById('xp-level-badge');
  if(fill) fill.style.width=pct+'%';
  if(label) label.innerText=(needed?cur+' / '+needed:g.xp)+' XP';
  if(badge) badge.innerText='Lvl '+lv+' '+LEVEL_NAMES[lv];
}

function setDailyGoal(val){
  const g=loadGamify();
  g.dailyGoal=parseInt(val)||3;
  saveGamify(g);
  renderGamify();
}

function renderGamify(){
  const g=loadGamify();
  // Catch-up pass: award anything earned while the tab wasn't open
  if(checkChallenges(g)) saveGamify(g);
  updateXPBar(g);

  // streak
  document.getElementById('g-streak').innerText=g.currentStreak+' days';
  document.getElementById('g-streak-title').innerText='Current streak';
  document.getElementById('g-streak-sub').innerText=g.currentStreak>0
    ?'Best: '+g.bestStreak+' days'
    :'Complete a task today to start your streak';
  const sm=document.getElementById('sidebar-streak-val');
  if(sm) sm.innerText=g.currentStreak+' days';

  // daily goal (design: "X / N tasks" + stepper buttons)
  const today=toLocalISO(new Date());
  const todayDone=g.lastDoneDate===today?g.todayDone:0;
  const goalPct=Math.min(100,Math.round(todayDone/g.dailyGoal*100));
  document.getElementById('g-goal-label').innerText=todayDone+' / '+g.dailyGoal+' tasks';
  document.getElementById('g-goal-fill').style.width=goalPct+'%';

  // challenges — design rows: name + orange XP, slim blue bar
  const chalEl=document.getElementById('g-challenges');
  if(chalEl){
    const vals=challengeVals(g);
    chalEl.innerHTML=CHALLENGES.map(ch=>{
      const prog=Math.min(ch.target,vals[ch.xpKey]||0);
      const pct=Math.round(prog/ch.target*100);
      const done=g.challengeDone&&g.challengeDone[ch.id];
      return '<div class="chal-row">'
        +'<div class="chal-head"><span>'+(done?'✅ ':'')+ch.name+'</span><span class="chal-xp">+'+ch.reward+' XP</span></div>'
        +'<div class="chal-track"><div class="chal-fill" style="width:'+pct+'%;'+(done?'background:var(--green)':'')+'"></div></div>'
        +'</div>';
    }).join('');
  }

  // weekly summary
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const weekHistory=g.weekHistory||{};
  const now=new Date();
  let weekTotal=0,weekXP=0,bestDay='—',bestCount=0;
  const barData=[];
  for(let i=6;i>=0;i--){
    const d=new Date(now);d.setDate(now.getDate()-i);
    const ds=toLocalISO(d);
    const cnt=weekHistory[ds]||0;
    weekTotal+=cnt;
    weekXP+=cnt*20;
    barData.push({day:days[d.getDay()],cnt});
    if(cnt>bestCount){bestCount=cnt;bestDay=days[d.getDay()];}
  }
  document.getElementById('wk-done').innerText=weekTotal;
  document.getElementById('wk-xp').innerText=weekXP;
  document.getElementById('wk-streak').innerText=g.bestStreak;
  document.getElementById('wk-best').innerText=bestDay;
  const maxCnt=Math.max(...barData.map(x=>x.cnt),1);
  const barsEl=document.getElementById('wk-bars');
  const labelsEl=document.getElementById('wk-labels');
  if(barsEl) barsEl.innerHTML=barData.map(b=>'<div class="wdb'+(b.cnt>0?' active':'')+'" style="height:'+Math.max(8,Math.round(b.cnt/maxCnt*80))+'px" title="'+b.cnt+' tasks"></div>').join('');
  if(labelsEl) labelsEl.innerHTML=barData.map(b=>'<div class="wdl">'+b.day.charAt(0)+'</div>').join('');

  // badges — design: circular 44px icons, dimmed when locked
  const badgeEl=document.getElementById('g-badges');
  if(badgeEl){
    badgeEl.innerHTML=BADGE_DEFS.map(b=>{
      const earned=g.earnedBadges.includes(b.id);
      return '<div class="badge-item'+(earned?'':' locked')+'" title="'+(earned?b.name+': '+b.desc:'🔒 '+b.desc)+'">'
        +'<div class="badge-icon">'+b.icon+'</div>'
        +'<div class="badge-name">'+b.name+'</div>'
        +'</div>';
    }).join('');
  }
}

// Design's +/- steppers on the Daily goal card
function adjustDailyGoal(delta){
  const g=loadGamify();
  setDailyGoal(Math.max(1,(parseInt(g.dailyGoal)||3)+delta));
}

function haptic(type){
  if(!navigator.vibrate) return;
  if(type==='complete') navigator.vibrate([30,10,60]);
  else if(type==='delete') navigator.vibrate([10,5,10,5,10]);
  else if(type==='light') navigator.vibrate(15);
  else if(type==='heavy') navigator.vibrate(60);
}

// Fired once on app load when overdue tasks are present.
// 5 seconds of pulsed vibration (200ms on, 150ms off) to alert the user.
let _overdueVibrated=false;
function overdueVibration(){
  if(_overdueVibrated) return; // only once per session
  if(!navigator.vibrate) return;
  _overdueVibrated=true;
  // 5000ms total: alternating 200ms buzz / 150ms pause
  const pattern=[];
  let elapsed=0;
  while(elapsed<5000){pattern.push(200);elapsed+=200;pattern.push(150);elapsed+=150;}
  navigator.vibrate(pattern);
}

let _audioCtx = null;
let _noiseNode = null;
let _noiseGain = null;
let _soundEnabled = safeParse(localStorage.getItem('donezo_sound'), true);
let _noiseType = localStorage.getItem('donezo_noise') || 'off';

function getAudioCtx(){
  if(!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playDing(){
  if(!_soundEnabled) return;
  try{
    const ctx=getAudioCtx();
    const t=ctx.currentTime;
    // Two-note rising chime: C5 then E5
    [[523,0],[659,0.18]].forEach(function(note){
      const osc=ctx.createOscillator();
      const gain=ctx.createGain();
      osc.connect(gain);gain.connect(ctx.destination);
      osc.type='sine';
      osc.frequency.setValueAtTime(note[0],t+note[1]);
      gain.gain.setValueAtTime(0,t+note[1]);
      gain.gain.linearRampToValueAtTime(0.28,t+note[1]+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001,t+note[1]+0.45);
      osc.start(t+note[1]);
      osc.stop(t+note[1]+0.5);
    });
  }catch(e){}
}

function playPop(){
  if(!_soundEnabled) return;
  try{
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  } catch(e){}
}

function startNoise(type){
  stopNoise();
  if(type === 'off') return;
  try{
    const ctx = getAudioCtx();
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    if(type === 'white'){
      for(let i=0; i<bufferSize; i++) data[i] = Math.random()*2-1;
    } else if(type === 'brown'){
      let last = 0;
      for(let i=0; i<bufferSize; i++){
        const w = Math.random()*2-1;
        data[i] = (last + 0.02*w) / 1.02;
        last = data[i]; data[i] *= 3.5;
      }
    } else if(type === 'tick'){
      // gentle metronome tick every second
      const sr = ctx.sampleRate;
      for(let i=0; i<bufferSize; i++){
        const pos = i % sr;
        data[i] = pos < 800 ? Math.sin(pos/800*Math.PI)*0.4*Math.exp(-pos/200) : 0;
      }
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    _noiseGain = ctx.createGain();
    _noiseGain.gain.value = 0.15;
    source.connect(_noiseGain);
    _noiseGain.connect(ctx.destination);
    source.start();
    _noiseNode = source;
  } catch(e){}
}

function stopNoise(){
  if(_noiseNode){ try{ _noiseNode.stop(); } catch(e){} _noiseNode = null; }
  if(_noiseGain){ try{ _noiseGain.disconnect(); } catch(e){} _noiseGain = null; }
}

function toggleSound(){
  _soundEnabled = !_soundEnabled;
  localStorage.setItem('donezo_sound', JSON.stringify(_soundEnabled));
  const swS=document.getElementById('sw-sound');if(swS)swS.checked=_soundEnabled;
}

function setNoiseType(type){
  _noiseType = type;
  localStorage.setItem('donezo_noise', type);
  startNoise(type);
}
function showToast(msg,undoFn){
  const t=document.getElementById('toast');if(!t)return;
  if(undoFn){
    t.innerHTML=msg+' <span onclick="window._toastUndo&&window._toastUndo()" style="margin-left:8px;text-decoration:underline;cursor:pointer;font-weight:900">Undo</span>';
    window._toastUndo=undoFn;
  } else {
    t.innerText=msg;
    window._toastUndo=null;
  }
  t.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer=setTimeout(()=>{t.classList.remove('show');window._toastUndo=null;},4000);
}

// Undo stack — the toast only ever shows one "Undo" affordance, so deleting
// several tasks in quick succession used to lose all but the last undo. Each
// deletion pushes its restore here; clicking Undo pops the most recent (LIFO)
// and re-offers the next one until the stack is empty.
let _undoStack=[];
function pushUndo(label,restoreFn){
  _undoStack.push(restoreFn);
  const n=_undoStack.length;
  showToast(label+(n>1?' ('+n+' pending)':''),runUndo);
}
function runUndo(){
  const fn=_undoStack.pop();
  if(fn)fn();
  if(_undoStack.length) showToast('Restored — '+_undoStack.length+' more (Undo)',runUndo);
  else showToast('Task restored');
}

function renderModalSteps(){
  const c=document.getElementById('steps-list');if(!c)return;
  if(!window.currentModalSteps.length){c.innerHTML=`<div style="font-size:11.5px;font-weight:600;color:var(--text-muted);padding:2px 0 4px">No steps added</div>`;return}
  // Design step row: text input + delete square; the status cycle + per-step dates are app features kept below
  c.innerHTML=window.currentModalSteps.map(s=>`<div class="step-item" style="flex-direction:column;align-items:stretch;gap:6px"><div style="display:flex;align-items:center;gap:6px"><input class="mi" value="${esc(s.text)}" oninput="updateStepText('${s.id}',this.value)" placeholder="Step description…" style="flex:1;padding:9px 11px;font-size:13px"><button onclick="cycleStepStatus('${s.id}')" title="Status: ${s.status.replace('-',' ')} — click to cycle" style="width:30px;height:30px;border-radius:9px;border:1.5px solid var(--border-color);background:${s.status==='completed'?'var(--green)':s.status==='in-progress'?'var(--purple)':'var(--input-bg)'};cursor:pointer;flex-shrink:0"></button><button class="step-del" onclick="removeStep('${s.id}')" title="Remove step">✕</button></div><div style="display:flex;align-items:center;gap:8px;overflow-x:auto"><span class="ml" style="margin:0">Due</span><input type="date" value="${s.dueDate||''}" onchange="updateStepDate('${s.id}',this.value)" class="mi" style="width:auto;padding:5px 8px;font-size:11px"><span class="ml" style="margin:0">Time</span><input type="time" value="${s.notifTime||''}" onchange="updateStepTime('${s.id}',this.value)" class="mi" style="width:auto;padding:5px 8px;font-size:11px"></div></div>`).join('');
}

function getTrendData(){
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const labels=[],work=[],personal=[];
  for(let i=6;i>=0;i--){
    const d=new Date();d.setDate(d.getDate()-i);
    const ds=toLocalISO(d);
    labels.push(i===0?'Today':d.getDate()+' '+mo[d.getMonth()]);
    // Count completed tasks
    let wCount=tasks.filter(t=>t.category==='work'&&t.status==='done'&&(t.completedAt||t.updatedAt)&&
      toLocalISO(new Date(t.completedAt||t.updatedAt))===ds).length;
    let pCount=tasks.filter(t=>t.category==='personal'&&t.status==='done'&&(t.completedAt||t.updatedAt)&&
      toLocalISO(new Date(t.completedAt||t.updatedAt))===ds).length;
    // Also count completed steps
    tasks.forEach(function(t){
      (t.steps||[]).filter(function(s){return s.status==='completed'&&s.completedAt;}).forEach(function(s){
        if(toLocalISO(new Date(s.completedAt))===ds){
          if(t.category==='work') wCount++;
          else pCount++;
        }
      });
    });
    work.push(wCount);
    personal.push(pCount);
  }
  return{labels,work,personal};
}


// ── Stats view (design: metric tiles · heatmap+trend · matrix · category cards) ──
function renderStatsView(){
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.innerText=v;};
  const total=tasks.length;
  const doneAll=tasks.filter(t=>t.status==='done').length;
  set('sv-completion',total?Math.round(doneAll/total*100)+'%':'—');
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayCounts=Array(7).fill(0);
  tasks.filter(t=>t.status==='done'&&(t.completedAt||t.updatedAt)).forEach(t=>{dayCounts[new Date(t.completedAt||t.updatedAt).getDay()]++;});
  const maxD=Math.max.apply(null,dayCounts);
  set('sv-productive',maxD>0?days[dayCounts.indexOf(maxD)]:'—');
  const work=tasks.filter(t=>t.category==='work'),personal=tasks.filter(t=>t.category==='personal');
  const workDone=work.filter(t=>t.status==='done').length,personalDone=personal.filter(t=>t.status==='done').length;
  const workPct=work.length?Math.round(workDone/work.length*100):0;
  const personalPct=personal.length?Math.round(personalDone/personal.length*100):0;
  set('sv-workdone',work.length?workPct+'%':'—');
  set('sv-personaldone',personal.length?personalPct+'%':'—');

  renderHeatmap();
  renderTrendBars();
  renderMatrixVisual();

  // Category split — counts per category over all tasks (design: Work blue / Personal coral bars)
  const splitEl=document.getElementById('cat-split');
  if(splitEl){
    const tot=tasks.length||1;
    const rows=[['Work',work.length,'#3b6ef2'],['Personal',personal.length,'#f4795b']];
    loadCategories().forEach(function(c){
      if(c.id==='work'||c.id==='personal')return;
      const n=tasks.filter(t=>t.category===c.id).length;
      if(n)rows.push([c.name,n,c.color]);
    });
    splitEl.innerHTML=rows.map(r=>'<div class="split-row"><div class="split-head"><span>'+esc(r[0])+'</span><span>'+r[1]+'</span></div><div class="split-track"><div class="split-fill" style="background:'+r[2]+';width:'+Math.round(r[1]/tot*100)+'%"></div></div></div>').join('');
  }

  // Category completion % — big colored callouts
  const ccEl=document.getElementById('cat-completion-box');
  if(ccEl){
    ccEl.innerHTML='<div><div class="pc-lbl">Work</div><div style="font-size:22px;font-weight:800;font-family:var(--font-display);color:var(--due-val)">'+workPct+'%</div></div>'
      +'<div><div class="pc-lbl">Personal</div><div style="font-size:22px;font-weight:800;font-family:var(--font-display);color:#f4795b">'+personalPct+'%</div></div>';
  }
}

// Completion trend — 7-day CSS bar chart (design: blue 5px-radius bars, day-initial labels)
function renderTrendBars(){
  const el=document.getElementById('trend-bars');if(!el)return;
  const td=getTrendData();
  const totals=td.work.map((w,i)=>w+td.personal[i]);
  const max=Math.max.apply(null,totals.concat([1]));
  const init=['S','M','T','W','T','F','S'];
  const now=new Date();
  el.innerHTML=totals.map(function(v,i){
    const d=new Date();d.setDate(now.getDate()-(6-i));
    return '<div class="trend-col"><div class="trend-fill" style="height:'+(v?Math.max(8,Math.round(v/max*100)):4)+'%"></div><span class="trend-lbl">'+init[d.getDay()]+'</span></div>';
  }).join('');
}

function renderCalendar(){
  const c=document.getElementById('calendar-grid');if(!c)return;c.innerHTML='';
  const yr=currentCalDate.getFullYear(),mo=currentCalDate.getMonth();
  const names=["January","February","March","April","May","June","July","August","September","October","November","December"];
  document.getElementById('cal-month-title').innerText=`${names[mo]} ${yr}`;
  ['S','M','T','W','T','F','S'].forEach(d=>{c.innerHTML+=`<div class="cal-day-name">${d}</div>`});
  const firstDay=new Date(yr,mo,1).getDay(),dim=new Date(yr,mo+1,0).getDate();
  const ct=tasks.filter(t=>currentMode==='all'||t.category===currentMode);
  for(let i=0;i<firstDay;i++)c.innerHTML+=`<div class="cal-cell" style="opacity:0;pointer-events:none"></div>`;
  for(let day=1;day<=dim;day++){
    const ds=`${yr}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dt=ct.filter(t=>t.dueDate===ds);
    const inc=dt.filter(t=>t.status!=='done').length;
    const isToday=new Date().toDateString()===new Date(yr,mo,day).toDateString();
    let col='transparent';
    if(dt.length){const hi=dt.some(t=>t.priority==='high'&&t.status!=='done');const mi=dt.some(t=>t.priority==='medium'&&t.status!=='done');col=hi?'var(--p-high)':(mi?'var(--p-med)':'var(--p-low)')}
    c.innerHTML+=`<div class="cal-cell ${isToday?'today':''} ${dt.length?'has-task':''}" onclick="showDayTasks('${ds}')" ${dt.length?`style="border-bottom-color:${col}"`:''}>${day}${inc>0?`<div class="cal-task-count">${inc}</div>`:''}</div>`;
  }
}

function showDayTasks(ds){
  selectedDateStr=ds;
  var dt=tasks.filter(function(t){return t.dueDate===ds&&t.status!=='done';});
  var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var parts=ds.split('-');
  var dObj=new Date(parseInt(parts[0]),parseInt(parts[1])-1,parseInt(parts[2]));
  document.getElementById('day-tasks-list').innerHTML='';
  document.getElementById('day-view-title').innerText=dObj.getDate()+' '+mo[dObj.getMonth()]+' '+dObj.getFullYear();
  var timed=dt.filter(function(t){return !!t.startTime;}).sort(function(a,b){return a.startTime>b.startTime?1:-1;});
  var untimed=dt.filter(function(t){return !t.startTime;});
  var html='';
  if(timed.length){
    html+='<div style="font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Time Blocks</div>';
    timed.forEach(function(t){
      var dur=t.duration?t.duration+'min':'';
      var timeStr=t.startTime;
      if(t.startTime&&t.duration){
        var tp=t.startTime.split(':');
        var ts=new Date();ts.setHours(parseInt(tp[0]),parseInt(tp[1]),0,0);
        var te=new Date(ts.getTime()+t.duration*60000);
        timeStr+='-'+te.getHours().toString().padStart(2,'0')+':'+te.getMinutes().toString().padStart(2,'0');
      }
      var row=document.createElement('div');
      row.className='time-block-row';
      row.innerHTML='<div class="time-block-time">'+timeStr+'</div>'
        +'<div class="time-block-name">'+esc(t.name)+'</div>'
        +(dur?'<div class="time-block-dur">'+dur+'</div>':'')
        +'<button class="tb-focus-btn" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--purple);font-weight:700;padding:0 4px;white-space:nowrap">Focus</button>';
      row.addEventListener('click',function(){closeDayView();showTaskDetail(t.id);});
      row.querySelector('.tb-focus-btn').addEventListener('click',function(e){e.stopPropagation();openFocusFromBlock(t.id);});
      document.getElementById('day-tasks-list').appendChild(row);
    });
  }
  if(untimed.length){
    var label=document.createElement('div');
    label.style.cssText='font-size:10px;font-weight:800;text-transform:uppercase;color:var(--text-muted);margin:'+(timed.length?'12px':'0')+'px 0 8px';
    label.innerText='Unscheduled';
    document.getElementById('day-tasks-list').appendChild(label);
    untimed.forEach(function(t){
      var row=document.createElement('div');
      row.className='day-task-item';
      row.innerHTML='<div style="font-weight:700;margin-bottom:4px">'+esc(t.name)+'</div>'
        +'<div style="font-size:10px;color:var(--text-muted);display:flex;gap:8px">'
        +'<span class="badge-priority '+t.priority+'">'+t.priority+'</span>'
        +'<span>&bull;</span><span style="text-transform:capitalize">'+esc(t.category)+'</span>'
        +'</div>';
      row.addEventListener('click',function(){closeDayView();showTaskDetail(t.id);});
      document.getElementById('day-tasks-list').appendChild(row);
    });
  }
  if(!timed.length&&!untimed.length){
    document.getElementById('day-tasks-list').innerHTML='<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">No tasks due this day</div>';
  }
  document.getElementById('day-overlay').classList.add('open');
}

function openFocusFromBlock(id){
  closeDayView();
  setTimeout(function(){openFocusMode(id);},200);
}
function closeDayView(){document.getElementById('day-overlay').classList.remove('open')}
function closeDayOverlayBg(e){if(e.target.id==='day-overlay')closeDayView()}
function openModalWithDate(){closeDayView();openModal();document.getElementById('f-due').value=selectedDateStr}

function renderMatrixVisual(){
  ['1','2','3','4'].forEach(q=>{
    const list=document.getElementById(`q${q}-list`);if(!list)return;
    // Design shows every task in its quadrant, done ones struck through
    const qt=tasks.filter(t=>(t.matrix||'4')===q).slice(0,6);
    list.innerHTML=qt.length?qt.map(t=>`<div class="matrix-v-item${t.status==='done'?' done':''}" title="${esc(t.name)}" onclick="showTaskDetail('${t.id}')">${esc(t.name)}</div>`).join(''):`<div style="font-size:11px;opacity:.6;padding:2px 0">No tasks</div>`;
  });
}

function renderHeatmap(){
  const grid=document.getElementById('heatmap-grid');if(!grid)return;grid.innerHTML='';
  const now=new Date(),map={};
  tasks.forEach(t=>{if(t.status==='done'){const d=new Date(t.completedAt||t.updatedAt||Date.now()).toDateString();map[d]=(map[d]||0)+1}});
  for(let i=29;i>=0;i--){const d=new Date();d.setDate(now.getDate()-i);const cnt=map[d.toDateString()]||0;const lvl=cnt>=5?4:cnt>=3?3:cnt===2?2:cnt===1?1:0;grid.innerHTML+=`<div class="heatmap-day lvl-${lvl}" title="${d.toDateString()}: ${cnt} done"></div>`}
}

let _mpTimers={};
function updateManualProgress(id,val){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  t.manualProgress=parseInt(val);t.updatedAt=Date.now();
  // Update the visible bar immediately, but debounce the expensive persistence
  // (full-array localStorage write + Firebase set) — otherwise dragging the
  // slider fires dozens of writes per second.
  const bar=document.getElementById(`mpb-${id}`),pct=document.getElementById(`mpp-${id}`);
  if(bar)bar.style.width=val+'%';
  if(pct)pct.innerText=val+'%';
  clearTimeout(_mpTimers[id]);
  _mpTimers[id]=setTimeout(function(){
    saveTasksLocal();
    fbSave(t);
  },500);
}

function render(){
  const search=(document.getElementById('search-input')||{}).value?.toLowerCase()||'';
  const matrixFilter=(document.getElementById('matrix-filter')||{}).value||'all';
  const listEl=document.getElementById('task-list');
  const analyticsEl=document.querySelector('.analytics-section');
  if(currentDashboardView==='analytics'){
    if(listEl)listEl.style.display='none';
    if(analyticsEl){analyticsEl.style.display='block';analyticsEl.style.marginTop='0'}
  } else {
    if(listEl)listEl.style.display='grid';
    if(analyticsEl)analyticsEl.style.display='none';
  }

  let filtered=tasks.filter(t=>{
    const mOk=currentMode==='all'||t.category===currentMode;
    const sOk=!search||t.name.toLowerCase().includes(search)||(t.dueDate||'').includes(search)||(t.notes||'').toLowerCase().includes(search)||(t.steps||[]).some(s=>s.text&&s.text.toLowerCase().includes(search));
    const qOk=matrixFilter==='all'||(t.matrix||'4')===matrixFilter;
    return mOk&&sOk&&qOk;
  });

  const sortFn=(a,b)=>{
    if(a.status==='done'&&b.status!=='done')return 1;
    if(b.status==='done'&&a.status!=='done')return-1;
    // Pinned tasks always float to top within their status group
    if(a.pinned&&!b.pinned)return-1;
    if(b.pinned&&!a.pinned)return 1;
    if(sortMode==='due'){if(!a.dueDate)return 1;if(!b.dueDate)return-1;return new Date(a.dueDate)-new Date(b.dueDate)}
    if(sortMode==='priority'){const pw={high:3,medium:2,low:1};return pw[b.priority]-pw[a.priority]}
    return(b.updatedAt||0)-(a.updatedAt||0);
  };
  filtered.sort(sortFn);

  // -- Dashboard header: stat tiles + daily-goal hero -------------------
  updateHeader();
  (function(){
    const now=new Date();
    const today=new Date(now);today.setHours(0,0,0,0);
    const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
    function effDue(t){
      let best=null;
      if(t.dueDate)best=parseLocalDate(t.dueDate);
      (t.steps||[]).forEach(function(s){
        if(s.status!=='completed'&&s.dueDate){const d=parseLocalDate(s.dueDate);if(!best||d<best)best=d;}
      });
      return best;
    }
    const inc=tasks.filter(function(t){return t.status!=='done';});
    let od=0,dt=0;
    inc.forEach(function(t){
      const d=effDue(t);
      if(!d)return;
      if(d<today)od++;
      else if(d<tomorrow)dt++;
    });
    const doneToday=tasks.filter(function(t){
      if(t.status!=='done'||!t.completedAt)return false;
      const d=new Date(t.completedAt);d.setHours(0,0,0,0);
      return d.getTime()===today.getTime();
    }).length;
    const day=now.getDay();
    const monday=new Date(now);
    monday.setDate(now.getDate()-(day===0?6:day-1));
    monday.setHours(0,0,0,0);
    const weekDone=tasks.filter(function(t){
      return t.status==='done'&&t.completedAt&&new Date(t.completedAt)>=monday;
    }).length;
    const set=function(id,v){const e=document.getElementById(id);if(e)e.innerText=v;};
    set('ds-overdue-val',od);set('ds-today-val',dt);set('ds-done-val',doneToday);set('ds-week-val',weekDone);
    const gam=loadGamify();
    set('ds-streak-val',gam.currentStreak||0);
    const sm=document.getElementById('sidebar-streak-val');
    if(sm) sm.innerText=(gam.currentStreak||0)+' days';
    // Daily-goal hero tile (blue-purple gradient, matches design's dashboard row)
    const goal=gam.dailyGoal||3;
    const heroPct=Math.min(100,Math.round(doneToday/goal*100));
    const heroFill=document.getElementById('dash-hero-fill');
    if(heroFill)heroFill.style.width=heroPct+'%';
    set('dash-hero-val',doneToday+' / '+goal+' tasks');
    set('dash-hero-lvl','Daily goal · Level '+getLevel(gam.xp));
    set('dash-hero-xp','+'+(gam.xp||0)+' XP');
    // Overdue tile subtitle: first overdue task name + count of the rest
    (function(){
      const sub=document.getElementById('ds-overdue-sub');
      if(!sub)return;
      const late=inc.filter(function(t){const d=effDue(t);return d&&d<today;});
      if(!late.length){sub.innerText='All caught up';return;}
      sub.innerText=late[0].name+(late.length>1?' +'+(late.length-1)+' more':'');
    })();
  })();

  if(!filtered.length){
    listEl.innerHTML='<div class="empty-state"><div class="empty-state-icon" style="font-size:48px;margin-bottom:14px;opacity:0.4">&#9989;</div><div class="empty-state-title" style="font-size:16px;font-weight:700;color:var(--text-dim);margin-bottom:6px">No tasks here</div><div class="empty-state-sub" style="font-size:13px">Tap &ldquo;New Task&rdquo; to add one, or adjust your filters</div></div>';
  } else {
    const pBg={high:'#fff0f0',medium:'#fff8f0',low:'#ebf4ff'};
    const pCol={high:'var(--p-high)',medium:'var(--p-med)',low:'var(--p-low)'};

    function nextDueStep(t){
      if(t.status==='done'||(t.steps||[]).length===0) return null;
      const inc=(t.steps||[]).filter(s=>s.status!=='completed'&&s.dueDate&&s.dueDate.trim());
      if(!inc.length) return null;
      inc.sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
      return inc[0].text;
    }

    function rowHTML(t){
      const steps=t.steps||[];
      const doneS=steps.filter(s=>s.status==='completed').length;
      const prog=t.status==='done'?100:steps.length?Math.round(doneS/steps.length*100):(t.manualProgress||0);
      const isDone=t.status==='done';
      const stepsHtml=uiSettings.showSteps&&steps.length?'<span style="font-size:9px;font-weight:700;color:var(--purple)">'+doneS+'/'+steps.length+'</span>':'';
      let dateLbl='';
      if(t.dueDate&&!isDone){
        const mo2=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const[,mm2,dd2]=t.dueDate.split('-');
        const diff2=Math.ceil((parseLocalDate(t.dueDate)-new Date())/86400000);
        const dtxt=diff2<0?'Overdue':diff2===0?'Today':parseInt(dd2)+' '+mo2[parseInt(mm2)-1];
        const dcol=diff2<0?'var(--red)':diff2===0?'var(--p-med)':'var(--text-muted)';
        dateLbl='<span style="font-size:10px;font-weight:700;color:'+dcol+';flex-shrink:0">'+dtxt+'</span>';
      }
      const nds=nextDueStep(t);
      const ndsTrunc=nds&&nds.length>22?nds.substring(0,20)+'…':nds;
      const suffix=ndsTrunc?'<span style="font-size:10px;color:var(--text-muted);font-weight:500"> ('+esc(ndsTrunc)+')</span>':'';
      const bl=tasks.filter(x=>x.blocking===t.id&&x.status!=='done');
      const blockedBadge=bl.length?' <span style="font-size:9px;font-weight:800;color:var(--red);background:#fff0f0;padding:1px 5px;border-radius:4px;vertical-align:middle;opacity:1">BLOCKED</span>':'';
      const nameStyle=bl.length?'opacity:0.55;':'';
      const pinBtn='<button class="tr-pin" data-pin="'+t.id+'" aria-label="'+(t.pinned?'Unpin task':'Pin task to top')+'" title="'+(t.pinned?'Unpin':'Pin to top')+'" style="background:none;border:none;cursor:pointer;font-size:13px;opacity:'+(t.pinned?'1':'0.3')+';flex-shrink:0;padding:0 2px">&#128204;</button>';
      const isOverdue=overdueIds&&overdueIds.has(t.id);
      const overdueStyle=isOverdue&&!isDone?'background:var(--overdue-bg);':'';
      const out='<div class="task-row prio-'+t.priority+(isDone?' is-done':'')+(t.pinned?' pinned':'')+(isOverdue&&!isDone?' overdue-card':'')+'" data-id="'+t.id+'" style="'+overdueStyle+'">'
        +'<div class="swipe-bg swipe-done-bg"><span class="swipe-icon">&#10003; Done</span></div>'
        +'<div class="swipe-bg swipe-del-bg"><span class="swipe-icon-del">&#215; Delete</span></div>'
        +'<button class="tr-check'+(isDone?' checked':'')+' " data-check="'+t.id+'" aria-label="'+(isDone?'Mark task not done':'Mark task done')+'" aria-pressed="'+(isDone?'true':'false')+'"></button>'
        +'<span class="tr-name'+(isDone?' done':'')+' " data-detail="'+t.id+'" style="'+nameStyle+'">'+esc(t.name)+suffix+blockedBadge+'</span>'
        +'<div class="tr-right">'+dateLbl+stepsHtml
        +'<div class="tr-prog"><div class="tr-prog-fill" style="width:'+prog+'%"></div></div>'
        +pinBtn
        +'<button class="focus-trigger" data-focus="'+t.id+'" aria-label="Start focus session" title="Focus">&#127919;</button>'
        +'<button class="tr-del" data-del="'+t.id+'" aria-label="Delete task" title="Delete">&#215;</button>'
        +'</div></div>';
      return out;
    }

    function cardHTML(t){
      const steps=t.steps||[];
      const doneS=steps.filter(s=>s.status==='completed').length;
      const prog=t.status==='done'?100:steps.length?(doneS/steps.length)*100:(t.manualProgress||0);
      const mVal=t.matrix||'4';
      const mLabel=mVal==='1'?'Do First':mVal==='2'?'Schedule':mVal==='3'?'Delegate':'Eliminate';
      const isDone=t.status==='done';
      // Due-date pill — colored per urgency (overdue red / today blue / upcoming grey), matching design dueMap
      let duePill='';
      if(t.dueDate&&!isDone){
        const mo2=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const[,mm2,dd2]=t.dueDate.split('-');
        const diff2=Math.ceil((parseLocalDate(t.dueDate)-new Date())/86400000);
        const dtxt=diff2<0?(Math.abs(diff2)+'d late'):diff2===0?'Today':parseInt(dd2)+' '+mo2[parseInt(mm2)-1];
        const dcol=diff2<0?'#e24b4a':diff2===0?'#3b6ef2':'#8a93a3';
        const dbg=diff2<0?'rgba(226,75,74,0.13)':diff2===0?'rgba(59,110,242,0.13)':'rgba(138,147,163,0.15)';
        duePill='<span class="tc-due-pill" style="color:'+dcol+';background:'+dbg+'">'+dtxt+'</span>';
      }
      const catName=t.category==='work'?'Work':t.category==='personal'?'Personal':esc((t.category||'').charAt(0).toUpperCase()+(t.category||'').slice(1));
      const meta=''
        +(uiSettings.showMatrix?'<span class="matrix-badge q'+mVal+'">'+mLabel+'</span>':'')
        +duePill;
      const stepRow=(uiSettings.showSteps&&steps.length)
        ?'<div class="tc-steprow"><svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" fill="none"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path></svg>'+doneS+'/'+steps.length+' steps · '+catName+'</div>':'';
      const cardTitle=esc(t.name);
      const priColor=t.priority==='high'?'var(--p-high)':t.priority==='low'?'var(--p-low)':'var(--p-med)';
      // Design ring: blue progress conic, solid green when done (deriveTask ringCBg)
      const ringDeg=Math.round(prog*3.6);
      const ringStyle=isDone?'':'background:conic-gradient(var(--purple) '+ringDeg+'deg,var(--bg-track) 0)';
      const ringInner=isDone?'✓':Math.round(prog);
      return '<div class="task-card'+(isDone?' is-done':'')+'"><div class="tc-stripe" style="background:'+priColor+'"></div><div class="task-card-row"><div class="tc-body" onclick="showTaskDetail(\''+t.id+'\')"><div class="tc-title'+(isDone?' done':'')+'">'+cardTitle+'</div><div class="tc-meta">'+meta+'</div>'+stepRow+'</div><div class="tc-check'+(isDone?' checked':'')+'" role="button" aria-label="'+(isDone?'Mark task not done':'Mark task done')+'" aria-pressed="'+(isDone?'true':'false')+'" style="'+ringStyle+'" onclick="toggleDone(\''+t.id+'\',event)"><span class="tc-check-inner">'+ringInner+'</span></div></div></div>';
    }

    const renderFn=taskView==='rows'?rowHTML:cardHTML;
    const now=new Date();now.setHours(0,0,0,0);
    const tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);

    // Helper: parse date string as local midnight (avoids UTC-offset day-shift)
    // parseLocalDate is defined globally below

    // Helper: most urgent step date for a task
    function mostUrgentStepDate(t){
      const dates=(t.steps||[]).filter(s=>s.status!=='completed'&&s.dueDate&&s.dueDate.trim()).map(s=>parseLocalDate(s.dueDate)).filter(Boolean);
      return dates.length?new Date(Math.min(...dates)):null;
    }

    function effectiveDueDate(t){
      const td=t.dueDate&&t.dueDate.trim()?parseLocalDate(t.dueDate):null;
      const sd=mostUrgentStepDate(t);
      // Return whichever is more urgent (earlier)
      if(td&&sd) return sd<td?sd:td;
      return td||sd;
    }

    const incomplete=filtered.filter(t=>t.status!=='done');
    const overdue=incomplete.filter(t=>{const d=effectiveDueDate(t);return d&&d<now;});
    const overdueIds=new Set(overdue.map(t=>t.id));
    const dueToday=incomplete.filter(t=>{if(overdueIds.has(t.id))return false;const d=effectiveDueDate(t);return d&&d>=now&&d<tomorrow;});
    const dueTodayIds=new Set(dueToday.map(t=>t.id));
    const urgent=[...overdue,...dueToday];
    const urgentIds=new Set(urgent.map(t=>t.id));
    const active=incomplete.filter(t=>!urgentIds.has(t.id));
    const done=filtered.filter(t=>t.status==='done').sort((a,b)=>(b.completedAt||b.updatedAt||0)-(a.completedAt||a.updatedAt||0));
    let html='';
    if(overdue.length){
      html+='<div class="section-divider" id="sec-overdue" style="color:var(--red)">&#9888; Past due ('+overdue.length+')</div>'+overdue.map(renderFn).join('');
      overdueVibration(); // pulse vibration on load when overdue tasks exist
    }
    if(dueToday.length){
      html+='<div class="section-divider" id="sec-today" style="color:var(--p-med)">&#128197; Due today ('+dueToday.length+')</div>'+dueToday.map(renderFn).join('');
    }
    if(active.length){
      if(urgent.length) html+='<div class="section-divider">Active ('+active.length+')</div>';
      html+=active.map(renderFn).join('');
    }
    if(done.length){
      html+='<div class="section-divider" onclick="toggleDoneSection()"><span class="chev'+(doneCollapsed?' collapsed':'')+'" id="done-chev">&#9660;</span>Completed ('+done.length+')</div><div id="done-section" style="'+(doneCollapsed?'display:none':'')+'">' +done.map(renderFn).join('')+'</div>';
    }
    html+='<div class="add-task-row" onclick="openModal()"><span style="font-size:18px;line-height:1;font-weight:300">+</span> Add task</div>';
    listEl.innerHTML=html;
  }
  // Only render analytics widgets when the Stats view is visible
  if(currentDashboardView==='analytics'){
    renderStatsView();
  }
  setTimeout(attachAllSwipes,60);
  const fab=document.getElementById('fab-add');if(fab)fab.classList.toggle('hidden',!uiSettings.showFab);
}

function toggleDoneSection(){
  doneCollapsed=!doneCollapsed;
  const sec=document.getElementById('done-section'),chev=document.getElementById('done-chev');
  if(sec)sec.style.display=doneCollapsed?'none':'';
  if(chev)chev.className='chev'+(doneCollapsed?' collapsed':'');
}


let detailTaskId=null;

function showTaskDetail(id){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  detailTaskId=id;
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mLabel={'1':'Urgent & Important - Do First','2':'Important, Not Urgent - Schedule','3':'Urgent, Not Important - Delegate','4':'Neither - Eliminate'};
  const statusLabel={'todo':'To Do','done':'Done','in-progress':'In Progress','review':'In Review','blocked':'Blocked'};
  const steps=t.steps||[];
  const doneS=steps.filter(s=>s.status==='completed').length;
  const prog=t.status==='done'?100:steps.length?Math.round(doneS/steps.length*100):(t.manualProgress||0);

  const isDone=t.status==='done';
  const titleEl=document.getElementById('dp-title');
  titleEl.innerText=t.name;
  titleEl.classList.toggle('done',isDone);

  // Badge row — design: quadrant pill · due pill · category chip · repeat chip
  const badges=document.getElementById('dp-badges');
  if(badges){
    const mVal=t.matrix||'4';
    const mShort={'1':'Do First','2':'Schedule','3':'Delegate','4':'Eliminate'}[mVal];
    let bHtml='<span class="dp-badge" style="background:var(--q'+mVal+'-bg);color:var(--q'+mVal+'-c)">'+mShort+'</span>';
    if(t.dueDate){
      const diffB=Math.ceil((parseLocalDate(t.dueDate)-new Date())/86400000);
      const dParts=t.dueDate.split('-');
      const dateTxt=parseInt(dParts[2])+' '+mo[parseInt(dParts[1])-1];
      const dtxt=isDone?dateTxt:(diffB<0?Math.abs(diffB)+'d late':diffB===0?'Today':dateTxt);
      const dcol=(!isDone&&diffB<0)?'#e24b4a':(!isDone&&diffB===0)?'#3b6ef2':'#8a93a3';
      const dbg=(!isDone&&diffB<0)?'rgba(226,75,74,0.13)':(!isDone&&diffB===0)?'rgba(59,110,242,0.13)':'rgba(138,147,163,0.15)';
      bHtml+='<span class="dp-badge" style="color:'+dcol+';background:'+dbg+'">'+dtxt+'</span>';
    }
    const catName=t.category==='work'?'Work':t.category==='personal'?'Personal':esc((t.category||'').charAt(0).toUpperCase()+(t.category||'').slice(1));
    bHtml+='<span class="dp-badge">'+catName+'</span>';
    bHtml+='<span class="dp-badge">'+t.priority.charAt(0).toUpperCase()+t.priority.slice(1)+' priority</span>';
    if(t.repeat&&t.repeat!=='none')bHtml+='<span class="dp-badge">↻ '+t.repeat.charAt(0).toUpperCase()+t.repeat.slice(1)+'</span>';
    badges.innerHTML=bHtml;
  }

  // Progress card — fill uses the priority color (design deriveTask.priColor)
  const priColorD=t.priority==='high'?'var(--p-high)':t.priority==='low'?'var(--p-low)':'var(--p-med)';
  const pctEl=document.getElementById('dp-prog-pct');
  if(pctEl)pctEl.innerText=prog+'%';
  const barEl=document.getElementById('dp-prog-bar');
  if(barEl){barEl.style.width=prog+'%';barEl.style.background=priColorD;}

  // Status toggle button — green "Mark done" / neutral "Reopen task"
  const sbtn=document.getElementById('dp-status-btn');
  if(sbtn){sbtn.innerText=isDone?'Reopen task':'Mark done';sbtn.classList.toggle('reopen',isDone);}

  const dueRow=document.getElementById('dp-due-row');
  const dueLbl=document.getElementById('dp-due-lbl');
  const dueInp=document.getElementById('dp-due-input');
  dueRow.style.display='flex';
  if(dueInp)dueInp.value=t.dueDate||'';
  if(t.dueDate){
    const[,m,d]=t.dueDate.split('-');
    const todayMid=new Date();todayMid.setHours(0,0,0,0);
    const diff=Math.round((parseLocalDate(t.dueDate)-todayMid)/86400000);
    const lbl=diff<0?' (Overdue)':diff===0?' (Today)':diff<=3?' ('+diff+'d away)':'';
    if(dueLbl)dueLbl.innerText=parseInt(d)+' '+mo[parseInt(m)-1]+' '+t.dueDate.split('-')[0]+lbl;
  } else { if(dueLbl)dueLbl.innerText='Not set'; }

  const createdRow=document.getElementById('dp-created-row');
  if(createdRow){
    if(t.createdAt){
      const cd=new Date(t.createdAt);
      const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const diffDays=Math.floor((Date.now()-t.createdAt)/86400000);
      const age=diffDays===0?'Today':diffDays===1?'Yesterday':diffDays+'d ago';
      document.getElementById('dp-created').innerText=cd.getDate()+' '+mo[cd.getMonth()]+' '+cd.getFullYear()+' ('+age+')';
      createdRow.style.display='flex';
    } else {
      createdRow.style.display='none';
    }
  }

  // time block
  var timeRow=document.getElementById('dp-time-row');
  if(timeRow){
    if(t.startTime){
      var tStr=t.startTime;
      if(t.duration){
        var tp=t.startTime.split(':');
        var ts=new Date();ts.setHours(parseInt(tp[0]),parseInt(tp[1]),0,0);
        var te=new Date(ts.getTime()+t.duration*60000);
        tStr+=' - '+te.getHours().toString().padStart(2,'0')+':'+te.getMinutes().toString().padStart(2,'0')+' ('+t.duration+'min)';
      }
      document.getElementById('dp-time').innerText=tStr;
      timeRow.style.display='flex';
    } else {timeRow.style.display='none';}
  }
  // Blocks / blocked-by — design: tinted chips in their own card
  const blocksCard=document.getElementById('dp-blocks-card');
  const chipsEl=document.getElementById('dp-block-chips');
  if(blocksCard&&chipsEl){
    let chips='';
    if(t.blocking){
      const blocksTask=tasks.find(function(x){return x.id===t.blocking;});
      chips+='<span class="dp-chip" style="background:var(--q1-bg);color:var(--q1-c)">Blocks: '+esc(blocksTask?blocksTask.name:'(deleted)')+'</span>';
    }
    getBlockedByTasks(t.id).forEach(function(x){
      chips+='<span class="dp-chip" style="background:var(--q2-bg);color:var(--q2-c)">Blocked by: '+esc(x.name)+'</span>';
    });
    chipsEl.innerHTML=chips;
    blocksCard.style.display=chips?'block':'none';
  }

  // Completed date row — only shown for done tasks, editable
  const completedRow=document.getElementById('dp-completed-row');
  if(completedRow){
    if(t.status==='done'){
      const ts=t.completedAt||t.updatedAt;
      const cd=ts?new Date(ts):null;
      const lbl=document.getElementById('dp-completed-lbl');
      const inp=document.getElementById('dp-completed-input');
      if(lbl)lbl.innerText=cd?(cd.getDate()+' '+mo[cd.getMonth()]+' '+cd.getFullYear()):'Unknown';
      if(inp)inp.value=cd?toLocalISO(cd):'';
      completedRow.style.display='flex';
    } else {
      completedRow.style.display='none';
    }
  }

  // Checklist card — design: 19px rounded checkboxes, green when done
  const stepsWrap=document.getElementById('dp-steps');
  const stepsList=document.getElementById('dp-steps-list');
  if(steps.length){
    stepsWrap.style.display='block';
    stepsList.innerHTML='';
    steps.forEach(function(s){
      const el=document.createElement('div');
      el.className='dchk';
      const box=document.createElement('span');
      box.className='dchk-box'+(s.status==='completed'?' on':'');
      if(s.status==='completed')box.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4"><path d="M20 6L9 17l-5-5"></path></svg>';
      else if(s.status==='in-progress')box.innerHTML='<span style="width:9px;height:9px;border-radius:3px;background:var(--purple);display:block"></span>';
      const txt=document.createElement('span');
      txt.className='dchk-txt'+(s.status==='completed'?' done':'');
      txt.textContent=s.text;
      el.appendChild(box);el.appendChild(txt);
      if(s.dueDate||s.notifTime){
        const metaS=document.createElement('span');
        metaS.style.cssText='margin-left:auto;font-size:11px;font-weight:600;color:var(--text-muted);white-space:nowrap';
        metaS.textContent=(s.dueDate||'')+(s.notifTime?' 🔔'+s.notifTime:'');
        el.appendChild(metaS);
      }
      el.addEventListener('click',function(){toggleDetailStep(t.id,s.id);});
      stepsList.appendChild(el);
    });
  } else { stepsWrap.style.display='none'; }

  // History card
  var histEl=document.getElementById('dp-history');
  var histList=document.getElementById('dp-history-list');
  if(histEl&&t.history&&t.history.length){
    histEl.style.display='block';
    var moH=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    histList.innerHTML=t.history.map(function(h){
      var d=new Date(h.at);
      return '<div class="dhist-row"><span>'+esc(h.action)+'</span><span class="rt">'+d.getDate()+' '+moH[d.getMonth()]+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+'</span></div>';
    }).join('');
  } else if(histEl){histEl.style.display='none';}

  document.getElementById('detail-overlay').classList.add('open');
}

// Design action row: status toggle + focus launcher
function toggleFromDetail(){
  if(!detailTaskId)return;
  const id=detailTaskId;
  toggleDone(id,null);
  // toggleDone re-renders the list; refresh the open sheet with the new state
  if(tasks.find(x=>x.id===id))showTaskDetail(id);
  else closeDetail();
}
function focusFromDetail(){
  const id=detailTaskId;
  closeDetail();
  if(id)setTimeout(function(){openFocusMode(id);},150);
}



const CAT_KEY='donezo_categories';
const DEFAULT_CATS=[{id:'work',name:'Work',color:'#A3292D'},{id:'personal',name:'Personal',color:'#7c3aed'}];
function loadCategories(){const raw=localStorage.getItem(CAT_KEY);if(!raw)return [...DEFAULT_CATS];const parsed=safeParse(raw,null);if(!Array.isArray(parsed))return [...DEFAULT_CATS];if(!parsed.find(x=>x.id==='work'))parsed.unshift({id:'work',name:'Work',color:'#A3292D'});if(!parsed.find(x=>x.id==='personal'))parsed.push({id:'personal',name:'Personal',color:'#7c3aed'});return parsed;}
function saveCategories(cats){localStorage.setItem(CAT_KEY,JSON.stringify(cats));}

function addCustomCategory(){
  const name=document.getElementById('cat-name-input').value.trim();
  const color=document.getElementById('cat-color-pick').value;
  if(!name){showToast('Enter a category name');return;}
  const cats=loadCategories();
  const id=name.toLowerCase().replace(/\s+/g,'-');
  if(cats.find(x=>x.id===id)){showToast('Category already exists');return;}
  cats.push({id,name,color});
  saveCategories(cats);
  document.getElementById('cat-name-input').value='';
  renderCategorySettings();
  refreshCategorySelect();
  showToast('Category added: '+name);
}

function deleteCustomCategory(id){
  if(id==='work'||id==='personal'){showToast('Cannot delete default categories');return;}
  const cats=loadCategories().filter(x=>x.id!==id);
  saveCategories(cats);
  renderCategorySettings();
  refreshCategorySelect();
}

function renderCategorySettings(){
  const list=document.getElementById('cats-list');if(!list)return;
  const cats=loadCategories();
  // Design: tinted pills (color at ~13% alpha bg, solid color text)
  list.innerHTML=cats.map(function(cat){
    return '<span class="cat-pill" style="background:'+cat.color+'22;color:'+cat.color+'">'+esc(cat.name)
      +(cat.id!=='work'&&cat.id!=='personal'?'<button data-del="'+cat.id+'" title="Delete category">&#215;</button>':'')
      +'</span>';
  }).join('');
  list.querySelectorAll('[data-del]').forEach(function(btn){
    btn.addEventListener('click',function(){deleteCustomCategory(btn.dataset.del);});
  });
}

// Swatch picker for new custom categories (design: 4 fixed swatches)
function pickCatColor(btn){
  document.querySelectorAll('.swatch').forEach(function(s){s.classList.remove('active');});
  btn.classList.add('active');
  const inp=document.getElementById('cat-color-pick');
  if(inp)inp.value=btn.dataset.swatch;
}

// Soundscape button group (settings card + focus mode) — active button coral
function setNoiseTypeBtn(type){
  setNoiseType(type);
  updateSoundBtns();
}
function updateSoundBtns(){
  ['off','white','brown','tick'].forEach(function(t){
    ['nsb-','fsb-'].forEach(function(prefix){
      const b=document.getElementById(prefix+t);
      if(b)b.classList.toggle('active',_noiseType===t);
    });
  });
}

// Notifications switch — requesting is one-way (the browser owns revocation)
function onNotifSwitch(cb){
  const granted=('Notification' in window)&&Notification.permission==='granted';
  if(!granted&&cb.checked){
    requestNotifPermission();
  } else if(granted&&!cb.checked){
    cb.checked=true;
    showToast('Disable notifications in your browser/site settings');
  }
}

function refreshCategorySelect(){
  const cats=loadCategories();
  const sel=document.getElementById('f-cat');
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML=cats.map(cat=>'<option value="'+esc(cat.id)+'">'+esc(cat.name)+'</option>').join('');
  if(cats.find(x=>x.id===cur))sel.value=cur;
  // Design: category is a segmented button group, not a dropdown
  const grp=document.getElementById('seg-cat');
  if(grp){
    grp.innerHTML=cats.map(cat=>'<button class="seg-btn" data-val="'+esc(cat.id)+'" onclick="segSet(\'f-cat\',\''+esc(cat.id)+'\')">'+esc(cat.name)+'</button>').join('');
  }
  refreshModalSegs();
}

// Segmented button groups drive the hidden selects that hold modal form state
function segSet(selId,val){
  const sel=document.getElementById(selId);
  if(sel)sel.value=val;
  refreshModalSegs();
}
function refreshModalSegs(){
  [['f-cat','seg-cat'],['f-priority','seg-priority'],['f-status','seg-status'],['f-matrix','quad-grid'],['f-repeat','seg-repeat']].forEach(function(p){
    const sel=document.getElementById(p[0]);
    const grp=document.getElementById(p[1]);
    if(!sel||!grp)return;
    grp.querySelectorAll('[data-val]').forEach(function(b){b.classList.toggle('active',b.dataset.val===sel.value);});
  });
}

function getCatColor(catId){
  const cats=loadCategories();
  const cat=cats.find(x=>x.id===catId);
  return cat?cat.color:'#9aa5b4';
}



function shareFromDetail(){
  const t=tasks.find(x=>x.id===detailTaskId);if(!t)return;
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let text=t.name;
  if(t.dueDate){
    const[,m,d]=t.dueDate.split('-');
    text+=' — due '+parseInt(d)+' '+mo[parseInt(m)-1];
  }
  if(t.steps&&t.steps.length){
    text+='\nSteps:\n'+t.steps.map((s,i)=>(i+1)+'. '+s.text+(s.status==='completed'?' ✓':'')).join('\n');
  }
  if(navigator.share){
    navigator.share({title:t.name,text}).catch(()=>{});
  } else {
    navigator.clipboard.writeText(text).then(()=>showToast('Copied to clipboard'));
  }
}

// ── Focus Mode ────────────────────────────────────────────────────────
let _focusTaskId=null,_focusTimer=null,_focusSecs=25*60,_focusRunning=false,_focusTotal=25*60;

// Design timer ring: coral conic progress on the 240px ring as time elapses
function updateFocusRing(){
  const ring=document.getElementById('focus-ring');
  if(!ring)return;
  if(_focusRunning||_focusSecs<_focusTotal){
    const deg=Math.round((1-_focusSecs/_focusTotal)*360);
    ring.style.background='conic-gradient(#f4795b '+deg+'deg,var(--bg-track) 0)';
  } else {
    ring.style.background='var(--bg-track)';
  }
}

function openFocusMode(idOrEl){
  var fid=typeof idOrEl==='string'?idOrEl:(idOrEl&&idOrEl.getAttribute?idOrEl.getAttribute('data-focus'):idOrEl);
  const t=tasks.find(x=>x.id===fid);if(!t)return;
  const id=fid;
  _focusTaskId=id;
  _focusSecs=(t.duration&&t.duration>0?t.duration:25)*60;_focusTotal=_focusSecs;_focusRunning=false;
  updateFocusRing();
  updateSoundBtns();
  document.getElementById('focus-task-name').innerText=t.name;
  const pLabel={high:'High priority',medium:'Medium priority',low:'Low priority'};
  const mLabel2={'1':'Do First','2':'Schedule','3':'Delegate','4':'Eliminate'};
  var slotTxt=t.startTime?(t.startTime.slice(0,5)+(t.duration?' for '+t.duration+'min':'')):''; document.getElementById('focus-task-meta').innerText=pLabel[t.priority]+' · '+(mLabel2[t.matrix||'4'])+(slotTxt?' · '+slotTxt:'');
  var focusMins=t.duration&&t.duration>0?t.duration:25; document.getElementById('focus-timer').innerText=focusMins.toString().padStart(2,'0')+':00';
  document.getElementById('focus-timer-label').innerText=(t.duration&&t.duration>0?t.duration+'-minute session':'Pomodoro — 25 minutes');
  const startBtn=document.getElementById('focus-start-btn');
  if(startBtn)startBtn.innerText='Start timer';
  const steps=t.steps||[];
  const stepsEl=document.getElementById('focus-steps');
  if(steps.length){
    stepsEl.style.display='block';
    stepsEl.innerHTML='<div class="dcard-title">Checklist</div>'+steps.map(s=>{
      const dot=s.status==='completed'?'var(--green)':s.status==='in-progress'?'var(--purple)':'var(--border-color)';
      return'<div class="focus-step'+(s.status==='completed'?' done':'')+'"><span class="focus-step-dot" style="background:'+dot+'"></span>'+esc(s.text)+'</div>';
    }).join('');
  } else {
    stepsEl.style.display='none';
  }
  document.getElementById('focus-overlay').classList.add('open');
}

function closeFocusMode(){
  stopNoise();
  clearInterval(_focusTimer);_focusRunning=false;
  document.getElementById('focus-overlay').classList.remove('open');
  _focusTaskId=null;
}

function closeFocusBg(e){if(e.target.id==='focus-overlay')closeFocusMode()}

function toggleFocusTimer(){
  const btn=document.getElementById('focus-start-btn');
  if(_focusRunning){
    clearInterval(_focusTimer);_focusRunning=false;
    if(btn)btn.innerText='Resume';
  } else {
    _focusRunning=true;
    if(btn)btn.innerText='Pause';
    _focusTimer=setInterval(()=>{
      _focusSecs--;
      if(_focusSecs<=0){
        clearInterval(_focusTimer);_focusRunning=false;
        document.getElementById('focus-timer').innerText='00:00';
        document.getElementById('focus-timer-label').innerText='Time\'s up! Great work.';
        if(btn)btn.innerText='Restart';
        _focusSecs=25*60;_focusTotal=25*60;
        updateFocusRing();
        showToast('Pomodoro complete! Take a break ☕');
        return;
      }
      const m=Math.floor(_focusSecs/60).toString().padStart(2,'0');
      const s=(_focusSecs%60).toString().padStart(2,'0');
      document.getElementById('focus-timer').innerText=m+':'+s;
      updateFocusRing();
    },1000);
  }
}

function completeFocusTask(){
  if(!_focusTaskId)return;
  const t=tasks.find(x=>x.id===_focusTaskId);
  if(t){toggleDone(_focusTaskId,null);}
  closeFocusMode();
}



function logHistory(task, action){
  if(!task.history) task.history=[];
  task.history.unshift({action:action, at:Date.now()});
  if(task.history.length>20) task.history=task.history.slice(0,20);
}
function refreshBlockingSelect(excludeId){
  var sel=document.getElementById('f-blocking');
  if(!sel)return;
  var cur=sel.value;
  sel.innerHTML='<option value="">None</option>'+tasks.filter(function(t){
    return t.id!==excludeId&&t.status!=='done';
  }).map(function(t){
    return '<option value="'+t.id+'"'+(t.id===cur?' selected':'')+'>'+esc(t.name)+'</option>';
  }).join('');
}

function getBlockedByTasks(id){
  return tasks.filter(function(t){return t.blocking===id;});
}
function setQuickDate(offset){
  var inp=document.getElementById('f-due');
  if(!inp)return;
  if(offset===-1){inp.value='';syncQuickPick();return;}
  var d=new Date();d.setDate(d.getDate()+offset);
  inp.value=toLocalISO(d);
  syncQuickPick();
}
function syncQuickPick(){
  var val=document.getElementById('f-due').value;
  var today=new Date();today.setHours(0,0,0,0);
  document.querySelectorAll('.date-qbtn').forEach(function(btn){btn.classList.remove('active');});
  if(!val)return;
  var d=new Date(val);d.setHours(0,0,0,0);
  var diff=Math.round((d-today)/86400000);
  var btns=document.querySelectorAll('.date-qbtn');
  if(diff===0&&btns[0])btns[0].classList.add('active');
  else if(diff===1&&btns[1])btns[1].classList.add('active');
  else if(diff===7&&btns[2])btns[2].classList.add('active');
  else if(diff===14&&btns[3])btns[3].classList.add('active');
}

function toggleDetailStep(taskId, stepId){
  var t=tasks.find(function(x){return x.id===taskId;});
  if(!t)return;
  var s=t.steps&&t.steps.find(function(x){return x.id===stepId;});
  if(!s)return;
  var cycle={'not-started':'in-progress','in-progress':'completed','completed':'not-started'};
  s.status=cycle[s.status]||'not-started';
  if(s.status==='completed'){s.completedAt=Date.now();playPop();haptic('light');}
  else if(s.status!=='completed'){delete s.completedAt;}
  t.updatedAt=Date.now();
  saveTasksLocal();
  fbSave(t);
  // re-render detail panel steps
  showTaskDetail(taskId);
  render();
}
function closeDetail(){document.getElementById('detail-overlay').classList.remove('open');detailTaskId=null}
function closeDetailBg(e){if(e.target.id==='detail-overlay')closeDetail()}
function editFromDetail(){const id=detailTaskId;closeDetail();editTask(id)}

// Inline rename: tap the title in the detail panel to edit in place
function startTitleEdit(){
  const el=document.getElementById('dp-title');
  const t=tasks.find(function(x){return x.id===detailTaskId;});
  if(!el||!t||el.querySelector('input'))return;
  const inp=document.createElement('input');
  inp.type='text';
  inp.value=t.name;
  inp.style.cssText='width:100%;font-family:inherit;font-size:inherit;font-weight:inherit;background:transparent;border:none;border-bottom:2px solid var(--purple);color:var(--text-main);outline:none;padding:0';
  el.innerHTML='';
  el.appendChild(inp);
  inp.focus();
  inp.select();
  let settled=false;
  function commit(){
    if(settled)return;
    settled=true;
    const v=inp.value.trim();
    if(v&&v!==t.name){
      t.name=v;
      t.updatedAt=Date.now();
      (t.history=t.history||[]).push({action:'Renamed',at:Date.now()});
      saveTasksLocal();
      fbSave(t);
      render();
      showToast('Task renamed');
    }
    showTaskDetail(t.id);
  }
  inp.addEventListener('blur',commit);
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter')inp.blur();
    if(e.key==='Escape'){settled=true;showTaskDetail(t.id);}
  });
}

// Inline due date change from the detail panel
function saveDueDate(dateStr){
  const t=tasks.find(function(x){return x.id===detailTaskId;});
  if(!t)return;
  t.dueDate=dateStr||'';
  t.updatedAt=Date.now();
  (t.history=t.history||[]).push({action:dateStr?'Due date changed':'Due date removed',at:Date.now()});
  saveTasksLocal();
  fbSave(t);
  showTaskDetail(t.id);
  render();
  showToast('Due date updated');
}

// Smooth-scroll to a dashboard section (used by stat cards)
function scrollToSection(id){
  const el=document.getElementById(id);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}

// Format a Date as YYYY-MM-DD in LOCAL time (toISOString shifts to UTC
// which gives the wrong date before 01:00 in Lagos GMT+1)
function toLocalISO(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function saveStepCompletedAt(taskId,stepId,dateStr,lblEl){
  const t=tasks.find(x=>x.id===taskId);if(!t)return;
  const s=(t.steps||[]).find(x=>x.id===stepId);if(!s||s.status!=='completed')return;
  if(!dateStr){showToast('Invalid date');return;}
  const parts=dateStr.split('-');
  const newDate=new Date(parseInt(parts[0]),parseInt(parts[1])-1,parseInt(parts[2]));
  if(isNaN(newDate.getTime())){showToast('Invalid date');return;}
  // Preserve original time-of-day
  let hours=12,minutes=0;
  if(s.completedAt){const ed=new Date(s.completedAt);hours=ed.getHours();minutes=ed.getMinutes();}
  newDate.setHours(hours,minutes,0,0);
  s.completedAt=newDate.getTime();
  t.updatedAt=Date.now();
  saveTasksLocal();
  fbSave(t);
  // Update label immediately
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if(lblEl)lblEl.textContent=newDate.getDate()+' '+mo[newDate.getMonth()]+' '+newDate.getFullYear();
  updateDailyRing();
  showToast('Step completion date updated');
}

function saveCompletedAt(dateStr){
  const t=tasks.find(x=>x.id===detailTaskId);if(!t||t.status!=='done')return;
  if(!dateStr){showToast('Invalid date');return;}
  // Parse the date as local midnight, preserve the original time-of-day if available
  const parts=dateStr.split('-');
  const newDate=new Date(parseInt(parts[0]),parseInt(parts[1])-1,parseInt(parts[2]));
  if(isNaN(newDate.getTime())){showToast('Invalid date');return;}
  // Keep original time component if completedAt exists, else use noon
  let hours=12,minutes=0;
  const existing=t.completedAt||t.updatedAt;
  if(existing){const ed=new Date(existing);hours=ed.getHours();minutes=ed.getMinutes();}
  newDate.setHours(hours,minutes,0,0);
  t.completedAt=newDate.getTime();
  t.updatedAt=newDate.getTime();
  saveTasksLocal();
  fbSave(t);
  // Update the label in the detail panel immediately
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const lbl=document.getElementById('dp-completed-lbl');
  if(lbl)lbl.innerText=newDate.getDate()+' '+mo[newDate.getMonth()]+' '+newDate.getFullYear();
  updateDailyRing();
  showToast('Completion date updated');
}
function deleteFromDetail(){const id=detailTaskId;closeDetail();deleteTask(id);}
function onMatrixChange(sel){
  scheduleRender();
  const btn=document.getElementById('btn-matrix');
  if(btn) btn.style.borderColor=sel.value!=='all'?'var(--grad)':'var(--border-color)';
}
function onSortChange(sel){
  setSortMode(sel.value);
  const btn=document.getElementById('btn-sort');
  if(btn) btn.style.borderColor=sel.value!=='recent'?'var(--grad)':'var(--border-color)';
}

function setTaskView(v){
  taskView=v;
  const r=document.getElementById('vt-rows'),c=document.getElementById('vt-cards');
  if(r)r.classList.toggle('active',v==='rows');
  if(c)c.classList.toggle('active',v==='cards');
  render();
}



function hideTaskAutocomplete(){
  const ac=document.getElementById('task-autocomplete');
  if(ac)ac.style.display='none';
}

function initTaskAutocomplete(){
  const inp=document.getElementById('f-name');
  const ac=document.getElementById('task-autocomplete');
  if(!inp||!ac||inp._acBound)return;
  inp._acBound=true;
  inp.addEventListener('input',function(){
    const q=inp.value.trim().toLowerCase();
    if(!q||q.length<2){ac.style.display='none';return;}
    // Search all tasks (active + archive) including completed ones
    const arch=loadArch();
    const allTasks=[...tasks,...arch];
    const seen=new Set();
    const matches=allTasks.filter(function(t){
      if(seen.has(t.name))return false;
      if(!t.name.toLowerCase().includes(q))return false;
      seen.add(t.name);return true;
    }).slice(0,6);
    if(!matches.length){ac.style.display='none';return;}
    ac.innerHTML='';
    matches.forEach(function(t){
      const item=document.createElement('div');
      item.className='autocomplete-item';
      const name=document.createElement('div');name.textContent=t.name;
      const sub=document.createElement('div');sub.className='autocomplete-item-sub';
      sub.textContent=t.category+(t.status==='done'?' · completed':'')+(t.dueDate?' · '+t.dueDate:'');
      item.appendChild(name);item.appendChild(sub);
      item.addEventListener('mousedown',function(e){
        e.preventDefault();
        ac.style.display='none';
        // Find the live task (may be in archive)
        const live=tasks.find(function(x){return x.id===t.id;});
        if(live){
          // Close new-task modal and open edit for this task
          closeModal();
          editTask(t.id);
        } else {
          // Archived task — just fill the name so user can recreate
          inp.value=t.name;
          const catSel=document.getElementById('f-cat');if(catSel&&t.category)catSel.value=t.category;
          const priSel=document.getElementById('f-priority');if(priSel&&t.priority)priSel.value=t.priority;
          const matSel=document.getElementById('f-matrix');if(matSel&&t.matrix)matSel.value=t.matrix;
          showToast('Task is archived — fields pre-filled');
        }
      });
      ac.appendChild(item);
    });
    ac.style.display='block';
  });
  inp.addEventListener('blur',function(){setTimeout(function(){ac.style.display='none';},150);});
  inp.addEventListener('keydown',function(e){if(e.key==='Escape')ac.style.display='none';});
}

function openModal(){
  editingId=null;window.currentModalSteps=[];
  document.getElementById('modal-ttl').innerText='New Task';
  ['f-name','f-due'].forEach(id=>{document.getElementById(id).value=''});
  hideTaskAutocomplete();
  document.getElementById('f-cat').value=currentMode==='all'?'work':currentMode;
  document.getElementById('f-matrix').value='2';
  document.getElementById('f-priority').value='medium';
  document.getElementById('f-status').value='todo';document.getElementById('f-repeat').value='none';refreshBlockingSelect(null);document.getElementById('f-blocking').value='';
  renderModalSteps();
  refreshCategorySelect();
  document.getElementById('overlay').classList.add('open');
  setTimeout(()=>{document.getElementById('f-name').focus();initTaskAutocomplete();},200);
}

function editTask(id){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  editingId=id;
  document.getElementById('modal-ttl').innerText='Edit Task';
  document.getElementById('f-name').value=t.name;
  document.getElementById('f-cat').value=t.category;
  document.getElementById('f-priority').value=t.priority;
  document.getElementById('f-matrix').value=t.matrix||'2';
  document.getElementById('f-status').value=t.status;
  document.getElementById('f-due').value=t.dueDate||'';
  window.currentModalSteps=JSON.parse(JSON.stringify(t.steps||[]));document.getElementById('f-repeat').value=t.repeat||'none';refreshBlockingSelect(editingId);document.getElementById('f-blocking').value=t.blocking||'';
  var stInp=document.getElementById('f-start-time');if(stInp)stInp.value=t.startTime||'';
  var durSel=document.getElementById('f-duration');if(durSel)durSel.value=t.duration||'';
  renderModalSteps();
  refreshCategorySelect();
  document.getElementById('f-cat').value=t.category;
  refreshModalSegs();
  document.getElementById('overlay').classList.add('open');
  setTimeout(()=>document.getElementById('f-name').focus(),200);
}

function saveTask(){
  const n=document.getElementById('f-name').value.trim();
  if(!n){showToast('Task title is required');document.getElementById('f-name').focus();return}
  const existing=editingId?tasks.find(x=>x.id===editingId):null;
  const t={id:editingId||crypto.randomUUID(),name:n,createdAt:existing?existing.createdAt||Date.now():Date.now(),completedAt:existing&&existing.status==='done'?existing.completedAt||null:null,category:document.getElementById('f-cat').value,priority:document.getElementById('f-priority').value,matrix:document.getElementById('f-matrix').value,status:document.getElementById('f-status').value,dueDate:document.getElementById('f-due').value,steps:window.currentModalSteps,manualProgress:existing?existing.manualProgress||0:0,repeat:document.getElementById('f-repeat').value||'none',blocking:document.getElementById('f-blocking').value||'',startTime:document.getElementById('f-start-time').value||'',duration:parseInt(document.getElementById('f-duration').value)||0,updatedAt:Date.now()};
  logHistory(t,editingId?'Edited':'Created');
  if(editingId)tasks=tasks.map(x=>x.id===editingId?t:x);else tasks.push(t);
  saveTasksLocal();
  fbSave(t);
  closeModal();render();showToast(editingId?'Changes saved':'Task added');
}


function toggleDone(id,event){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  const wasDone=t.status==='done';
  t.status=wasDone?'todo':'done';t.updatedAt=Date.now();
  if(!wasDone){
    t.completedAt=Date.now();
    const incomplete=(t.steps||[]).filter(s=>s.status!=='completed');
    if(incomplete.length){
      // Flag auto-completed steps so reopening the task can revert them
      incomplete.forEach(s=>{s.status='completed';s.completedAt=Date.now();s.autoCompleted=true;});
      setTimeout(()=>showToast('Task done — '+incomplete.length+' step'+(incomplete.length>1?'s':'')+' auto-completed'),600);
    }
  } else {
    delete t.completedAt;
    // Revert steps that were only completed as a side-effect of marking the
    // task done — manually completed steps keep their status
    (t.steps||[]).forEach(s=>{
      if(s.autoCompleted){s.status='not-started';delete s.completedAt;delete s.autoCompleted;}
    });
  }
  logHistory(t,t.status==='done'?'Marked done':'Reopened');
  if(!wasDone){onTaskCompleted(t);playDing();haptic('complete');}
  saveTasksLocal();
  fbSave(t);
  if(!wasDone&&t.repeat&&t.repeat!=='none'&&t.dueDate){
    // Advance a local date by one repeat interval (avoids UTC day-shift)
    const advance=function(ds){
      const d0=parseLocalDate(ds);if(!d0)return '';
      if(t.repeat==='daily')d0.setDate(d0.getDate()+1);
      else if(t.repeat==='weekly')d0.setDate(d0.getDate()+7);
      else if(t.repeat==='monthly')d0.setMonth(d0.getMonth()+1);
      return toLocalISO(d0);
    };
    const nextDue=advance(t.dueDate);
    const next={...t,id:crypto.randomUUID(),status:'todo',manualProgress:0,
      dueDate:nextDue,
      createdAt:Date.now(),completedAt:null,history:[],
      // Fresh step ids, reset status, and shift each step's own deadline
      // forward by the same interval so they don't arrive already overdue
      steps:(t.steps||[]).map(s=>{
        const ns={...s,id:crypto.randomUUID(),status:'not-started',dueDate:s.dueDate?advance(s.dueDate):''};
        delete ns.completedAt;delete ns.autoCompleted;
        return ns;
      }),
      updatedAt:Date.now()};
    logHistory(next,'Created (repeat)');
    tasks.push(next);fbSave(next);
    saveTasksLocal();
    showToast('Next occurrence added: '+next.dueDate);
  }
  render();
}

function deleteTask(id){
  haptic('delete');
  const t=tasks.find(x=>x.id===id);if(!t)return;
  // move to archive
  const archived={...t,archivedAt:Date.now()};
  let arch=loadArch();
  arch.unshift(archived);
  arch=arch.filter(x=>(Date.now()-x.archivedAt)<30*86400000);
  saveArch(arch);
  // remove from tasks
  tasks=tasks.filter(x=>x.id!==id);
  saveTasksLocal();
  fbDelete(id);
  render();
  pushUndo('Task archived',function(){
    // undo: restore to tasks
    tasks.push(t);
    fbSave(t);
    saveTasksLocal();
    let a=loadArch().filter(x=>x.id!==id);
    saveArch(a);
    render();
  });
}
function closeModal(){document.getElementById('overlay').classList.remove('open');editingId=null;hideTaskAutocomplete();}
function closeOverlayBg(e){if(e.target.id==='overlay')closeModal()}




function updateThemeColor(){
  const isDark=document.body.classList.contains('dark-mode');
  // Match --bg-app in styles.css so the browser chrome blends with the page
  const colour=isDark?'#1b1712':'#f5efe6';
  const meta=document.getElementById('theme-color-meta');
  if(meta) meta.setAttribute('content', colour);
}

function setDarkMode(isDark){
  document.body.classList.toggle('dark-mode',isDark);
  localStorage.setItem('donezo_dark',isDark);
  const moon=document.getElementById('icon-dark'),sun=document.getElementById('icon-light');
  if(moon)moon.style.display=isDark?'none':'block';
  if(sun)sun.style.display=isDark?'block':'none';
  const swD=document.getElementById('sw-dark');
  if(swD)swD.checked=isDark;
  updateThemeColor();
}
function toggleDarkMode(){setDarkMode(!document.body.classList.contains('dark-mode'));}
function updateUISetting(key,val){uiSettings[key]=val;localStorage.setItem(UI_KEY,JSON.stringify(uiSettings));render()}
function changeMonth(offset){currentCalDate.setMonth(currentCalDate.getMonth()+offset);renderCalendar()}

function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('sidebar-overlay').classList.toggle('active')}
function closeSidebarMobile(){if(window.innerWidth<=800){document.getElementById('sidebar').classList.remove('open');document.getElementById('sidebar-overlay').classList.remove('active')}}

function setMode(m){
  currentMode=m;
  ['all','work','personal'].forEach(x=>{const t=document.getElementById('tab-'+x);if(t)t.classList.toggle('active',x===m)});
  setView('dashboard');
}

function setDashboardView(v){
  currentDashboardView=v;
  ['list','analytics'].forEach(x=>{const t=document.getElementById('tab-view-'+x);if(t)t.classList.toggle('active',x===v)});
  render();
}

// Header — design: uppercase date eyebrow + page title (greeting on dashboard)
function updateHeader(){
  const eyebrow=document.getElementById('hdr-eyebrow');
  const title=document.getElementById('hdr-title');
  if(!eyebrow||!title)return;
  const now=new Date();
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const mos=['January','February','March','April','May','June','July','August','September','October','November','December'];
  eyebrow.innerText=(days[now.getDay()]+', '+mos[now.getMonth()]+' '+now.getDate()).toUpperCase();
  const h=now.getHours();
  const greeting=h<12?'Good morning':h<17?'Good afternoon':'Good evening';
  const titles={dashboard:greeting,history:'History',gamify:'Progress',archive:'Archive',settings:'Settings'};
  title.innerText=titles[currentView]||'Tracker';
}

function setSortMode(m){sortMode=m;localStorage.setItem('donezo_sort',m);if(fbRef)fbRef.parent.child('meta/sort').set(m).catch(()=>{});render();}

function togglePin(id){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  t.pinned=!t.pinned;t.updatedAt=Date.now();
  saveTasksLocal();
  fbSave(t);render();
  showToast(t.pinned?'Pinned to top':'Unpinned');
}

function setView(v){
  currentView=v;
  document.getElementById('view-dashboard').style.display=v==='dashboard'?'block':'none';
  document.getElementById('view-settings').style.display=v==='settings'?'block':'none';
  document.getElementById('view-archive').style.display=v==='archive'?'block':'none';
  document.getElementById('view-gamify').style.display=v==='gamify'?'block':'none';
  document.getElementById('view-history').style.display=v==='history'?'block':'none';
  // Sidebar nav items (desktop)
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const nav=document.getElementById('nav-'+v);if(nav)nav.classList.add('active');
  // Bottom nav tabs (mobile)
  document.querySelectorAll('.bn-tab').forEach(n=>n.classList.remove('active'));
  const bnt=document.getElementById('bnt-'+v);if(bnt)bnt.classList.add('active');
  updateHeader();
  if(v==='dashboard')render();
  if(v==='archive')renderArchive();
  if(v==='gamify')renderGamify();
  if(v==='history')renderHistory();
}





function attachSwipe(el,id){
  if(el._swipe)return;
  el._swipe=true;
  let startX=0,startY=0,dx=0,dragging=false;
  const THRESHOLD=72;
  el.addEventListener('touchstart',e=>{
    startX=e.touches[0].clientX;startY=e.touches[0].clientY;dx=0;dragging=false;
  },{passive:true});
  el.addEventListener('touchmove',e=>{
    dx=e.touches[0].clientX-startX;
    const dy=Math.abs(e.touches[0].clientY-startY);
    if(!dragging&&dy>Math.abs(dx))return; // vertical scroll — ignore
    dragging=true;
    const clamped=Math.max(-120,Math.min(120,dx));
    el.style.transform='translateX('+clamped+'px)';
    el.style.transition='none';
    const doneBg=el.querySelector('.swipe-done-bg');
    const delBg=el.querySelector('.swipe-del-bg');
    if(doneBg)doneBg.style.opacity=dx>0?Math.min(1,dx/THRESHOLD):'0';
    if(delBg)delBg.style.opacity=dx<0?Math.min(1,-dx/THRESHOLD):'0';
  },{passive:true});
  el.addEventListener('touchend',()=>{
    if(!dragging){el.style.transform='';return}
    el.style.transition='transform 0.22s ease';
    const doneBg=el.querySelector('.swipe-done-bg');
    const delBg=el.querySelector('.swipe-del-bg');
    if(dx>THRESHOLD){
      el.style.transform='translateX(0)';
      if(doneBg)doneBg.style.opacity='0';
      toggleDone(id,null);
    } else if(dx<-THRESHOLD){
      el.style.transform='translateX(-110%)';
      setTimeout(()=>deleteTask(id),220);
    } else {
      el.style.transform='translateX(0)';
      if(doneBg)doneBg.style.opacity='0';
      if(delBg)delBg.style.opacity='0';
    }
  });
}

function attachAllSwipes(){
  document.querySelectorAll('.task-row[data-id]').forEach(el=>attachSwipe(el,el.dataset.id));
  // Event delegation for row buttons (avoids inline handler quoting issues)
  const list=document.getElementById('task-list');
  if(list&&!list._delegated){
    list._delegated=true;
    list.addEventListener('click',function(e){
      const check=e.target.closest('[data-check]');
      if(check){e.stopPropagation();toggleDone(check.dataset.check,e);return;}
      const detail=e.target.closest('[data-detail]');
      if(detail){e.stopPropagation();showTaskDetail(detail.dataset.detail);return;}
      const del=e.target.closest('button[data-del]');
      if(del){e.stopPropagation();deleteTask(del.dataset.del);return;}
      const pin=e.target.closest('[data-pin]');
      if(pin){e.stopPropagation();togglePin(pin.dataset.pin);return;}
      const focus=e.target.closest('[data-focus]');
      if(focus){e.stopPropagation();openFocusMode(focus);return;}
    });
  }
}


function exportBackup(){
  const backup={
    version:2,
    exportedAt:new Date().toISOString(),
    tasks:tasks,
    archive:loadArch(),
    gamify:loadGamify(),
    categories:loadCategories(),
    settings:{
      dark:localStorage.getItem('donezo_dark'),
      sort:localStorage.getItem('donezo_sort'),
      ui:localStorage.getItem('donezo_ui_v1'),
      notifTime:localStorage.getItem('donezo_notif_time'),
      noise:localStorage.getItem('donezo_noise'),
      sound:localStorage.getItem('donezo_sound'),
    }
  };
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download='tracker-backup-'+toLocalISO(new Date())+'.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded');
}

function importBackup(e){
  const file=e.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=function(ev){
    try{
      const backup=JSON.parse(ev.target.result);
      if(!backup.version||!backup.tasks){showToast('Invalid backup file');return;}

      // Confirm before overwriting
      if(!confirm('This will replace ALL your current data. Continue?'))return;

      // Restore tasks (normalize so a hand-edited/partial backup can't inject
      // tasks with missing priority/status that would break sorting & rendering)
      tasks=(Array.isArray(backup.tasks)?backup.tasks:[]).map(normalizeTask);
      saveTasksLocal();

      // Restore archive
      if(backup.archive) localStorage.setItem('donezo_archive',JSON.stringify(backup.archive));

      // Restore gamify
      if(backup.gamify) localStorage.setItem(GK,JSON.stringify(backup.gamify));

      // Restore categories
      if(backup.categories) localStorage.setItem(CAT_KEY,JSON.stringify(backup.categories));

      // Restore settings — write to storage AND apply to the live session so
      // the import takes effect immediately without a reload
      if(backup.settings){
        const s=backup.settings;
        if(s.dark!=null) setDarkMode(s.dark===true||s.dark==='true');
        if(s.sort){
          localStorage.setItem('donezo_sort',s.sort);
          sortMode=s.sort;
          const ss=document.getElementById('sort-select');if(ss)ss.value=s.sort;
        }
        if(s.ui){
          localStorage.setItem('donezo_ui_v1',s.ui);
          uiSettings=safeParse(s.ui,uiSettings);
          const fabCb=document.getElementById('ui-show-fab');if(fabCb)fabCb.checked=uiSettings.showFab!==false;
        }
        if(s.notifTime) localStorage.setItem('donezo_notif_time',s.notifTime);
        // 'noise' is the current key; 'noiseType' accepted for older backups
        const noiseVal=s.noise!=null?s.noise:s.noiseType;
        if(noiseVal!=null){localStorage.setItem('donezo_noise',noiseVal);_noiseType=noiseVal;}
        if(s.sound!=null){
          localStorage.setItem('donezo_sound',s.sound);
          _soundEnabled=safeParse(s.sound,true);
          const swS=document.getElementById('sw-sound');if(swS)swS.checked=_soundEnabled;
        }
      }

      // Push tasks to Firebase
      if(fbRef){
        const fbObj=tasks.reduce(function(o,t){o[t.id]=t;return o;},{});
        fbRef.set(fbObj).catch(function(e){console.warn('FB sync error:',e);});
      }
      if(archRef&&backup.archive){
        const archObj=backup.archive.reduce(function(o,t){o[t.id.replace(/[.#$\[\]]/g,'_')]=t;return o;},{});
        archRef.set(archObj).catch(function(e){console.warn('FB archive sync error:',e);});
      }

      // Re-apply settings
      renderCategorySettings();
      refreshCategorySelect();
      updateXPBar(loadGamify());
      render();

      showToast('Backup restored — '+tasks.length+' tasks imported');
    }catch(err){
      showToast('Failed to read file: '+err.message);
    }
    // Reset file input
    e.target.value='';
  };
  reader.readAsText(file);
}
function exportCSV(){
  const esc=v=>'"'+String(v==null?'':''+v).replace(/"/g,'""')+'"';
  const headers=['Type','Task Name','Step Name','Category','Status','Priority','Matrix','Due Date','Completed At','Steps Done','Steps Total'];
  const rows=[];
  tasks.forEach(function(t){
    const steps=t.steps||[];
    const doneS=steps.filter(s=>s.status==='completed').length;
    const completedAt=t.status==='done'&&(t.completedAt||t.updatedAt)?toLocalISO(new Date(t.completedAt||t.updatedAt)):'';
    // Task row
    rows.push(['Task',t.name,'',t.category,t.status,t.priority,t.matrix||'4',t.dueDate||'',completedAt,doneS,steps.length].map(esc).join(','));
    // Step rows
    steps.forEach(function(s){
      const sCompletedAt=s.status==='completed'&&s.completedAt?toLocalISO(new Date(s.completedAt)):'';
      rows.push(['Step',t.name,s.text,t.category,s.status,'','',s.dueDate||'',sCompletedAt,'',''].map(esc).join(','));
    });
  });
  const csv=[headers.map(esc).join(','),...rows].join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='tasks-'+toLocalISO(new Date())+'.csv';
  a.click();
  showToast('CSV downloaded');
}
// ── Notifications ────────────────────────────────────────────────────

// ── In-app notification log ───────────────────────────────────────────
const NOTIF_LOG_KEY = 'donezo_notif_log';

function loadNotifLog(){
  try{return JSON.parse(localStorage.getItem(NOTIF_LOG_KEY)||'[]');}catch(e){return[];}
}
function saveNotifLog(log){
  // Keep last 30
  localStorage.setItem(NOTIF_LOG_KEY, JSON.stringify(log.slice(0,30)));
}

function logNotif(title, body, taskId){
  const log = loadNotifLog();
  log.unshift({title, body, taskId:taskId||null, at:Date.now(), read:false});
  saveNotifLog(log);
  updateNotifBadge();
}

function updateNotifBadge(){
  const log = loadNotifLog();
  const unread = log.filter(n=>!n.read).length;
  const badge = document.getElementById('notif-badge');
  // Design: red 16px counter bubble on the bell
  if(badge){badge.textContent=unread>9?'9+':unread;badge.style.display = unread>0?'flex':'none';}
}

function toggleNotifPanel(){
  const panel = document.getElementById('notif-panel');
  if(!panel) return;
  const isOpen = panel.classList.toggle('open');
  if(isOpen){
    renderNotifPanel();
    // Mark all as read
    const log = loadNotifLog().map(n=>({...n, read:true}));
    saveNotifLog(log);
    updateNotifBadge();
  }
}

function renderNotifPanel(){
  const list=document.getElementById('notif-list');
  if(!list)return;
  const log=loadNotifLog();
  if(!log.length){
    list.innerHTML='<div class="notif-empty">No notifications yet</div>';
    return;
  }
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  list.innerHTML='';
  log.forEach(function(n,i){
    const d=new Date(n.at);
    const time=d.getDate()+' '+mo[d.getMonth()]+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
    const el=document.createElement('div');
    el.className='notif-item'+(n.read?'':' unread');

    // Content
    const title=document.createElement('div');title.className='notif-item-title';title.textContent=n.title;
    const body=n.body?document.createElement('div'):null;
    if(body){body.className='notif-item-body';body.textContent=n.body;}
    const meta=document.createElement('div');meta.className='notif-item-time';
    meta.textContent=time;
    if(n.taskId){const arrow=document.createElement('span');arrow.style.cssText='color:var(--purple);margin-left:6px;font-weight:700';arrow.innerHTML='&#8594; Open';meta.appendChild(arrow);}
    const hint=document.createElement('span');hint.className='notif-dismiss-hint';hint.textContent='Swipe to dismiss';
    el.appendChild(title);if(body)el.appendChild(body);el.appendChild(meta);el.appendChild(hint);

    // Tap to open task
    if(n.taskId){
      el.addEventListener('click',function(){
        const t=tasks.find(function(x){return x.id===n.taskId;});
        if(!t)return;
        document.getElementById('notif-panel').classList.remove('open');
        showTaskDetail(n.taskId);
      });
    }

    // Swipe to dismiss
    let startX=0,startY=0,dx=0,swiping=false;
    el.addEventListener('touchstart',function(e){
      startX=e.touches[0].clientX;startY=e.touches[0].clientY;dx=0;swiping=false;
    },{passive:true});
    el.addEventListener('touchmove',function(e){
      const curX=e.touches[0].clientX,curY=e.touches[0].clientY;
      dx=curX-startX;
      const dy=Math.abs(curY-startY);
      if(!swiping&&Math.abs(dx)>dy&&Math.abs(dx)>8) swiping=true;
      if(swiping){
        el.classList.add('swiping');
        el.style.transform='translateX('+dx+'px)';
        el.style.opacity=Math.max(0,1-Math.abs(dx)/120);
        hint.style.opacity=Math.min(1,Math.abs(dx)/60);
      }
    },{passive:true});
    el.addEventListener('touchend',function(){
      el.classList.remove('swiping');
      if(Math.abs(dx)>80){
        el.style.transform='translateX('+(dx>0?'120%':'-120%')+')';
        el.style.opacity='0';
        setTimeout(function(){dismissNotif(i);},250);
      } else {
        el.style.transform='';el.style.opacity='';hint.style.opacity='0';
      }
    },{passive:true});

    list.appendChild(el);
  });
}

function dismissNotif(idx){
  const log=loadNotifLog().filter(function(_,i){return i!==idx;});
  saveNotifLog(log);
  renderNotifPanel();
  updateNotifBadge();
}

function clearAllNotifs(){
  saveNotifLog([]);
  renderNotifPanel();
  updateNotifBadge();
}

// Close panel when clicking outside
document.addEventListener('click', function(e){
  const panel = document.getElementById('notif-panel');
  const btn = document.getElementById('btn-notif-bell');
  if(panel&&panel.classList.contains('open')&&!panel.contains(e.target)&&e.target!==btn&&!btn.contains(e.target)){
    panel.classList.remove('open');
  }
});
function updateNotifUI(){
  const granted=('Notification' in window)&&Notification.permission==='granted';
  const sw=document.getElementById('sw-notif');
  const timeRow=document.getElementById('notif-time-row');
  const noteRow=document.getElementById('notif-note-row');
  if(sw)sw.checked=granted;
  if(timeRow)timeRow.style.display=granted?'flex':'none';
  if(noteRow)noteRow.style.display=granted?'flex':'none';
  if(granted){
    const saved=localStorage.getItem('donezo_notif_time')||'09:00';
    const inp=document.getElementById('notif-time');
    if(inp)inp.value=saved;
  }
}

function requestNotifPermission(){
  if(!('Notification' in window)){showToast('Notifications not supported on this browser');return;}
  if(Notification.permission==='granted'){
    showToast('Notifications already enabled');
    updateNotifUI();
    return;
  }
  Notification.requestPermission().then(function(p){
    if(p==='granted'){
      showToast('Notifications enabled');
      updateNotifUI();
      scheduleNotifLoop();
      checkDueNotifications();
      registerPeriodicSync();
    } else {
      showToast('Permission denied — check browser settings');
    }
  });
}

function saveNotifTime(val){
  localStorage.setItem('donezo_notif_time',val);
  showToast('Daily reminder set for '+val);
  scheduleNotifLoop();
}

function fireNotif(title, body, tag, taskId){
  logNotif(title, body, taskId);
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  const uniqueTag=(tag||'tracker')+'-'+Date.now();
  // Always try SW first — required on Android Chrome
  if('serviceWorker' in navigator){
    navigator.serviceWorker.ready.then(function(reg){
      reg.showNotification(title,{
        body:body,
        tag:uniqueTag,
        vibrate:[100,50,100],
        requireInteraction:false
      });
    }).catch(function(){
      // SW not available, fall back to direct API
      try{new Notification(title,{body:body,tag:uniqueTag});}catch(e){}
    });
  } else {
    try{new Notification(title,{body:body,tag:uniqueTag});}catch(e){}
  }
}

let _lastDueNotifDate='';
function checkDueNotifications(){
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  // Fire at 10:30, 13:00, 17:00 plus the user's saved daily reminder time
  const now=new Date();
  const hhmm=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const savedTime=localStorage.getItem('donezo_notif_time')||'';
  const slots=['10:30','13:00','17:00'];
  if(savedTime&&!slots.includes(savedTime)) slots.push(savedTime);
  const todaySlotKey='donezo_notif_fired_'+toLocalISO(now)+'_'+hhmm;
  if(!slots.includes(hhmm)) return;
  if(localStorage.getItem(todaySlotKey)) return;
  localStorage.setItem(todaySlotKey,'1');
  // Prune old slot keys (keep only today's) to prevent localStorage bloat
  (function(){
    const prefix='donezo_notif_fired_';
    const todayPrefix=prefix+toLocalISO(now);
    Object.keys(localStorage).forEach(function(k){
      if(k.startsWith(prefix)&&!k.startsWith(todayPrefix)) localStorage.removeItem(k);
    });
  })();

  const today=new Date();today.setHours(0,0,0,0);
  const active=tasks.filter(function(t){return t.status!=='done';});
  // parseLocalDate (not new Date(str)) — string dates parse as UTC midnight
  // and shift a day in negative-UTC timezones
  const overdue=active.filter(function(t){if(!t.dueDate)return false;const d=parseLocalDate(t.dueDate);return d&&d<today;});
  const dueToday=active.filter(function(t){if(!t.dueDate)return false;const d=parseLocalDate(t.dueDate);return d&&d.getTime()===today.getTime();});

  if(overdue.length>0){
    const names=overdue.slice(0,3).map(function(t){return t.name;}).join(', ')+(overdue.length>3?'...':'');
    fireNotif(
      overdue.length+' overdue task'+(overdue.length>1?'s':''),
      names,
      'tracker-overdue',
      overdue.length===1?overdue[0].id:null
    );
  }

  if(dueToday.length>0){
    setTimeout(function(){
      const names=dueToday.slice(0,3).map(function(t){return t.name;}).join(', ')+(dueToday.length>3?'...':'');
      fireNotif(
        dueToday.length+' task'+(dueToday.length>1?'s':'')+' due today',
        names,
        'tracker-today',
        dueToday.length===1?dueToday[0].id:null
      );
    }, overdue.length>0?1500:0);
  }
}

// Per-task start-time notifications + step notifications
function checkStepNotifs(){
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  const now=new Date();
  const todayStr=toLocalISO(now);
  const hhmm=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const nineAM=hhmm==='09:00';
  tasks.filter(function(t){return t.status!=='done';}).forEach(function(t){
    (t.steps||[]).filter(function(s){return s.status!=='completed';}).forEach(function(s){
      // Specific time notification
      if(s.notifTime&&s.notifTime===hhmm){
        var tag='step-time-'+t.id+'-'+s.id;
        fireNotif(
          'Step reminder: '+s.text,
          'Part of: '+t.name,
          tag,
          t.id
        );
      }
      // Due date morning notification at 9am
      if(nineAM&&s.dueDate&&s.dueDate===todayStr){
        var tag2='step-due-'+t.id+'-'+s.id;
        fireNotif(
          'Step due today: '+s.text,
          'Part of: '+t.name,
          tag2,
          t.id
        );
      }
    });
  });
}

// Per-task start-time notifications
function checkTimeBlockNotifs(){
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  const now=new Date();
  const todayStr=toLocalISO(now);
  const hhmm=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  tasks.filter(function(t){
    return t.status!=='done'&&t.dueDate===todayStr&&t.startTime&&t.startTime===hhmm;
  }).forEach(function(t){
    fireNotif('Time to start: '+t.name, t.duration?t.duration+' min block':'Scheduled now','tracker-block-'+t.id, t.id);
  });
}

// Notification loop — checks every minute for time-block notifs + daily reminder
let _notifTimer=null;
function sendTasksToSW(type){
  // Push current task state + reminder time to SW so it can evaluate notifications
  // even if the page is backgrounded or closed. type 'TASKS_SNAPSHOT' persists
  // only; default 'SYNC_CHECK' also runs the notification check.
  if(!('serviceWorker' in navigator)) return;
  const msg={
    type:type||'SYNC_CHECK',
    tasks:tasks,
    reminderTime:localStorage.getItem('donezo_notif_time')||''
  };
  if(navigator.serviceWorker.controller){
    navigator.serviceWorker.controller.postMessage(msg);
  } else {
    // First load after SW install — no controller yet, message the active SW
    navigator.serviceWorker.ready.then(function(reg){
      if(reg.active) reg.active.postMessage(msg);
    }).catch(function(){});
  }
}

function scheduleNotifLoop(){
  clearInterval(_notifTimer);
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  _notifTimer=setInterval(function(){
    checkTimeBlockNotifs();
    checkStepNotifs();
    checkDueNotifications(); // only fires at 10:30, 13:00, 17:00
    sendTasksToSW();         // keep SW in sync for background checks
  },60000); // every minute
}

function registerPeriodicSync(){
  if(!('serviceWorker' in navigator)||!('periodicSync' in ServiceWorkerRegistration.prototype)) return;
  navigator.serviceWorker.ready.then(function(reg){
    reg.periodicSync.register('tracker-notif-check',{minInterval:60*60*1000}) // hourly minimum
      .then(function(){console.log('Periodic Background Sync registered');})
      .catch(function(e){console.log('PBS not available:',e.message);});
  });
}


let _historyTab='all',_histCalDate=new Date(),_histGroupCollapsed={},_histDayKeys=[];
function setHistoryTab(tab){
  _historyTab=tab;
  ['all','work','personal'].forEach(function(t){
    const btn=document.getElementById('hist-tab-'+t);
    if(btn)btn.classList.toggle('active',t===tab);
  });
  renderHistory();
}

function renderHistCalendar(buckets){
  const c=document.getElementById('hist-cal-grid');if(!c)return;c.innerHTML='';
  const yr=_histCalDate.getFullYear(),mo=_histCalDate.getMonth();
  const names=["January","February","March","April","May","June","July","August","September","October","November","December"];
  document.getElementById('hist-cal-title').innerText=names[mo]+' '+yr;
  ['S','M','T','W','T','F','S'].forEach(function(d){
    const h=document.createElement('div');h.className='cal-day-name';h.textContent=d;c.appendChild(h);
  });
  const firstDay=new Date(yr,mo,1).getDay(),dim=new Date(yr,mo+1,0).getDate();
  const todayStr=toLocalISO(new Date());
  for(let i=0;i<firstDay;i++){
    const e=document.createElement('div');e.className='hist-cal-cell empty';c.appendChild(e);
  }
  // Design day cells: surface bg, number + green activity dot, today = solid blue
  for(let day=1;day<=dim;day++){
    const ds=yr+'-'+String(mo+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    const count=(buckets[ds]||[]).length;
    const isToday=ds===todayStr;
    const el=document.createElement('div');
    el.className='hist-cal-cell'+(isToday?' today-hist':'');
    const n=document.createElement('span');n.textContent=day;el.appendChild(n);
    if(count||isToday){
      const dot=document.createElement('span');dot.className='hist-cal-dot';
      if(!count)dot.style.opacity='0';
      el.appendChild(dot);
    }
    el.addEventListener('click',function(){showHistDayTasks(ds,buckets[ds]||[]);});
    c.appendChild(el);
  }
}

function changeHistMonth(offset){_histCalDate.setMonth(_histCalDate.getMonth()+offset);renderHistory();}

function showHistDayTasks(ds,items){
  // Show completed tasks/steps for a given day in the day overlay modal
  const parts=ds.split('-');
  const dObj=new Date(parseInt(parts[0]),parseInt(parts[1])-1,parseInt(parts[2]));
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('day-view-title').innerText=days[dObj.getDay()]+', '+dObj.getDate()+' '+mo[dObj.getMonth()]+' '+dObj.getFullYear();
  const container=document.getElementById('day-tasks-list');
  container.innerHTML='';
  if(!items||!items.length){
    container.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">No completions on this day</div>';
    document.getElementById('day-overlay').classList.add('open');
    return;
  }
  const sorted=items.slice().sort(function(a,b){return b.completedAt-a.completedAt;});
  sorted.forEach(function(item){
    const row=document.createElement('div');
    const time=new Date(item.completedAt);
    const hhmm=time.getHours().toString().padStart(2,'0')+':'+time.getMinutes().toString().padStart(2,'0');
    if(item.type==='task'){
      const t=item.task;
      row.className='history-task-item';
      row.innerHTML='<div class="history-task-name">&#9989; '+esc(t.name)+'</div>'
        +'<div class="history-task-meta">'+esc(t.category)+' &bull; '+t.priority+' &bull; '+hhmm+'</div>';
      row.addEventListener('click',function(){
        closeDayView();
        const live=tasks.find(function(x){return x.id===t.id;});
        if(live)showTaskDetail(t.id); else showToast('Task no longer in active list');
      });
    } else {
      const s=item.step,t=item.task;
      row.className='history-step-item';
      row.style.cursor='pointer';
      row.innerHTML=esc(s.text)+' <span style="color:var(--text-muted);font-size:10px">('+esc(t.name)+') &bull; '+hhmm+'</span>';
      row.addEventListener('click',function(){
        closeDayView();
        const live=tasks.find(function(x){return x.id===t.id;});
        if(live)showTaskDetail(t.id); else showToast('Task no longer in active list');
      });
    }
    container.appendChild(row);
  });
  document.getElementById('day-overlay').classList.add('open');
}

function toggleAllHistGroups(){
  const anyExpanded=_histDayKeys.some(function(ds){return !_histGroupCollapsed[ds];});
  _histDayKeys.forEach(function(ds){_histGroupCollapsed[ds]=anyExpanded;});
  const btn=document.getElementById('hist-collapse-all-btn');
  if(btn)btn.textContent=anyExpanded?'Expand all':'Collapse all';
  renderHistory();
}

function renderHistory(){
  const list=document.getElementById('history-list');
  if(!list)return;
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Build day buckets
  const buckets={};
  function addToBucket(key,item){if(!buckets[key])buckets[key]=[];buckets[key].push(item);}

  tasks.filter(t=>t.status==='done'&&(t.completedAt||t.updatedAt)&&(_historyTab==='all'||t.category===_historyTab)).forEach(t=>{
    const key=toLocalISO(new Date(t.completedAt||t.updatedAt));
    addToBucket(key,{type:'task',task:t,completedAt:t.completedAt||t.updatedAt});
  });
  loadArch().filter(t=>t.status==='done'&&(t.completedAt||t.updatedAt)&&(_historyTab==='all'||t.category===_historyTab)).forEach(t=>{
    const key=toLocalISO(new Date(t.completedAt||t.updatedAt));
    addToBucket(key,{type:'task',task:t,completedAt:t.completedAt||t.updatedAt,archived:true});
  });
  tasks.filter(t=>_historyTab==='all'||t.category===_historyTab).forEach(t=>{
    (t.steps||[]).filter(s=>s.status==='completed'&&s.completedAt).forEach(s=>{
      const key=toLocalISO(new Date(s.completedAt));
      addToBucket(key,{type:'step',step:s,task:t,completedAt:s.completedAt});
    });
  });

  // Render calendar
  renderHistCalendar(buckets);

  const sortedDays=Object.keys(buckets).sort((a,b)=>b.localeCompare(a));
  if(!sortedDays.length){
    list.innerHTML='<div class="empty-state"><div class="empty-state-title" style="font-size:15px;font-weight:700;color:var(--text-dim);margin-bottom:6px">No completed tasks yet</div><div class="empty-state-sub" style="font-size:13px">Completed tasks and steps will appear here</div></div>';
    return;
  }

  const now=new Date();now.setHours(0,0,0,0);
  const yesterday=new Date(now);yesterday.setDate(now.getDate()-1);
  _histDayKeys=sortedDays;
  const priCol={high:'var(--p-high)',medium:'var(--p-med)',low:'var(--p-low)'};

  // Design: one collapsible card per day — date + "N done ▾", rows with priority dot + name + category
  function renderItem(item){
    const t=item.task;
    const isStep=item.type==='step';
    const name=isStep?item.step.text:t.name;
    const dot=isStep?'var(--purple)':(priCol[t.priority]||'var(--p-med)');
    const catLabel=t.category==='work'?'Work':t.category==='personal'?'Personal':esc((t.category||'').charAt(0).toUpperCase()+(t.category||'').slice(1));
    return '<div class="hg-item" data-hist-task="'+t.id+'">'
      +'<span class="hg-dot" style="background:'+dot+'"></span>'
      +'<span class="hg-name">'+esc(name)+(isStep?' <span style="color:var(--text-muted);font-size:11px">· '+esc(t.name)+'</span>':'')+'</span>'
      +'<span class="hg-cat">'+catLabel+'</span>'
      +'</div>';
  }

  let html='';
  sortedDays.forEach(function(ds){
    const items=(buckets[ds]||[]).slice().sort((a,b)=>b.completedAt-a.completedAt);
    const collapsed=_histGroupCollapsed[ds]===true;
    const d=new Date(ds+'T12:00:00');
    let dayLabel='';
    if(d.toDateString()===now.toDateString()) dayLabel='Today';
    else if(d.toDateString()===yesterday.toDateString()) dayLabel='Yesterday';
    else dayLabel=d.getDate()+' '+mo[d.getMonth()]+(d.getFullYear()!==now.getFullYear()?' '+d.getFullYear():'');
    html+='<div class="hg-card">'
      +'<div class="hg-head" data-grp="'+ds+'">'
      +'<span class="hg-date">'+dayLabel+'</span>'
      +'<span class="hg-count">'+items.length+' done '+(collapsed?'▸':'▾')+'</span>'
      +'</div>'
      +'<div class="hg-body" style="'+(collapsed?'display:none':'')+'">'+items.map(renderItem).join('')+'</div>'
      +'</div>';
  });

  if(!html) html='<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">No completions in selected period</div>';
  list.innerHTML=html;

  // Collapse toggles
  list.querySelectorAll('[data-grp]').forEach(function(header){
    header.addEventListener('click',function(){
      const gKey=header.dataset.grp;
      _histGroupCollapsed[gKey]=!_histGroupCollapsed[gKey];
      renderHistory();
    });
  });

  // Task/step clicks
  list.querySelectorAll('[data-hist-task]').forEach(function(el){
    el.addEventListener('click',function(){
      const id=el.dataset.histTask;
      const t=tasks.find(function(x){return x.id===id;});
      if(t) showTaskDetail(id);
      else showToast('Task no longer in active list');
    });
  });
}
function renderArchive(){
  const list=document.getElementById('archive-list');if(!list)return;
  let arch=loadArch().filter(x=>(Date.now()-x.archivedAt)<30*86400000);
  if(!arch.length){
    list.innerHTML='<div class="empty-state"><div class="empty-state-icon" style="font-size:40px;opacity:0.3">&#128452;</div><div class="empty-state-title" style="font-size:16px;font-weight:700;color:var(--text-dim);margin-bottom:6px">Archive is empty</div><div class="empty-state-sub" style="font-size:13px">Deleted tasks will appear here for 30 days</div></div>';
    return;
  }
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const priCol={high:'var(--p-high)',medium:'var(--p-med)',low:'var(--p-low)'};
  // Design row: priority dot · name + "Deleted {date} · {N} days left" · blue Restore pill
  list.innerHTML=arch.map(t=>{
    const d=new Date(t.archivedAt);
    const when=mo[d.getMonth()]+' '+d.getDate();
    const daysLeft=Math.ceil((t.archivedAt+30*86400000-Date.now())/86400000);
    return '<div class="archive-item">'
      +'<span class="arch-dot" style="background:'+(priCol[t.priority]||'var(--p-med)')+'"></span>'
      +'<div style="flex:1;min-width:0">'
      +'<div class="archive-item-name">'+esc(t.name)+'</div>'
      +'<div class="archive-item-meta">Deleted '+when+' &middot; '+daysLeft+' days left</div>'
      +'</div>'
      +'<button class="restore-btn" data-restore="'+t.id+'">Restore</button>'
      +'</div>';
  }).join('');
  list.querySelectorAll('[data-restore]').forEach(function(btn){
    btn.addEventListener('click',function(){restoreArchived(btn.dataset.restore);});
  });
}

function restoreArchived(id){
  let arch=JSON.parse(localStorage.getItem('donezo_archive')||'[]');
  const t=arch.find(x=>x.id===id);if(!t)return;
  const restored={...t};delete restored.archivedAt;
  tasks.push(restored);
  fbSave(restored);
  arch=arch.filter(x=>x.id!==id);
  saveArch(arch);
  saveTasksLocal();
  render();renderArchive();
  showToast('Task restored');
}

function permanentlyDeleteArchived(id){
  const arch=loadArch().filter(x=>x.id!==id);
  saveArch(arch);
  renderArchive();
  showToast('Permanently deleted');
}

function addStep(){window.currentModalSteps.push({id:crypto.randomUUID(),text:'',status:'not-started',dueDate:''});renderModalSteps()}
function removeStep(id){window.currentModalSteps=window.currentModalSteps.filter(x=>x.id!==id);renderModalSteps()}
function cycleStepStatus(id){const s=window.currentModalSteps.find(x=>x.id===id);if(!s)return;s.status={'not-started':'in-progress','in-progress':'completed','completed':'not-started'}[s.status];if(s.status==='completed')s.completedAt=Date.now();else delete s.completedAt;renderModalSteps()}
function updateStepText(id,v){const s=window.currentModalSteps.find(x=>x.id===id);if(s)s.text=v}
function updateStepDate(id,v){const s=window.currentModalSteps.find(x=>x.id===id);if(s)s.dueDate=v}
function updateStepTime(id,v){const s=window.currentModalSteps.find(x=>x.id===id);if(s)s.notifTime=v}

if(localStorage.getItem('donezo_dark')==='true'){
  document.body.classList.add('dark-mode');
  const moon=document.getElementById('icon-dark'),sun=document.getElementById('icon-light');
  if(moon)moon.style.display='none';
  if(sun)sun.style.display='block';
  // Topbar icons
  const tmoon=document.getElementById('topbar-icon-dark'),tsun=document.getElementById('topbar-icon-light');
  if(tmoon)tmoon.style.display='none';
  if(tsun)tsun.style.display='block';
}
window.addEventListener('load',()=>{
  const fabCb=document.getElementById('ui-show-fab');if(fabCb)fabCb.checked=uiSettings.showFab!==false;
  const ss=document.getElementById('sort-select');if(ss)ss.value=sortMode;
  updateNotifUI();
  // Start notification loop on load — covers cases where permission was granted
  // in a previous session (common on Android PWA installs)
  if(Notification.permission==='granted'){
    scheduleNotifLoop();
  }
  // Also try after SW is ready (Android Chrome requires SW for showNotification)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.ready.then(function(){
      if(Notification.permission==='granted'){
        scheduleNotifLoop();
        registerPeriodicSync(); // register PBS if already permitted
        sendTasksToSW();        // immediately send tasks to SW on load
      }
    });
  }
});
render();
initFirebase();
(function(){
  const el=document.getElementById('app-version-badge');if(el)el.textContent='v'+APP_VERSION;
  const sv=document.getElementById('settings-version-badge');if(sv)sv.textContent='Tracker v'+APP_VERSION;
})();
(function(){
  const swS=document.getElementById('sw-sound');if(swS)swS.checked=_soundEnabled;
  const swD=document.getElementById('sw-dark');if(swD)swD.checked=document.body.classList.contains('dark-mode');
  updateSoundBtns();
  updateHeader();
})();
renderCategorySettings();
initMetaSync();
updateThemeColor();
updateNotifBadge();
updateXPBar(loadGamify());
updateDailyRing();

// Re-sync when tab becomes visible again (fixes desktop stale data)
// If Firebase realtime listener is already connected, skip the extra fetch —
// the WebSocket keeps data current automatically. Only force-fetch if offline.
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'){
    // Always re-fetch on tab focus — the realtime listener keeps data live
    // when the tab is active, but after a long background or cache clear,
    // the WebSocket may have dropped and reconnected without triggering render
    forceSync();
    if(Notification.permission==='granted') scheduleNotifLoop();
  } else {
    // Page going to background (often the last event before it's killed) —
    // persist the freshest snapshot for the SW's background checks
    sendTasksToSW('TASKS_SNAPSHOT');
  }
});


// ── Pull to refresh — triggers full page reload ───────────────────────
(function(){
  const indicator=document.createElement('div');
  indicator.id='ptr-indicator';
  indicator.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%) translateY(-48px);background:var(--bg-card);border:1px solid var(--border-color);border-radius:0 0 20px 20px;padding:6px 20px;font-size:12px;font-weight:700;color:var(--text-muted);z-index:9999;transition:transform 0.2s;white-space:nowrap;pointer-events:none';
  indicator.innerText='Pull to reload';
  document.body.appendChild(indicator);
  let startY=0,pulling=false,activeContent=null;
  function attachPTR(content){
    content.addEventListener('touchstart',e=>{
      startY=content.scrollTop===0?e.touches[0].clientY:0;
      if(startY)activeContent=content;
    },{passive:true});
    content.addEventListener('touchmove',e=>{
      if(!startY||activeContent!==content)return;
      const dy=e.touches[0].clientY-startY;
      if(dy>10){
        pulling=true;
        const prog=Math.min(dy,80);
        indicator.style.transform='translateX(-50%) translateY('+(prog-48)+'px)';
        indicator.innerText=dy>60?'Release to reload':'Pull to reload';
      }
    },{passive:true});
    content.addEventListener('touchend',e=>{
      if(!pulling||activeContent!==content){startY=0;return;}
      const dy=e.changedTouches[0].clientY-startY;
      indicator.style.transform='translateX(-50%) translateY(-48px)';
      if(dy>60){
        indicator.innerText='Reloading…';
        indicator.style.transform='translateX(-50%) translateY(4px)';
        setTimeout(hardReload,300);
      }
      pulling=false;startY=0;activeContent=null;
    },{passive:true});
  }
  document.querySelectorAll('.content').forEach(attachPTR);
})();

(function(){
  let _ringTimer=null;
  const ring=document.getElementById('daily-ring');
  if(!ring)return;
  function showRingTooltip(){
    const now=new Date();now.setHours(0,0,0,0);
    const tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);
    // Count items (tasks + steps) due today or overdue, completed today
    let total=0,doneTodayCount=0,overdue=0,dueTodayCount=0;
    function ttCompletedToday(ts){
      if(!ts)return false;
      const d=new Date(ts);d.setHours(0,0,0,0);
      return d.getTime()===now.getTime();
    }
    tasks.forEach(function(t){
      const steps=t.steps||[];
      const taskDate=ringDueDate(t);
      if(taskDate&&taskDate<tomorrow){
        const doneToday=t.status==='done'&&ttCompletedToday(t.updatedAt);
        const incomplete=t.status!=='done';
        if(incomplete||doneToday){
          total++;
          if(doneToday)doneTodayCount++;
          else if(taskDate<now)overdue++; else dueTodayCount++;
        }
      }
      steps.forEach(function(s){
        if(!s.dueDate||!s.dueDate.trim())return;
        const sd=parseLocalDate(s.dueDate);
        if(!sd||sd>=tomorrow)return;
        const doneToday=s.status==='completed'&&ttCompletedToday(s.completedAt);
        const incomplete=s.status!=='completed';
        if(incomplete||doneToday){
          total++;
          if(doneToday)doneTodayCount++;
          else if(sd<now)overdue++; else dueTodayCount++;
        }
      });
    });
    const tip=document.getElementById('ring-tooltip');
    if(!tip)return;
    tip.innerHTML='<div style="margin-bottom:6px;font-size:12px;font-weight:800;color:var(--text-main)">Today&#39;s Progress</div>'
      +'<div style="display:flex;flex-direction:column;gap:4px">'
      +'<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:var(--green)">&#10003; Done today</span><span>'+doneTodayCount+'/'+total+'</span></div>'
      +(dueTodayCount?'<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:var(--p-med)">&#9679; Due today</span><span>'+dueTodayCount+'</span></div>':'')
      +(overdue?'<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:var(--red)">&#9888; Overdue</span><span>'+overdue+'</span></div>':'')
      +'</div>';
    tip.style.display='block';
    setTimeout(()=>tip.style.display='none',3000);
  }
  ring.addEventListener('click',function(e){e.stopPropagation();showRingTooltip();},{passive:true});
  document.addEventListener('click',e=>{
    const tip=document.getElementById('ring-tooltip');
    if(tip&&!ring.contains(e.target))tip.style.display='none';
  });
})();

window.addEventListener('online',()=>{const b=document.getElementById('offline-banner');if(b)b.style.display='none'});
window.addEventListener('offline',()=>{const b=document.getElementById('offline-banner');if(b)b.style.display='block'});
if(!navigator.onLine){const b=document.getElementById('offline-banner');if(b)b.style.display='block'}



// ── PWA: service worker ──────────────────────────────────────────────
if('serviceWorker' in navigator){
  // Listen for notifications fired by the SW (background/PBS notifications)
  // so they appear in the in-app notification log even when fired outside the page
  navigator.serviceWorker.addEventListener('message', function(e){
    if(e.data && e.data.type === 'NOTIF_FIRED'){
      logNotif(e.data.title, e.data.body, e.data.taskId || null);
    }
    // SW asking for the live task list (periodicsync with a page open)
    if(e.data && e.data.type === 'GET_TASKS' && e.ports && e.ports[0]){
      e.ports[0].postMessage(tasks);
    }
  });
  navigator.serviceWorker.register('./sw.js')
    .then(reg => console.log('SW registered, scope:', reg.scope))
    .catch(e => console.log('SW registration failed:', e));
}

// ── PWA: install prompt ──────────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btn-install');
  if(btn) btn.style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('btn-install');
  if(btn) btn.style.display = 'none';
  showToast('App installed successfully!');
});
function installApp(){
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(r => {
      if(r.outcome === 'accepted') showToast('Installing…');
      deferredInstallPrompt = null;
    });
  }
}

