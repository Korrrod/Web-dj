'use strict';
/* Тиндер треков: карточка трека, свайп вправо — огоньки, влево — дизлайк, вниз — спросить позже. */

const S = { tracks: [], byKey: new Map(), cache: {}, overrides: {}, settings: null, ratings: {}, ratingsV: null };
const T = { deck: [], pos: 0, undo: [], mode: 'new', cur: null, card: null, busy: false, started: false, tok: 0, audioKey: null };
const audio = $('#audio');
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { } return null; };

/* ---------- колода ---------- */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const isRazn = () => T.mode === 'razn';
// «Разнос»: треки с ♥♥, по которым ещё не решали, получат ли они третий огонёк
const inRazn = t => { const r = ratingOf(t); return !isDisliked(t) && xOf(t) === 2 && !(r && r.rz); };
function inMode(t, mode) {
  const r = ratingOf(t);
  if (mode === 'new') return !r && xOwn(t) == null;   // ни оценки, ни своих огоньков
  if (mode === 'later') return !!r && r.r === 'later';
  if (mode === 'liked') return !!r && r.r === 'like';
  if (mode === 'razn') return inRazn(t);
  return !isDisliked(t);
}
function buildDeck() {
  let list = shuffle(S.tracks.filter(t => inMode(t, T.mode)));
  // в «новых» после неоценённых идут отложенные «спросить позже»
  if (T.mode === 'new') list = list.concat(shuffle(S.tracks.filter(isLater)));
  T.deck = list.map(t => t.key); T.pos = 0;
}

