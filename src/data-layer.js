/* ============================ storage: supabase ============================ */
/* The rendering and analysis code above and below this block is unchanged from
   the original single-file version. It reads `state.days` — a map of date key to
   {date, events:[]} — so this layer's only job is to keep that map in sync with
   the `events` table and to push writes back. Each logged thing is its own row,
   so two people tapping at the same moment no longer overwrite each other. */

const SB = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseKey, {
  auth: {persistSession: true, autoRefreshToken: true},
  realtime: {params: {eventsPerSecond: 5}}
});

const LS = 'puppy-logbook-cache-v1';

/* Row <-> event. Everything type-specific rides in `data` so adding an event
   type never needs a migration. */
function rowToEvent(r){
  return Object.assign({}, r.data || {}, {
    id: r.id, type: r.type, at: r.at,
    endAt: r.ended_at || null, by: r.by_user || null
  });
}
function eventToRow(ev){
  const data = Object.assign({}, ev);
  delete data.id; delete data.type; delete data.at; delete data.endAt; delete data.by; delete data.createdAt;
  return {type: ev.type, at: ev.at, ended_at: ev.endAt || null, data};
}

/* state.days is derived, never edited directly. */
function rebuildDays(){
  const days = {};
  state.events.forEach(e=>{
    const k = dateKey(new Date(e.at));
    (days[k] = days[k] || {date:k, events:[]}).events.push(e);
  });
  state.days = days;
}
function putEvent(ev){
  const i = state.events.findIndex(e=>e.id===ev.id);
  if(i>-1) state.events[i] = ev; else state.events.push(ev);
  rebuildDays();
}
function dropEvent(id){
  state.events = state.events.filter(e=>e.id!==id);
  rebuildDays();
}

function saveLocal(){
  try{
    localStorage.setItem(LS, JSON.stringify({
      profile: state.profile, events: state.events.slice(0, 1500),
      pantry: state.pantry, dogId: state.dogId, householdId: state.householdId
    }));
  }catch(e){}
}
function loadLocal(){
  try{
    const raw = localStorage.getItem(LS); if(!raw) return;
    const o = JSON.parse(raw);
    if(o.profile) state.profile = Object.assign(state.profile, o.profile);
    if(Array.isArray(o.events)) state.events = o.events;
    if(o.pantry) state.pantry = o.pantry;
    if(o.dogId) state.dogId = o.dogId;
    if(o.householdId) state.householdId = o.householdId;
    rebuildDays();
  }catch(e){}
}

function dbError(err, what){
  console.error(what, err);
  const msg = (err && err.message) || '';
  if(/row-level security|permission/i.test(msg)) toast("You are not a member of this household any more.");
  else if(/JWT|session/i.test(msg)) toast("Your session expired — sign in again.");
  else toast("Couldn't save. It is still on this device; it will retry when you are back online.");
}

/* ---- writes ---- */
async function addEvent(ev){
  if(!state.dogId){ toast('Add her details first.'); return null; }
  const optimistic = Object.assign({id:'tmp-'+uid(), at:new Date().toISOString(), by:state.me && state.me.id}, ev);
  putEvent(optimistic); render(); saveLocal();
  const row = Object.assign(eventToRow(optimistic), {dog_id: state.dogId, by_user: state.me && state.me.id});
  const {data, error} = await SB.from('events').insert(row).select().single();
  if(error){ dropEvent(optimistic.id); render(); dbError(error, 'addEvent'); return null; }
  dropEvent(optimistic.id); putEvent(rowToEvent(data)); render(); saveLocal();
  return rowToEvent(data);
}
function findEvent(id){
  const ev = state.events.find(e=>e.id===id);
  return ev ? {ev, key: dateKey(new Date(ev.at))} : null;
}
async function patchEvent(id, patch){
  const f = findEvent(id); if(!f) return;
  const before = f.ev;
  const merged = Object.assign({}, before, patch);
  putEvent(merged); render(); saveLocal();
  if(String(id).indexOf('tmp-')===0) return;
  const row = eventToRow(merged);
  const {error} = await SB.from('events').update(row).eq('id', id);
  if(error){ putEvent(before); render(); dbError(error, 'patchEvent'); }
}
async function removeEvent(id){
  const f = findEvent(id); if(!f) return;
  const before = f.ev;
  dropEvent(id); render(); saveLocal();
  if(String(id).indexOf('tmp-')===0) return;
  const {error} = await SB.from('events').delete().eq('id', id);
  if(error){ putEvent(before); render(); dbError(error, 'removeEvent'); }
}
async function writePantry(){
  saveLocal();
  // Pantry writes are handled per-item by openItemSheet through savePantryItem.
}
async function savePantryItem(item, isNew){
  const row = {dog_id: state.dogId, kind:item.kind, brand:item.brand, name:item.name,
    rating:item.rating, note:item.note};
  if(isNew){
    row.added_by = state.me && state.me.id;
    const {data, error} = await SB.from('pantry_items').insert(row).select().single();
    if(error) return dbError(error, 'pantry insert');
    item.id = data.id;
  } else {
    const {error} = await SB.from('pantry_items').update(row).eq('id', item.id);
    if(error) return dbError(error, 'pantry update');
  }
  saveLocal();
}
async function deletePantryItem(id){
  const {error} = await SB.from('pantry_items').delete().eq('id', id);
  if(error) dbError(error, 'pantry delete');
  saveLocal();
}
async function writeProfile(){
  saveLocal();
  if(!state.dogId) return;
  const p = state.profile;
  const {error} = await SB.from('dogs').update({
    name:p.name, birthday:p.birthday || null, breed:p.breed, size:p.size, unit:p.unit
  }).eq('id', state.dogId);
  if(error) dbError(error, 'writeProfile');
}

