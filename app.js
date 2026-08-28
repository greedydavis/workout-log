'use strict';
import { configured, getSupabase } from './supabaseClient.js';

/* ---------- 常數 ---------- */
const WD = ['日','一','二','三','四','五','六'];
const CATS = [
  { id:'push', label:'推', color:'#e0664a' },
  { id:'pull', label:'拉', color:'#3f8ff2' },
  { id:'legs', label:'腿', color:'#3ecf8e' },
  { id:'core', label:'核心', color:'#c98be0' },
  { id:'other', label:'其他', color:'#8a949e' },
];
const BODY_METRICS = [{ id:'weight', label:'體重' }, { id:'body_fat', label:'體脂率' }, { id:'muscle_mass', label:'骨骼肌' }];
const EX_METRICS = [{ id:'e1rm', label:'估算1RM' }, { id:'weight', label:'重量' }, { id:'reps', label:'次數' }];
const CACHE_KEY = 'trainlog.cache.v2';
const QUEUE_KEY = 'trainlog.queue.v1';

function catLabel(id){ return (CATS.find(c => c.id === id) || CATS[4]).label; }
function catColor(id){ return (CATS.find(c => c.id === id) || CATS[4]).color; }

/* ---------- 狀態 ---------- */
let supabase = null;
let session = null;
let authMode = 'signin';

function emptyState(){ return { exercises:[], sets:[], bodyMetrics:[], foodLogs:[], pinned:new Set() }; }
let state = emptyState();

let pendingOps = [];
let flushing = false;

let cur = iso(new Date());
let weekAnchor = cur;
let view = 'log';
let editing = null;
let catFilterLog = 'all';
let catFilterEx = 'all';
let exDetail = null;
let exMetric = 'e1rm';
let bodyMetric = 'weight';

/* ---------- 日期工具 ---------- */
function iso(d){
  const t = new Date(d);
  return t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0') + '-' + String(t.getDate()).padStart(2,'0');
}
function parseISO(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function shiftDay(s, n){ const d = parseISO(s); d.setDate(d.getDate()+n); return iso(d); }
function mondayOf(s){ const d = parseISO(s); const off = (d.getDay()+6)%7; d.setDate(d.getDate()-off); return iso(d); }
function shortDate(k){ const d = parseISO(k); return (d.getMonth()+1) + '/' + d.getDate(); }
function shortDateFull(k){ const d = parseISO(k); return (d.getMonth()+1) + '/' + d.getDate() + ' (' + WD[d.getDay()] + ')'; }
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(n){ return Number.isInteger(n) ? String(n) : n.toFixed(1); }

/* ---------- 計算 ---------- */
const vol = sets => sets.reduce((a,s) => a + (s.w||0)*(s.r||0), 0);
const e1rmOf = (w,r) => (w||0) * (1 + (r||0)/30);
const bestE = sets => sets.reduce((a,s) => Math.max(a, e1rmOf(s.w,s.r)), 0);
function topSet(sets){ return sets.reduce((best,s) => e1rmOf(s.w,s.r) > e1rmOf(best.w,best.r) ? s : best, sets[0]); }
function metricValue(session_, metric){
  const t = topSet(session_.sets);
  if(metric === 'weight') return t.w;
  if(metric === 'reps') return t.r;
  return e1rmOf(t.w, t.r);
}
function setsText(sets){
  if(!sets.length) return '';
  const parts = []; let curW = null, reps = [];
  for(const s of sets){
    if(s.w === curW){ reps.push(s.r); }
    else{ if(curW !== null) parts.push(fmt(curW)+'×'+reps.join(',')); curW = s.w; reps = [s.r]; }
  }
  if(curW !== null) parts.push(fmt(curW)+'×'+reps.join(','));
  return parts.join('  ');
}
function setsTextRPE(sets){
  return sets.map(s => fmt(s.w) + '×' + s.r + (s.rpe!=null && s.rpe!=='' ? ' @' + fmt(s.rpe) : '')).join('  ·  ');
}
function cleanSets(sets){
  return sets
    .map(s => ({ w: parseFloat(s.w), r: parseInt(s.r,10), rpe: (s.rpe==='' || s.rpe==null) ? null : parseFloat(s.rpe) }))
    .filter(s => !isNaN(s.w) && !isNaN(s.r) && s.r > 0);
}

/* ---------- 本機快取 / 同步佇列 ---------- */
function persistCache(){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      exercises: state.exercises, sets: state.sets, bodyMetrics: state.bodyMetrics,
      foodLogs: state.foodLogs, pinned: [...state.pinned]
    }));
  }catch(e){ console.warn('本機快取儲存失敗', e); }
}
function loadCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if(!raw) return;
    const p = JSON.parse(raw);
    state.exercises = p.exercises || [];
    state.sets = p.sets || [];
    state.bodyMetrics = p.bodyMetrics || [];
    state.foodLogs = p.foodLogs || [];
    state.pinned = new Set(p.pinned || []);
  }catch(e){ console.warn('本機快取讀取失敗', e); }
}
function persistQueue(){ try{ localStorage.setItem(QUEUE_KEY, JSON.stringify(pendingOps)); }catch(e){} }
function loadQueue(){ try{ pendingOps = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }catch(e){ pendingOps = []; } }

