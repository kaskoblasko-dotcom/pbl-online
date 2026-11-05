// PBL Online server: usernames, top-100 leaderboard, room codes, relay for Co-op / Fight rooms.
const express=require('express'),http=require('http'),{WebSocketServer}=require('ws'),fs=require('fs'),crypto=require('crypto');
const app=express(),srv=http.createServer(app),wss=new WebSocketServer({server:srv,maxPayload:50e6});
const DB=process.env.DATA_FILE||__dirname+'/data.json';let users={};
try{users=JSON.parse(fs.readFileSync(DB,'utf8'))}catch(e){}
const save=()=>{try{fs.writeFileSync(DB,JSON.stringify(users))}catch(e){}};setInterval(save,30000);
const pub=u=>({r:u.r,w:u.w,l:u.l});
const top=()=>Object.values(users).sort((a,b)=>b.r-a.r||b.w-a.w).slice(0,100).map(u=>({n:u.d,r:u.r,w:u.w,l:u.l}));
app.use((q,s,n)=>{s.set('Access-Control-Allow-Origin','*');n()});
app.use(express.static(__dirname+'/public'));
app.get('/api/leaderboard',(q,s)=>s.json(top()));
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
 else{u=users[k]={d:n,r:1000,w:0,l:0,tok:crypto.randomBytes(12).toString('hex')};save()}
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
   a.u.r=Math.round(a.u.r+K*(1-ea));b.u.r=Math.max(0,Math.round(b.u.r-K*(1-ea)));a.u.w++;b.u.l++;save();
   snd(a,{t:'u',u:pub(a.u)});snd(b,{t:'u',u:pub(b.u)});cast(r)}
 })});
setInterval(()=>wss.clients.forEach(c=>{if(!c.alive)return c.terminate();c.alive=false;c.ping()}),25000);
srv.listen(process.env.PORT||3000,()=>console.log('PBL online on',process.env.PORT||3000));
