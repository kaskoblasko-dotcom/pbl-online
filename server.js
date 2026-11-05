// PBL Online server: usernames, top-100 leaderboard, room codes, relay for Co-op / Fight rooms.
// Persistence: Postgres when DATABASE_URL is set (e.g. Neon); otherwise local data.json / saves.json files.
// Accounts also own 3 cloud save slots (franchise saves), served over a small REST API.
const express=require('express'),http=require('http'),{WebSocketServer}=require('ws'),fs=require('fs'),crypto=require('crypto');
const {Pool}=require('pg');
const app=express(),srv=http.createServer(app),wss=new WebSocketServer({server:srv,maxPayload:50e6});

// ---------- storage ----------
const FILE=process.env.DATA_FILE||__dirname+'/data.json';
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:3}):null;
if(pool)pool.on('error',e=>console.error('pg pool error',e.message));
let users={};
const dirty=new Set();
let flushing=false;

async function loadUsers(){
 if(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS users(
   k TEXT PRIMARY KEY, d TEXT NOT NULL, r INTEGER NOT NULL DEFAULT 1000,
   w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0, tok TEXT NOT NULL)`);
  const res=await pool.query('SELECT k,d,r,w,l,tok FROM users');
  res.rows.forEach(x=>users[x.k]={d:x.d,r:x.r,w:x.w,l:x.l,tok:x.tok});
  console.log('DB ready,',res.rows.length,'users loaded');
 }else{
  try{users=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){}
  console.log('No DATABASE_URL: using',FILE,'(not persistent on Render free)');
 }
}
const markDirty=u=>{dirty.add(u.d.toLowerCase())};
async function flush(){
 if(flushing||!dirty.size)return;
 flushing=true;
 const keys=[...dirty];dirty.clear();
 try{
  if(pool){
   for(const k of keys){const u=users[k];if(!u)continue;
    await pool.query(
     `INSERT INTO users(k,d,r,w,l,tok) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(k) DO UPDATE SET d=EXCLUDED.d,r=EXCLUDED.r,w=EXCLUDED.w,l=EXCLUDED.l,tok=EXCLUDED.tok`,
     [k,u.d,u.r,u.w,u.l,u.tok]);}
  }else fs.writeFileSync(FILE,JSON.stringify(users));
 }catch(e){console.error('save failed',e.message);keys.forEach(k=>dirty.add(k))}
 flushing=false;
}
setInterval(flush,5000);
const shutdown=async()=>{await flush();flushSavesFile();process.exit(0)};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);

// ---------- http ----------
const pub=u=>({r:u.r,w:u.w,l:u.l});
const top=()=>Object.values(users).sort((a,b)=>b.r-a.r||b.w-a.w).slice(0,100).map(u=>({n:u.d,r:u.r,w:u.w,l:u.l}));
app.use((q,s,n)=>{s.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,X-User,X-Token','Access-Control-Allow-Methods':'GET,PUT,DELETE,OPTIONS'});n()});
app.options('/api/*',(q,s)=>s.sendStatus(204));
// ---------- installable app (PWA) ----------
app.get('/manifest.webmanifest',(q,s)=>s.type('application/manifest+json').send(JSON.stringify({name:'Pixel Basketball League',short_name:'PBL',start_url:'/',display:'standalone',background_color:'#0b0e17',theme_color:'#0b0e17',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]})));
app.get('/icon.svg',(q,s)=>s.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0b0e17"/><circle cx="256" cy="256" r="170" fill="#ffb81c"/><path d="M256 86v340M86 256h340M136 136c60 60 60 180 0 240M376 136c-60 60-60 180 0 240" stroke="#0b0e17" stroke-width="14" fill="none"/></svg>'));
app.get('/sw.js',(q,s)=>s.type('application/javascript').send("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window'}).then(l=>l.length?l[0].focus():self.clients.openWindow('/')))});"));
app.use(express.static(__dirname+'/public'));
app.get('/api/leaderboard',(q,s)=>s.json(top()));

// ---------- cloud saves: 3 slots per account ----------
const SAVES_FILE=process.env.SAVES_FILE||__dirname+'/saves.json';
let fsaves={},fsDirty=false;   // file mode only: {key:{slot:{ts,meta,data}}} (meta and data are JSON text)
function flushSavesFile(){if(pool||!fsDirty)return;fsDirty=false;try{fs.writeFileSync(SAVES_FILE,JSON.stringify(fsaves))}catch(e){fsDirty=true;console.error('saves file write failed',e.message)}}
setInterval(flushSavesFile,5000);
async function initSaves(){
 if(pool)await pool.query(`CREATE TABLE IF NOT EXISTS saves(
  k TEXT NOT NULL, slot INTEGER NOT NULL, ts BIGINT NOT NULL, meta TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(k,slot))`);
 else try{fsaves=JSON.parse(fs.readFileSync(SAVES_FILE,'utf8'))}catch(e){}
}
const sList=async k=>pool
 ?(await pool.query('SELECT slot,ts,meta FROM saves WHERE k=$1 ORDER BY slot',[k])).rows.map(r=>({slot:r.slot,ts:Number(r.ts),meta:JSON.parse(r.meta)}))
 :Object.entries(fsaves[k]||{}).map(([s,v])=>({slot:+s,ts:v.ts,meta:JSON.parse(v.meta)}));
const sGet=async(k,s)=>pool?(await pool.query('SELECT ts,meta,data FROM saves WHERE k=$1 AND slot=$2',[k,s])).rows[0]:(fsaves[k]||{})[s];
const sPut=async(k,s,ts,meta,data)=>{
 if(pool)await pool.query(`INSERT INTO saves(k,slot,ts,meta,data) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(k,slot) DO UPDATE SET ts=EXCLUDED.ts,meta=EXCLUDED.meta,data=EXCLUDED.data`,[k,s,ts,meta,data]);
 else{(fsaves[k]=fsaves[k]||{})[s]={ts,meta,data};fsDirty=true}};
const sDel=async(k,s)=>{
 if(pool)await pool.query(s?'DELETE FROM saves WHERE k=$1 AND slot=$2':'DELETE FROM saves WHERE k=$1',s?[k,s]:[k]);
 else{if(s)delete(fsaves[k]||{})[s];else delete fsaves[k];fsDirty=true}};

const wrap=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(e=>{console.error('api error',e.message);s.status(500).json({error:'server'})});
function authU(q,s,n){ // account = X-User name + X-Token (issued at sign-in)
 const k=String(q.get('x-user')||'').toLowerCase(),t=String(q.get('x-token')||''),u=Object.prototype.hasOwnProperty.call(users,k)?users[k]:null;
 const ok=u&&t.length===u.tok.length&&crypto.timingSafeEqual(Buffer.from(t),Buffer.from(u.tok));
 if(!ok)return s.status(401).json({error:'auth'});q.k=k;n()}
const slotOf=q=>{const n=Number(q.params.slot);return Number.isInteger(n)&&n>=1&&n<=6?n:0};
const lastPut={},jp=express.json({limit:'4mb'});
app.get('/api/saves',authU,wrap(async(q,s)=>s.json(await sList(q.k))));
app.get('/api/saves/:slot',authU,wrap(async(q,s)=>{
 const n=slotOf(q);if(!n)return s.status(400).json({error:'slot'});
 const r=await sGet(q.k,n);if(!r)return s.status(404).json({error:'empty'});
 s.type('json').send('{"ts":'+Number(r.ts)+',"meta":'+r.meta+',"data":'+r.data+'}')}));
app.put('/api/saves/:slot',authU,jp,wrap(async(q,s)=>{
 const n=slotOf(q);if(!n)return s.status(400).json({error:'slot'});
 const b=q.body;if(!b||typeof b.data!=='object'||!b.data||typeof b.meta!=='object'||!b.meta)return s.status(400).json({error:'body'});
 const now=Date.now();if(now-(lastPut[q.k]||0)<500)return s.status(429).json({error:'slow down'});lastPut[q.k]=now;
 let ach=b.meta.ach&&typeof b.meta.ach==='object'?b.meta.ach:{};if(JSON.stringify(ach).length>5000)ach={};
 const meta=JSON.stringify({team:String(b.meta.team||'').slice(0,60),season:Number(b.meta.season)||0,rec:String(b.meta.rec||'').slice(0,20),ach});
 await sPut(q.k,n,now,meta,JSON.stringify(b.data));s.json({ts:now})}));
app.delete('/api/saves/:slot',authU,wrap(async(q,s)=>{const n=slotOf(q);if(!n)return s.status(400).json({error:'slot'});await sDel(q.k,n);s.json({ok:1})}));
app.delete('/api/saves',authU,wrap(async(q,s)=>{await sDel(q.k,0);s.json({ok:1})}));
app.use((e,q,s,n)=>s.status(e.status||500).json({error:e.type||'error'}));

// ---------- rooms ----------
const rooms={},snd=(ws,m)=>{if(ws.readyState===1)ws.send(JSON.stringify(m))};
const mkCode=()=>{let c;do{c=Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('')}while(rooms[c]);return c};
const info=r=>({t:'room',code:r.code,mode:r.mode,host:r.host.u.d,members:r.mem.map(c=>({name:c.u.d,r:c.u.r}))});
const cast=r=>r.mem.forEach(c=>snd(c,info(r)));
function leave(ws){const r=ws.room;if(!r)return;ws.room=null;r.mem=r.mem.filter(c=>c!==ws);
 if(ws===r.host){r.mem.forEach(c=>{c.room=null;snd(c,{t:'closed'})});delete rooms[r.code]}else cast(r)}
function login(ws,m){const n=String(m.name||'').trim();
 if(!/^[A-Za-z0-9_]{3,16}$/.test(n))return snd(ws,{t:'err',m:'Username: 3-16 letters, numbers or _'});
 const k=n.toLowerCase();let u=users[k];
 if(u){if(u.tok!==m.tok)return snd(ws,{t:'err',m:'That username is taken'})}
 else{u=users[k]={d:n,r:1000,w:0,l:0,tok:crypto.randomBytes(12).toString('hex')};markDirty(u);flush()}
 wss.clients.forEach(c=>{if(c!==ws&&c.k===k){leave(c);c.close()}});
 ws.k=k;ws.u=u;snd(ws,{t:'logged',name:u.d,tok:u.tok,u:pub(u)})}
wss.on('connection',ws=>{ws.alive=true;ws.on('pong',()=>ws.alive=true);ws.n=0;
 const tk=setInterval(()=>ws.n=0,1000);
 ws.on('close',()=>{clearInterval(tk);leave(ws)});
 ws.on('message',raw=>{if(++ws.n>60)return;let m;try{m=JSON.parse(raw)}catch(e){return}
  if(!m||typeof m.t!=='string')return;if(m.t==='login')return login(ws,m);
  if(!ws.u)return snd(ws,{t:'err',m:'Sign in first'});const r=ws.room;
  if(m.t==='create'){if(m.mode!=='coop'&&m.mode!=='fight')return;leave(ws);
   const room={code:mkCode(),mode:m.mode,host:ws,mem:[ws],hist:{}};rooms[room.code]=room;ws.room=room;cast(room)}
  else if(m.t==='join'){const room=rooms[String(m.code||'').toUpperCase()];
   if(!room)return snd(ws,{t:'err',m:'Room not found'});if(room===r)return;
   if(room.mem.length>=(room.mode==='coop'?4:8))return snd(ws,{t:'err',m:'Room is full'});
   leave(ws);room.mem.push(ws);ws.room=room;cast(room)}
  else if(m.t==='leave')leave(ws);
  else if(!r)return;
  else if(m.t==='host'){if(ws!==r.host)snd(r.host,{t:'rel',from:ws.u.d,d:m.d})}
  else if(m.t==='all'){if(ws===r.host)r.mem.forEach(c=>{if(c!==ws)snd(c,{t:'rel',from:ws.u.d,d:m.d})})}
  else if(m.t==='one'){if(ws===r.host){const c=r.mem.find(c=>c.u.d===m.to);if(c)snd(c,{t:'rel',from:ws.u.d,d:m.d})}}
  else if(m.t==='result'){// only the host of a Fight room can report; both must be members
   if(ws!==r.host||r.mode!=='fight')return;const a=r.mem.find(c=>c.u.d===m.w),b=r.mem.find(c=>c.u.d===m.l);
   if(!a||!b||a===b)return;const key=[a.k,b.k].sort().join('|'),now=Date.now();
   if(now-(r.hist[key]||0)<8000)return;r.hist[key]=now;
   const ea=1/(1+Math.pow(10,(b.u.r-a.u.r)/400)),K=32;
   a.u.r=Math.round(a.u.r+K*(1-ea));b.u.r=Math.max(0,Math.round(b.u.r-K*(1-ea)));a.u.w++;b.u.l++;
   markDirty(a.u);markDirty(b.u);flush();
   snd(a,{t:'u',u:pub(a.u)});snd(b,{t:'u',u:pub(b.u)});cast(r)}
 })});
setInterval(()=>wss.clients.forEach(c=>{if(!c.alive)return c.terminate();c.alive=false;c.ping()}),25000);

// ---------- start ----------
loadUsers().then(initSaves).then(()=>{
 srv.listen(process.env.PORT||3000,()=>console.log('PBL online on',process.env.PORT||3000));
}).catch(e=>{console.error('Startup failed:',e.message);process.exit(1)});