async function pushOp(op){
  pendingOps.push(op);
  persistQueue();
  updateSyncDot();
  await flushQueue();
}
async function flushQueue(){
  if(flushing) return;
  flushing = true;
  try{
    if(!navigator.onLine || !session || !supabase) return;
    while(pendingOps.length){
      const op = pendingOps[0];
      try{ await runOp(op); pendingOps.shift(); persistQueue(); }
      catch(e){ console.warn('同步失敗，稍後重試', e); break; }
    }
  }finally{
    flushing = false;
    updateSyncDot();
  }
}
async function runOp(op){
  const uid = session.user.id;
  if(op.type === 'upsert'){
    const opts = op.onConflict ? { onConflict: op.onConflict } : undefined;
    // user_id 在這裡才補上，而不是在本機建立資料當下：
    // 這樣即使離線、還沒有 session 也能先本機記錄，之後登入時再一起補同步。
    const rows = op.rows.map(r => ({ ...r, user_id: uid }));
    const { error } = await supabase.from(op.table).upsert(rows, opts);
    if(error && error.code !== '23505') throw error;
  }else if(op.type === 'delete'){
    const { error } = await supabase.from(op.table).delete().in('id', op.ids);
    if(error) throw error;
  }else if(op.type === 'pin'){
    const { error } = await supabase.from('pinned_exercises').insert({ user_id: uid, exercise_id: op.exercise_id });
    if(error && error.code !== '23505') throw error;
  }else if(op.type === 'unpin'){
    const { error } = await supabase.from('pinned_exercises').delete().eq('user_id', uid).eq('exercise_id', op.exercise_id);
    if(error) throw error;
  }else if(op.type === 'wipeAll'){
    for(const t of ['body_metrics','food_logs','exercises']){
      const { error } = await supabase.from(t).delete().eq('user_id', uid);
      if(error) throw error;
    }
  }
}
function updateSyncDot(){
  const dot = document.getElementById('syncDot');
  if(!dot) return;
  if(!navigator.onLine){ dot.className = 'syncdot off'; dot.title = '離線'; }
  else if(pendingOps.length){ dot.className = 'syncdot pending'; dot.title = pendingOps.length + ' 筆待同步'; }
  else{ dot.className = 'syncdot'; dot.title = '已同步'; }
}
async function refreshFromCloud(){
  if(!navigator.onLine || !supabase || !session) return;
  try{
    const uid = session.user.id;
    const [ex, st, bm, fl, pin] = await Promise.all([
      supabase.from('exercises').select('*').eq('user_id', uid),
      supabase.from('sets').select('*').eq('user_id', uid),
      supabase.from('body_metrics').select('*').eq('user_id', uid),
      supabase.from('food_logs').select('*').eq('user_id', uid),
      supabase.from('pinned_exercises').select('exercise_id').eq('user_id', uid),
    ]);
    const err = ex.error || st.error || bm.error || fl.error || pin.error;
    if(err) throw err;
    state.exercises = ex.data;
    state.sets = st.data;
    state.bodyMetrics = bm.data;
    state.foodLogs = fl.data;
    state.pinned = new Set(pin.data.map(p => p.exercise_id));
    persistCache();
  }catch(e){ console.warn('雲端資料讀取失敗', e); }
}

/* ---------- 資料操作（本機先寫，背景同步） ---------- */
// 離線、還沒有 session 時本機也要能正常記錄；user_id 留空，真正送出時由 runOp() 補上目前登入者。
function uidOrNull(){ return session ? session.user.id : null; }
function exById(id){ return state.exercises.find(e => e.id === id) || null; }

function createExercise(name, category){
  const ex = { id: crypto.randomUUID(), user_id: uidOrNull(), name, category, created_at: new Date().toISOString() };
  state.exercises.push(ex);
  persistCache();
  pushOp({ type:'upsert', table:'exercises', rows:[ex] });
  return ex;
}
function saveSession(ex, date, sets, note){
  const oldIds = state.sets.filter(s => s.exercise_id === ex.id && s.date === date).map(s => s.id);
  state.sets = state.sets.filter(s => !(s.exercise_id === ex.id && s.date === date));
  const now = new Date().toISOString();
  const newRows = sets.map((s,i) => ({
    id: crypto.randomUUID(), user_id: uidOrNull(), exercise_id: ex.id, date,
    position:i, weight:s.w, reps:s.r, rpe:s.rpe, note, created_at:now, updated_at:now
  }));
  state.sets.push(...newRows);
  persistCache();
  if(oldIds.length) pushOp({ type:'delete', table:'sets', ids:oldIds });
  pushOp({ type:'upsert', table:'sets', rows:newRows });
}
function deleteSession(exId, date){
  const oldIds = state.sets.filter(s => s.exercise_id === exId && s.date === date).map(s => s.id);
  state.sets = state.sets.filter(s => !(s.exercise_id === exId && s.date === date));
  persistCache();
  if(oldIds.length) pushOp({ type:'delete', table:'sets', ids:oldIds });
}
function currentFoodRow(date){ return state.foodLogs.find(f => f.date === date) || null; }
function upsertFoodLog(date, text){
  let row = currentFoodRow(date);
  if(!text.trim()){
    if(row){ state.foodLogs = state.foodLogs.filter(f => f.id !== row.id); persistCache(); pushOp({ type:'delete', table:'food_logs', ids:[row.id] }); }
    return;
  }
  if(!row){ row = { id: crypto.randomUUID(), user_id: uidOrNull(), date, text:'' }; state.foodLogs.push(row); }
  row.text = text;
  persistCache();
  pushOp({ type:'upsert', table:'food_logs', rows:[row], onConflict:'user_id,date' });
}
function currentBodyRow(date){ return state.bodyMetrics.find(b => b.date === date) || null; }
function upsertBodyMetric(date, patch){
  let row = currentBodyRow(date);
  if(!row){
    row = { id: crypto.randomUUID(), user_id: uidOrNull(), date, weight:null, body_fat:null, muscle_mass:null };
    state.bodyMetrics.push(row);
  }
  Object.assign(row, patch);
  if(row.weight == null && row.body_fat == null && row.muscle_mass == null){
    state.bodyMetrics = state.bodyMetrics.filter(b => b.id !== row.id);
    persistCache();
    pushOp({ type:'delete', table:'body_metrics', ids:[row.id] });
    return;
  }
  persistCache();
  pushOp({ type:'upsert', table:'body_metrics', rows:[row], onConflict:'user_id,date' });
}
function togglePin(exId){
  if(state.pinned.has(exId)){ state.pinned.delete(exId); pushOp({ type:'unpin', exercise_id:exId }); }
  else{ state.pinned.add(exId); pushOp({ type:'pin', exercise_id:exId }); }
  persistCache();
}

