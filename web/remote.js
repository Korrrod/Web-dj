'use strict';
/* Пульт: управляет плеером, который играет на ноутбуке. Команды идут через сервер. */

const S = { tracks: [], byKey: new Map(), cache: {}, overrides: {}, settings: null, ratings: {}, ratingsV: null };
const R = { st: null, at: 0, age: -1, seeking: false, volTimer: null };

/* ---------- связь ---------- */
async function send(cmd, args = {}) {
  try {
    const r = await fetch('/api/remote/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ cmd }, args)) });
    if (!r.ok) throw new Error(r.status);
    setTimeout(poll, 500); setTimeout(poll, 1300);
    return true;
  } catch { toast('Нет связи с компьютером'); return false; }
}
async function poll() {
  try {
    const d = await getJSON('/api/remote/status');
    R.st = d.s; R.age = d.age; R.at = performance.now();
  } catch { R.st = null; R.age = -1; }
  render();
}

/* ---------- отрисовка ---------- */
const fireSpan = x => x ? `<span class="fires">${fires(x)}</span>` : '';
function render() {
  const s = R.st, alive = s && R.age >= 0 && R.age < 6000;
  const link = $('#link');
  link.classList.toggle('off', !alive);
  link.querySelector('span').textContent = alive ? 'на связи' : 'нет связи';
  $('#offline').hidden = !!alive;
  $('#blocked').hidden = !(alive && s.blocked);
  if (!s) return;
  const c = s.cur;
  $('#nowTitle').textContent = c ? c.title : 'Ничего не играет';
  $('#nowArtist').textContent = c ? c.artist : 'Нажмите ▶ — трек подберётся сам';
  $('#nowTags').innerHTML = c ? tagChips(c.tags) : '';
  const ob = R.bpmHold && c && R.bpmHold.key === c.key && performance.now() < R.bpmHold.until ? R.bpmHold.b : null;
  $('#nowBpm').textContent = ob || (c && c.bpm) || '—';
  $('#bpmBox').disabled = !c;
  $('#nowStyle').textContent = c && c.style ? styleAbbr(c.style) : '';
  $('#nowStyle').title = c && c.style ? c.style : '';
  const x = c ? c.x || 0 : 0;
  $('#nowHearts').innerHTML = [1, 2, 3].map(n =>
    `<button class="heart ${n <= x ? 'on' : ''}" data-n="${n}" role="radio" aria-checked="${n === x}" ${c ? '' : 'disabled'} title="${n === x ? 'Ещё раз — убрать огоньки' : 'Огоньков: ' + n}">${iconHeart(n <= x)}</button>`).join('');
  $('#toggle').innerHTML = s.paused ? ICON_PLAY : ICON_PAUSE;
  $('#gapNote').hidden = !s.gap;
  if (!R.volTimer && document.activeElement !== $('#vol')) $('#vol').value = s.volume;
  $('#autoNext').checked = !!s.autoNext;
  document.querySelectorAll('#energy button').forEach(b => b.classList.toggle('on', +b.dataset.x === +s.energy));
  R.last = s; if (!R.mixDrag) renderRMix(s);   // доли направлений — полоса с ползунками
  const q = s.queue || [];
  if (R.qDrag) { tick(); return; }   // пока тянут трек — очередь не перерисовываем
  $('#queue').innerHTML = q.length ? q.map((t, k) => `
    <li data-key="${esc(t.key)}">
      <span class="m"><span class="mt"><b class="${t.manual ? 'manual' : ''}">${noteBadge(S.byKey.get(t.key))}${esc(t.title)}</b></span><span class="q-art">${esc(t.artist) || "—"}</span><span class="q-bpm">${t.bpm || "—"} BPM ${fireSpan(t.x)}</span></span>
      <span class="stags rq-tags">${tagChips(t.tags)}</span>
      <span class="a">
        <button class="lsn" data-c="listen" title="Послушать на телефоне">${ICON_PHONES}</button>
        <button class="play" data-c="play" title="Включить сейчас">${ICON_PLAY}</button>
        <button data-c="roll" title="Заменить на другой трек такого же типа">${ICON_SWAP}</button>
        <button data-c="unqueue" title="Убрать">✕</button>
      </span></li>`).join('') : '<li class="empty">Очередь пуста</li>';
  tick();
}
function showPos(pos, dur) {
  $('#tCur').textContent = fmtTime(pos); $('#tLeft').textContent = '−' + fmtTime(Math.max(0, (dur || 0) - pos));
  $('#now').style.setProperty('--p', (dur ? Math.min(100, pos / dur * 100) : 0) + '%');
}
// сокращение стиля, как на ноутбуке: первая буква + согласные («Блб»)
function styleAbbr(name) {
  const s = (name || '').replace(/[^A-Za-zА-Яа-яЁё]/g, ''); if (!s) return '';
  return (s[0].toUpperCase() + s.slice(1).replace(/[aeiouyаеёиоуыэюяьъ]/gi, '').toLowerCase()).slice(0, 3);
}
// позиция трека между опросами считается на телефоне
function tick() {
  const s = R.st; if (!s || R.seeking) return;
  let pos = Math.min(s.dur || 0, s.pos + (s.paused ? 0 : (performance.now() - R.at + Math.max(0, R.age)) / 1000));
  // без рывков назад и вперёд при каждом ответе ноутбука: маленькое расхождение (< 1,5 с) догоняем плавно,
  // большое (перемотка, другой трек) — показываем сразу
  const key = s.cur, last = R.shown;
  if (last && last.key === key && !s.paused && Math.abs(pos - last.pos) < 1.5) {
    const now = performance.now(), dt = Math.min(0.1, (now - last.t) / 1000);
    const expected = last.pos + dt;                    // где были бы при ровном ходе
    pos = expected + (pos - expected) * Math.min(1, dt * 2);   // мягко подтягиваемся к точной позиции
  }
  R.shown = { key, pos, t: performance.now() };
  showPos(pos, s.dur);
}

/* ---------- поиск по библиотеке ---------- */
function renderResults() {
  const q = searchWords($('#search').value);
  const el = $('#results');
  if (!q.length) { el.innerHTML = ''; return; }
  const hay = searchHay;   // название, исполнитель, папка, комментарий файла и свои комментарии
  const rows = S.tracks.filter(t => !isDisliked(t) && q.every(w => hay(t).includes(w) || String(bpmOf(t)) === w)).slice(0, 40);
  el.innerHTML = rows.length ? rows.map(t => {
    const k = styleOfT(t);
    return `<li data-key="${esc(t.key)}">
      <span class="m"><span class="mt"><b>${noteBadge(t)}${esc(titleOf(t))}</b><span class="stags">${tagChips(styleTags(t))}</span></span><span>${bpmOf(t) || "—"} BPM ${fireSpan(xOf(t))} · ${esc(artistOf(t))}</span></span>
      <span class="a">
        <button class="lsn" data-c="listen" title="Послушать на телефоне">${ICON_PHONES}</button>
        <button class="play" data-c="play" title="Включить сейчас">${ICON_PLAY}</button>
        <button data-c="queue" title="Поставить в очередь">＋</button>
      </span></li>`;
  }).join('') : '<li class="empty">Ничего не нашлось</li>';
}

/* ---------- события ---------- */
$('#toggle').onclick = () => { if (R.st) { R.st.paused = !R.st.paused; render(); } send('toggle'); };
$('#next').innerHTML = ICON_NEXT;   // иконки одним стилем с плеером
$('#next').onclick = () => send('next');
// огоньки играющего трека: нажатие на n-е ставит n, повторное — убирает
$('#nowHearts').onclick = e => {
  const b = e.target.closest('button[data-n]'), c = R.st && R.st.cur; if (!b || !c) return;
  const n = +b.dataset.n, x = n === (c.x || 0) ? 0 : n;
  c.x = x; render(); // сразу показываем, не дожидаясь ноутбука
  send('setX', { key: c.key, x }).then(ok => ok && toast(x ? `Огоньков: ${x} — сохранено` : 'Огоньки убраны'));
};
$('#replan').onclick = () => send('replan');
$('#autoNext').onchange = e => send('autoNext', { on: e.target.checked });
$('#vol').oninput = e => {
  clearTimeout(R.volTimer);
  R.volTimer = setTimeout(() => { R.volTimer = null; send('volume', { v: +e.target.value }); }, 250);
};
$('#energy').onclick = e => { const b = e.target.closest('button'); if (b) { send('energy', { x: +b.dataset.x }); toast(b.dataset.x === '0' ? 'Любые треки' : 'Огоньков: ' + b.dataset.x); } };

function listClick(e) {
  const b = e.target.closest('button[data-c]');
  if (!b) {   // нажатие на сам трек (название, исполнитель) — отправить или скачать его файл
    const li = e.target.closest('li[data-key]'), t = li && S.byKey.get(li.dataset.key);
    if (t && e.target.closest('.m')) { toast('Готовлю файл…'); shareTrackFile(t).then(ok => toast(ok ? 'Готово' : 'Не удалось получить файл')); }
    return;
  }
  const li = b.closest('li'), key = li.dataset.key, cmd = b.dataset.c;
  const title = li.querySelector('b').textContent;
  if (cmd === 'listen') { pvOpen(key); return; }
  if (cmd === 'play') {
    if (R.st && R.st.cur && !R.st.paused && !confirm(`Прервать текущий трек и включить «${title}»?`)) return;
    send('play', { key }).then(ok => ok && toast('Играет: ' + esc(title)));
  } else if (cmd === 'queue') send('queue', { key }).then(ok => ok && toast('Следующим: ' + esc(title)));
  else send(cmd, { key });
}
$('#queue').onclick = listClick;
$('#results').onclick = listClick;
$('#search').oninput = debounce(renderResults, 200);

// перемотка: тянуть пальцем вправо-влево по карточке «сейчас играет» — сдвиг от текущего места (простое касание не перематывает)
$('#now').addEventListener('pointerdown', e => {
  const s = R.st; if (!s || !s.dur || e.target.closest('button')) return;
  const card = e.currentTarget, x0 = e.clientX;
  // сдвиг от текущего места на столько, на сколько сдвинут палец (вся ширина карточки = весь трек)
  const p0 = Math.min(s.dur, s.pos + (s.paused ? 0 : (performance.now() - R.at + Math.max(0, R.age)) / 1000)), w0 = card.getBoundingClientRect().width;
  const at = ev => Math.max(0, Math.min(s.dur - 0.5, p0 + (ev.clientX - x0) / w0 * s.dur));
  let drag = false;
  const move = ev => {
    if (!drag && Math.abs(ev.clientX - x0) < 12) return;
    if (!drag) { drag = true; R.seeking = true; card.classList.add('seeking'); try { card.setPointerCapture(ev.pointerId); } catch { } }
    showPos(at(ev), s.dur);
  };
  const end = ev => {
    card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', end); card.removeEventListener('pointercancel', end);
    card.classList.remove('seeking');
    if (!drag) return;
    R.seeking = false;
    if (ev.type === 'pointercancel') { tick(); return; }
    const t = at(ev); s.pos = t; R.at = performance.now(); R.age = 0; send('seek', { t }); toast(fmtTime(t));
  };
  card.addEventListener('pointermove', move); card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
});

// накликать темп играющего трека: стучите по «Тык», BPM уходит на ноутбук (как TAP в тиндере)
const tapper = makeTapper();
let bpmKey = null;
function openBpm() {
  const c = R.st && R.st.cur; if (!c) return;
  bpmKey = c.key; tapper.reset();
  $('#bpmSrc').textContent = `${c.title} — ${c.artist}`;
  $('#bpmVal').value = c.bpm || '';
  $('#bpmHint').textContent = 'стучите по «Тык» в такт музыке, 4 раза и больше';
  $('#bpmSheet').hidden = false;
}
const closeBpm = () => { $('#bpmSheet').hidden = true; bpmKey = null; };
async function saveBpm(b) {
  const key = bpmKey; if (!key) return;
  closeBpm();
  try {
    await postBpm(key, b);
    if (b) { R.bpmHold = { key, b, until: performance.now() + 8000 }; render(); }
    toast(b ? `Темп ${b} сохранён` : 'Темп сброшен к исходному');
  } catch { toast('Нет связи с компьютером'); }
}
$('#bpmBox').onclick = openBpm;
$('#bpmTap').addEventListener('pointerdown', e => {
  e.preventDefault();
  const v = tapper.tap(), n = tapper.count(), b = $('#bpmTap');
  if (v >= 40 && v <= 400) { $('#bpmVal').value = v; $('#bpmHint').textContent = `ударов: ${n}`; }
  else $('#bpmHint').textContent = n >= 4 ? 'слишком быстро или медленно' : `ещё ${4 - n}…`;
  b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 90);
  if (navigator.vibrate) navigator.vibrate(8);
});
$('#bpmSave').onclick = () => {
  const b = Math.round(+$('#bpmVal').value);
  if (!(b >= 40 && b <= 400)) { $('#bpmHint').textContent = 'нужно число от 40 до 400'; return; }
  saveBpm(b);
};
$('#bpmReset').onclick = () => saveBpm(null);
$('#bpmCancel').onclick = closeBpm;
$('#bpmSheet').addEventListener('click', e => { if (e.target === e.currentTarget) closeBpm(); });