/* ---------- карточка ---------- */
function makeCard(t) {
  const b = bpmOf(t), k = styleOfT(t), st = S.settings.styles[k], g = t.tags || {};
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="body">
      <div class="bpm">${b || '—'}<small> BPM</small></div>
      <div class="bsrc">${esc(bpmSource(t))}</div>
      <div class="ttl">${esc(titleOf(t))}</div>
      <div class="art">${esc(artistOf(t)) || '&nbsp;'}</div>
      <div class="meta">${tagChips(styleTags(t))}<button class="tag-add" title="Добавить или убрать тег" aria-label="Теги">＋</button>${g.y ? `<span>${esc(g.y)}</span>` : ''}${g.g ? `<span>${esc(g.g)}</span>` : ''}</div>
      <div class="cur">${xOf(t) ? fires(xOf(t)) : ''}</div>
      ${g.c ? `<div class="cm">${esc(g.c)}</div>` : ''}
      <div class="file">${esc(t.p)}</div>
    </div>
    <div class="tint"></div>
    <div class="stamp yes">${HEART}</div>
    <div class="stamp no">НЕТ</div>
    <div class="stamp later">ПОЗЖЕ</div>`;
  return el;
}
async function ensureTags(t) { if (!t.tags) { t.tags = await readTags(t); applyTags(t); } }

async function render() {
  const tok = ++T.tok;
  const stage = $('#stage');
  updateCounts();
  const t = S.byKey.get(T.deck[T.pos]);
  if (!t) {
    stage.querySelectorAll('.card').forEach(c => c.remove());
    T.cur = T.card = null; audio.pause(); showEmpty(); return;
  }
  await ensureTags(t);
  if (tok !== T.tok) return;
  stage.querySelectorAll('.card').forEach(c => c.remove());
  $('#empty').hidden = true;
  const nt = S.byKey.get(T.deck[T.pos + 1]);
  if (nt) {
    const n = makeCard(nt); n.classList.add('next'); stage.appendChild(n);
    if (!nt.tags) ensureTags(nt).then(() => { if (n.isConnected) n.replaceWith(Object.assign(makeCard(nt), { className: 'card next' })); });
  }
  const c = makeCard(t); stage.appendChild(c);
  attachDrag(c);
  if (!T.cur || T.cur.key !== t.key) resetTap();
  T.cur = t; T.card = c;
  paint({});
  loadAudio(t);
  showTap();
}
// перерисовать текущую карточку (например, после нового BPM), не теряя свайп
function refreshCard() {
  if (!T.cur || !T.card) return;
  const c = makeCard(T.cur);
  T.card.replaceWith(c); T.card = c;
  attachDrag(c); paint({});
}

/* ---------- TAP: натапать темп ---------- */
const tapper = makeTapper();
let tapVal = 0;
function resetTap() { tapper.reset(); tapVal = 0; showTap(); }
function showTap() {
  const n = tapper.count();
  $('#tapBpm').textContent = tapVal || (n ? '•'.repeat(n) : '—');
  const was = T.cur ? bpmOf(T.cur) : 0;
  $('#tapHint').textContent = tapVal ? `сейчас у трека: ${was || 'нет'}` : n ? `ещё ${Math.max(0, 4 - n)}…` : 'стучите в такт, 4+ раза';
  $('#tapHalf').disabled = $('#tapDouble').disabled = $('#tapSave').disabled = !tapVal || !T.cur;
}
function doTap() {
  const v = tapper.tap();
  if (v >= 40 && v <= 400) tapVal = v;
  const btn = $('#tap'); btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 90);
  try { if (navigator.vibrate) navigator.vibrate(5); } catch { }
  showTap();
}
// pointerdown, а не click: так нажатие засчитывается без задержки
$('#tap').addEventListener('pointerdown', e => { e.preventDefault(); doTap(); });
$('#tapHalf').onclick = () => { tapVal = Math.max(40, Math.round(tapVal / 2)); showTap(); };
$('#tapDouble').onclick = () => { tapVal = Math.min(400, tapVal * 2); showTap(); };
$('#tapSave').onclick = async () => {
  if (!T.cur || !tapVal) return;
  const v = tapVal;
  try { await postBpm(T.cur.key, v); } catch { toast('Не сохранилось — нет связи с компьютером'); return; }
  toast(`BPM ${v} сохранён`);
  tapper.reset(); tapVal = 0;
  refreshCard(); showTap();
};
function showEmpty() {
  const e = $('#empty'); e.hidden = false;
  const later = S.tracks.filter(isLater).length;
  const msg = { new: 'Все новые треки оценены', later: 'Отложенных треков нет', liked: 'Пока нет понравившихся треков', razn: 'Разнос окончен: по всем трекам с двумя огоньками решено', all: 'Треков нет' }[T.mode];
  e.innerHTML = `<b>${msg}</b>
    ${T.mode !== 'later' && later ? `<button data-mode="later" class="icon">Показать отложенные (${later})</button>` : ''}
    ${T.mode !== 'all' ? '<button data-mode="all" class="icon">Показать все треки</button>' : ''}`;
}
$('#empty').onclick = e => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); };

function updateCounts() {
  const all = Object.values(S.ratings), n = r => all.filter(x => x.r === r).length;
  const left = Math.max(0, T.deck.length - T.pos);
  if (isRazn()) { const three = S.tracks.filter(t => xOf(t) === 3).length; $('#counts').innerHTML = `осталось ${left} · ${fires(3)} ${three}`; return; }
  $('#counts').innerHTML = `осталось ${left} · ${HEART} ${n('like')} · нет ${n('dislike')} · позже ${n('later')}`;
}
// кнопки внизу: в «Разносе» они значат «♥♥ / пропустить / ♥♥♥»
function renderActions() {
  const r = isRazn(), q = a => $(`#actions [data-act=${a}]`);
  q('dislike').innerHTML = r ? fires(2) : ICON_X;
  q('dislike').title = r ? 'Оставить 2 огонька (←)' : 'Не нравится (←)';
  q('later').innerHTML = r ? ICON_NEXT : ICON_CLOCK;
  q('later').title = r ? 'Пропустить — спрошу в конце (↓)' : 'Спросить позже (↓)';
  q('like').innerHTML = fires(r ? 3 : 2);
  q('like').title = r ? 'Третий огонёк — 3 огонька (→)' : 'Нравится — 2 огонька (→)';
  document.body.classList.toggle('razn', r);
}
function setMode(m) { T.mode = m; $('#mode').value = m; LS('tinderMode', m); renderActions(); buildDeck(); render(); }
$('#mode').onchange = e => setMode(e.target.value);