/* 依動作彙整所有歷史：exId -> [{date,sets,note}] 由舊到新 */
function allSessionsIndex(){
  const byKey = new Map();
  state.sets.forEach(s => {
    const k = s.exercise_id + '|' + s.date;
    if(!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  });
  const m = new Map();
  for(const [k, rows] of byKey){
    const [exId, date] = k.split('|');
    rows.sort((a,b) => a.position - b.position);
    if(!m.has(exId)) m.set(exId, []);
    m.get(exId).push({ date, sets: rows.map(r => ({ w:r.weight, r:r.reps, rpe:r.rpe })), note: rows[0]?.note || '' });
  }
  for(const arr of m.values()) arr.sort((a,b) => a.date.localeCompare(b.date));
  return m;
}
function lastBefore(idx, exId, before){
  const arr = idx.get(exId);
  if(!arr) return null;
  for(let i = arr.length-1; i >= 0; i--) if(arr[i].date < before) return arr[i];
  return null;
}
function entriesForDate(date){
  const byEx = new Map();
  state.sets.filter(s => s.date === date).forEach(s => {
    if(!byEx.has(s.exercise_id)) byEx.set(s.exercise_id, []);
    byEx.get(s.exercise_id).push(s);
  });
  return [...byEx.entries()].map(([exId, rows]) => {
    rows.sort((a,b) => a.position - b.position);
    return { ex: exById(exId), sets: rows.map(r => ({ w:r.weight, r:r.reps, rpe:r.rpe })), note: rows[0]?.note || '' };
  }).filter(e => e.ex);
}

/* ---------- 畫面：記錄 ---------- */
function renderDate(){
  const d = parseISO(cur), today = iso(new Date());
  const rel = cur === today ? '今天' : (cur === shiftDay(today,-1) ? '昨天' : '');
  document.getElementById('dateLabel').innerHTML =
    (d.getMonth()+1) + '/' + d.getDate() + ' (' + WD[d.getDay()] + ')' +
    (rel ? '<small>' + rel + '</small>' : '<small>' + d.getFullYear() + '</small>');
  document.getElementById('todayBtn').hidden = (cur === today);
}
function renderCatChips(container, current, onPick){
  container.innerHTML = '';
  [{ id:'all', label:'全部' }, ...CATS].forEach(c => {
    const b = document.createElement('button');
    b.className = 'catchip' + (current === c.id ? ' on' : '');
    b.textContent = c.label;
    b.onclick = () => onPick(c.id);
    container.appendChild(b);
  });
}
function renderToggle(container, options, current, onPick){
  container.innerHTML = '';
  options.forEach(o => {
    const b = document.createElement('button');
    b.className = current === o.id ? 'on' : '';
    b.textContent = o.label;
    b.onclick = () => onPick(o.id);
    container.appendChild(b);
  });
}

function renderLog(){
  renderDate();
  updateSyncDot();
  const idx = allSessionsIndex();
  const entries = entriesForDate(cur);

  const list = document.getElementById('todayList');
  if(!entries.length){
    list.innerHTML = '<div class="empty">還沒有紀錄。從上面搜尋或點下面的動作開始。</div>';
  }else{
    list.innerHTML = '';
    entries.forEach(e => {
      const b = document.createElement('button');
      b.className = 'entry';
      b.innerHTML =
        '<span><span class="n">' + esc(e.ex.name) + '</span>' +
        '<div class="sets">' + esc(setsText(e.sets)) + '</div>' +
        (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') + '</span>' +
        '<span class="vol">' + Math.round(vol(e.sets)) + ' kg<br>' +
        '<span style="opacity:.75">1RM ' + Math.round(bestE(e.sets)) + '</span></span>';
      b.onclick = () => openSheet({ id:e.ex.id }, cur);
      list.appendChild(b);
    });
  }

  renderCatChips(document.getElementById('logCatChips'), catFilterLog, id => { catFilterLog = id; renderLog(); });

  const done = new Set(entries.map(e => e.ex.id));
  let recent = [...idx.entries()].map(([exId, sess]) => ({ ex: exById(exId), last: sess[sess.length-1] })).filter(r => r.ex);
  if(catFilterLog !== 'all') recent = recent.filter(r => r.ex.category === catFilterLog);
  recent = recent.sort((a,b) => b.last.date.localeCompare(a.last.date)).slice(0, 12);

  const grid = document.getElementById('recentGrid');
  if(!recent.length){
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">還沒有任何動作。在上面搜尋框輸入名稱就能新增。</div>';
  }else{
    grid.innerHTML = '';
    recent.forEach(r => {
      const isDone = done.has(r.ex.id);
      const todayEntry = isDone ? entries.find(e => e.ex.id === r.ex.id) : null;
      const prev = lastBefore(idx, r.ex.id, cur);
      const b = document.createElement('button');
      b.className = 'chip' + (isDone ? ' done' : '');
      const sub = todayEntry ? setsText(todayEntry.sets) : (prev ? '上次 ' + setsText(prev.sets) : '—');
      b.innerHTML = '<div class="n"><span class="catdot" style="background:' + catColor(r.ex.category) + '"></span>' + esc(r.ex.name) + '</div>' +
        '<div class="s">' + esc(sub) + '</div>';
      b.onclick = () => openSheet({ id:r.ex.id }, cur);
      grid.appendChild(b);
    });
  }

  const foodRow = currentFoodRow(cur);
  document.getElementById('food').value = foodRow ? foodRow.text : '';
  const bodyRow = currentBodyRow(cur);
  document.getElementById('bw').value = (bodyRow && bodyRow.weight != null) ? bodyRow.weight : '';
  document.getElementById('bf').value = (bodyRow && bodyRow.body_fat != null) ? bodyRow.body_fat : '';
  document.getElementById('mm').value = (bodyRow && bodyRow.muscle_mass != null) ? bodyRow.muscle_mass : '';
}

function renderSearch(){
  const q = document.getElementById('search').value.trim();
  const box = document.getElementById('results');
  if(!q){ box.className = ''; box.innerHTML = ''; return; }
  const idx = allSessionsIndex();
  const matches = state.exercises.filter(e => e.name.toLowerCase().includes(q.toLowerCase()));
  box.className = 'on'; box.innerHTML = '';
  matches.slice(0,8).forEach(ex => {
    const prev = lastBefore(idx, ex.id, cur);
    const b = document.createElement('button');
    b.className = 'result';
    b.innerHTML = '<span class="n"><span class="catdot" style="background:' + catColor(ex.category) + '"></span>' + esc(ex.name) + '</span><span class="s">' +
      (prev ? esc(setsText(prev.sets)) : '—') + '</span>';
    b.onclick = () => { clearSearch(); openSheet({ id:ex.id }, cur); };
    box.appendChild(b);
  });
  if(!matches.some(e => e.name === q)){
    const b = document.createElement('button');
    b.className = 'result new';
    b.innerHTML = '<span class="n">＋ 新增「' + esc(q) + '」</span>';
    b.onclick = () => { clearSearch(); openSheet({ name:q }, cur); };
    box.appendChild(b);
  }
}
function clearSearch(){
  const s = document.getElementById('search');
  s.value = ''; s.blur();
  document.getElementById('results').className = '';
  document.getElementById('results').innerHTML = '';
}

/* ---------- 輸入面板 ---------- */
function openSheet(target, date = cur){
  const ex = target.id ? exById(target.id) : null;
  const isNew = !ex;
  const name = ex ? ex.name : target.name;
  const idx = allSessionsIndex();
  const existing = ex ? (idx.get(ex.id) || []).find(s => s.date === date) : null;
  const prev = ex ? lastBefore(idx, ex.id, date) : null;

  let sets, note = '', hint;
  if(existing){
    sets = existing.sets.map(s => ({ w:s.w, r:s.r, rpe:s.rpe==null?'':s.rpe }));
    note = existing.note || '';
    hint = prev ? ('上次 ' + setsText(prev.sets) + ' · ' + shortDate(prev.date)) : (shortDateFull(date) + ' 已記錄');
  }else if(prev){
    sets = prev.sets.map(s => ({ w:s.w, r:s.r, rpe:'' }));
    hint = '已帶入 <b>' + shortDate(prev.date) + '</b> 的 ' + setsText(prev.sets) + '，改動後儲存';
  }else{
    sets = [{ w:'', r:'', rpe:'' }];
    hint = isNew ? '選擇部位並輸入第一組' : '第一次記這個動作';
  }

  editing = { exId: ex ? ex.id : null, name, category: ex ? ex.category : null, isNew, date, sets, note };
  document.getElementById('sheetName').textContent = name;
  document.getElementById('lastHint').innerHTML = hint;
  document.getElementById('noteInput').value = note;
  document.getElementById('deleteEntry').style.display = existing ? '' : 'none';

  const catPicker = document.getElementById('newCatPicker');
  catPicker.hidden = !isNew;
  if(isNew) document.querySelectorAll('#newCatRow button').forEach(b => b.classList.remove('on'));

  renderSetRows();
  document.getElementById('scrim').classList.add('on');
  document.getElementById('sheet').classList.add('on');
}
function closeSheet(){
  document.getElementById('scrim').classList.remove('on');
  document.getElementById('sheet').classList.remove('on');
  editing = null;
}
function initNewCatPicker(){
  const row = document.getElementById('newCatRow');
  row.innerHTML = '';
  CATS.forEach(c => {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.dataset.cat = c.id;
    b.onclick = () => {
      editing.category = c.id;
      row.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.cat === c.id));
    };
    row.appendChild(b);
  });
}
function renderSetRows(){
  const box = document.getElementById('setRows');
  box.innerHTML = '';
  editing.sets.forEach((s,i) => {
    const row = document.createElement('div');
    row.className = 'setrow';
    row.innerHTML =
      '<span class="idx">' + (i+1) + '</span>' +
      '<input type="number" inputmode="decimal" step="0.5" placeholder="重量" value="' + (s.w === '' ? '' : s.w) + '">' +
      '<input type="number" inputmode="numeric" step="1" placeholder="次數" value="' + (s.r === '' ? '' : s.r) + '">' +
      '<input class="rpe" type="number" inputmode="decimal" step="0.5" min="1" max="10" placeholder="RPE" value="' + (s.rpe==null||s.rpe==='' ? '' : s.rpe) + '">' +
      '<button class="del" aria-label="刪除這組">✕</button>';
    const [wi, ri, rpi] = row.querySelectorAll('input');
    wi.oninput = () => { s.w = wi.value === '' ? '' : parseFloat(wi.value); updateE1rm(); };
    ri.oninput = () => { s.r = ri.value === '' ? '' : parseInt(ri.value,10); updateE1rm(); };
    rpi.oninput = () => { s.rpe = rpi.value === '' ? '' : parseFloat(rpi.value); };
    row.querySelector('.del').onclick = () => {
      editing.sets.splice(i,1);
      if(!editing.sets.length) editing.sets.push({ w:'', r:'', rpe:'' });
      renderSetRows();
    };
    box.appendChild(row);
  });
  updateE1rm();
}
function updateE1rm(){
  const valid = cleanSets(editing.sets);
  const el = document.getElementById('e1rmHint');
  if(!valid.length){ el.textContent = ''; return; }
  el.textContent = '總量 ' + Math.round(vol(valid)) + ' kg · 估算 1RM ' + Math.round(bestE(valid)) + ' kg';
}
function onSaveEntry(){
  const sets = cleanSets(editing.sets);
  const note = document.getElementById('noteInput').value.trim();
  let exId = editing.exId;
  if(editing.isNew){
    if(!sets.length){ closeSheet(); return; }
    if(!editing.category){ alert('請選擇動作部位'); return; }
    exId = createExercise(editing.name, editing.category).id;
  }
  if(!sets.length) deleteSession(exId, editing.date);
  else saveSession(exById(exId), editing.date, sets, note);
  closeSheet();
  renderCurrentView();
}