let toastTimer = null;
function toast(msg) {
  const el = $('#toast'); el.innerHTML = msg; el.hidden = false;   // innerHTML: в сообщении бывает иконка огонька
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

/* ---------- запуск ---------- */
async function init() {
  poll();
  setInterval(poll, 1000);
  // каждый кадр, а не 4 раза в секунду: заливка «сейчас играет» едет плавно
  const loop = () => { tick(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  try {
    const [lib, state, cache, rat] = await Promise.all([getJSON('/api/tracks'), getJSON('/api/state'), getJSON('/api/cache'), getJSON('/api/ratings')]);
    S.cache = cache || {}; S.overrides = state.overrides || {};
    loadSettings(state.settings);
    applyRatings(rat);
    makeTracks(lib.tracks || []);
  } catch { $('#search').placeholder = 'библиотека не загрузилась'; }
}
init();

/* ---------- доли направлений на пульте: как полоса в плеере ----------
   подписи (кружок — нажать, чтобы убрать стиль), «＋» — добавить стиль с 0 %, полоса: тянуть ручку или нажать в нужное место */
function rShares(s) { const sum = s.styles.reduce((a, x) => a + (+x.w || 0), 0); return s.styles.map(x => sum ? (+x.w || 0) / sum * 100 : 0); }
function renderRMix(s) {
  const box = $('#mixBox'); if (!box || !s || !s.styles) return;
  box.hidden = s.mode !== 'mix';
  const sh = R.mixSh || rShares(s), act = s.styles.map((x, k) => k).filter(k => sh[k] > 0.05 || s.styles[k].on);
  const rnd = {}; let left = act.some(k => sh[k] > 0) ? 100 : 0;
  act.forEach(k => { rnd[k] = Math.floor(sh[k]); left -= rnd[k]; });
  act.slice().sort((a, b) => (sh[b] - rnd[b]) - (sh[a] - rnd[a])).slice(0, Math.max(0, left)).forEach(k => rnd[k]++);
  $('#rmixLabels').innerHTML = act.map(k => `<div class="rml" data-k="${k}"><button class="rml-off" data-off="${k}" style="--c:${esc(s.styles[k].color)}" aria-label="Убрать «${esc(s.styles[k].name)}»"></button><span class="rml-n">${esc(s.styles[k].name)}</span><b>${rnd[k]}%</b></div>`).join('')
    + (s.styles.some((x, k) => !act.includes(k)) ? '<button class="rml-plus" id="rmixPlus" aria-label="Добавить направление">＋</button>' : '');
  let x = 0, html = '';
  act.forEach((k, i) => {
    html += `<div class="rseg" style="left:${x}%;width:${sh[k]}%;background:${esc(s.styles[k].color)}"></div>`;
    x += sh[k];
    if (i < act.length - 1) html += `<div class="rmh" data-k="${k}" style="left:${x}%"></div>`;
  });
  $('#rmixTrack').innerHTML = html;
  R.mixAct = act;
}
function sendMix(sh, on) { send('mix', { w: sh.map(v => Math.round(v * 10) / 10), on }); }
$('#rmixLabels').addEventListener('click', e => {
  const s = R.last; if (!s) return;
  const sh = rShares(s), on = s.styles.map(x => !!x.on);
  const off = e.target.closest('.rml-off');
  if (off) {   // убрать направление: его доля делится между остальными по пропорции
    const k = +off.dataset.off, rest = 100 - sh[k];
    const w = sh.map((v, i) => i === k ? 0 : rest > 0 ? v / rest * 100 : 0); on[k] = false;
    sendMix(w, on); toast('Убрано: ' + esc(s.styles[k].name)); return;
  }
  const plus = e.target.closest('#rmixPlus');
  if (plus) {   // список стилей, которых нет на полосе
    let menu = $('#rmixMenu');
    if (!menu) { menu = document.createElement('div'); menu.id = 'rmixMenu'; menu.className = 'rmix-menu'; document.body.appendChild(menu); }
    menu.innerHTML = s.styles.map((x, k) => k).filter(k => !(R.mixAct || []).includes(k))
      .map(k => `<button data-k="${k}"><i style="background:${esc(s.styles[k].color)}"></i>${esc(s.styles[k].name)}</button>`).join('');
    const r = plus.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - 220, r.left)) + 'px'; menu.style.top = (r.bottom + 6) + 'px'; menu.hidden = false;
  }
});
document.addEventListener('click', e => {
  const m = $('#rmixMenu'); if (!m || m.hidden) return;
  const b = e.target.closest('#rmixMenu button[data-k]');
  if (b) {   // добавить с 0 % (если долей нет совсем — сразу 100 %)
    const s = R.last, k = +b.dataset.k, sh = rShares(s), on = s.styles.map(x => !!x.on); on[k] = true;
    if (!sh.some(v => v > 0)) sh[k] = 100;
    sendMix(sh, on); toast('Добавлено: ' + esc(s.styles[k].name) + ' — долю наберите на полосе');
  }
  if (b || !e.target.closest('#rmixPlus')) m.hidden = true;
});
// ползунки: доля переходит только между двумя соседними цветами; нажатие мимо ручки — ближайшая ручка прыгает туда
$('#rmixTrack').addEventListener('pointerdown', e => {
  const s = R.last, act = R.mixAct || []; if (!s || act.length < 2) return;
  const track = $('#rmixTrack'), rect = track.getBoundingClientRect(), hs = [...track.querySelectorAll('.rmh')]; if (!hs.length) return;
  const cx = el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
  let h = e.target.closest('.rmh'), x0 = e.clientX;
  if (!h) { h = hs.reduce((a, b) => Math.abs(cx(b) - e.clientX) < Math.abs(cx(a) - e.clientX) ? b : a); x0 = cx(h); }
  e.preventDefault(); try { track.setPointerCapture(e.pointerId); } catch { }
  const sh = rShares(s), pos = act.indexOf(+h.dataset.k);
  let lo = pos, hi = pos;
  while (lo > 0 && sh[act[lo]] <= 0.05) lo--;
  while (hi < act.length - 2 && sh[act[hi + 1]] <= 0.05) hi++;
  R.mixDrag = { act, sh, lo, hi, rect, x0, side: 0, on: s.styles.map(x => !!x.on) };
  if (x0 !== e.clientX) rMixMove(e);
});
function rMixMove(e) {
  const d = R.mixDrag; if (!d) return;
  if (!d.side) {
    if (Math.abs(e.clientX - d.x0) < 2) return;
    d.side = e.clientX < d.x0 ? -1 : 1;
    const p = d.side < 0 ? d.lo : d.hi;
    d.k = d.act[p]; d.n = d.act[p + 1];
    d.before0 = d.act.slice(0, p).reduce((a, i) => a + d.sh[i], 0); d.pair = d.sh[d.k] + d.sh[d.n];
  }
  const B = Math.max(0, Math.min(100, (e.clientX - d.rect.left) / d.rect.width * 100));
  const a = Math.max(0, Math.min(d.pair, B - d.before0));
  const sh = d.sh.slice(); sh[d.k] = a; sh[d.n] = d.pair - a; d.cur = sh; d.on[d.k] = d.on[d.n] = true;
  R.mixSh = sh; renderRMix(Object.assign({}, R.last, { styles: R.last.styles.map((x, i) => Object.assign({}, x, { on: d.on[i] })) })); R.mixSh = null;
}
$('#rmixTrack').addEventListener('pointermove', rMixMove);
const rMixEnd = () => { const d = R.mixDrag; if (!d) return; R.mixDrag = null; if (d.cur) sendMix(d.cur, d.on); };
$('#rmixTrack').addEventListener('pointerup', rMixEnd);
$('#rmixTrack').addEventListener('pointercancel', rMixEnd);

/* ---------- очередь на пульте: перетаскивание вместо ↑ ----------
   палец: подержать ~0,3 с и тянуть; мышь: зажать и тянуть. белая линия — куда встанет трек */
let rq = null;
// нажали и отпустили — меню трека (настройки); подержали ~0,25 с и повели — перетаскивание; быстро провели — прокрутка.
// мышь: зажать и тянуть — перетаскивание; подержать на месте или правая кнопка — меню
$('#queue').addEventListener('pointerdown', e => {
  const li = e.target.closest('li[data-key]'); if (!li || e.target.closest('button')) return;
  if (e.button === 2) return;
  const lis = [...$('#queue').querySelectorAll('li[data-key]')];
  rq = { li, from: lis.indexOf(li), x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== 'mouse', active: false, moved: false, to: -1 };
  R.qDrag = true;   // пока палец на треке, очередь не перерисовываем (иначе строка под пальцем заменится)
  const d = rq; d.timer = setTimeout(() => { if (rq === d) rqLift(); }, 250);
});
function rqLift() {
  const d = rq; if (!d) return; d.active = true; R.qDrag = true;
  try { $('#queue').setPointerCapture(d.id); } catch { }
  d.li.classList.add('rq-hold');
  if (d.touch && navigator.vibrate) navigator.vibrate(15);
}
function rqStart() {
  const d = rq; if (!d) return; d.active = true; d.moved = true; R.qDrag = true;
  try { $('#queue').setPointerCapture(d.id); } catch { }
  d.li.classList.remove('rq-hold'); d.li.classList.add('rq-src'); document.body.classList.add('rq-dragging');
  d.ghost = document.createElement('div'); d.ghost.className = 'rq-ghost'; d.ghost.textContent = d.li.querySelector('b').textContent;
  d.line = document.createElement('div'); d.line.className = 'rq-line';
  document.body.append(d.ghost, d.line);
}
$('#queue').addEventListener('pointermove', e => {
  const d = rq; if (!d) return;
  const far = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8;
  if (!d.active) {
    if (far) { if (d.touch) { clearTimeout(d.timer); rq = null; R.qDrag = false; return; } clearTimeout(d.timer); rqStart(); } else return;   // палец сдвинулся раньше времени — это прокрутка
  }
  e.preventDefault();
  rqMove(e.clientX, e.clientY);
}, { passive: false });
// перемещение поднятого трека: и от pointer-, и от touch-событий (телефон может отменить pointer-события)
function rqMove(x, y) {
  const d = rq; if (!d || !d.active) return;
  if (!d.moved) { if (Math.hypot(x - d.x, y - d.y) <= 8) return; rqStart(); }
  d.lastX = x; d.lastY = y;
  // у края экрана список сам прокручивается, чтобы трек можно было унести дальше видимого
  d.edge = y < 80 ? -1 : y > innerHeight - 80 ? 1 : 0;
  if (d.edge && !d.scroller) d.scroller = setInterval(() => { const q = rq; if (!q || !q.edge) { clearInterval(d.scroller); d.scroller = null; return; } scrollBy(0, q.edge * 9); rqMove(q.lastX, q.lastY); }, 16);
  d.ghost.style.left = (x + 12) + 'px'; d.ghost.style.top = (y - 18) + 'px';
  const lis = [...$('#queue').querySelectorAll('li[data-key]')]; let to = lis.length;
  for (let i = 0; i < lis.length; i++) { const r = lis[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { to = i; break; } }
  d.to = to;
  const ref = lis[Math.min(to, lis.length - 1)].getBoundingClientRect(), yl = to < lis.length ? ref.top : ref.bottom;
  Object.assign(d.line.style, { left: ref.left + 'px', width: ref.width + 'px', top: (yl - 2) + 'px' });
}
const eatClick = () => { const stop = ev => { ev.stopPropagation(); ev.preventDefault(); }; document.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => document.removeEventListener('click', stop, true), 0); };
const rqEnd = drop => {
  const d = rq; rq = null; if (!d) return; clearTimeout(d.timer); clearInterval(d.scroller);
  R.qDrag = false;
  if (!d.active) { if (drop) { eatClick(); openTm(d.li); } return; }   // просто нажали и отпустили — меню трека
  d.li.classList.remove('rq-hold');
  if (!d.moved) { eatClick(); if (drop) openTm(d.li); return; }   // подержали и отпустили — меню трека
  d.ghost.remove(); d.line.remove(); d.li.classList.remove('rq-src'); document.body.classList.remove('rq-dragging');
  let to = d.to; if (drop && to >= 0) { if (to > d.from) to--; if (to !== d.from) { send('move', { from: d.from, to }).then(ok => ok && toast('Порядок изменён')); } }
  eatClick();   // клик после перетаскивания не считаем нажатием кнопки
};
$('#queue').addEventListener('pointerup', () => rqEnd(true));
$('#queue').addEventListener('pointercancel', () => { if (rq && rq.active) return; rqEnd(false); });   // поднятый трек не роняем
// телефон: как только трек «поднят» (подержали палец), страница не прокручивается — палец двигает трек.
// Без этого браузер начинает прокрутку и обрывает перетаскивание.
$('#queue').addEventListener('touchmove', e => { if (rq && rq.active) { e.preventDefault(); const p = e.touches[0]; if (p) rqMove(p.clientX, p.clientY); } }, { passive: false });
// касание закончилось (в т. ч. после отменённого pointer-события) — завершаем перетаскивание по последнему месту
$('#queue').addEventListener('touchend', () => { if (rq && rq.active) rqEnd(true); });
$('#queue').addEventListener('touchcancel', () => { if (rq && rq.active) rqEnd(false); });
$('#queue').addEventListener('contextmenu', e => { e.preventDefault(); const li = e.target.closest('li[data-key]'); if (li && !rq) openTm(li); });
/* ---------- послушать трек на телефоне (в наушниках), пока на ноутбуке играет другой ----------
   🎧 у трека — панель внизу: ▶/⏸, перемотка по полосе, «Включить на ноутбуке» — переключить зал на этот трек */
const PV = { key: null, a: new Audio() };
PV.a.preload = 'auto';
(function pvBuild() {
  const el = document.createElement('div'); el.id = 'pv'; el.className = 'pv'; el.hidden = true;
  el.innerHTML = `<div class="pv-top">
      <span class="pv-ic">${ICON_PHONES}</span>
      <span class="pv-m"><b id="pvTitle"></b><span id="pvSub"></span></span>
      <button id="pvToggle" class="pv-btn" title="Пауза / продолжить">${ICON_PAUSE}</button>
      <button id="pvClose" class="pv-btn" title="Закрыть">${ICON_X}</button>
    </div>
    <div class="pv-bar" id="pvBar"><div class="pv-fill" id="pvFill"></div></div>
    <div class="pv-row"><span id="pvCur">0:00</span><button id="pvGo" class="pv-go">Включить на ноутбуке</button><span id="pvLeft">−0:00</span></div>`;
  document.body.appendChild(el);
})();
function pvOpen(key) {
  const t = S.byKey.get(key); if (!t) return;
  if (PV.key === key && !$('#pv').hidden) { pvToggle(); return; }
  PV.key = key;
  PV.a.src = '/media/' + t.i; PV.a.currentTime = 0;
  PV.a.play().catch(() => toast('Не удалось включить на телефоне'));
  $('#pvTitle').textContent = titleOf(t);
  $('#pvSub').textContent = [artistOf(t), bpmOf(t) ? bpmOf(t) + ' BPM' : ''].filter(Boolean).join(' · ');
  $('#pv').hidden = false; document.body.classList.add('pv-on');
  pvMark(); pvShow();
}
function pvToggle() { if (PV.a.paused) PV.a.play().catch(() => { }); else PV.a.pause(); }
function pvClose() { PV.a.pause(); PV.a.removeAttribute('src'); PV.a.load(); PV.key = null; $('#pv').hidden = true; document.body.classList.remove('pv-on'); pvMark(); }
// какой трек сейчас слушают — у его 🎧 подсветка (и в очереди, и в поиске)
function pvMark() { document.querySelectorAll('.list li[data-key]').forEach(li => li.classList.toggle('pv-cur', li.dataset.key === PV.key)); }
function pvShow() {
  const d = PV.a.duration || 0, p = PV.a.currentTime || 0;
  $('#pvFill').style.width = (d ? p / d * 100 : 0) + '%';
  $('#pvCur').textContent = fmtTime(p); $('#pvLeft').textContent = '−' + fmtTime(Math.max(0, d - p));
  $('#pvToggle').innerHTML = PV.a.paused ? ICON_PLAY : ICON_PAUSE;
}
PV.a.addEventListener('timeupdate', pvShow); PV.a.addEventListener('play', pvShow); PV.a.addEventListener('pause', pvShow);
PV.a.addEventListener('loadedmetadata', pvShow); PV.a.addEventListener('ended', pvShow);
$('#pvToggle').onclick = pvToggle;
$('#pvClose').onclick = pvClose;
// перемотка: нажать или вести пальцем по полосе
$('#pvBar').addEventListener('pointerdown', e => {
  const bar = e.currentTarget, seek = ev => { const r = bar.getBoundingClientRect(), d = PV.a.duration; if (d) { PV.a.currentTime = Math.max(0, Math.min(d - 0.3, (ev.clientX - r.left) / r.width * d)); pvShow(); } };
  seek(e); try { bar.setPointerCapture(e.pointerId); } catch { }
  const up = () => { bar.removeEventListener('pointermove', seek); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); };
  bar.addEventListener('pointermove', seek); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
});
// переключить ноутбук на прослушанный трек (с начала); на телефоне прослушивание останавливается
$('#pvGo').onclick = () => {
  const key = PV.key, t = key && S.byKey.get(key); if (!t) return;
  const title = titleOf(t);
  if (R.st && R.st.cur && !R.st.paused && !confirm(`Прервать текущий трек на ноутбуке и включить «${title}»?`)) return;
  send('play', { key }).then(ok => { if (ok) { toast('Играет на ноутбуке: ' + esc(title)); pvClose(); } });
};
// очередь и поиск перерисовываются — подсветку прослушиваемого трека возвращаем
new MutationObserver(pvMark).observe($('#queue'), { childList: true });
new MutationObserver(pvMark).observe($('#results'), { childList: true });