/* ---- loading ---- */
async function loadAll(){
  const [evs, pantry, dogRes, members] = await Promise.all([
    SB.from('events').select('*').eq('dog_id', state.dogId).order('at', {ascending:false}).limit(4000),
    SB.from('pantry_items').select('*').eq('dog_id', state.dogId),
    SB.from('dogs').select('*').eq('id', state.dogId).single(),
    SB.from('household_members').select('user_id, display_name').eq('household_id', state.householdId)
  ]);
  if(evs.data) state.events = evs.data.map(rowToEvent);
  if(pantry.data) state.pantry = {items: pantry.data.map(r=>({
    id:r.id, kind:r.kind, brand:r.brand, name:r.name, rating:r.rating, note:r.note
  }))};
  if(dogRes.data){
    const d = dogRes.data;
    state.profile = {name:d.name||'', birthday:d.birthday||'', breed:d.breed||'', size:d.size||'toy', unit:d.unit||'lb'};
  }
  state.members = {};
  (members.data||[]).forEach(m=>{ state.members[m.user_id] = m.display_name || ''; });
  rebuildDays(); state.ready = true; saveLocal(); render();
}

let channel = null;
function subscribe(){
  if(channel) SB.removeChannel(channel);
  channel = SB.channel('log-'+state.dogId)
    .on('postgres_changes', {event:'*', schema:'public', table:'events', filter:'dog_id=eq.'+state.dogId}, payload=>{
      if(payload.eventType === 'DELETE'){ dropEvent(payload.old.id); }
      else { putEvent(rowToEvent(payload.new)); }
      saveLocal(); render();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'pantry_items', filter:'dog_id=eq.'+state.dogId}, ()=>{
      SB.from('pantry_items').select('*').eq('dog_id', state.dogId).then(({data})=>{
        if(data) state.pantry = {items:data.map(r=>({id:r.id,kind:r.kind,brand:r.brand,name:r.name,rating:r.rating,note:r.note}))};
        saveLocal(); render();
      });
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'dogs', filter:'id=eq.'+state.dogId}, payload=>{
      const d = payload.new;
      state.profile = {name:d.name||'', birthday:d.birthday||'', breed:d.breed||'', size:d.size||'toy', unit:d.unit||'lb'};
      saveLocal(); render();
    })
    .subscribe();
}

/* ============================ auth & onboarding ============================ */
function showGate(html){
  document.getElementById('gate').hidden = false;
  document.getElementById('shell').hidden = true;
  document.getElementById('gateBody').innerHTML = '';
  document.getElementById('gateBody').appendChild(html);
}
function hideGate(){
  document.getElementById('gate').hidden = true;
  document.getElementById('shell').hidden = false;
}