/* ---------- свайп ---------- */
const glows = { L: $('#glowL'), R: $('#glowR'), D: $('#glowD') };
// куда сейчас тянут: like (с числом огоньков), dislike, later или ещё не решено
function zone(dx, dy) {
  const W = innerWidth, H = innerHeight;
  const tx = Math.max(70, W * 0.2), ty = Math.max(70, H * 0.13);
  if (dy > ty && dy > Math.abs(dx) * 1.1) return { kind: 'later' };
  if (dx > tx) return { kind: 'like' };
  if (dx < -tx) return { kind: 'dislike' };
  const down = dy > Math.abs(dx) ? Math.max(0, dy) / ty : 0;
  return { kind: null, r: Math.max(0, dx / tx) * (1 - down), l: Math.max(0, -dx / tx) * (1 - down), d: down };
}
function paint(z) {
  const r = z.kind === 'like' ? 1 : z.kind ? 0 : z.r || 0;
  const l = z.kind === 'dislike' ? 1 : z.kind ? 0 : z.l || 0;
  const d = z.kind === 'later' ? 1 : z.kind ? 0 : z.d || 0;
  glows.R.style.opacity = r * 0.9; glows.L.style.opacity = l * 0.9; glows.D.style.opacity = d * 0.9;
  const c = T.card; if (!c) return;
  const tint = c.querySelector('.tint');
  if (r >= l && r >= d) tint.style.background = `rgba(47,191,98,${0.45 * r})`;
  else if (l >= d) tint.style.background = `rgba(229,72,59,${0.45 * l})`;
  else tint.style.background = `rgba(76,143,224,${0.45 * d})`;
  tint.style.opacity = 1;
  const yes = c.querySelector('.stamp.yes'), no = c.querySelector('.stamp.no'), lt = c.querySelector('.stamp.later');
  yes.innerHTML = fires(isRazn() ? 3 : 2);
  no.innerHTML = isRazn() ? fires(2) : 'НЕТ';
  lt.textContent = isRazn() ? 'ПРОПУСТИТЬ' : 'ПОЗЖЕ';
  yes.style.opacity = r; c.querySelector('.stamp.no').style.opacity = l; c.querySelector('.stamp.later').style.opacity = d;
}
function buzz() { try { if (navigator.vibrate) navigator.vibrate(10); } catch { } }

function attachDrag(card) {
  let id = null, sx = 0, sy = 0, dx = 0, dy = 0, t0 = 0, lastSig = '';
  card.addEventListener('pointerdown', e => {
    if (T.busy || id !== null || e.target.closest('button')) return;   // кнопка на карточке («＋» теги) — не перетаскивание
    id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = performance.now(); lastSig = '';
    try { card.setPointerCapture(id); } catch { }
    card.classList.remove('back');
    document.body.classList.add('dragging');
  });
  card.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const z = zone(dx, dy); paint(z);
    const sig = (z.kind || '') + (z.lv || '');
    if (sig !== lastSig) { if (z.kind) buzz(); lastSig = sig; }
  });
  const finish = (e, cancelled) => {
    if (e.pointerId !== id) return;
    id = null; document.body.classList.remove('dragging');
    let z = cancelled ? {} : zone(dx, dy);
    const dist = Math.hypot(dx, dy), speed = dist / Math.max(1, performance.now() - t0);
    if (!z.kind && !cancelled && speed > 0.9 && dist > 50) { // быстрый взмах
      z = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? { kind: 'like' } : { kind: 'dislike' }) : dy > 0 ? { kind: 'later' } : {};
    }
    if (z.kind) decide(z.kind, z.lv, { dx, dy });
    else { card.classList.add('back'); card.style.transform = ''; paint({}); }
  };
  card.addEventListener('pointerup', e => finish(e, false));
  card.addEventListener('pointercancel', e => finish(e, true));
}

function flyOut(kind, from) {
  const c = T.card; if (!c) return Promise.resolve();
  const W = innerWidth, H = innerHeight, dx = (from && from.dx) || 0, dy = (from && from.dy) || 0;
  c.classList.remove('back'); c.classList.add('fly');
  c.style.transform = kind === 'like' ? `translate(${W * 1.3}px, ${dy}px) rotate(28deg)`
    : kind === 'dislike' ? `translate(${-W * 1.3}px, ${dy}px) rotate(-28deg)`
    : `translate(${dx}px, ${H * 1.1}px)`;
  c.style.opacity = '0';
  return new Promise(r => setTimeout(r, 300));
}