/* ---------- меню трека в очереди: подержать палец на треке ----------
   трек подсвечен, остальное размыто; огоньки, BPM (числом или «Тык»), комментарий, теги, убрать / «Не в моём вкусе» */
const TM = { key: null, item: null, tap: makeTapper() };
function tmItem(key) { return ((R.st && R.st.queue) || []).find(q => q.key === key) || null; }
function openTm(li) {
  const key = li.dataset.key, q0 = tmItem(key); if (!q0) return;
  closeTm();
  const q = Object.assign({}, q0, { tags: (q0.tags || []).slice(), tagsAdd: (q0.tagsAdd || []).slice(), tagsDel: (q0.tagsDel || []).slice() });
  TM.key = key; TM.item = q; TM.tap.reset();
  const r = li.getBoundingClientRect();
  const wrap = document.createElement('div'); wrap.id = 'tm'; wrap.className = 'tm';
  // копия строки внутри такого же списка — выглядит ровно как в очереди, только кнопки справа убраны
  const row = document.createElement('ol'); row.className = 'list tm-row';
  const copy = li.cloneNode(true); copy.classList.remove('rq-hold', 'pv-cur'); copy.querySelectorAll('.a').forEach(a => a.remove()); row.appendChild(copy);
  const sh = document.createElement('div'); sh.className = 'tm-sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', 'Трек');
  wrap.append(row, sh); document.body.appendChild(wrap);
  tmPaint();
  // строка трека остаётся на своём месте; если окну не хватает места снизу — строка поднимается
  Object.assign(row.style, { left: r.left + 'px', width: r.width + 'px', top: r.top + 'px' });
  const rowH = row.offsetHeight, shH = sh.offsetHeight, gap = 8, pad = 10;
  const top = Math.max(pad, Math.min(r.top, innerHeight - pad - shH - gap - rowH));
  Object.assign(row.style, { left: r.left + 'px', width: r.width + 'px', top: r.top + 'px' });
  sh.style.top = (top + rowH + gap) + 'px';
  void wrap.offsetWidth;   // зафиксировать начальное положение, чтобы сработала анимация
  wrap.classList.add('on'); row.style.top = top + 'px';
}
function closeTm() { const w = $('#tm'); if (w) w.remove(); TM.key = null; TM.item = null; }
function tmPaint() {
  const sh = $('#tm .tm-sheet'), q = TM.item; if (!sh || !q) return;
  const x = q.x || 0, on = new Set((q.tags || []).map(g => g.name));
  sh.innerHTML = `
    <div class="tm-sec"><span class="tm-l">Огоньки</span>
      <div class="tm-fires">${[1, 2, 3].map(n => `<button data-tx="${n}" class="${n <= x ? 'on' : ''}" title="${n === x ? 'Ещё раз — убрать' : 'Огоньков: ' + n}">${iconHeart(n <= x)}</button>`).join('')}</div></div>
    <div class="tm-sec"><span class="tm-l">BPM</span>
      <div class="tm-bpm"><input id="tmBpm" type="number" inputmode="numeric" min="40" max="400" value="${q.bpm || ''}" placeholder="—"><button id="tmTap" class="tm-tap" title="Стучите в такт">Тык</button></div></div>
    <div class="tm-sec col"><span class="tm-l">Комментарий</span>
      <textarea id="tmNote" rows="2" placeholder="например: для разминки">${esc(q.note || '')}</textarea></div>
    <div class="tm-sec col"><span class="tm-l">Теги</span>
      <div class="tm-tags">${(S.settings ? S.settings.styles : []).map(s => `<button data-tag="${esc(s.name)}" class="${on.has(s.name) ? 'on' : ''}"><i style="background:${esc(s.color)}"></i>${esc(s.name)}</button>`).join('')}</div></div>
    <button id="tmShare" class="tm-share">Отправить файл</button>
    <div class="tm-act">
      <button id="tmUnq">Убрать из очереди</button>
      <button id="tmTrash" class="danger">Не в моём вкусе</button>
    </div>
    <div class="tm-foot"><button id="tmCancel">Закрыть</button><button id="tmSave" class="pri">Сохранить</button></div>`;
}
document.addEventListener('click', async e => {
  const w = $('#tm'); if (!w) return;
  if (e.target === w || e.target.closest('.tm-row')) { closeTm(); return; }
  const q = TM.item, key = TM.key; if (!q) return;
  const fx = e.target.closest('[data-tx]');
  if (fx) {   // огоньки — сразу
    const n = +fx.dataset.tx, x = n === (q.x || 0) ? 0 : n; q.x = x;
    const keep = [$('#tmBpm').value, $('#tmNote').value]; tmPaint(); $('#tmBpm').value = keep[0]; $('#tmNote').value = keep[1];
    send('setX', { key, x }).then(ok => ok && toast(x ? `Огоньков: ${x}` : 'Огоньки убраны'));
    return;
  }
  const tg = e.target.closest('[data-tag]');
  if (tg) {   // тег — сразу; ручные теги считаем от того, что прислал ноутбук
    const name = tg.dataset.tag, has = q.tags.some(g => g.name === name);
    const add = q.tagsAdd.filter(n => n !== name), del = q.tagsDel.filter(n => n !== name);
    if (has) del.push(name); else add.push(name);
    q.tagsAdd = add; q.tagsDel = del;
    q.tags = has ? q.tags.filter(g => g.name !== name) : q.tags.concat([{ name }]);
    tg.classList.toggle('on', !has);
    send('tags', { key, add, del }).then(ok => ok && toast((has ? 'Тег убран: ' : 'Тег добавлен: ') + esc(name)));
    return;
  }
  if (e.target.closest('#tmTap')) return;
  if (e.target.closest('#tmCancel')) { closeTm(); return; }
  if (e.target.closest('#tmShare')) { const t = S.byKey.get(key); closeTm(); if (t) { toast('Готовлю файл…'); shareTrackFile(t).then(ok => toast(ok ? 'Готово' : 'Не удалось получить файл')); } return; }
  if (e.target.closest('#tmUnq')) { closeTm(); send('unqueue', { key }).then(ok => ok && toast('Убрано из очереди')); return; }
  if (e.target.closest('#tmTrash')) {
    if (!confirm(`Убрать трек в папку «Не в моём вкусе»?\n\n${q.title} — ${q.artist || ''}`)) return;
    closeTm(); send('trash', { key }).then(ok => ok && toast('Убран в «Не в моём вкусе»')); return;
  }
  if (e.target.closest('#tmSave')) {
    const raw = $('#tmBpm').value, b = Math.round(+raw || 0), note = $('#tmNote').value.trim(), done = [];
    if (raw && !(b >= 40 && b <= 400)) { toast('BPM — число от 40 до 400'); return; }
    closeTm();
    if (b && b !== (q.bpm || 0)) { try { await postBpm(key, b); done.push('BPM ' + b); } catch { toast('Нет связи с компьютером'); return; } }
    if (note !== (q.note || '')) { if (await send('note', { key, note })) done.push('комментарий'); }
    toast(done.length ? 'Сохранено: ' + done.join(', ') : 'Без изменений');
    setTimeout(poll, 600);
  }
});
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('#tmTap'); if (!b) return;
  e.preventDefault();
  const v = TM.tap.tap(); if (v >= 40 && v <= 400) $('#tmBpm').value = v;
  b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 90);
  if (navigator.vibrate) navigator.vibrate(8);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTm(); });