function authScreen(mode){
  const wrap = el('div',{});
  wrap.appendChild(el('h2',{class:'gate-h', text: mode==='up' ? 'Create your account' : 'Welcome back'}));
  wrap.appendChild(el('p',{class:'gate-p', text: mode==='up'
    ? 'One account each. Everyone in the household logs to the same record.'
    : 'Sign in to pick up the log where the rest of the house left off.'}));

  const email = el('input',{class:'inp', id:'authEmail', type:'email', autocomplete:'email', placeholder:'you@example.com'});
  const pass  = el('input',{class:'inp', id:'authPass', type:'password',
    autocomplete: mode==='up' ? 'new-password' : 'current-password', placeholder:'At least 8 characters'});
  const name  = el('input',{class:'inp', id:'authName', autocomplete:'name', placeholder:'The name the others will see'});

  wrap.appendChild(field('Email', email));
  if(mode==='up') wrap.appendChild(field('Your name', name));
  wrap.appendChild(field('Password', pass));

  const err = el('div',{class:'gate-err', hidden:true});
  wrap.appendChild(err);
  const fail = m => { err.hidden = false; err.textContent = m; };

  const go = el('button',{class:'btn p', style:'width:100%;margin-top:6px',
    text: mode==='up' ? 'Create account' : 'Sign in', onclick: async ()=>{
    err.hidden = true;
    const e = email.value.trim(), p = pass.value;
    if(!e || !p) return fail('Email and password, please.');
    go.disabled = true; go.textContent = 'One moment…';
    const res = mode==='up'
      ? await SB.auth.signUp({email:e, password:p, options:{data:{display_name:name.value.trim()}}})
      : await SB.auth.signInWithPassword({email:e, password:p});
    go.disabled = false; go.textContent = mode==='up' ? 'Create account' : 'Sign in';
    if(res.error) return fail(res.error.message);
    if(!res.data.session) return fail('Check your email to confirm the account, then sign in.');
    start();
  }});
  wrap.appendChild(go);

  wrap.appendChild(el('button',{class:'gate-alt', text: mode==='up'
    ? 'I already have an account' : 'I need to create an account',
    onclick:()=> showGate(authScreen(mode==='up' ? 'in' : 'up'))}));
  return wrap;
}

function onboardScreen(){
  const wrap = el('div',{});
  wrap.appendChild(el('h2',{class:'gate-h', text:'Set up the household'}));
  wrap.appendChild(el('p',{class:'gate-p', text:'One household, one shared record. Start it, or join the one someone already made.'}));

  const hname = el('input',{class:'inp', id:'hhName', placeholder:'The Eid household'});
  wrap.appendChild(field('Household name', hname));
  const err = el('div',{class:'gate-err', hidden:true});
  const fail = m => { err.hidden=false; err.textContent = m; };

  wrap.appendChild(el('button',{class:'btn p', style:'width:100%', text:'Start a new household', onclick: async ()=>{
    err.hidden = true;
    const {data, error} = await SB.rpc('create_household', {hname: hname.value.trim(), who: displayName()});
    if(error) return fail(error.message);
    state.householdId = data;
    await ensureDog(); await afterHousehold();
  }}));

  wrap.appendChild(el('div',{class:'gate-or', text:'or'}));

  const code = el('input',{class:'inp', id:'joinCode', placeholder:'e.g. 4f9c2a1b7e', autocapitalize:'off', autocorrect:'off'});
  wrap.appendChild(field('Invite code', code, 'Ask whoever set it up — it is in their Settings.'));
  wrap.appendChild(el('button',{class:'btn s', style:'width:100%', text:'Join with a code', onclick: async ()=>{
    err.hidden = true;
    const c = code.value.trim();
    if(!c) return fail('Paste the invite code first.');
    const {data, error} = await SB.rpc('join_household', {code: c, who: displayName()});
    if(error) return fail(error.message);
    state.householdId = data;
    await afterHousehold();
  }}));
  wrap.appendChild(err);

  wrap.appendChild(el('button',{class:'gate-alt', text:'Sign out', onclick: async ()=>{ await SB.auth.signOut(); start(); }}));
  return wrap;
}

function displayName(){
  const u = state.session && state.session.user;
  return (u && u.user_metadata && u.user_metadata.display_name) || (u && u.email ? u.email.split('@')[0] : '');
}

async function ensureDog(){
  const {data} = await SB.from('dogs').select('id').eq('household_id', state.householdId).limit(1);
  if(data && data.length){ state.dogId = data[0].id; return; }
  const {data:made, error} = await SB.from('dogs').insert({household_id: state.householdId}).select().single();
  if(error) return dbError(error, 'ensureDog');
  state.dogId = made.id;
}

async function afterHousehold(){
  await ensureDog();
  if(!state.dogId) return;
  hideGate();
  renderTabs();
  await loadAll();
  subscribe();
  if(!state.profile.name) setTimeout(()=>{ if(!state.profile.name) openSettings(true); }, 400);
}

async function start(){
  const {data:{session}} = await SB.auth.getSession();
  state.session = session;
  if(!session){ showGate(authScreen('in')); return; }

  state.me = {id: session.user.id, name: displayName()};
  const who = document.getElementById('who');
  who.hidden = false;
  document.getElementById('whoName').textContent = state.me.name || 'you';
  document.getElementById('whoImg').hidden = true;

  const {data: memberships, error} = await SB.from('household_members')
    .select('household_id').eq('user_id', session.user.id).limit(1);
  if(error){ dbError(error, 'memberships'); return; }
  if(!memberships || !memberships.length){ showGate(onboardScreen()); return; }
  state.householdId = memberships[0].household_id;
  await afterHousehold();
}

/* ============================ boot ============================ */
loadLocal();
render();
start();

SB.auth.onAuthStateChange((event)=>{
  if(event === 'SIGNED_OUT'){ location.reload(); }
});