// решение по карточке.
// Обычные колоды: вправо — нравится (♥♥, если у трека не было больше), влево — дизлайк, вниз — спросить позже.
// «Разнос»: вправо — третий огонёк (♥♥♥), влево — остаётся ♥♥, вниз — пропустить (трек вернётся в конец колоды).
async function decide(kind, lv, from) {
  if (!T.cur || T.busy) return;
  T.busy = true;
  const t = T.cur, prev = ratingOf(t) ? Object.assign({}, ratingOf(t)) : null, razn = isRazn();
  paint({ kind }); buzz();
  let save = Promise.resolve(), msg, skip = false;
  if (razn) {
    if (kind === 'later') { skip = true; msg = 'Пропущен — спрошу в конце'; }
    else {
      const x = kind === 'like' ? 3 : 2;
      save = postRating(t.key, 'like', x, true);
      msg = kind === "like" ? "Третий огонёк — теперь 3" : "Остаётся 2 огонька";
    }
  } else if (kind === 'like') {
    const x = Math.min(3, Math.max(2, xOwn(t) || 0));
    save = postRating(t.key, 'like', x);
    msg = `Огоньков: ${x} — сохранено`;
  } else if (kind === 'dislike') {
    // «не нравится» больше не убирает трек: огоньки остаются прежними, трек просто помечен просмотренным
    save = postRating(t.key, 'keep');
    msg = 'Оставлен как есть';
  } else {
    save = postRating(t.key, kind);
    msg = 'Спрошу позже';
  }
  await flyOut(kind, from);
  try { await save; }
  catch (e) {
    T.busy = false; toast('Не сохранилось — нет связи с компьютером'); paint({}); T.audioKey = null; render(); return;
  }
  T.undo.push({ key: t.key, prev, pos: T.pos, skip });
  $('#undo').disabled = false;
  if (kind === 'later') T.deck.push(t.key); // спросим ещё раз в конце колоды
  T.pos++;
  T.busy = false;
  toast(msg);
  paint({});
  render();
}

async function undo() {
  if (T.busy) return;
  const u = T.undo.pop(); if (!u) return;
  $('#undo').disabled = !T.undo.length;
  if (!u.skip) {
    try { await postRating(u.key, u.prev ? u.prev.r : null, u.prev ? u.prev.x : undefined, u.prev && u.prev.rz); }
    catch { toast('Нет связи с компьютером'); T.undo.push(u); $('#undo').disabled = false; return; }
  }
  const dup = T.deck.lastIndexOf(u.key); if (dup > u.pos) T.deck.splice(dup, 1);
  T.pos = u.pos;
  toast('Вернул трек');
  render();
}
$('#undo').onclick = undo;

$('#actions').onclick = e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  if (b.dataset.act === 'trash') { trashCur(); return; }
  decide(b.dataset.act);
};

// удалить трек: файл переезжает в папку «Не в моём вкусе» рядом с музыкой (вернуть можно, перетащив обратно)
async function trashCur() {
  const t = T.cur; if (!t || T.busy) return;
  if (!confirm(`Убрать трек в папку «Не в моём вкусе»?\n\n${titleOf(t)} — ${artistOf(t)}`)) return;
  T.busy = true;
  try {
    const r = await fetch('/api/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: t.key }) });
    if (!r.ok) throw new Error(r.status);
  } catch { T.busy = false; toast('Не получилось — нет связи с компьютером'); return; }
  S.tracks = S.tracks.filter(x => x.key !== t.key); S.byKey.delete(t.key);
  T.deck.splice(T.pos, 1); T.audioKey = null;
  T.busy = false; toast('Убран в «Не в моём вкусе»'); paint({}); render();
}

// теги трека прямо в тиндере: «＋» на карточке — список направлений, нажатие ставит или снимает тег.
// Сохраняет плеер на ноутбуке (как правку из настроек трека)
async function toggleTag(t, name) {
  const o = S.overrides[t.key] || (S.overrides[t.key] = {});
  const on = styleTags(t).some(g => S.settings.styles[g.k].name === name);
  let add = (o.tagsAdd || []).filter(n => n !== name), del = (o.tagsDel || []).filter(n => n !== name);
  if (on) del.push(name); else add.push(name);
  if (add.length) o.tagsAdd = add; else delete o.tagsAdd;
  if (del.length) o.tagsDel = del; else delete o.tagsDel;
  try {
    const r = await fetch('/api/remote/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'tags', key: t.key, add, del }) });
    if (!r.ok) throw new Error(r.status);
    toast((on ? 'Тег убран: ' : 'Тег добавлен: ') + esc(name));
  } catch { toast('Не сохранилось — откройте плеер на ноутбуке'); }
  render();
}
document.addEventListener('click', e => {
  const plus = e.target.closest('.tag-add');
  const menu = $('#tagMenu');
  if (plus) {
    e.stopPropagation();
    const t = T.cur; if (!t) return;
    const m = menu || Object.assign(document.createElement('div'), { id: 'tagMenu', className: 'tag-menu' });
    if (!m.parentNode) document.body.appendChild(m);
    const on = new Set(styleTags(t).map(g => g.k));
    m.innerHTML = S.settings.styles.map((s, k) => `<button data-name="${esc(s.name)}" class="${on.has(k) ? 'on' : ''}"><i style="background:${esc(s.color)}"></i>${esc(s.name)}${on.has(k) ? '<b>✓</b>' : ''}</button>`).join('');
    const r = plus.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(innerWidth - 228, r.left)) + 'px'; m.style.top = Math.min(innerHeight - 320, r.bottom + 6) + 'px'; m.hidden = false;
    return;
  }
  if (menu && !menu.hidden) {
    const b = e.target.closest('#tagMenu button[data-name]');
    menu.hidden = true;
    if (b && T.cur) toggleTag(T.cur, b.dataset.name);
  }
});

let toastTimer = null;
function toast(msg) {
  const el = $('#toast'); el.innerHTML = msg; el.hidden = false;   // innerHTML: в сообщении бывает иконка огонька
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 1400);
}