/* ---------- 週檢視 ---------- */
function stat(v,k){ return '<div class="stat"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }
function renderWeek(){
  const mon = mondayOf(weekAnchor);
  const days = Array.from({length:7}, (_,i) => shiftDay(mon,i));
  const today = iso(new Date());
  const m0 = parseISO(days[0]), m6 = parseISO(days[6]);
  document.getElementById('weekLabel').innerHTML =
    (m0.getMonth()+1) + '/' + m0.getDate() + ' – ' + (m6.getMonth()+1) + '/' + m6.getDate() +
    '<small>' + (mon === mondayOf(today) ? '本週' : m0.getFullYear()) + '</small>';

  const grid = document.getElementById('weekGrid');
  grid.innerHTML = '';
  days.forEach(k => {
    const entries = entriesForDate(k);
    const v = entries.reduce((a,e) => a + vol(e.sets), 0);
    const food = currentFoodRow(k);
    const dt = parseISO(k);
    const b = document.createElement('button');
    b.className = 'daycell' + (v > 0 ? ' has' : '') + (k === today ? ' today' : '');
    b.innerHTML = '<div class="wd">' + WD[dt.getDay()] + '</div><div class="dd">' + dt.getDate() + '</div>' +
      '<div class="vv">' + (v > 0 ? Math.round(v/100)/10 + 't' : (food && food.text ? '🍚' : '')) + '</div>';
    b.onclick = () => { cur = k; switchView('log'); };
    grid.appendChild(b);
  });

  const sum = ks => {
    let d0 = 0, v0 = 0;
    ks.forEach(k => {
      const entries = entriesForDate(k);
      if(entries.length){ d0++; v0 += entries.reduce((a,e) => a + vol(e.sets), 0); }
    });
    return { days:d0, vol:v0 };
  };
  const thisW = sum(days);
  const prevW = sum(Array.from({length:7}, (_,i) => shiftDay(shiftDay(mon,-7), i)));
  const dv = prevW.vol ? Math.round((thisW.vol - prevW.vol) / prevW.vol * 100) : null;

  document.getElementById('weekStats').innerHTML =
    stat(thisW.days, '訓練天數') +
    stat(Math.round(thisW.vol/100)/10 + 't', '總訓練量') +
    stat(dv === null ? '—' : '<span class="delta ' + (dv >= 0 ? 'up' : 'down') + '">' + (dv >= 0 ? '+' : '') + dv + '%</span>', '對比上週');

  const agg = new Map();
  const catCounts = Object.fromEntries(CATS.map(c => [c.id, 0]));
  days.forEach(k => {
    entriesForDate(k).forEach(e => {
      if(!agg.has(e.ex.id)) agg.set(e.ex.id, { name:e.ex.name, sets:0, vol:0 });
      const a = agg.get(e.ex.id);
      a.sets += e.sets.length;
      a.vol += vol(e.sets);
      catCounts[e.ex.category] = (catCounts[e.ex.category] || 0) + e.sets.length;
    });
  });
  document.getElementById('weekCatCoverage').innerHTML = CATS.map(c => {
    const n = catCounts[c.id] || 0;
    const done = n > 0;
    return '<div class="covchip"' + (done ? ' style="border-color:' + c.color + '"' : '') + '>' +
      '<span class="dot" style="background:' + (done ? c.color : 'var(--line)') + '"></span>' +
      '<span class="lbl">' + c.label + '</span>' +
      '<span class="cnt">' + (done ? n + ' 組' : '未安排') + '</span></div>';
  }).join('');

  const wx = document.getElementById('weekExercises');
  if(!agg.size){
    wx.innerHTML = '<div class="empty">這週還沒有訓練紀錄。</div>';
  }else{
    wx.innerHTML = [...agg.values()].sort((a,b) => b.vol - a.vol)
      .map(a => '<div class="pin-row"><div><div>' + esc(a.name) + '</div>' +
        '<div class="meta">' + a.sets + ' 組</div></div>' +
        '<div class="meta">' + Math.round(a.vol) + ' kg</div></div>').join('');
  }
}

/* ---------- 動作庫 / 趨勢 ---------- */
function chart(points, color){
  if(points.length < 2) return '';
  const W = 320, H = 110, PL = 6, PR = 6, PT = 10, PB = 14;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = (maxY - minY) * 0.18 || Math.max(1, maxY * 0.05);
  const y0 = minY - pad, y1 = maxY + pad;
  const px = x => maxX === minX ? W/2 : PL + (x - minX) / (maxX - minX) * (W - PL - PR);
  const py = y => H - PB - (y - y0) / (y1 - y0) * (H - PT - PB);
  const line = points.map((p,i) => (i ? 'L' : 'M') + px(p.x).toFixed(1) + ' ' + py(p.y).toFixed(1)).join(' ');
  const area = line + ' L' + px(maxX).toFixed(1) + ' ' + (H - PB) + ' L' + px(minX).toFixed(1) + ' ' + (H - PB) + ' Z';
  const dots = points.map(p => '<circle cx="' + px(p.x).toFixed(1) + '" cy="' + py(p.y).toFixed(1) +
    '" r="2.6" fill="' + color + '"/>').join('');
  const uid = 'g' + Math.random().toString(36).slice(2,8);
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
    '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + color + '" stop-opacity=".22"/>' +
    '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + area + '" fill="url(#' + uid + ')"/>' +
    '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" ' +
    'stroke-linejoin="round" stroke-linecap="round"/>' + dots +
    '<text x="' + PL + '" y="' + (H-3) + '" font-size="9" fill="currentColor" opacity=".5">' +
    shortDate(points[0].k) + '</text>' +
    '<text x="' + (W-PR) + '" y="' + (H-3) + '" font-size="9" fill="currentColor" opacity=".5" text-anchor="end">' +
    shortDate(points[points.length-1].k) + '</text></svg>';
}
function getAccent(){ return getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#2f6fed'; }
function getGood(){ return getComputedStyle(document.body).getPropertyValue('--good').trim() || '#1f9d55'; }

function renderExercisesTab(){
  document.getElementById('exListPane').hidden = !!exDetail;
  document.getElementById('exDetailPane').hidden = !exDetail;
  if(exDetail) renderExDetail(); else renderExList();
}
function renderBodyChart(){
  renderToggle(document.getElementById('bodyMetricToggle'), BODY_METRICS, bodyMetric, id => { bodyMetric = id; renderBodyChart(); });
  const pts = state.bodyMetrics
    .filter(b => b[bodyMetric] != null && b[bodyMetric] !== '')
    .slice().sort((a,b) => a.date.localeCompare(b.date))
    .map(b => ({ x: parseISO(b.date).getTime(), y: parseFloat(b[bodyMetric]), k: b.date }));
  const box = document.getElementById('bodyChart');
  const unit = bodyMetric === 'body_fat' ? '%' : 'kg';
  if(pts.length < 2){ box.innerHTML = '<div class="empty">記錄至少 2 天就會出現曲線。</div>'; return; }
  const f = pts[0].y, l = pts[pts.length-1].y, d = l - f;
  box.innerHTML = '<div class="trend-head"><span class="n">' + fmt(l) + ' ' + unit + '</span>' +
    '<span class="v"><span class="delta ' + (d >= 0 ? 'up' : 'down') + '">' +
    (d >= 0 ? '+' : '') + fmt(Math.round(d*10)/10) + ' ' + unit + '</span> 自 ' + shortDate(pts[0].k) + '</span></div>' +
    chart(pts, getGood());
}
function renderExList(){
  renderBodyChart();
  renderCatChips(document.getElementById('exCatChips'), catFilterEx, id => { catFilterEx = id; renderExList(); });
  const list = document.getElementById('exList');
  const idx = allSessionsIndex();
  let items = state.exercises.map(ex => {
    const sess = idx.get(ex.id) || [];
    return { ex, count: sess.length, last: sess.length ? sess[sess.length-1].date : null };
  });
  if(catFilterEx !== 'all') items = items.filter(i => i.ex.category === catFilterEx);
  items.sort((a,b) => {
    const pa = state.pinned.has(a.ex.id), pb = state.pinned.has(b.ex.id);
    if(pa !== pb) return pa ? -1 : 1;
    return (b.last || '').localeCompare(a.last || '');
  });
  if(!items.length){ list.innerHTML = '<div class="empty">這個分類還沒有動作。</div>'; return; }
  list.innerHTML = '';
  items.forEach(({ ex, count, last }) => {
    const row = document.createElement('button');
    row.className = 'exlist-item';
    const pinned = state.pinned.has(ex.id);
    row.innerHTML = '<span class="n"><span class="catdot" style="background:' + catColor(ex.category) + '"></span>' + esc(ex.name) +
      '<div class="meta" style="font-weight:400">' + catLabel(ex.category) + ' · ' + count + ' 次' + (last ? ' · 最後 ' + shortDate(last) : '') + '</div></span>' +
      '<span class="pin' + (pinned ? ' on' : '') + '">' + (pinned ? '★' : '☆') + '</span>';
    row.onclick = () => { exDetail = ex.id; exMetric = 'e1rm'; renderExercisesTab(); };
    list.appendChild(row);
  });
}
function renderExDetail(){
  const ex = exById(exDetail);
  if(!ex){ exDetail = null; renderExercisesTab(); return; }
  document.getElementById('exDetailName').textContent = ex.name;
  document.getElementById('exDetailCat').textContent = catLabel(ex.category);
  const pinned = state.pinned.has(ex.id);
  const pinBtn = document.getElementById('exPinBtn');
  pinBtn.textContent = pinned ? '已釘選' : '釘選';
  pinBtn.className = 'toggle' + (pinned ? ' on' : '');

  renderToggle(document.getElementById('exMetricToggle'), EX_METRICS, exMetric, id => { exMetric = id; renderExDetail(); });

  const idx = allSessionsIndex();
  const sessions = idx.get(ex.id) || [];
  const chartBox = document.getElementById('exChart');
  const valEl = document.getElementById('exMetricVal');
  if(sessions.length < 2){
    chartBox.innerHTML = '<div class="empty">至少要有 2 次紀錄才畫得出曲線' + (sessions.length ? '（目前 1 次）' : '') + '。</div>';
    valEl.textContent = '';
  }else{
    const pts = sessions.map(s => ({ x: parseISO(s.date).getTime(), y: metricValue(s, exMetric), k: s.date }));
    const first = pts[0].y, last = pts[pts.length-1].y;
    const dv = first ? Math.round((last - first) / first * 100) : null;
    const unit = exMetric === 'reps' ? ' 下' : ' kg';
    valEl.innerHTML = fmt(last) + unit + (dv !== null ? ' <span class="delta ' + (dv >= 0 ? 'up' : 'down') + '">' + (dv >= 0 ? '+' : '') + dv + '%</span>' : '');
    chartBox.innerHTML = chart(pts, getAccent());
  }

  const hist = document.getElementById('exHistory');
  if(!sessions.length){ hist.innerHTML = '<div class="empty">還沒有紀錄。</div>'; return; }
  hist.innerHTML = '';
  [...sessions].reverse().forEach(s => {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML =
      '<div class="top"><div><div class="d">' + shortDateFull(s.date) + '</div>' +
      '<div class="sets">' + esc(setsTextRPE(s.sets)) + '</div>' +
      (s.note ? '<div class="note">' + esc(s.note) + '</div>' : '') + '</div>' +
      '<div class="actions"><button class="edit">編輯</button><button class="del">刪除</button></div></div>';
    row.querySelector('.edit').onclick = () => openSheet({ id:ex.id }, s.date);
    row.querySelector('.del').onclick = () => {
      if(!confirm('刪除 ' + shortDate(s.date) + ' 這筆紀錄？')) return;
      deleteSession(ex.id, s.date);
      renderExDetail();
    };
    hist.appendChild(row);
  });
}

/* ---------- 設定 ---------- */
function renderSettings(){
  document.getElementById('accountEmail').textContent = session ? session.user.email : '';
  const dateSet = new Set(state.sets.map(s => s.date));
  const sessions = new Set(state.sets.map(s => s.exercise_id + '|' + s.date)).size;
  document.getElementById('dataStats').innerHTML =
    dateSet.size + ' 天有資料 · ' + sessions + ' 次訓練 · ' + state.sets.length + ' 組 · ' + state.exercises.length + ' 個動作<br>' +
    (pendingOps.length ? pendingOps.length + ' 筆待同步' : '已同步到雲端');
  const note = document.getElementById('backupNote');
  const lastExport = localStorage.getItem('trainlog.lastExport');
  if(lastExport){
    const days2 = Math.floor((Date.now() - Number(lastExport)) / 86400000);
    note.innerHTML = '上次匯出：' + new Date(Number(lastExport)).toLocaleDateString('zh-TW') +
      (days2 >= 30 ? ' <b style="color:var(--danger)">（已經 ' + days2 + ' 天了）</b>' : '');
  }else{
    note.innerHTML = '資料會自動同步到雲端；匯出 JSON 可以額外多一份備份。';
  }
}

/* ---------- 導覽 ---------- */
function renderCurrentView(){
  if(view === 'log') renderLog();
  else if(view === 'week') renderWeek();
  else if(view === 'exercises') renderExercisesTab();
  else if(view === 'settings') renderSettings();
}
function switchView(v){
  view = v;
  ['log','week','exercises','settings'].forEach(x => {
    document.getElementById('view-' + x).hidden = (x !== v);
  });
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  document.getElementById('topbar').hidden = (v !== 'log');
  renderCurrentView();
  window.scrollTo(0,0);
}
function renderAll(){ switchView(view); }

/* ---------- 事件綁定 ---------- */
function wireStaticHandlers(){
  document.querySelectorAll('#tabbar button').forEach(b => {
    b.onclick = () => { if(b.dataset.view === 'exercises') exDetail = null; switchView(b.dataset.view); };
  });
  document.getElementById('prevDay').onclick = () => { cur = shiftDay(cur,-1); clearSearch(); renderLog(); };
  document.getElementById('nextDay').onclick = () => { cur = shiftDay(cur,1); clearSearch(); renderLog(); };
  document.getElementById('todayBtn').onclick = () => { cur = iso(new Date()); clearSearch(); renderLog(); };
  document.getElementById('prevWeek').onclick = () => { weekAnchor = shiftDay(mondayOf(weekAnchor),-7); renderWeek(); };
  document.getElementById('nextWeek').onclick = () => { weekAnchor = shiftDay(mondayOf(weekAnchor),7); renderWeek(); };

  document.getElementById('search').oninput = renderSearch;
  document.getElementById('search').onkeydown = e => {
    if(e.key === 'Enter'){ e.preventDefault(); const first = document.querySelector('#results .result'); if(first) first.click(); }
  };

  document.getElementById('addSet').onclick = () => {
    const last = editing.sets[editing.sets.length-1];
    editing.sets.push(last ? { w:last.w, r:last.r, rpe:'' } : { w:'', r:'', rpe:'' });
    renderSetRows();
    const inputs = document.querySelectorAll('#setRows .setrow input');
    if(inputs.length >= 3) inputs[inputs.length-3].focus();
  };
  document.getElementById('saveEntry').onclick = onSaveEntry;
  document.getElementById('deleteEntry').onclick = () => {
    if(editing.exId) deleteSession(editing.exId, editing.date);
    closeSheet();
    renderCurrentView();
  };
  document.getElementById('sheetClose').onclick = closeSheet;
  document.getElementById('scrim').onclick = closeSheet;

  document.getElementById('exBack').onclick = () => { exDetail = null; renderExercisesTab(); };
  document.getElementById('exPinBtn').onclick = () => { if(exDetail){ togglePin(exDetail); renderExDetail(); } };

  let foodTimer = null;
  document.getElementById('food').oninput = e => {
    clearTimeout(foodTimer);
    const val = e.target.value;
    foodTimer = setTimeout(() => upsertFoodLog(cur, val), 500);
  };
  const bindBodyField = (id, key) => {
    document.getElementById(id).onchange = e => {
      const v = e.target.value.trim();
      upsertBodyMetric(cur, { [key]: v === '' ? null : parseFloat(v) });
    };
  };
  bindBodyField('bw','weight');
  bindBodyField('bf','body_fat');
  bindBodyField('mm','muscle_mass');

  document.getElementById('exportBtn').onclick = () => {
    const payload = { exercises: state.exercises, sets: state.sets, bodyMetrics: state.bodyMetrics, foodLogs: state.foodLogs, pinned: [...state.pinned] };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '訓練紀錄-' + iso(new Date()) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    localStorage.setItem('trainlog.lastExport', String(Date.now()));
    renderSettings();
  };
  document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').onchange = ev => {
    const f = ev.target.files[0];
    if(!f) return;
    const r = new FileReader();
    r.onload = () => {
      try{
        const p = JSON.parse(r.result);
        if(!p || typeof p !== 'object' || !Array.isArray(p.exercises)) throw new Error('格式不符');
        if(!confirm('匯入 ' + p.exercises.length + ' 個動作、' + (p.sets||[]).length + ' 組紀錄？這會覆蓋目前帳號裡的全部資料。')) return;
        state = { exercises: p.exercises||[], sets: p.sets||[], bodyMetrics: p.bodyMetrics||[], foodLogs: p.foodLogs||[], pinned: new Set(p.pinned||[]) };
        persistCache();
        pushOp({ type:'wipeAll' });
        pushOp({ type:'upsert', table:'exercises', rows:state.exercises });
        pushOp({ type:'upsert', table:'sets', rows:state.sets });
        pushOp({ type:'upsert', table:'body_metrics', rows:state.bodyMetrics });
        pushOp({ type:'upsert', table:'food_logs', rows:state.foodLogs });
        [...state.pinned].forEach(exId => pushOp({ type:'pin', exercise_id:exId }));
        renderCurrentView();
        alert('匯入完成。');
      }catch(e){ alert('匯入失敗：' + e.message); }
      ev.target.value = '';
    };
    r.readAsText(f);
  };
  document.getElementById('wipeBtn').onclick = () => {
    if(!confirm('確定要清除所有訓練紀錄嗎？這個動作無法復原。')) return;
    if(!confirm('真的確定？建議先匯出一份備份。')) return;
    state = emptyState();
    persistCache();
    pushOp({ type:'wipeAll' });
    renderCurrentView();
  };
  document.getElementById('signOutBtn').onclick = async () => {
    if(supabase) await supabase.auth.signOut();
    state = emptyState();
    persistCache();
    localStorage.removeItem('trainlog.lastUser');
    session = null;
    showAuthGate();
  };
}

/* ---------- 登入 / 註冊 ---------- */
function translateAuthError(m){
  if(/Invalid login credentials/i.test(m)) return 'Email 或密碼錯誤';
  if(/already registered/i.test(m)) return '這個 Email 已經註冊過了';
  if(/Password should be/i.test(m)) return '密碼至少需要 6 個字元';
  if(/Email not confirmed/i.test(m)) return '這個 Email 還沒驗證，請先到信箱點擊驗證連結，或請管理員在 Supabase 後台手動確認';
  return m;
}
function setAuthMode(mode){
  authMode = mode;
  document.getElementById('authSubmit').textContent = authMode === 'signin' ? '登入' : '註冊';
  document.getElementById('authSwitchText').textContent = authMode === 'signin' ? '還沒有帳號？' : '已經有帳號？';
  document.getElementById('authSwitchBtn').textContent = authMode === 'signin' ? '註冊' : '登入';
  document.getElementById('authMsg').textContent = '';
}
async function onAuthSubmit(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const msg = document.getElementById('authMsg');
  msg.className = 'authmsg';
  if(!email || !password){ msg.textContent = '請輸入 Email 和密碼'; return; }
  if(!supabase){ msg.textContent = '目前離線，無法登入。'; return; }
  const btn = document.getElementById('authSubmit');
  const prevLabel = btn.textContent;
  btn.textContent = '處理中…';
  try{
    if(authMode === 'signin'){
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if(error) throw error;
    }else{
      const { data, error } = await supabase.auth.signUp({ email, password });
      if(error) throw error;
      if(data.user && !data.session){
        msg.className = 'authmsg ok';
        msg.textContent = '註冊成功，請至信箱點擊驗證連結後再登入。';
        setAuthMode('signin');
        return;
      }
    }
  }catch(e){
    msg.textContent = translateAuthError(e.message);
  }finally{
    btn.textContent = authMode === 'signin' ? '登入' : '註冊';
    void prevLabel;
  }
}
function wireAuthForm(){
  document.getElementById('authSwitchBtn').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  document.getElementById('authSubmit').onclick = onAuthSubmit;
}
function showApp(email, offline){
  document.getElementById('authGate').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('accountEmail').textContent = email + (offline ? '（離線模式）' : '');
  renderAll();
}
function showAuthGate(){
  document.getElementById('authGate').hidden = false;
  document.getElementById('app').hidden = true;
}
async function onAuthChange(){
  if(session){
    localStorage.setItem('trainlog.lastUser', session.user.email);
    showApp(session.user.email, false);
    await flushQueue();
    await refreshFromCloud();
    renderCurrentView();
    updateSyncDot();
  }else{
    showAuthGate();
  }
}

/* ---------- Service Worker ---------- */
function registerSW(){
  if('serviceWorker' in navigator){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 註冊失敗', e));
    });
  }
}

/* ---------- 啟動 ---------- */
async function init(){
  loadCache();
  loadQueue();
  wireAuthForm();
  wireStaticHandlers();
  initNewCatPicker();
  window.addEventListener('online', () => { flushQueue(); updateSyncDot(); });
  window.addEventListener('offline', updateSyncDot);
  registerSW();

  const cachedEmail = localStorage.getItem('trainlog.lastUser');

  if(!configured){
    document.getElementById('authSetupNote').hidden = false;
    if(cachedEmail) showApp(cachedEmail, true);
    else showAuthGate();
    return;
  }

  supabase = await getSupabase();
  if(!supabase){
    if(cachedEmail) showApp(cachedEmail, true);
    else{ showAuthGate(); document.getElementById('authMsg').textContent = '目前離線，需要連上網路才能第一次登入。'; }
    return;
  }

  supabase.auth.onAuthStateChange((_evt, s2) => { session = s2; onAuthChange(); });
}

init();