/* ---------- звук ---------- */
function loadAudio(t) {
  if (T.audioKey === t.key) return;
  T.audioKey = t.key;
  audio.src = '/media/' + t.i;
  const quarter = $('#fromQuarter').checked;
  audio.onloadedmetadata = () => { if (quarter && audio.duration > 40) audio.currentTime = audio.duration * 0.25; };
  if (T.started) audio.play().catch(() => { });
}
audio.addEventListener('timeupdate', () => {
  $('#tCur').textContent = fmtTime(audio.currentTime);
  $('#tDur').textContent = fmtTime(audio.duration);
  $('#progressFill').style.width = (audio.duration ? audio.currentTime / audio.duration * 100 : 0) + '%';
});
audio.addEventListener('play', () => { $('#play').innerHTML = ICON_PAUSE; });
audio.addEventListener('pause', () => { $('#play').innerHTML = ICON_PLAY; });
audio.addEventListener('error', () => { if (T.cur) toast('Этот файл не играет в браузере'); });
$('#play').onclick = () => { if (audio.paused) audio.play().catch(() => { }); else audio.pause(); };
$('#back15').onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 15); };
$('#fwd15').onclick = () => { if (audio.duration) audio.currentTime = Math.min(audio.duration - 1, audio.currentTime + 15); };
$('#progress').addEventListener('pointerdown', e => {
  const bar = e.currentTarget;
  const seek = ev => { if (!audio.duration) return; const r = bar.getBoundingClientRect(); audio.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * audio.duration; };
  seek(e); bar.setPointerCapture(e.pointerId);
  bar.onpointermove = seek; bar.onpointerup = () => { bar.onpointermove = null; };
});
$('#fromQuarter').onchange = e => LS('tinderQuarter', e.target.checked ? '1' : '0');

document.addEventListener('keydown', e => {
  if (e.target.matches('select, input')) return;
  const k = e.key;
  if (k === 'ArrowRight') decide('like');
  else if (k === 'ArrowLeft') decide('dislike');
  else if (k === 'ArrowDown') decide('later');
  else if (k === 'Backspace' || k === 'z') undo();
  else if (k === 't' || k === 'е') doTap();
  else if (k === 'Enter' && tapVal) $('#tapSave').click();
  else if (k === ' ') { e.preventDefault(); $('#play').click(); }
  else return;
  e.preventDefault();
});

/* ---------- запуск ---------- */
$('#go').onclick = () => {
  T.started = true;
  $('#start').hidden = true;
  if (T.cur) audio.play().catch(() => { });
};

async function init() {
  let lib, state, cache, rat;
  try { [lib, state, cache, rat] = await Promise.all([getJSON('/api/tracks'), getJSON('/api/state'), getJSON('/api/cache'), getJSON('/api/ratings')]); }
  catch { document.body.innerHTML = '<p style="padding:30px">Нет связи с компьютером. Проверьте, что SwingDJ запущен и телефон в той же Wi-Fi сети.</p>'; return; }
  S.cache = cache || {}; S.overrides = state.overrides || {};
  loadSettings(state.settings);
  applyRatings(rat);
  makeTracks(lib.tracks || []);
  const m = LS('tinderMode'); if (m && ['new', 'later', 'liked', 'razn', 'all'].includes(m)) T.mode = m;
  renderActions();
  $('#mode').value = T.mode;
  $('#fromQuarter').checked = LS('tinderQuarter') !== '0';
  buildDeck();
  render();
}
init();
