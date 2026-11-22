'use strict';
/* SwingDJ — всё в браузере: чтение тегов, подбор треков, плеер. Сервер только отдаёт файлы. */


const S = {
  root: '', tracks: [], byKey: new Map(), cache: {}, overrides: {}, settings: null, ratings: {}, ratingsV: null,
  history: [], queue: [], cur: null, sort: { k: 'artist', dir: 1 }, scanning: false,
  loud: {},   // замеры громкости: key → { lu, pk }
};


/* ---------- сохранение ---------- */
function postJSON(url, obj) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
    .catch(e => console.warn('save failed', e));
}
const saveState = debounce(() => postJSON('/api/state', {
  v: 1, settings: S.settings, overrides: S.overrides, history: S.history, histSt: S.histSt, loud: S.loud,
}), 600);
function saveCacheNow() {
  const out = {};
  for (const t of S.tracks) if (t.tags) out[t.ck] = t.tags;
  S.cache = out;
  return postJSON('/api/cache', out);
}
const saveCache = debounce(saveCacheNow, 3000);

/* =========================================================
   Подбор следующего трека
   ========================================================= */
// Какой стиль нужен следующим, чтобы доля в последних N треках была как заказано
// название для сравнения «тот же трек»: без номера-BPM в начале, без скобок «(live)», регистра и знаков
const TITLE_GAP = 5;
const PAIR_CHANCE = 0.35;   // как часто направление звучит два трека подряд (пара), вместо строгого чередования
const normTitle = t => (titleOf(t) || '').toLowerCase().replace(/^\s*\d+\s*[-–—.]?\s*/, '').replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function pickStyle(hist, skip) {
  const st = S.settings;
  const act = st.styles.map((s, k) => ({ s, k })).filter(o => +o.s.w > 0 && !(skip && skip.has(o.k)));
  if (!act.length) return -1;
  if (act.length === 1) return act[0].k;
  // доли считаются с момента, когда вы их последний раз меняли (st.mixFrom — место в истории): всё, что сыграно
  // после этого, плюс очередь. До изменения — не в счёт
  const sum = act.reduce((a, o) => a + +o.s.w, 0);
  const counts = new Array(st.styles.length).fill(0);
  const from = Math.max(0, Math.min(hist.length, st.mixFrom | 0), hist.length - 300);
  // под какой стиль трек подобран: в очереди — hist.st, сыгранный — S.histSt (запоминается при игре)
  const knownSt = i => { const q = hist.st && hist.qStart != null && i >= hist.qStart ? hist.st[i - hist.qStart] : (S.histSt || [])[i];
    return q != null && q >= 0 ? q : undefined; };
  for (let i = from; i < hist.length; i++) {
    const qs = knownSt(i);
    if (qs != null && +st.styles[qs]?.w > 0) { counts[qs]++; continue; }
    const t = S.byKey.get(hist[i]); if (!t) continue;
    // трек с несколькими тегами делит «счёт» между ними поровну (среди стилей с долей)
    const ks = styleTags(t).map(g => g.k).filter(k => +st.styles[k].w > 0);
    for (const k of ks) counts[k] += 1 / ks.length;
  }
  // направления чередуются: стиль предыдущего трека (в т. ч. поставленного вами со звездой) подряд не повторяем,
  // если есть другие. Исключение — стиль с долей больше половины: ему без повторов подряд не набрать свою долю
  const prev = S.byKey.get(hist[hist.length - 1]);
  const pq = knownSt(hist.length - 1);
  const prevKs = pq != null ? new Set([pq]) : prev ? new Set(styleTags(prev).map(g => g.k)) : new Set();
  let pool = act.filter(o => !prevKs.has(o.k) || +o.s.w / sum > 0.5);
  if (!pool.length) pool = act;
  // равномерно, без кучек: после m треков стилю с долей p «положено» p·(m+1); берём тот, кому недодали больше всех.
  // Так 70/30 идёт Л Б Л Л Б Л Л Б…, 50/50 — строго через один, а в любом куске очереди доли близки к заданным
  const m = hist.length - from;
  // иногда — два трека одного направления подряд (люди растанцевались), даже у стиля с маленькой долей.
  // Только пара (не три), и только если стиль не ушёл заметно сверх своей доли — потом доли выровняются
  const stOf = i => { const q = knownSt(i); if (q != null) return q; const t = S.byKey.get(hist[i]); return t ? styleOfT(t) : -1; };
  const p1 = stOf(hist.length - 1), p2 = stOf(hist.length - 2);
  const po = act.find(o => o.k === p1);
  if (po && p1 !== p2 && Math.random() < PAIR_CHANCE && counts[p1] + 1 - (+po.s.w / sum) * (m + 1) <= (+po.s.w / sum < 0.5 ? 1 : 0.5) + 1e-9) return p1;   // после пары стиль не выше своей доли больше чем на полтрека (у меньшей доли — на трек, иначе пар у неё не было бы)
  // и без длинных серий: стилю с долей p > ½ подряд — не больше ⌈p/(1−p)⌉ (но хотя бы 2): 70/30 → до 3, 60/40 → до 2
  if (po && +po.s.w / sum > 0.5) {
    let run = 0; for (let i = hist.length - 1; i >= 0 && stOf(i) === p1; i--) run++;
    const p = +po.s.w / sum, cap = p >= 0.999 ? Infinity : Math.max(2, Math.ceil(p / (1 - p)));
    if (run >= cap) { const rest = pool.filter(o => o.k !== p1); if (rest.length) pool = rest; }
  }
  const lastAt = k => { for (let i = hist.length - 1; i >= 0; i--) if (stOf(i) === k) return i; return -1; };
  let best = null, bv = -Infinity;
  for (const o of pool) {
    const p = +o.s.w / sum;
    const v = p * (m + 1) - counts[o.k];
    // при равенстве — тот, что дольше не звучал (а не всегда первый в списке): иначе при 50/50 Линди выигрывал бы все ничьи
    if (v > bv + 1e-9 || (Math.abs(v - bv) < 1e-9 && lastAt(o.k) < lastAt(best.k))) { bv = v; best = o; }
  }
  return best.k;
}

function energyTests() {
  const lv = +S.settings.energy, up = S.settings.energyUp;
  return {
    strict: t => { if (!lv) return true; const x = xOf(t); return up ? x >= lv : x === lv; },
    near: t => { if (!lv) return true; const x = xOf(t); return x > 0 && (up ? x >= lv - 1 : Math.abs(x - lv) <= 1); },
  };
}

function planNext(hist, excl, forcedStyle) {
  const st = S.settings, played = new Set(S.history);
  const ok = t => t.tags && !t.bad && !isDisliked(t);
  let base = S.tracks.filter(t => ok(t) && !excl.has(t.key) && !(st.noRepeat && played.has(t.key)));
  let style = -1, inB = null, dist = null;
  if (st.mode === 'mix') {
    style = forcedStyle ?? pickStyle(hist);
    const s = st.styles[style];
    if (s) {
      // трек подходит стилю, если у него есть такой тег (Stealin' Apples с тегами Линди и Бальбоа годится обоим)
      inB = t => styleTags(t).some(g => g.k === style);
      // у стиля «без учёта темпа» замены «ближайшим по темпу» нет: чужой трек туда не подставляем
      dist = s.anyBpm ? null : t => { const b = bpmOf(t); return !b ? 1e9 : b < +s.min ? +s.min - b : b > +s.max ? b - +s.max : 0; };
    }
  } else if (st.mode === 'bpm') {
    const c = +st.bpmTarget, tol = +st.bpmTol;
    // треки стилей «без учёта темпа» (Буги) в «точный BPM» не берём — это режим для танцев по темпу
    inB = t => { const b = bpmOf(t); return b > 0 && Math.abs(b - c) <= tol && !isExclusiveTrack(t); };
    dist = t => { const b = bpmOf(t); return b ? Math.abs(b - c) : 1e9; };
  }
  // повторы (кнопка «повторы» над очередью): когда свежих треков нужного стиля нет, можно брать уже
  // сыгранные и уже стоящие в очереди
  const repOn = !!st.repeat;
  let all = repOn ? S.tracks.filter(ok) : null;
  let rep = false;
  if (!base.length) { if (!all || !all.length) return null; base = all; rep = true; }
  // трек с тем же названием (тот же файл или другая версия) — не раньше чем через 5 треков.
  // Если без него стилю нечего поставить, срабатывает обычная замена (другой стиль или ближайший по темпу)
  const recent = new Set(hist.slice(-TITLE_GAP).map(k => S.byKey.get(k)).filter(Boolean).map(normTitle));
  const farTitle = t => !recent.has(normTitle(t));
  { const b = base.filter(farTitle); if (b.length) base = b; }
  if (all) { const a = all.filter(farTitle); if (a.length) all = a; }
  const E = energyTests(), B = t => !inB || inB(t);
  let cand = [], relaxed = 0;
  const steps = [t => B(t) && E.strict(t), t => B(t) && E.near(t), B];
  for (let k = 0; k < steps.length; k++) { cand = base.filter(steps[k]); if (cand.length) { relaxed = k; break; } }
  if (!cand.length && all && !rep) {   // свежих нет — повторяем трек нужного стиля, а не подменяем стиль
    for (let k = 0; k < steps.length; k++) { cand = all.filter(steps[k]); if (cand.length) { relaxed = k; rep = true; break; } }
  }
  // для стиля «без учёта темпа» треки кончились — выбираем направление среди остальных по их долям
  // (а не всегда самое большое: иначе при Буги 80 % без треков играл бы один Линди-хоп)
  if (!cand.length && st.mode === 'mix' && style >= 0 && st.styles[style].anyBpm && forcedStyle == null) {
    const alt = pickStyle(hist, new Set([style]));
    if (alt >= 0) { const r = planNext(hist, excl, alt); if (r) r.miss = style; return r; }   // miss — какой стиль хотели
  }
  if (!cand.length && dist) { // нет трека нужного стиля — берём самые близкие по темпу
    let pool = base.filter(E.strict); if (!pool.length) pool = base;
    // не таскаем треки, у которых явно другой стиль (пометка или ручной выбор)
    if (st.mode === 'mix') { const free = pool.filter(t => { const k = styleOfT(t); return k < 0 || styleSource(t) === 'по темпу'; }); if (free.length) pool = free; }
    pool = pool.filter(t => bpmOf(t)).sort((a, b) => dist(a) - dist(b)).slice(0, 5);
    cand = pool; relaxed = 3;
  }
  if (!cand.length) { cand = base; relaxed = 4; }
  const last = S.byKey.get(hist[hist.length - 1]); // не ставим одного артиста подряд
  if (last && artistOf(last)) {
    const la = artistOf(last).toLowerCase(), c2 = cand.filter(t => artistOf(t).toLowerCase() !== la);
    if (c2.length) cand = c2;
  }
  if (rep) {   // из повторов — сначала то, что давно не звучало и чего ещё нет в очереди
    const ago = t => { const i = hist.lastIndexOf(t.key); return i < 0 ? 1e9 : hist.length - i; };   // hist = сыгранные + уже подобранные
    // при повторах важнее разнообразие, чем точные огоньки: берём все треки нужного стиля
    if (relaxed < 3) { const wide = (all || base).filter(B); if (wide.length > cand.length) cand = wide; }
    const fresh = cand.filter(t => !excl.has(t.key)); if (fresh.length) cand = fresh;
    cand = cand.slice().sort((a, b) => ago(b) - ago(a)).slice(0, Math.max(1, Math.ceil(cand.length / 2)));
  }
  return { t: pickByFire(cand), style, relaxed, rep };
}
// случайный трек, но чем больше огоньков, тем чаще (веса в настройках «Как часто играют»)
function pickByFire(cand) {
  const w = S.settings.fireW || [1, 1, 1, 1];
  const weights = cand.map(t => Math.max(0, +w[xOf(t)] || 0));
  let sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return cand[Math.floor(Math.random() * cand.length)];
  let r = Math.random() * sum;
  for (let k = 0; k < cand.length; k++) { r -= weights[k]; if (r < 0) return cand[k]; }
  return cand[cand.length - 1];
}

function refill() {
  const hist = S.history.slice(); hist.qStart = hist.length; hist.st = [];   // доли считаются по самой очереди (st — стиль каждого места)
  const excl = new Set(S.queue.map(q => q.key)); if (S.cur) excl.add(S.cur);
  for (const q of S.queue) { hist.push(q.key); hist.st.push(q.style); }
  while (S.queue.length < S.settings.queueLen) {
    const n = planNext(hist, excl); if (!n) break;
    S.queue.push({ key: n.t.key, manual: false, style: n.style, relaxed: n.relaxed, miss: n.miss, rep: n.rep });
    excl.add(n.t.key); hist.push(n.t.key); hist.st.push(n.style);
  }
}
// пересобрать очередь: треки со звездой (поставленные или передвинутые вами) остаются на СВОИХ местах
// и в своём порядке; заново подбираются только плановые треки в промежутках между ними
function rebuildQueue() {
  const old = S.queue, lastManual = old.reduce((a, q, k) => q.manual ? k : a, -1);
  const len = Math.max(S.settings.queueLen, lastManual + 1);
  const hist = S.history.slice(); hist.qStart = hist.length; hist.st = []; const excl = new Set(old.filter(q => q.manual).map(q => q.key)); if (S.cur) excl.add(S.cur);
  const out = [];
  for (let i = 0; i < len; i++) {
    const q = old[i];
    if (q && q.manual) { out.push(q); hist.push(q.key); hist.st.push(q.style); continue; }
    const n = planNext(hist, excl); if (!n) continue;   // не нашлось — ручные просто сдвинутся, порядок тот же
    out.push({ key: n.t.key, manual: false, style: n.style, relaxed: n.relaxed, miss: n.miss, rep: n.rep });
    excl.add(n.t.key); hist.push(n.t.key); hist.st.push(n.style);
  }
  S.queue = out;
  refill();
}
function replan() { rebuildQueue(); renderQueue(); scheduleLibRender(); }
function reroll(k) {
  const q = S.queue[k]; if (!q) return;
  const hist = S.history.concat(S.queue.slice(0, k).map(x => x.key)); hist.qStart = S.history.length; hist.st = S.queue.slice(0, k).map(x => x.style);
  const excl = new Set(S.queue.map(x => x.key)); if (S.cur) excl.add(S.cur);
  const n = planNext(hist, excl, S.settings.mode === 'mix' ? q.style : undefined);
  if (n) S.queue[k] = { key: n.t.key, manual: false, style: n.style, relaxed: n.relaxed, miss: n.miss, rep: n.rep };
  renderQueue(); scheduleLibRender();
}

/* =========================================================
   Плеер
   ========================================================= */
const audio = $('#audio');
let gapTimer = null, gapTick = null, fading = false;

function clearGap() { clearTimeout(gapTimer); clearInterval(gapTick); gapTimer = gapTick = null; $('#gapNote').hidden = true; }
function fadeOut(ms) {
  return new Promise(res => {
    if (audio.paused || !audio.src) return res();
    fading = true;
    const v0 = audio.volume, t0 = performance.now();
    const h = setInterval(() => {
      const k = (performance.now() - t0) / ms;
      if (k >= 1) { clearInterval(h); audio.volume = 0; fading = false; res(); } else audio.volume = v0 * (1 - k);
    }, 40);
  });
}
async function playKey(key, fade = true) {
  const t = S.byKey.get(key); if (!t) return;
  clearGap();
  if (fade) await fadeOut(1500);
  audio.pause();
  audio.src = '/media/' + t.i;
  audio.volume = S.settings.volume;
  S.cur = key; applyGain(true);
  if (S.history[S.history.length - 1] !== key) { S.history.push(key); (S.histSt ||= [])[S.history.length - 1] = S.pendingStyle ?? -1; }
  S.pendingStyle = null;   // стиль, под который трек стоял в очереди, — для счёта долей
  saveState();
  try { await audio.play(); S.playBlocked = false; }
  catch (e) { console.warn(e); if (e.name === 'NotAllowedError') S.playBlocked = true; }
  renderPlayer(); renderHistory(); renderQueue(); scheduleLibRender();
}
async function next(fade = true) {
  if (!S.queue.length) refill();
  const q = S.queue.shift();
  if (!q) { renderQueue(); alert('Нет подходящих треков. Ослабьте фильтры или начните новую вечеринку.'); return; }
  S.pendingStyle = q.style; await playKey(q.key, fade);
  refill(); renderQueue();
}
// трек из очереди: играем его, остальная очередь остаётся как была
async function playFromQueue(k) {
  const q = S.queue[k]; if (!q) return;
  S.queue.splice(k, 1);
  renderQueue();
  S.pendingStyle = q.style; await playKey(q.key);
  refill(); renderQueue(); scheduleLibRender();
}
function playNow(key) {
  S.queue = S.queue.filter(q => q.key !== key);
  playKey(key).then(replan);
}
// ＋ ставит трек в очередь ещё раз, даже если он уже там или играет сейчас — повторов сколько угодно
// first = true — поставить самым первым (так добавляет пульт: «сыграть следующим»), иначе — после последнего ручного
function addToQueue(key, first = false) {
  const lastManual = S.queue.reduce((a, q, k) => q.manual ? k : a, -1);
  const t = S.byKey.get(key);
  S.queue.splice(first ? 0 : lastManual + 1, 0, { key, manual: true, style: styleOfT(t), relaxed: 0 });
  // плановые треки после ручного пересчитываем, чтобы пропорция сохранилась
  rebuildQueue();
  renderQueue(); scheduleLibRender();
}

audio.addEventListener('ended', () => {
  if (!S.settings.autoNext) { renderPlayer(); return; }
  const gap = Math.max(0, +S.settings.gap || 0);
  if (!gap) { next(false); return; }
  let left = gap;
  const note = $('#gapNote'); note.hidden = false; note.textContent = `Следующий через ${left} с…`;
  gapTick = setInterval(() => { left--; note.textContent = `Следующий через ${Math.max(left, 0)} с…`; }, 1000);
  gapTimer = setTimeout(() => { clearGap(); next(false); }, gap * 1000);
});
audio.addEventListener('error', () => {
  const t = S.byKey.get(S.cur); if (!t || S.trashing || !audio.getAttribute('src')) return;
  t.bad = true;
  $('#nowSub').textContent = 'Браузер не может воспроизвести этот файл — пропускаю';
  setTimeout(() => next(false), 1500);
});
// прогресс: «таблетка» закрашивается чёрным слева направо; время — прошло в начале, осталось в конце
function renderProgress() {
  if (scrub && scrub.moved) return;   // пока тянут — показываем позицию под рукой
  const d = audio.duration, c = audio.currentTime || 0, ok = isFinite(d) && d > 0;
  $('#tCur').textContent = fmtTime(c);
  $('#tLeft').textContent = '−' + fmtTime(ok ? Math.max(0, d - c) : 0);
  $('#mainPill').style.setProperty('--p', (ok ? Math.min(100, c / d * 100) : 0) + '%');
}
for (const ev of ['timeupdate', 'durationchange', 'emptied', 'seeked']) audio.addEventListener(ev, renderProgress);
audio.addEventListener('play', () => { $('#btnPlay').innerHTML = ICON_PAUSE; S.playBlocked = false; scheduleStatus(); });
audio.addEventListener('pause', () => { $('#btnPlay').innerHTML = ICON_PLAY; scheduleStatus(); });
// браузер разрешает звук только после первого клика по странице — пульт должен об этом знать
document.addEventListener('pointerdown', () => { if (S.playBlocked) { S.playBlocked = false; scheduleStatus(); } }, { once: false });

$('#btnPlay').onclick = () => togglePlay();
$('#btnNext').onclick = () => next(true);
// перемотка — только по свободному месту «таблетки». Путь щелчка берём на момент нажатия:
// кнопку-огонёк к этому времени уже перерисовали, и сама она в странице не найдётся
const NO_SEEK = 'button, input, select, label, a, .hearts, .bpm-box, .style-abbr, .style-tags, [role=radio]';
// перемотка «за поле»: зажать свободное место «таблетки» и тянуть — позиция сдвигается на столько,
// на сколько сдвинута рука (вся ширина = весь трек). Простой щелчок без движения — перемотка в точку щелчка
var scrub = null;   // var: renderProgress может спросить раньше этой строки
function showScrub(t) {
  const d = audio.duration;
  $('#tCur').textContent = fmtTime(t); $('#tLeft').textContent = '−' + fmtTime(Math.max(0, d - t));
  $('#mainPill').style.setProperty('--p', Math.min(100, t / d * 100) + '%');
}
$('#mainPill').addEventListener('pointerdown', e => {
  if (e.button !== 0 || !audio.duration || !isFinite(audio.duration)) return;
  if (e.composedPath().some(n => n instanceof Element && n !== e.currentTarget && n.matches(NO_SEEK))) return;
  const r = e.currentTarget.getBoundingClientRect();
  scrub = { id: e.pointerId, x0: e.clientX, t0: audio.currentTime, t: audio.currentTime, w: r.width, left: r.left, moved: false };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
});
$('#mainPill').addEventListener('pointermove', e => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const dx = e.clientX - scrub.x0;
  if (!scrub.moved && Math.abs(dx) < 4) return;
  if (!scrub.moved) { scrub.moved = true; document.body.classList.add('scrubbing'); }
  scrub.t = Math.max(0, Math.min(audio.duration - 0.5, scrub.t0 + dx / scrub.w * audio.duration));
  showScrub(scrub.t);
});
const endScrub = (e, cancel) => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const s = scrub; scrub = null; document.body.classList.remove('scrubbing');
  if (!cancel) audio.currentTime = s.moved ? s.t : Math.max(0, Math.min(1, (e.clientX - s.left) / s.w)) * audio.duration;
  renderProgress();
};
$('#mainPill').addEventListener('pointerup', e => endScrub(e, false));
$('#mainPill').addEventListener('pointercancel', e => endScrub(e, true));

/* ---------- TAP BPM ---------- */
let taps = [], tapValue = 0;
$('#btnTap').onclick = () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);   // все удары серии — темп по среднему промежутку
  if (taps.length >= 4) {
    tapValue = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
    $('#tapBpm').textContent = tapValue + ' bpm';
    $('#btnTapSave').hidden = !S.cur;
  } else $('#tapBpm').textContent = '·'.repeat(taps.length);
};
$('#btnTapSave').onclick = () => {
  if (S.cur && tapValue) setOverride(S.cur, 'bpm', tapValue);
  $('#btnTapSave').hidden = true;
};

function setOverride(key, field, val) {
  const o = S.overrides[key] || (S.overrides[key] = {});
  if (val == null || val === '') delete o[field]; else o[field] = val;
  if (field === 'x') { if (o.x == null) delete o.xts; else o.xts = Date.now(); } // сравнивается со временем оценки в тиндере
  if (field === 'bpm') { if (o.bpm == null) delete o.bpmts; else o.bpmts = Date.now(); } // и со временем тапа в тиндере
  if (!Object.keys(o).length) delete S.overrides[key];
  saveState(); renderPlayer(); renderQueue(); renderStyles(); renderStats(); scheduleLibRender();
}

/* =========================================================
   Отрисовка
   ========================================================= */
const xBadge = (x, isOv) => `<span class="xb ${x ? 'x' + x : ''} ${isOv ? 'ov' : ''}" title="${x ? 'огоньков: ' + x : 'без огоньков'}${isOv ? ' (изменено вручную)' : ''}">${x ? fires(x) : '—'}</span>`;
const styleChip = t => {
  // нет «основного» стиля (выключено «по темпу») — показываем стили, подходящие по темпу (как теги в очереди)
  const k = styleOfT(t); if (k < 0) { const tt = styleTags(t); return tt.length ? `<span class="stags lib-tags">${tagChips(tt)}</span>` : '<span class="hint">—</span>'; }
  const src = styleSource(t), mark = src === 'выбран вручную' ? ' ✎' : src === 'по пометке в комментарии' ? ' 🏷' : '';
  const tags = styleTags(t); if (tags[0] && mark) tags[0] = Object.assign({}, tags[0], { name: tags[0].name + mark });
  return `<span class="stags lib-tags">${tagChips(tags)}</span>`;
};

// кнопка огоньков играющего трека: клик — селектор 0..3
// три огонька = огоньки трека; клик по n-му ставит n, повторный клик по последнему закрашенному — убирает
function renderNowFire(t) {
  const x = t ? xOf(t) : 0;
  $('#nowHearts').innerHTML = [1, 2, 3].map(n =>
    `<button class="heart ${n <= x ? 'on' : ''}" data-n="${n}" role="radio" aria-checked="${n === x}" ${t ? '' : 'disabled'} title="${n === x ? 'Нажмите ещё раз — убрать огоньки' : 'Огоньков: ' + n}">${iconHeart(n <= x)}</button>`).join('');
}
// «Убрать трек в «Не в моём вкусе»» в меню ⋯: убрать играющий трек из библиотеки (файл — в папку «Не в моём вкусе») и включить следующий
$('#btnTrash').onclick = async e => {
  if (e) e.stopPropagation();
  $('#moreMenu').hidden = true; $('#btnMore').setAttribute('aria-expanded', false); closeTrackPop();
  const key = S.editKey || S.cur, t = S.byKey.get(key); if (!t) return;
  if (!confirm(`Удалить трек из библиотеки?\n\n${titleOf(t)} — ${artistOf(t)}\n${t.p}\n\nФайл переместится в папку «Не в моём вкусе» рядом с музыкой — оттуда его можно вернуть вручную.`)) return;
  if (key !== S.cur) { await trashTracks([key]); return; }   // не играющий — просто убрать из библиотеки
  const wasPlaying = !audio.paused;
  S.trashing = true; audio.pause(); audio.removeAttribute('src'); audio.load(); // отпускаем файл, чтобы Windows дала его переместить
  const ok = await trashTracks([key]); S.trashing = false;
  if (ok) { if (wasPlaying) next(false); else renderPlayer(); }
  else playKey(key);
};
$('#nowHearts').addEventListener('click', e => {
  const b = e.target.closest('button[data-n]'), t = S.byKey.get(S.cur); if (!b || !t) return;
  const n = +b.dataset.n;
  setFire(t.key, n === xOf(t) ? 0 : n);
});
// сокращение стиля, как «Blb» в макете: первая буква + согласные
function styleAbbr(name) {
  const s = (name || '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');
  if (!s) return '';
  const rest = s.slice(1).replace(/[aeiouyаеёиоуыэюяьъ]/gi, '');
  return (s[0].toUpperCase() + rest.toLowerCase()).slice(0, 3);
}
// боковые «таблетки» карусели: предыдущий и следующий трек
// BPM, огоньки и стиль трека — для боковых «таблеток»
function pillMeta(t) {
  if (!t) return '';
  const k = styleOfT(t), name = k >= 0 && S.settings.styles[k] ? S.settings.styles[k].name : '';
  return `<span class="ptags">${tagChips(styleTags(t))}</span><span class="pb">${bpmOf(t) || '—'}<small>BPM</small></span>`
    + (xOf(t) ? `<span class="ph">${fires(xOf(t))}</span>` : '');
}
function renderSidePills() {
  const hist = S.history, prevKey = hist[hist.length - 1] === S.cur ? hist[hist.length - 2] : hist[hist.length - 1];
  const p = S.byKey.get(prevKey), n = S.queue[0] && S.byKey.get(S.queue[0].key);
  $('#prevPill').classList.toggle('empty', !p);
  $('#prevTitle').textContent = p ? titleOf(p) : ''; $('#prevArtist').textContent = p ? artistOf(p) : '';
  $('#prevMeta').innerHTML = pillMeta(p);
  $('#nextPill').disabled = !n;
  $('#nextTitle').textContent = n ? titleOf(n) : 'Очередь пуста'; $('#nextArtist').textContent = n ? artistOf(n) : '';
  $('#nextMeta').innerHTML = pillMeta(n);
  if (!$('#histPop').hidden) renderHistPop();
}
$('#prevPill').onclick = () => {
  const hist = S.history, k = hist[hist.length - 1] === S.cur ? hist[hist.length - 2] : hist[hist.length - 1];
  if (k && S.byKey.has(k)) playNow(k);
};
$('#nextPill').onclick = () => { if (S.queue.length) playFromQueue(0); };
// история: левая «таблетка» при наведении выезжает в прямоугольник со списком сыгранных (4 видно, дальше прокрутка)
let histHideT = 0;
function renderHistPop() {
  const pop = $('#histPop'), hist = S.history.slice();
  if (hist[hist.length - 1] === S.cur) hist.pop();
  const items = hist.slice(-60).reverse().map(k => S.byKey.get(k)).filter(Boolean);
  pop.innerHTML = `<div class="hp-scroll">` + (items.length
    ? `<ol>${items.map(t => { const x = xOf(t), b = bpmOf(t), k = styleOfT(t), st = S.settings.styles[k];
        return `<li data-k="${esc(t.key)}" title="Включить снова">
          <i class="dot" style="background:${esc(tagsBg(t))}"></i>
          <span class="tt"><b>${noteBadge(t)}${esc(titleOf(t))}</b><span>${esc(artistOf(t))}</span></span>
          <span class="sa">${tagChips(styleTags(t))}</span>
          <span class="bpm">${b || '—'}<small>BPM</small></span>
          <span class="hx">${x ? fires(x) : ''}</span>
          <button class="icon hp-edit" data-act="edit" title="Настройки трека">${ICON_MORE}</button>
          </li>`; }).join('')}</ol>`
    : `<div class="hp-empty">Пока ничего не играло</div>`) + `</div><i class="hp-thumb"></i>`;
  const sc = pop.querySelector(".hp-scroll"); sc.addEventListener("scroll", () => histThumb(pop)); requestAnimationFrame(() => histThumb(pop));
}
// свой ползунок прокрутки поверх строк: подсветка строки идёт до самого края
function histThumb(pop) {
  const sc = pop.querySelector(".hp-scroll"), th = pop.querySelector(".hp-thumb"); if (!sc || !th) return;
  const cs = getComputedStyle(pop), row = parseFloat(cs.getPropertyValue("--row")) || 60;
  const ch = row * (+pop.style.getPropertyValue("--n") || 4), sh = sc.scrollHeight, pad = Math.max(12, row / 2), track = ch - pad * 2;
  if (sh <= ch + 1 || track <= 0) { th.style.display = "none"; return; }
  const h = Math.max(24, track * ch / sh), y = pad + (track - h) * sc.scrollTop / (sh - ch);
  th.style.display = ""; th.style.height = h + "px"; th.style.transform = `translateY(${y}px)`;
}
function showHistPop() {
  clearTimeout(histHideT);
  const pop = $('#histPop');
  if (!pop.hidden && pop.classList.contains('open')) return;
  const r = $('#prevPill').getBoundingClientRect();
  renderHistPop(); pop.style.setProperty('--n', Math.max(1, Math.min(4, pop.querySelectorAll('li').length)));
  pop.style.left = r.left + 'px'; pop.style.top = r.top + 'px';
  pop.style.setProperty('--w0', r.width + 'px'); pop.style.setProperty('--h0', r.height + 'px');
  pop.hidden = false; void pop.offsetWidth;
  pop.classList.add('open'); $('.carousel').classList.add('hist-open');
}
const hideHistPop = (ms = 180) => {
  clearTimeout(histHideT);
  histHideT = setTimeout(() => {
    const pop = $('#histPop'); pop.classList.remove('open'); $('.carousel').classList.remove('hist-open');
    histHideT = setTimeout(() => { pop.hidden = true; }, 220);
  }, ms);
};
for (const el of [$('#prevPill'), $('#histPop')]) {
  el.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') showHistPop(); });
  el.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') hideHistPop(); });
}
$('#histPop').addEventListener('click', e => {
  const li = e.target.closest('li[data-k]'); if (!li) return;
  const ed = e.target.closest('[data-act=edit]');
  // ⋯ — настройки уже сыгранного трека (название, теги, BPM, огоньки…), трек при этом не включается
  if (ed) { e.stopPropagation(); hideHistPop(0); openTrackPop(li.dataset.k, ed); return; }
  hideHistPop(0); playNow(li.dataset.k);
});
// меню «⋯» и кнопка звука
$('#btnMore').onclick = e => {
  e.stopPropagation();
  const m = $('#moreMenu'), open = m.hidden;
  m.hidden = !open; $('#btnMore').setAttribute('aria-expanded', open);
  if (open) {
    $('#moreMenu').appendChild($('#trackSec')); closeTrackPop(); renderTrackSec(S.cur);   // блок «Трек» — про играющий трек
    const r = $('#btnMore').getBoundingClientRect();
    m.style.top = (r.bottom + 8) + 'px';
    m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
  }
};
document.addEventListener('pointerdown', e => {
  if (!$('#moreMenu').hidden && !e.target.closest('#moreMenu, #btnMore')) { $('#moreMenu').hidden = true; $('#btnMore').setAttribute('aria-expanded', false); }
});
// иконки панели трека — из common.js, одним стилем
$('#btnNext').innerHTML = ICON_NEXT; $('#btnMute').innerHTML = ICON_VOL; $('#btnMore').innerHTML = ICON_MORE;
$('#btnMute').onclick = () => { audio.muted = !audio.muted; const b = $('#btnMute'); b.innerHTML = audio.muted ? ICON_MUTE : ICON_VOL; b.setAttribute('aria-pressed', audio.muted); };
function setFire(key, x) {
  const t = S.byKey.get(key); if (!t) return;
  x = Math.max(0, Math.min(3, x | 0)); setOverride(key, 'x', x); tagNow(key, { x });
  // в очереди могли стоять треки, подобранные под старые огоньки, — пересобираем только если фильтр по огонькам включён
  if (S.settings.energy) replan();
}
// сменить BPM трека; n пусто/0 — вернуть исходный (из имени файла или тегов) и забыть тап из тиндера
async function setBpm(key, n) {
  n = Math.round(+n || 0);
  if (n > 0) { n = Math.max(40, Math.min(400, n)); setOverride(key, 'bpm', n); tagBpmNow(key, n); }
  else { setOverride(key, 'bpm', null); if (S.bpmTaps[key]) { try { await postBpm(key, null); } catch { } setOverride(key, 'bpm', null); } }
  replan();
}
// окошко смены темпа под BPM в шапке
function closeBpmPop() { document.querySelectorAll('.bpm-pop').forEach(p => p.remove()); }
$('#bpmBox').onclick = e => {
  e.stopPropagation();
  if (document.querySelector('.bpm-pop')) { closeBpmPop(); return; }
  const t = S.byKey.get(S.cur); if (!t) return;
  const orig = t.fileBpm || (t.tags && t.tags.b) || 0;
  const pop = document.createElement('div');
  pop.className = 'bpm-pop';
  pop.innerHTML = `
    <div class="src">${esc(titleOf(t))} · ${esc(bpmSource(t) || 'BPM не задан')}</div>
    <div class="row">
      <input type="number" min="40" max="400" step="1" value="${bpmOf(t) || ''}" placeholder="BPM">
      <button data-b="tap" class="tap-btn" title="Стучите в такт 4+ раз — темп подставится в поле (клавиша T)">Тык</button>
    </div>
    <div class="tap-hint">стучите по «Тык» в такт</div>
    <div class="row acts">
      <button data-b="reset" class="text" title="Вернуть исходный темп${orig ? ': ' + orig : ''}">Сбросить</button>
      <button data-b="save" class="filled">Сохранить</button>
    </div>`;
  document.body.appendChild(pop);
  const r = e.currentTarget.getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
  const inp = pop.querySelector('input'); inp.focus(); inp.select();
  const key = t.key;
  // TAP: каждое нажатие пересчитывает темп и подставляет его в поле
  const tapper = makeTapper(), tapBtn = pop.querySelector('[data-b=tap]'), hint = pop.querySelector('.tap-hint');
  const doTap = () => {
    const v = tapper.tap(), n = tapper.count();
    if (v >= 40 && v <= 400) { inp.value = v; hint.textContent = `ударов: ${n}`; }
    else hint.textContent = n >= 4 ? 'слишком быстро или медленно' : `ещё ${4 - n}…`;
    tapBtn.classList.add('hit'); setTimeout(() => tapBtn.classList.remove('hit'), 90);
  };
  tapBtn.addEventListener('pointerdown', ev => { ev.preventDefault(); doTap(); }); // pointerdown — без задержки клика
  pop.addEventListener('keydown', ev => { if ((ev.key === 't' || ev.key === 'е' || ev.key === 'T') && !ev.repeat) { ev.preventDefault(); doTap(); } });
  const save = () => { const v = +inp.value; closeBpmPop(); if (v > 0) setBpm(key, v); };
  pop.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-b]'); if (!b) return;
    if (b.dataset.b === 'reset') { closeBpmPop(); setBpm(key, 0); }
    else if (b.dataset.b === 'save') save();
  });
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeBpmPop(); }
  });
};
document.addEventListener('pointerdown', e => { if (!e.target.closest('.bpm-pop, #bpmBox')) closeBpmPop(); });
function renderPlayer() {
  const t = S.byKey.get(S.cur);
  renderNowFire(t);
  renderSidePills();
  if (!t) {
    $('#nowTitle').textContent = 'Ничего не играет'; $('#nowSub').textContent = 'Нажмите ▶ — трек подберётся сам';
    $('#nowBpm').textContent = '—'; $('#nowStyle').innerHTML = ''; setNowNote(null); $('#bpmBox').disabled = true; closeBpmPop(); return;
  }
  $('#nowTitle').textContent = titleOf(t); setNowNote(t);
  $('#nowSub').textContent = artistOf(t) || '—';
  $('#nowTitle').title = [titleOf(t), artistOf(t), t.tags && t.tags.y].filter(Boolean).join(' · ');
  const b = bpmOf(t); $('#nowBpm').textContent = b || '—';
  $('#bpmBox').disabled = false;
  $('#bpmBox').title = `Темп${bpmSource(t) ? ' (' + bpmSource(t) + ')' : ''} — нажмите, чтобы изменить`;
  // теги стилей: цветная плашка с названием; основной стиль — первым, затем подходящие по темпу
  const src = styleSource(t);
  $('#nowStyle').innerHTML = styleTags(t).map(g => `<span class="stag${g.main ? ' main' : ''}" style="background:${g.bg};color:${g.ink}"
    title="${esc(g.main ? g.name + (src ? ' — ' + src : '') : g.name + ' — тоже подходит по темпу')}">${esc(g.name)}</span>`).join('')
;
  document.title = '▶ ' + titleOf(t) + ' — SwingDJ';
  if (!$('#moreMenu').hidden && !document.activeElement.closest('#trackSec')) renderTrackSec(S.cur);
  scheduleStatus();
}

/* ---------- длительность трека: тег файла → замер громкости → заголовок файла (лёгкий запрос) ---------- */
const durOf = t => (t.tags && +t.tags.d) || (S.loud && S.loud[t.key] && S.loud[t.key].dur) || t.durProbe || 0;
const fmtDur = t => { const d = durOf(t); return d ? fmtTime(d) : '—'; };
const durQueue = [], durBusy = { n: 0 };
const rerenderForDur = debounce(() => renderQueue(), 300);
function probeDur(t) {
  if (!t || durOf(t) || t.durAsked) return;
  t.durAsked = true; durQueue.push(t); pumpDur();
}
function pumpDur() {
  while (durBusy.n < 2 && durQueue.length) {
    const t = durQueue.shift(); durBusy.n++;
    const a = new Audio(); a.preload = 'metadata';
    const done = () => { a.removeAttribute('src'); a.load(); durBusy.n--; pumpDur(); };
    a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration) && a.duration > 0) { t.durProbe = Math.round(a.duration); rerenderForDur(); } done(); }, { once: true });
    a.addEventListener('error', done, { once: true });
    a.src = '/media/' + t.i;
  }
}
// у играющего трека длительность известна из самого плеера
audio.addEventListener('durationchange', () => { const t = S.byKey.get(S.cur); if (t && isFinite(audio.duration) && audio.duration > 0 && !durOf(t)) t.durProbe = Math.round(audio.duration); });
function renderQueue() {
  const el = $('#queue');
  if (!S.queue.length) {
    const any = S.tracks.some(t => t.tags);
    el.innerHTML = `<li class="empty">${any ? 'Нет подходящих треков — ослабьте фильтры.' : 'Читаю теги…'}</li>`;
  } else {
    el.innerHTML = S.queue.map((q, k) => {
      const t = S.byKey.get(q.key); if (!t) return '';
      const b = bpmOf(t), sk = styleOfT(t); probeDur(t);
      const want = q.style >= 0 && S.settings.styles[q.style] ? S.settings.styles[q.style].name : '';
      const missName = q.miss != null && S.settings.styles[q.miss] ? S.settings.styles[q.miss].name : '';
      const note0 = missName ? `нет трека «${missName}» — взят «${want}»${S.settings.repeat ? '' : ' (включите «повторы» над очередью)'}` : q.relaxed >= 3 ? (want ? `нет трека «${want}» — взят ближайший по темпу` : 'нет трека в нужном темпе — взят ближайший') : '';   // «огоньки не совпали точно» больше не пишем
      const note = [q.rep ? 'повтор' : '', note0].filter(Boolean).join(' · ');
      return `<li data-k="${k}" class="${q.manual ? 'manual' : ''}" title="Зажмите и перетащите, чтобы поменять порядок">
        <button class="qplay" data-qa="play" title="Включить этот трек сейчас">${ICON_PLAY}</button>
        <span class="qm"><b>${esc(titleOf(t))}</b><span>${esc(artistOf(t))}${note ? ` · <span class="relaxed">${note}</span>` : ''}</span></span>
        <span class="qtags">${tagChips(styleTags(t))}</span>
        <span class="qd" title="Длительность">${fmtDur(t)}</span>
        <span class="qb">${b || '—'}</span>
        <button class="qx" data-qa="x" title="Огоньки — нажмите, чтобы выбрать другое число или сбросить">${xBadge(xOf(t))}</button>
        <span class="qa"><button data-qa="note"${noteBtnAttrs(t)}>${ICON_NOTE}</button>
          <button data-qa="roll" title="Заменить на другой трек такого же типа">${ICON_SWAP}</button>
          <button data-qa="edit" title="Настройки трека: название, исполнитель, BPM, огоньки, теги">${ICON_MORE}</button>
          <button data-qa="del" title="Убрать">✕</button>
        </span></li>`;
    }).join('');
  }
  renderPattern(); renderSidePills();
  scheduleStatus();
}

function renderPattern() {   // точки над очередью: следующие треки, цвет — по тегам (несколько — круг поделён под 45°)
  const fut = S.queue.map(q => S.byKey.get(q.key)).filter(Boolean);
  const dot = (t, cls) => `<i class="${cls}" style="background:${esc(tagsBg(t))}" title="${esc(titleOf(t))} · ${bpmOf(t) || '?'} BPM"></i>`;
  $('#pattern').innerHTML = fut.map(t => dot(t, '')).join('');   // только следующие треки
}

function renderHistory() {
  const items = S.history.slice(-60).map(k => S.byKey.get(k)).filter(Boolean).reverse();
  $('#history').innerHTML = items.map(t => `<li><b>${esc(titleOf(t))}</b> — ${esc(artistOf(t))} <span class="hint">${bpmOf(t) || ''}</span></li>`).join('');
  $('#history').start = items.length;
}

function renderStats() {
  const tagged = S.tracks.filter(t => t.tags);
  const withB = tagged.filter(t => bpmOf(t)).length, withX = tagged.filter(t => xOwn(t) > 0).length;
  $('#stats').innerHTML = `Треков: <b>${S.tracks.length}</b>, с BPM: <b>${withB}</b>, с огоньками: <b>${withX}</b><br>Сыграно за вечер: <b>${S.history.length}</b>`;
  renderFireShare(); renderTagBtn();
}

/* ---------- тиндер: ссылка для телефона, счётчики, список дизлайков ---------- */
function renderTinder() {
  const all = Object.values(S.ratings);
  const n = r => all.filter(x => x.r === r).length;
  const unrated = S.tracks.filter(t => !ratingOf(t) && xOwn(t) == null).length;
  const razn = S.tracks.filter(t => { const r = ratingOf(t); return !isDisliked(t) && xOf(t) === 2 && !(r && r.rz); }).length;
  $('#tinderStats').innerHTML = `${HEART} понравились: <b>${n('like')}</b> · ✕ нет: <b>${n('dislike')}</b> · ⏰ позже: <b>${n('later')}</b><br>Без оценки (считаются на ${HEART}): <b>${unrated}</b> · ждут «Разноса»: <b>${razn}</b>`;
  const dis = S.tracks.filter(isDisliked).sort((a, b) => (ratingOf(b).t || 0) - (ratingOf(a).t || 0));
  $('#dislikeCard').hidden = !dis.length;
  $('#dislikeCount').textContent = dis.length ? `(${dis.length})` : '';
  $('#dislikes').innerHTML = dis.map(t => `<li data-key="${esc(t.key)}">
      <span class="qm"><b>${esc(titleOf(t))}</b><span>${esc(artistOf(t))} · ${bpmOf(t) || '—'} BPM · ${esc(t.p)}</span></span>
      <span class="qa">
        <button data-da="listen" title="Послушать в плеере">${ICON_PLAY}</button>
        <button data-da="keep" title="Оставить: убрать из дизлайков">↩ оставить</button>
        <button data-da="trash" class="danger" title="Переместить файл в папку «Не в моём вкусе»">в «Не в моём вкусе»</button>
      </span></li>`).join('');
}
async function trashTracks(keys) {
  let ok = 0, fail = 0;
  for (const key of keys) {
    try {
      const r = await fetch('/api/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch { } throw new Error(r.status === 403 ? 'Убирать файлы можно только с этого компьютера (адрес localhost).' : 'Не удалось переместить файл: ' + (m || 'ошибка ' + r.status)); }
      ok++;
      if (S.cur === key) { audio.pause(); S.cur = null; }
      S.queue = S.queue.filter(q => q.key !== key);
      delete S.ratings[key];
      S.tracks = S.tracks.filter(t => t.key !== key); S.byKey.delete(key);
    } catch (e) { fail++; if (fail === 1) alert(e.message); }
  }
  refill(); renderAll();
  return ok;
}
async function pollRatings() {
  try {
    const d = await getJSON('/api/ratings');
    if (d.v === S.ratingsV) return;
    applyRatings(d);
    S.queue = S.queue.filter(q => { const t = S.byKey.get(q.key); return t && !isDisliked(t); });
    refill(); renderQueue(); renderStats(); renderTinder(); renderPlayer(); scheduleLibRender();
  } catch { }
}

function renderSettings() {
  const st = S.settings;
  document.querySelectorAll('#energySeg button').forEach(b => { const x = +b.dataset.x; b.classList.toggle('on', x === +st.energy); b.classList.toggle('f', x > 0 && x <= +st.energy); b.setAttribute('aria-checked', x === +st.energy); });
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode));
  $('#modeBpm').hidden = st.mode !== 'bpm';
  $('#modeMix').hidden = st.mode !== 'mix';
  $('#bpmTarget').value = st.bpmTarget; $('#bpmTol').value = st.bpmTol;
  $('#noRepeat').checked = st.noRepeat; $('#autoNext').checked = st.autoNext; renderRepeatBtn(); if (!colDrag) applyLibCols();
  $('#gap').value = st.gap; $('#vol').value = st.volume;
  $('#normOn').checked = !!st.normOn; renderLoudInfo();

  renderStyles(); renderFilterOptions();
}

function renderStyles() {
  const st = S.settings, sum = st.styles.reduce((s, x) => s + (+x.w || 0), 0);
  const counts = st.styles.map(() => 0), tagged = st.styles.map(() => 0);
  for (const t of S.tracks) {
    if (!t.tags) continue;
    for (const g of styleTags(t)) counts[g.k]++;   // считаем по тегам: трек с двумя тегами идёт в оба стиля
    const k = styleOfT(t); if (k >= 0 && styleSource(t) !== 'по темпу') tagged[k]++;
  }
  S.styleCounts = counts;   // для полосы долей: предупреждение «нет треков»
  $('#styles').innerHTML = st.styles.map((s, k) => `
    <div class="style-row ${inMix(st, k) ? '' : 'off'} ${(S.openStyles && S.openStyles.has(k)) ? 'open' : ''}" data-k="${k}" style="--sc:${esc(s.color)}">
      <input type="color" data-f="color" value="${esc(s.color)}">
      <input class="sname" data-f="name" value="${esc(s.name)}">
      <button class="st-tog" data-f="tog" title="${(S.openStyles && S.openStyles.has(k)) ? 'Свернуть' : 'Развернуть: темп, пометки, число треков'}" aria-expanded="${(S.openStyles && S.openStyles.has(k))}"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <button class="del" data-f="del" title="Удалить стиль">✕</button>
      <div class="bpmr">${s.anyBpm ? `<span class="anyb">темп не важен — по пометке, жанру или вручную</span>` : `<input type="number" data-f="min" value="${s.min}"> – <input type="number" data-f="max" value="${s.max}"> BPM
        <i class="shade" title="Цвет треков этого стиля: медленные темнее, быстрые светлее" style="background:linear-gradient(90deg, ${shadeOf(k, +s.min)}, ${shadeOf(k, +s.max)})"></i>
        <label class="chk mini" title="Треки без пометки тоже попадают в этот стиль по темпу"><input type="checkbox" data-f="byBpm" ${s.byBpm !== false ? 'checked' : ''}> по темпу</label>`}</div>
      <label class="chk mini anyrow" title="Стиль не зависит от темпа (например, Буги — это рок-н-ролл любого темпа): трек попадает в него только по пометке в комментарии или жанре, либо вручную, и тогда не идёт в другие направления"><input type="checkbox" data-f="anyBpm" ${s.anyBpm ? 'checked' : ''}> без учёта темпа</label>
      <input class="kw" data-f="kw" value="${esc((s.kw || []).join(', '))}" placeholder="${s.anyBpm ? 'пометки в комментарии или жанре' : 'пометки в комментарии'}, через запятую" title="Если в комментарии трека${s.anyBpm ? ' или в его жанре' : ''} есть одно из этих слов, трек относится к этому стилю">
      <div class="cnt hint">треков: ${counts[k]}${tagged[k] ? ` (с пометкой или вручную: ${tagged[k]})` : ''}</div>
    </div>`).join('');
  if (!S.openStyles) S.openStyles = new Set();
  document.querySelectorAll('#styles .style-row').forEach(r => setStyleOpen(r, S.openStyles.has(+r.dataset.k)));
  renderMixBar();
}
// доли стилей: ползунок показывает ДОЛЮ в процентах (вся шкала = 100 %), а не «вес»
const shareOf = (st, k) => { const sum = st.styles.reduce((s, x) => s + (+x.w || 0), 0); return sum ? +st.styles[k].w / sum * 100 : 0; };
function updatePct() {
  const st = S.settings;
  document.querySelectorAll('.style-row').forEach(r => {
    const k = +r.dataset.k, s = st.styles[k];   // доли меняются только на полосе над карточками
    r.classList.toggle('off', !inMix(st, k)); if (!r.classList.contains('open')) r.title = r.classList.contains('off') ? 'Нажмите — добавить в подбор (0 %)' : 'Нажмите — убрать из подбора';
  });
  if (!mixDrag) renderMixBar();
}
// поставить стилю k долю v %: остальные активные делят оставшееся пропорционально прежним долям
function setShare(k, v) {
  const st = S.settings, styles = st.styles; v = Math.max(0, Math.min(100, +v || 0));
  const others = styles.reduce((s, x, i) => i === k ? s : s + (+x.w || 0), 0);
  if (v >= 100) styles.forEach((x, i) => { x.w = i === k ? 100 : 0; });
  else if (!others) styles[k].w = v > 0 ? 100 : 0;          // единственный активный стиль — всегда 100 %
  else {
    const wk = v * others / (100 - v);
    styles[k].w = wk;
    const tot = styles.reduce((s, x) => s + (+x.w || 0), 0);  // приводим к сумме 100: веса = проценты
    styles.forEach(x => { x.w = Math.round((+x.w || 0) / tot * 1000) / 10; });
  }
}
/* ---------- полоса долей направлений (режим «Танцы») ----------
   Сверху — направления с процентами в порядке полосы; под ними полоса, где каждый стиль
   занимает свою долю своим цветом; между цветами — ручки. Тянете ручку — двигается только она:
   доля переходит между двумя соседними цветами, остальные не меняются. */
let mixDrag = null;
function shares() { const st = S.settings; return st.styles.map((s, k) => shareOf(st, k)); }
// под процентом стиля ничего не пишем (даже если треков нет) — вёрстка подписей ровная
function mixWarn() { return ''; }
// стиль «в подборе»: есть доля или он добавлен с 0 % (s.on) — тогда он стоит на полосе, и долю ему набирают ручками
function inMix(st, k, sh) { return (sh ? sh[k] : shareOf(st, k)) > 0.05 || !!st.styles[k].on; }
function renderMixBar() {
  const box = $('#mixBar'); if (!box) return;
  const st = S.settings, sh = shares();
  const act = st.styles.map((s, k) => k).filter(k => inMix(st, k, sh));
  // подписи: в том же порядке, что и цвета на полосе (Линди-хоп слева), затем не выбранные «＋ стиль»
  const order = act;
  // округление «наибольшим остатком»: подписи в сумме всегда дают ровно 100 %
  const rnd = {}; let left = act.some(k => sh[k] > 0) ? 100 : 0;
  act.forEach(k => { rnd[k] = Math.floor(sh[k]); left -= rnd[k]; });
  act.slice().sort((a, b) => (sh[b] - rnd[b]) - (sh[a] - rnd[a])).slice(0, Math.max(0, left)).forEach(k => rnd[k]++);
  const labs = $('#mixLabels');
  const old = new Map([...labs.children].map(el => [el.dataset.k, el.getBoundingClientRect().left]));   // для плавной перестановки
  labs.innerHTML = order.map(k => `<div class="ml ${sh[k] > 0.05 ? '' : 'zero'}" data-k="${k}"><span class="mn"><button class="mn-off" data-off="${k}" style="--c:${esc(st.styles[k].color)}" title="Убрать «${esc(st.styles[k].name)}» из подбора" aria-label="Убрать «${esc(st.styles[k].name)}» из подбора"></button>${esc(st.styles[k].name)}</span><b>${rnd[k]}%</b>${mixWarn(k, rnd[k])}</div>`).join('');   // «＋» убран: стиль добавляют нажатием на его карточку ниже
  for (const el of labs.children) {   // FLIP: подписи «переезжают» на новые места
    const was = old.get(el.dataset.k); if (was == null) continue;
    const dx = was - el.getBoundingClientRect().left; if (Math.abs(dx) < 1) continue;
    el.style.transition = 'none'; el.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => { el.style.transition = 'transform .25s ease'; el.style.transform = ''; });
  }
  // полоса: стили в постоянном порядке (как в списке), ручки — между соседними цветами.
  // У стиля с 0 % цвета не видно, его ручка стоит вплотную к соседней — потяните, и он появится
  const bar = $('#mixTrack');
  let x = 0, html = '';
  act.forEach((k, i) => {
    html += `<div class="seg-c" style="left:${x}%;width:${sh[k]}%;background:${esc(st.styles[k].color)}" title="${esc(st.styles[k].name)} — ${Math.round(sh[k])}%"></div>`;
    x += sh[k];
    if (i < act.length - 1) html += `<div class="mh" data-k="${k}" style="left:${x}%" title="Тяните, чтобы поменять долю «${esc(st.styles[k].name)}» и соседа"></div>`;
  });
  bar.innerHTML = html || '<div class="mix-empty">нет направлений — нажмите «＋» над полосой или на карточку стиля</div>';
}
// добавить стиль в подбор с 0 %: если других долей нет совсем, он сразу получает 100 %
function addToMix(k) {
  const st = S.settings, s = st.styles[k]; if (!s) return;
  s.on = true;
  if (!st.styles.some((x, i) => i !== k && +x.w > 0)) s.w = 100;
  changed();
}
function removeFromMix(k) { const s = S.settings.styles[k]; if (!s) return; s.on = false; setShare(k, 0); changed(); }
$('#mixLabels').addEventListener('click', e => {
  const off = e.target.closest('.mn-off');   // кружок стиля: «−» — убрать направление из подбора, его доля делится между остальными
  if (off) { removeFromMix(+off.dataset.off); return; }
  const plus = e.target.closest('.ml-plus'); if (!plus) return;
  e.stopPropagation(); openMixAdd(plus);
});
// общий выпадающий список в стиле плеера: items = [{ v, name, sub?, color?, on? }], onPick(v)
function openPickPop(anchor, items, onPick) {
  let pop = $('#pickPop');
  if (!pop) {
    pop = document.createElement('div'); pop.id = 'pickPop'; pop.className = 'mix-add-pop pick-pop'; pop.setAttribute('role', 'menu');
    document.body.appendChild(pop);
    document.addEventListener('pointerdown', e => { if (!pop.hidden && !e.target.closest('#pickPop')) pop.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') pop.hidden = true; });
  }
  pop.innerHTML = items.map((it, i) => `<button role="menuitemradio" aria-checked="${!!it.on}" data-i="${i}" class="${it.on ? 'on' : ''}">`
    + (it.color ? `<i style="background:${esc(it.color)}"></i>` : it.none ? '<i class="none"></i>' : '<i class="auto"></i>')
    + `<span>${esc(it.name)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.on ? '<b>✓</b>' : ''}</button>`).join('');
  pop.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; pop.hidden = true; onPick(items[+b.dataset.i].v); };
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.style.top = (r.bottom + 6 + pop.offsetHeight < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)) + 'px';
}
// выпадающий список «＋»: стили не из подбора, с цветом
function openMixAdd(anchor) {
  let pop = $('#mixAddPop');
  if (pop && !pop.hidden) { pop.hidden = true; return; }
  if (!pop) {
    pop = document.createElement('div'); pop.id = 'mixAddPop'; pop.className = 'mix-add-pop'; pop.setAttribute('role', 'menu');
    document.body.appendChild(pop);
    pop.addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (!b) return; pop.hidden = true; addToMix(+b.dataset.k); });
  }
  const st = S.settings, sh = shares();
  pop.innerHTML = st.styles.map((s, k) => k).filter(k => !inMix(st, k, sh))
    .map(k => `<button role="menuitem" data-k="${k}"><i style="background:${esc(st.styles[k].color)}"></i>${esc(st.styles[k].name)}</button>`).join('');
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.style.top = (r.bottom + 6 + pop.offsetHeight < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)) + 'px';
}
document.addEventListener('pointerdown', e => { const p = $('#mixAddPop'); if (p && !p.hidden && !e.target.closest('#mixAddPop, .ml-plus')) p.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const p = $('#mixAddPop'); if (p) p.hidden = true; } });
// тянуть ручку — или просто нажать на полосу: ближайшая ручка прыгнет в это место (и её можно тянуть дальше).
// Удобно, когда направлений два: нажали на 30 % — стало 30/70
$('#mixTrack').addEventListener('pointerdown', e => {
  let h = e.target.closest('.mh'), x0 = e.clientX;
  if (!h) {
    const hs = [...$('#mixTrack').querySelectorAll('.mh')]; if (!hs.length) return;
    const cx = el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    h = hs.reduce((a, b) => Math.abs(cx(b) - e.clientX) < Math.abs(cx(a) - e.clientX) ? b : a);
    x0 = cx(h);   // направление считаем от ручки, а не от места нажатия
  }
  e.preventDefault();
  const st = S.settings, sh = shares();
  st.styles.forEach((s, i) => { s.w = sh[i]; });   // веса = проценты, чтобы правка двух не сдвинула остальные
  // ручки, стоящие в одной точке (между ними стили с 0 %): какую из них тянуть, решим по направлению движения
  const act = st.styles.map((s, i) => i).filter(i => inMix(st, i, sh));
  const pos = act.indexOf(+h.dataset.k), at = act.slice(0, pos + 1).reduce((a, i) => a + sh[i], 0);
  let lo = pos, hi = pos;
  while (lo > 0 && sh[act[lo]] <= 0.05) lo--;                      // влево — к ручке, у которой слева есть цвет
  while (hi < act.length - 2 && sh[act[hi + 1]] <= 0.05) hi++;     // вправо — к ручке, у которой справа есть цвет
  mixDrag = { act, sh, lo, hi, at, rect: $('#mixTrack').getBoundingClientRect(), x0, side: 0 };
  $('#mixTrack').setPointerCapture(e.pointerId); document.body.classList.add('mix-dragging');
  if (x0 !== e.clientX) mixMove(e);   // нажали мимо ручки — сразу переносим её сюда
});
function mixMove(e) {
  const d = mixDrag; if (!d) return;
  if (!d.side) {   // направление первого заметного движения выбирает ручку из стопки
    if (Math.abs(e.clientX - d.x0) < 2) return;
    d.side = e.clientX < d.x0 ? -1 : 1;
    const p = d.side < 0 ? d.lo : d.hi;
    d.k = d.act[p]; d.n = d.act[p + 1];
    d.before0 = d.act.slice(0, p).reduce((a, i) => a + d.sh[i], 0);
    d.pair = d.sh[d.k] + d.sh[d.n];
  }
  const B = Math.max(0, Math.min(100, (e.clientX - d.rect.left) / d.rect.width * 100));
  // доля переходит только между двумя соседними цветами, остальные стоят на месте; 0 % — можно
  const a = Math.max(0, Math.min(d.pair, B - d.before0)), ws = S.settings.styles;
  ws[d.k].w = Math.round(a * 10) / 10; ws[d.n].w = Math.round((d.pair - a) * 10) / 10;
  ws[d.k].on = ws[d.n].on = true;   // сжатый до нуля остаётся на полосе с 0 % — убрать его можно кружком «−»
  renderMixBar(); updatePct();
}
$('#mixTrack').addEventListener('pointermove', mixMove);
const endMix = () => {
  if (!mixDrag) return;
  mixDrag = null; document.body.classList.remove('mix-dragging');
  changed();
};
$('#mixTrack').addEventListener('pointerup', endMix);
$('#mixTrack').addEventListener('pointercancel', endMix);

function renderFilterOptions() {
  const sel = $('#fStyle'), v = sel.value;
  sel.innerHTML = '<option value="">все стили</option>' +
    S.settings.styles.map((s, k) => `<option value="${k}">${esc(s.name)}</option>`).join('') +
    '<option value="none">вне стилей</option><option value="nobpm">без BPM</option>';
  sel.value = v; renderFltBtns();
}

/* ---------- библиотека ---------- */
const LIB_LIMIT = 600;
const sortKeys = {
  artist: t => artistOf(t).toLowerCase(), title: t => titleOf(t).toLowerCase(), bpm: t => bpmOf(t), x: t => xOf(t),
  style: t => { const g = styleTags(t); return g.length ? g[0].k : -1; }, year: t => +(t.tags && t.tags.y) || 0, comment: t => ((t.tags && t.tags.c) || '').toLowerCase(),
  genre: t => ((t.tags && t.tags.g) || '').toLowerCase(), path: t => t.key,
};
function renderLib() {
  const q = searchWords($('#search').value);
  const fs = $('#fStyle').value, fx = $('#fX').value;
  let rows = S.tracks.filter(t => t.tags);
  if (q.length) rows = rows.filter(t => { const h = searchHay(t); return q.every(w => h.includes(w)); });   // и по своим комментариям
  if (fs === 'nobpm') rows = rows.filter(t => !bpmOf(t));
  else if (fs === 'none') rows = rows.filter(t => !styleTags(t).length);
  else if (fs !== '') rows = rows.filter(t => styleTags(t).some(g => g.k === +fs));   // по тегам: трек с тегами Линди и Бальбоа найдётся в обоих
  if (fx !== '') rows = rows.filter(t => xOf(t) === +fx);
  const kf = sortKeys[S.sort.k], d = S.sort.dir;
  rows.sort((a, b) => { const x = kf(a), y = kf(b); return x < y ? -d : x > y ? d : 0; });
  const queued = new Set(S.queue.map(x => x.key)), played = new Set(S.history);
  $('#libCount').textContent = `${rows.length} из ${S.tracks.length}`;
  $('#lib tbody').innerHTML = rows.slice(0, LIB_LIMIT).map(t => {
    const g = t.tags, b = bpmOf(t), o = ov(t) || {};
    const cls = [t.key === S.cur ? 'playing' : '', played.has(t.key) ? 'played' : '', queued.has(t.key) ? 'queued' : ''].join(' ');
    return `<tr data-key="${esc(t.key)}" class="${cls}">
      <td class="act"><button data-act="play" title="Играть сейчас">${ICON_PLAY}</button><button data-act="queue" title="В очередь (можно несколько раз)">${ICON_PLUS}</button><button data-act="edit" title="Настройки трека">${ICON_MORE}</button></td>
      <td>${esc(artistOf(t))}</td><td>${noteBadge(t)}${esc(titleOf(t))}</td>
      <td class="num bpm ${o.bpm ? 'ov' : ''}" data-act="bpm" title="${esc(bpmSource(t))} · клик — изменить">${b || '—'}</td>
      <td class="x" data-act="x" title="Клик — сменить огоньки">${xBadge(xOf(t), o.x != null)}</td>
      <td class="st" data-act="style" title="${esc(styleSource(t))} · клик — выбрать стиль">${styleChip(t)}</td><td class="num">${esc(g.y)}</td>
      <td class="cm" title="${esc(g.c)}">${esc(g.c)}</td><td>${esc(g.g)}</td>
      <td class="path" title="${esc(t.p)}">${esc(t.p)}</td></tr>`;
  }).join('');
  $('#libMore').textContent = rows.length > LIB_LIMIT ? `Показаны первые ${LIB_LIMIT}. Уточните поиск.` : '';
  document.querySelectorAll('#lib th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === S.sort.k);
    th.classList.toggle('asc', th.dataset.sort === S.sort.k && S.sort.dir === 1);
  });
}
let libTimer = null;
function scheduleLibRender() { if (!libTimer) libTimer = setTimeout(() => { libTimer = null; renderLib(); }, 150); }

/* =========================================================
   События интерфейса
   ========================================================= */
// доли поменялись — считаем их заново с этого места (mixFrom), а не с начала вечера
function mixSig() { return S.settings.styles.map(s => (+s.w || 0).toFixed(1) + (s.on ? '+' : '')).join('|'); }
function markMixChange() { const s = mixSig(); if (S.mixSigV != null && s !== S.mixSigV) S.settings.mixFrom = S.history.length; S.mixSigV = s; }
function changed(replanToo = true) { markMixChange(); saveState(); renderSettings(); renderStats(); if (replanToo) replan(); }

// нажали выбранное огонёк ещё раз — снова «разнобой»
$('#energySeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; const x = +b.dataset.x; S.settings.energy = x && x === +S.settings.energy ? 0 : x; changed(); };
document.querySelectorAll('#energySeg .mh-h').forEach(b => { b.innerHTML = svgI(HEART_PATH, 'ico'); });
// настройки «и выше» и весов огоньков убраны из интерфейса; при «любые» веса работают по умолчанию
function renderFireShare() { }
$('#modeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.settings.mode = b.dataset.mode; changed(); };
$('#bpmTarget').onchange = e => { S.settings.bpmTarget = +e.target.value || 150; changed(); };
$('#bpmTol').onchange = e => { S.settings.bpmTol = Math.max(0, +e.target.value || 0); changed(); };
$('#noRepeat').onchange = e => { S.settings.noRepeat = e.target.checked; changed(); };
// кнопка «повторы» над очередью: включает подбор уже сыгранных треков, когда свежих нужного стиля нет
function renderRepeatBtn() { const b = $('#btnRepeat'); if (b) { b.classList.toggle('on', !!S.settings.repeat); b.setAttribute('aria-pressed', !!S.settings.repeat); } }
$('#btnRepeat').onclick = () => { S.settings.repeat = !S.settings.repeat; renderRepeatBtn(); changed(); };   // changed() пересобирает очередь
$('#autoNext').onchange = e => { S.settings.autoNext = e.target.checked; saveState(); };
$('#gap').onchange = e => { S.settings.gap = Math.max(0, +e.target.value || 0); saveState(); };
$('#vol').oninput = e => { S.settings.volume = +e.target.value; if (!fading) audio.volume = S.settings.volume; saveState(); };

$('#styles').addEventListener('input', e => {
  const f = e.target.dataset.f, row = e.target.closest('.style-row'); if (!f || !row) return;
  const s = S.settings.styles[+row.dataset.k];
  if (f === 'w') { setShare(+row.dataset.k, e.target.value); updatePct(); }
  else if (f === 'color') { s.color = e.target.value; const k = +row.dataset.k, sh = row.querySelector('.shade'); if (sh) sh.style.background = `linear-gradient(90deg, ${shadeOf(k, +s.min)}, ${shadeOf(k, +s.max)})`; renderQueue(); }
});
$('#styles').addEventListener('change', e => {
  const f = e.target.dataset.f, row = e.target.closest('.style-row'); if (!f || !row) return;
  const s = S.settings.styles[+row.dataset.k];
  if (f === 'name') {
    const old = s.name; s.name = e.target.value.trim() || 'Стиль';
    for (const o of Object.values(S.overrides)) if (o.style === old) o.style = s.name; // ручные выборы не теряются
  }
  else if (f === 'kw') s.kw = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
  else if (f === 'byBpm') s.byBpm = e.target.checked;
  else if (f === 'anyBpm') { s.anyBpm = e.target.checked; if (s.anyBpm) s.byBpm = false; renderStyles(); }
  else if (f === 'min' || f === 'max') s[f] = +e.target.value || 0;
  else if (f === 'w') { setShare(+row.dataset.k, e.target.value); e.target.blur(); }
  else if (f === 'color') s.color = e.target.value;
  changed(); scheduleLibRender();
});
// карточки стилей свёрнуты: видно цвет и название; ⌄ (или клик по пустому месту шапки) — развернуть
if (!S.openStyles) S.openStyles = new Set();
// развёрнута — можно править название и цвет; свёрнута — поля только для показа (клик идёт в карточку)
function setStyleOpen(row, open) {
  row.classList.toggle('open', open);
  const b = row.querySelector('[data-f=tog]'); b.setAttribute('aria-expanded', open); b.title = open ? 'Свернуть' : 'Развернуть для редактирования';
  const nm = row.querySelector('.sname'); nm.readOnly = !open; nm.tabIndex = open ? 0 : -1;
  row.querySelector('input[type=color]').disabled = !open;
  row.title = open ? '' : (row.classList.contains('off') ? 'Нажмите — добавить в подбор (0 %)' : 'Нажмите — убрать из подбора');
}
$('#styles').addEventListener('click', e => {
  const row = e.target.closest('.style-row'); if (!row) return;
  const tog = e.target.closest('[data-f=tog]');
  if (tog) {   // ⌄ — развернуть для редактирования (название, цвет, темп, пометки, удаление) или свернуть
    const k = +row.dataset.k;
    if (S.openStyles.has(k)) S.openStyles.delete(k); else S.openStyles.add(k);
    setStyleOpen(row, S.openStyles.has(k));
    return;
  }
  // свёрнутая карточка: нажатие только добавляет стиль в подбор (с 0 %) или убирает из него
  if (!row.classList.contains('open')) {
    const k = +row.dataset.k;
    if (row.classList.contains("off")) addToMix(k);
    else removeFromMix(k);
    return;
  }
  if (e.target.dataset.f !== 'del') return;
  const k = +e.target.closest('.style-row').dataset.k;
  if (!confirm(`Удалить стиль «${S.settings.styles[k].name}»?`)) return;
  S.settings.styles.splice(k, 1); changed(); scheduleLibRender();
});
$('#addStyle').onclick = () => {
  const colors = ['#7fd17f', '#e6d35f', '#e67fb0', '#7fe0e0', '#c0c0c0'];
  S.settings.styles.push({ name: 'Новый стиль', min: 100, max: 140, w: 0, color: colors[S.settings.styles.length % colors.length] });
  changed(false);
};
$('#newParty').onclick = () => {
  if (!confirm('Начать новую вечеринку? История сыгранного очистится.')) return;
  S.history = S.cur ? [S.cur] : []; S.histSt = S.history.map(() => -1); S.settings.mixFrom = 0; changed();
  renderHistory();
};
$('#replan').onclick = replan;

$('#dislikes').onclick = async e => {
  const b = e.target.closest('button[data-da]'); if (!b) return;
  const key = b.closest('li').dataset.key, t = S.byKey.get(key); if (!t) return;
  if (b.dataset.da === 'keep') { await postRating(key, null); refill(); renderAll(); }
  else if (b.dataset.da === 'listen') { playKey(key); }
  else if (b.dataset.da === 'trash') {
    if (!confirm(`Переместить в папку «Не в моём вкусе»?\n\n${t.p}`)) return;
    await trashTracks([key]);
  }
};
$('#trashAll').onclick = async () => {
  const keys = S.tracks.filter(isDisliked).map(t => t.key);
  if (!keys.length || !confirm(`Переместить в папку «Не в моём вкусе» все ${keys.length} файлов из списка «Не понравились»?\nИз библиотеки они пропадут, но сами файлы останутся в этой папке.`)) return;
  const ok = await trashTracks(keys);
  alert(`Перемещено в «Не в моём вкусе»: ${ok} из ${keys.length}.`);
};

$('#queue').onclick = e => {
  const b = e.target.closest('button[data-qa]'); if (!b) return;
  const k = +b.closest('li').dataset.k, q = S.queue[k]; if (!q) return;
  if (b.dataset.qa === 'play') playFromQueue(k);
  else if (b.dataset.qa === 'x') { openFirePicker(b, xOwn(S.byKey.get(q.key)) || 0, x => { setFire(q.key, x); renderQueue(); }); return; }   // огоньки трека прямо из очереди
  else if (b.dataset.qa === 'edit') { openTrackPop(q.key, b); return; }
  else if (b.dataset.qa === 'note') { openTrackPop(q.key, b, '#tsNote'); return; }
  else if (b.dataset.qa === 'del') { S.queue.splice(k, 1); refill(); renderQueue(); scheduleLibRender(); }
  else if (b.dataset.qa === 'roll') reroll(k);
  else if (b.dataset.qa === 'up' && k > 0) { [S.queue[k - 1], S.queue[k]] = [S.queue[k], S.queue[k - 1]]; S.queue[k - 1].manual = true; renderQueue(); }
};

$('#lib tbody').addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const key = el.closest('tr').dataset.key, t = S.byKey.get(key); if (!t) return;
  const act = el.dataset.act;
  if (act === 'play') {
    if (S.cur && !audio.paused && !confirm(`Прервать текущий трек и включить «${titleOf(t)}»?`)) return;
    playNow(key);
  } else if (act === 'edit') { openTrackPop(key, el.closest('button') || el); return; }
  else if (act === 'queue') addToQueue(key);
  else if (act === 'x') {
    setOverride(key, 'x', (xOf(t) + 1) % 4);
    if (S.settings.energy) replan();
  } else if (act === 'style') {
    // свой выпадающий список в стиле плеера (как у «＋»): «авто» и стили с цветом, текущий отмечен
    const cur = (ov(t) || {}).style || '';
    // что даст «авто» (без ручного выбора): тег, пометка или темп
    const o0 = ov(t), saved = o0 && o0.style; if (o0) delete o0.style;
    const autoK = styleOfT(t), tempo = autoK >= 0 ? [S.settings.styles[autoK].name] : stylesForBpm(bpmOf(t)).map(k => S.settings.styles[k].name);
    if (o0 && saved) o0.style = saved;
    openPickPop(el, [{ v: '', name: 'Авто', sub: tempo.length ? tempo.join(', ') : 'нет BPM и пометок', on: !cur },
      { v: NO_STYLE, name: 'Не указано', sub: 'без стиля — в подбор по направлениям не попадёт', on: cur === NO_STYLE, none: true }]
      .concat(S.settings.styles.map(s => ({ v: s.name, name: s.name, color: s.color, on: s.name === cur }))),
      v => {
        // выбран стиль — он и есть стиль трека: ручные теги других направлений забываем; «Не указано» — забываем все ручные теги
        const o = S.overrides[key] || (S.overrides[key] = {});
        if (v === NO_STYLE) delete o.tagsAdd;
        else if (v) { if (o.tagsAdd) { o.tagsAdd = o.tagsAdd.filter(n => n === v); if (!o.tagsAdd.length) delete o.tagsAdd; } if (o.tagsDel) { o.tagsDel = o.tagsDel.filter(n => n !== v); if (!o.tagsDel.length) delete o.tagsDel; } }
        setOverride(key, 'style', v || null); scheduleLibRender(); replan();
      });
    return;
  } else if (act === 'bpm') {
    const v = prompt(`BPM для «${titleOf(t)}»\n(пусто — вернуть исходный: ${t.fileBpm || (t.tags && t.tags.b) || 'нет'})`, bpmOf(t) || '');
    if (v === null) return;
    const n = Math.round(parseFloat(String(v).replace(',', '.')));
    setOverride(key, 'bpm', n > 0 ? n : null);
    if (!(n > 0) && S.bpmTaps[key]) { try { await postBpm(key, null); } catch { } setOverride(key, 'bpm', null); } // «вернуть исходный» забывает и тап
    replan();
  }
});
$('#lib tbody').addEventListener('dblclick', e => {
  if (e.target.closest('[data-act]')) return;
  const tr = e.target.closest('tr'); if (tr) addToQueue(tr.dataset.key);
});
/* ширина столбцов библиотеки: тяните правый край заголовка; двойной щелчок по краю — вернуть как было.
   Ширины хранятся в настройках (S.settings.libCols, px по порядку столбцов) */
function applyLibCols() {
  const tbl = $('#lib'), w = S.settings && S.settings.libCols;
  let cg = tbl.querySelector('colgroup');
  if (!Array.isArray(w) || !w.length) { if (cg) cg.remove(); tbl.classList.remove('fixed-cols'); tbl.style.width = ''; return; }
  if (!cg) { cg = document.createElement('colgroup'); tbl.prepend(cg); }
  // столбцу огоньков — не уже 76 px, иначе три огонька обрезаются
  const xi = [...tbl.querySelectorAll('thead th')].findIndex(th => th.dataset.sort === 'x'); if (xi >= 0 && w[xi] < 76) w[xi] = 76;
  cg.innerHTML = w.map(x => `<col style="width:${Math.round(x)}px">`).join('');
  tbl.classList.add('fixed-cols'); tbl.style.width = w.reduce((a, x) => a + x, 0) + 'px';
}
var colDrag = null;   // var: renderSettings может вызваться раньше этой строки
$('#lib thead').querySelectorAll('th').forEach((th, i) => { if (i) th.insertAdjacentHTML('beforeend', '<i class="col-rs" title="Тяните, чтобы изменить ширину; двойной щелчок — как было"></i>'); });
$('#lib thead').addEventListener('pointerdown', e => {
  const h = e.target.closest('.col-rs'); if (!h) return;
  e.preventDefault(); e.stopPropagation();
  const ths = [...$('#lib thead tr').children];
  if (!Array.isArray(S.settings.libCols) || S.settings.libCols.length !== ths.length) S.settings.libCols = ths.map(th => th.getBoundingClientRect().width);
  colDrag = { i: ths.indexOf(h.closest('th')), x0: e.clientX, w0: S.settings.libCols[ths.indexOf(h.closest('th'))] };
  h.setPointerCapture(e.pointerId); document.body.classList.add('col-dragging'); applyLibCols();
});
$('#lib thead').addEventListener('pointermove', e => {
  if (!colDrag) return;
  S.settings.libCols[colDrag.i] = Math.max(40, colDrag.w0 + e.clientX - colDrag.x0); applyLibCols();
});
const endColDrag = () => { if (!colDrag) return; colDrag = null; document.body.classList.remove('col-dragging'); saveState(); suppressSortClick = true; setTimeout(() => { suppressSortClick = false; }, 0); };
$('#lib thead').addEventListener('pointerup', endColDrag);
$('#lib thead').addEventListener('pointercancel', endColDrag);
$('#lib thead').addEventListener('dblclick', e => { if (!e.target.closest('.col-rs')) return; delete S.settings.libCols; applyLibCols(); saveState(); });
let suppressSortClick = false;
// применяется в renderSettings, когда настройки загружены
$('#lib thead').onclick = e => {
  if (suppressSortClick || e.target.closest('.col-rs')) return;   // отпустили ручку ширины — это не сортировка
  const th = e.target.closest('th[data-sort]'); if (!th) return;
  const k = th.dataset.sort;
  S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : (k === 'bpm' || k === 'x' || k === 'year' ? -1 : 1) };
  renderLib();
};
$('#search').oninput = scheduleLibRender;
$('#fStyle').onchange = renderLib;
$('#fX').onchange = renderLib;
$('#rescan').onclick = async () => {
  $('#rescan').disabled = true;
  try {
    const d = await (await fetch('/api/tracks?rescan=1', { cache: 'no-store' })).json();
    makeTracks(d.tracks);
    S.queue = S.queue.filter(q => S.byKey.has(q.key));
    renderAll(); await scanTags();
  } finally { $('#rescan').disabled = false; }
};
/* ---------- BPM и огоньки → в теги самих файлов (mp3, flac) ----------
   BPM — в поле BPM; комментарий — только огоньки: «X», «XX», «XXX» (всё прочее из комментариев удаляется) */
const TAGGABLE = ['mp3', 'flac'];
// что записать в файл: { key, b?, x? } или null, если в тегах уже всё как надо
function tagItem(t) {
  if (!TAGGABLE.includes(t.ext) || isDisliked(t)) return null;
  // в файл пишутся только свои огоньки трека; «♥ по умолчанию» у неоценённых — не пишется
  const it = { key: t.key }, b = bpmOf(t), x = xOwn(t) || 0;
  // темп из имени файла или ваша правка, а в теге его нет или он другой
  if (b && (t.fileBpm || manualBpm(t)) && !(t.tags && +t.tags.b === b)) it.b = b;
  // в комментарии должна быть только пометка огоньков («X», «XX», «XXX») — любой другой текст стирается
  // в комментарии — пометка огоньков + ваша заметка; переписываем, если пометка не та или есть старые «2x», ♥♥
  if (t.tags) { const c = t.tags.c || '', m = c.match(/(?:^|[^\p{L}\p{N}])([XХ]{1,3})(?![\p{L}\p{N}])/u); if ((m ? m[1].length : 0) !== x || parseX(c) !== x) it.x = x; }
  return it.b || it.x != null ? it : null;
}
const tagCandidates = () => S.tracks.map(tagItem).filter(Boolean);
function renderTagBtn() {
  const b = $('#tagBpm'); if (!b || b.dataset.busy) return;
  const n = tagCandidates().length;
  b.hidden = !n; b.innerHTML = `BPM и ${HEART} → в теги (${n})`;
}
async function postTags(items) {
  const r = await fetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  if (!r.ok) throw new Error('Ошибка ' + r.status);
  return r.json();
}
// после записи у файла поменялись размер и дата — перечитываем список и теги изменённых треков
async function refreshAfterTagWrite() {
  try {
    const d = await (await fetch('/api/tracks', { cache: 'no-store' })).json();
    makeTracks(d.tracks); renderAll(); await scanTags();
  } catch { }
}
// одна правка на ноутбуке — сразу в файл (трек, который играет, сервер допишет, когда он закончится, если нужно переписывать файл)
function tagNow(key, fields) {
  const t = S.byKey.get(key); if (!t || !TAGGABLE.includes(t.ext)) return;
  postTags([Object.assign({ key }, fields)]).then(r => { if (r.ok) refreshAfterTagWrite(); }).catch(() => { });
}
const tagBpmNow = (key, b) => { if (b >= 40) tagNow(key, { b }); };
$('#tagBpm').onclick = async () => {
  const list = tagCandidates(); if (!list.length) return;
  const nb = list.filter(i => i.b).length, nx = list.filter(i => i.x != null).length;
  if (!confirm(`Записать в теги ${list.length} файлов?\n\n• BPM — ${nb} файлов (из начала имени «158 Artist - Title» и ваших правок)\n` +
    `• огоньки в комментарий («X», «XX», «XXX») — ${nx} файлов; весь прежний текст комментариев удаляется, остаётся только пометка огоньков.\n\n` +
    `Меняются только эти поля внутри mp3/flac, сам звук не трогается.`)) return;
  const b = $('#tagBpm'); b.dataset.busy = '1'; b.disabled = true;
  const sum = { ok: 0, same: 0, later: 0, unsupported: 0, failed: 0 }, errs = [];
  try {
    for (let i = 0; i < list.length; i += 10) {
      b.textContent = `записываю ${Math.min(i + 10, list.length)} из ${list.length}…`;
      const r = await postTags(list.slice(i, i + 10));
      for (const k in sum) sum[k] += r[k] || 0;
      errs.push(...(r.errors || []));
    }
  } catch (e) { errs.push(e.message); }
  delete b.dataset.busy; b.disabled = false;
  alert(`Теги файлов:\nзаписано — ${sum.ok}\nуже было так же — ${sum.same}` +
    (sum.later ? `\nтрек играет — допишется, когда закончится: ${sum.later}` : '') +
    (sum.unsupported ? `\nформат не поддерживается: ${sum.unsupported}` : '') +
    (sum.failed || errs.length ? `\nошибок — ${sum.failed}\n${errs.slice(0, 5).join('\n')}` : ''));
  await refreshAfterTagWrite(); renderTagBtn();
};

/* ---------- настройки трека (меню ⋯): название, исполнитель, комментарий, теги ----------
   Название, исполнитель и заметка сохраняются в плеере и записываются в теги файла (mp3, flac).
   Теги стилей: добавленные вручную (tagsAdd) и убранные (tagsDel) — сразу, по нажатию. */
const fileTitle = t => t.dispT || t.name, fileArtist = t => t.dispA || '';
// noteOf (заметка трека) — в common.js: нужна и пульту, и тиндеру
function renderTrackSec(key) {
  if (key !== undefined) S.editKey = key;   // какой трек правим: играющий (меню ⋯) или выбранный в очереди / библиотеке
  const t = S.byKey.get(S.editKey), sec = $('#trackSec'); if (!sec) return;
  sec.classList.toggle('off', !t);
  for (const id of ['#tsTitle', '#tsArtist', '#tsNote', '#tsSave', '#tsBpm', '#btnTrash']) $(id).disabled = !t;
  $('#tsHead').textContent = !t ? 'Трек' : S.editKey === S.cur ? 'Трек · играет сейчас' : 'Трек';
  if (!t) { $('#tsTitle').value = $('#tsArtist').value = $('#tsNote').value = $('#tsBpm').value = ''; $('#tsHearts').innerHTML = ''; $('#tsTags').innerHTML = '<span class="hint">ничего не играет</span>'; $('#tsInfo').textContent = ''; return; }
  $('#tsTitle').value = titleOf(t); $('#tsArtist').value = artistOf(t); $('#tsNote').value = noteOf(t);
  $('#tsBpm').value = bpmOf(t) || ''; renderTsHearts(t);
  renderTsTags(t);
  $('#tsInfo').textContent = TAGGABLE.includes(t.ext) ? 'запишется и в файл' : 'только в плеере (формат ' + t.ext + ')';
}
// огоньки в настройках трека: нажатие на n-е ставит n, повторное — убирает
function renderTsHearts(t) {
  const x = xOf(t);
  $('#tsHearts').innerHTML = [1, 2, 3].map(n => `<button class="heart ${n <= x ? 'on' : ''}" data-n="${n}" role="radio" aria-checked="${n === x}" title="${n === x ? 'Ещё раз — убрать огоньки' : 'Огоньков: ' + n}">${iconHeart(n <= x)}</button>`).join('');
}
$('#tsHearts').addEventListener('click', e => {
  const b = e.target.closest('button[data-n]'), t = S.byKey.get(S.editKey); if (!b || !t) return;
  e.stopPropagation();
  const n = +b.dataset.n; setFire(t.key, n === xOf(t) ? 0 : n); renderTsHearts(S.byKey.get(t.key));
});
// настройки любого трека — кнопка ⋯ в строке очереди или библиотеки: тот же блок «Трек» во всплывающей панели
function openTrackPop(key, anchor, focusSel) {
  const t = S.byKey.get(key); if (!t) return;
  // повторный клик по тому же ⋯ — закрыть
  const was = $('#trackPop'); if (was && !was.hidden && S.editKey === key) { closeTrackPop(); return; }
  trackPopAnchor = anchor;
  $('#moreMenu').hidden = true; $('#btnMore').setAttribute('aria-expanded', false);
  let pop = $('#trackPop');
  if (!pop) { pop = document.createElement('div'); pop.id = 'trackPop'; pop.className = 'more-menu track-pop'; document.body.appendChild(pop); }
  pop.appendChild($('#trackSec')); pop.hidden = false;
  renderTrackSec(key);
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight, w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  pop.style.top = (r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  const f = $(focusSel || '#tsTitle'); f.focus(); f.select();
}
let trackPopAnchor = null;
function closeTrackPop() { const p = $('#trackPop'); if (p) p.hidden = true; trackPopAnchor = null; }
const trackPopOpen = () => { const p = $('#trackPop'); return !!(p && !p.hidden); };
$('#tsClose').onclick = e => { e.stopPropagation(); closeTrackPop(); };
document.addEventListener('pointerdown', e => { const p = $('#trackPop'); if (p && !p.hidden && !e.target.closest('#trackPop, [data-qa=edit], [data-qa=note], [data-act=edit], #nowNote')) closeTrackPop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTrackPop(); });
function renderTsTags(t) {
  const on = new Set(styleTags(t).map(g => g.k)), b = bpmOf(t);
  $('#tsTags').innerHTML = S.settings.styles.map((s, k) =>
    `<button class="stag ts-tag ${on.has(k) ? 'on' : ''}" data-k="${k}" style="${on.has(k) ? `background:${shadeOf(k, b)}` : ''}"
      title="${on.has(k) ? 'Убрать тег' : 'Добавить тег'}">${on.has(k) ? '' : '＋ '}${esc(s.name)}${on.has(k) ? ' ✕' : ''}</button>`).join('');
}
$('#tsTags').addEventListener('click', e => {
  const b = e.target.closest('button[data-k]'), t = S.byKey.get(S.editKey); if (!b || !t) return;
  e.stopPropagation();
  const name = S.settings.styles[+b.dataset.k].name, on = b.classList.contains('on');
  let add = tagNames(t, 'tagsAdd').filter(n => n !== name), del = tagNames(t, 'tagsDel').filter(n => n !== name);
  // убрать — забыть ручное добавление и пометить «убран» (тег мог прийти ещё и из пометки в комментарии/жанре или по темпу);
  // добавить — снять пометку «убран» и добавить вручную. Так ✕ убирает тег всегда, а ＋ всегда возвращает
  if (on) del.push(name); else add.push(name);
  const o0 = ov(t); if (on && o0 && o0.style === name) delete o0.style;   // убрали стиль, выбранный вручную, — забыть и выбор
  const o = S.overrides[t.key] || (S.overrides[t.key] = {});
  if (add.length) o.tagsAdd = add; else delete o.tagsAdd;
  if (del.length) o.tagsDel = del; else delete o.tagsDel;
  setOverride(t.key, '_', null);   // сохранить и перерисовать всё
  replan(); renderTsTags(t);
});
async function saveTrackSec() {
  const t = S.byKey.get(S.editKey); if (!t) return;
  const title = $('#tsTitle').value.trim(), artist = $('#tsArtist').value.trim(), note = $('#tsNote').value.trim();
  const o = S.overrides[t.key] || (S.overrides[t.key] = {});
  // правка хранится, только если отличается от тегов файла
  if (title && title !== fileTitle(t)) o.title = title; else delete o.title;
  if (artist !== fileArtist(t)) o.artist = artist; else delete o.artist;
  o.note = note;
  setOverride(t.key, '_', null);
  // BPM: изменили число — ставим его (пусто — вернуть исходный); запишется в файл отдельно
  const nb = Math.round(+$('#tsBpm').value || 0);
  if (nb !== (bpmOf(t) || 0) && (nb === 0 || (nb >= 40 && nb <= 400))) setBpm(t.key, nb);
  if (!TAGGABLE.includes(t.ext)) { flashNote('Сохранено в плеере'); return; }
  try {
    const r = await postTags([{ key: t.key, title: title || fileTitle(t), artist, note, x: xOwn(t) || 0 }]);
    flashNote(r.ok ? 'Сохранено и записано в файл' : r.same ? 'Сохранено, в файле уже так' : r.later ? 'Сохранено; в файл запишется, когда трек закончится' : 'Сохранено в плеере; в файл записать не удалось');
    if (r.ok) refreshAfterTagWrite();
  } catch { flashNote('Сохранено в плеере; нет связи с сервером'); }
}
// во всплывающем окне «Сохранить» ещё и закрывает его (после короткой надписи о записи в файл)
$('#tsSave').onclick = async e => { e.stopPropagation(); const pop = trackPopOpen(); await saveTrackSec(); if (pop) setTimeout(closeTrackPop, 900); };
for (const id of ['#tsTitle', '#tsArtist', '#tsBpm']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveTrackSec(); } });
$('#tsNote').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveTrackSec(); } });
// комментарий трека (с пульта): в плеере сразу, в файл — как из настроек трека
async function setNoteFor(key, note) {
  const t = S.byKey.get(key); if (!t) return;
  const o = S.overrides[key] || (S.overrides[key] = {}); o.note = note;
  setOverride(key, '_', null); renderQueue(); renderPlayer(); scheduleLibRender();
  if (!TAGGABLE.includes(t.ext)) return;
  try { const r = await postTags([{ key, note, x: xOwn(t) || 0 }]); if (r.ok) refreshAfterTagWrite(); } catch { }
}
/* ---------- перетаскивание: порядок очереди и библиотека → очередь ----------
   Мышь: зажать и потянуть. Палец: подержать ~0,3 с, затем тянуть. */
let drag = null, suppressClick = false;

function pressStart(e, key, el, fromIdx) {   // fromIdx — место в очереди, если тянут из очереди
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('button, select, input, a')) return;
  if (!key) return;
  drag = { key, el, id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, touch: e.pointerType !== 'mouse', active: false, idx: -1, from: fromIdx ?? -1 };
  if (drag.touch) { const d = drag; d.timer = setTimeout(() => { if (drag === d) activateDrag(); }, 300); }
}
$('#queue').addEventListener('pointerdown', e => {
  const li = e.target.closest('li[data-k]'); if (!li) return;
  const q = S.queue[+li.dataset.k]; if (q) pressStart(e, q.key, li, +li.dataset.k);
});
$('#lib tbody').addEventListener('pointerdown', e => {
  const tr = e.target.closest('tr[data-key]'); if (tr) pressStart(e, tr.dataset.key, tr);
});

function activateDrag() {
  const p = drag, t = S.byKey.get(p.key); if (!t) { drag = null; return; }
  p.active = true;
  try { window.getSelection().removeAllRanges(); } catch { }
  p.ghost = document.createElement('div'); p.ghost.className = 'drag-ghost';
  p.ghost.innerHTML = `<b>${esc(titleOf(t))}</b> <span>${esc(artistOf(t))} · ${bpmOf(t) || '—'} BPM</span>`;
  p.line = document.createElement('div'); p.line.className = 'drop-line';
  document.body.append(p.ghost, p.line);
  document.body.classList.add('dnd');
  p.el.classList.add('drag-src');
  if (p.touch && navigator.vibrate) navigator.vibrate(15);
  p.scroll = setInterval(() => { // автопрокрутка у краёв окна
    if (!drag || !drag.active) return;
    const top = $('#player').getBoundingClientRect().bottom;
    const dy = drag.ly < top + 50 ? -18 : drag.ly > innerHeight - 50 ? 18 : 0;
    if (dy) { window.scrollBy(0, dy); moveDrag(drag.lx, drag.ly); }
  }, 30);
  moveDrag(p.lx, p.ly);
}

function moveDrag(x, y) {
  const p = drag; p.lx = x; p.ly = y;
  p.ghost.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
  const ql = $('#queue'), card = ql.closest('.card'), r = card.getBoundingClientRect();
  const over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  card.classList.toggle('drop-on', over);
  p.idx = -1;
  if (!over) { p.line.style.display = 'none'; return; }
  const lis = [...ql.querySelectorAll('li[data-k]')], qr = ql.getBoundingClientRect();
  let idx = S.queue.length, lineY = lis.length ? lis[lis.length - 1].getBoundingClientRect().bottom : qr.top;
  for (const li of lis) {
    const b = li.getBoundingClientRect();
    if (y < b.top + b.height / 2) { idx = +li.dataset.k; lineY = b.top; break; }
  }
  p.idx = idx;
  Object.assign(p.line.style, { display: 'block', top: (lineY - 2) + 'px', left: qr.left + 'px', width: qr.width + 'px' });
}

function endDrag(drop) {
  const p = drag; drag = null; if (!p) return;
  clearTimeout(p.timer); clearInterval(p.scroll);
  if (!p.active) return;
  p.ghost.remove(); p.line.remove();
  document.body.classList.remove('dnd');
  p.el.classList.remove('drag-src');
  $('#queue').closest('.card').classList.remove('drop-on');
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
  if (drop && p.idx >= 0) dropToQueue(p.key, p.idx, p.from);
}

// from — место в очереди, откуда тянут (перестановка); из библиотеки (-1) — новая копия: один трек может стоять сколько угодно раз
function dropToQueue(key, idx, from = -1) {
  let item;
  if (from >= 0) { item = S.queue.splice(from, 1)[0]; if (from < idx) idx--; }
  else item = { key, style: styleOfT(S.byKey.get(key)), relaxed: 0 };
  item.manual = true;
  S.queue.splice(Math.max(0, Math.min(idx, S.queue.length)), 0, item);
  renderQueue(); scheduleLibRender();
}

document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
  drag.lx = e.clientX; drag.ly = e.clientY;
  if (!drag.active) {
    if (drag.touch) { if (far) { clearTimeout(drag.timer); drag = null; } return; } // это прокрутка пальцем
    if (!far) return;
    activateDrag();
  }
  if (drag) moveDrag(e.clientX, e.clientY);
});
document.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.id) endDrag(true); });
document.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) endDrag(false); });
document.addEventListener('touchmove', e => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => { if (drag) e.preventDefault(); });
/* ---------- копирование названий: правый щелчок по треку ----------
   Там, где обычный щелчок включает трек, перематывает или начинает перетаскивание, текст не выделить.
   Правый щелчок открывает меню «копировать» и ничего другого не делает. */
function trackAt(el) {
  let n;
  if ((n = el.closest('#histPop li[data-k]'))) return S.byKey.get(n.dataset.k);
  if ((n = el.closest('#queue li[data-k]'))) { const q = S.queue[+n.dataset.k]; return q && S.byKey.get(q.key); }
  if ((n = el.closest('[data-key]'))) return S.byKey.get(n.dataset.key);
  if (el.closest('#mainPill')) return S.byKey.get(S.cur);
  if (el.closest('#nextPill')) return S.queue[0] && S.byKey.get(S.queue[0].key);
  if (el.closest('#prevPill')) { const h = S.history, k = h[h.length - 1] === S.cur ? h[h.length - 2] : h[h.length - 1]; return S.byKey.get(k); }
  return null;
}
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; }
  catch {
    // запасной путь, если буфер обмена недоступен (страница открыта не по localhost)
    const ta = document.createElement('textarea'); ta.value = s; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { }
    ta.remove(); return ok;
  }
}
function flashNote(msg) {
  let el = $('#flashNote');
  if (!el) { el = document.createElement('div'); el.id = 'flashNote'; el.className = 'flash-note'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(flashNote.t); flashNote.t = setTimeout(() => { el.hidden = true; }, 1600);
}
function closeCopyMenu() { const m = $('#copyMenu'); if (m) m.remove(); }
document.addEventListener('contextmenu', e => {
  if (drag || e.target.closest('input, textarea, select')) return;
  const t = trackAt(e.target); if (!t) return;
  e.preventDefault(); closeCopyMenu();
  const a = artistOf(t), ti = titleOf(t), both = a ? `${a} — ${ti}` : ti;
  const m = document.createElement('div'); m.id = 'copyMenu'; m.className = 'copy-menu'; m.setAttribute('role', 'menu');
  const items = [['Копировать: ' + both, both], ['Копировать название', ti]];
  if (a) items.push(['Копировать исполнителя', a]);
  // сам файл: в буфер обмена Windows (вставить в папку, Telegram, почту…) — только на этом компьютере;
  // «Отправить…» — системное меню «Поделиться», если браузер его умеет
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) items.push(['Копировать файл трека', null, 'file']);
  if (navigator.canShare) items.push(['Отправить файл…', null, 'share']);
  m.innerHTML = items.map((it, i) => `<button role="menuitem" data-i="${i}" class="${it[2] ? 'cm-file' : ''}">${esc(it[0])}</button>`).join('');
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX)) + 'px';
  m.style.top = Math.max(8, Math.min(innerHeight - h - 8, e.clientY)) + 'px';
  m.addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-i]'); if (!b) return;
    ev.stopPropagation(); closeCopyMenu();
    const it = items[+b.dataset.i];
    if (it[2] === 'file') {
      try {
        const r = await fetch('/api/copyfile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportBody(t)) });
        const d = await r.json().catch(() => ({}));
        flashNote(r.ok && d.ok ? 'Файл в буфере обмена — вставьте его куда нужно (Ctrl+V)' : 'Не удалось скопировать файл');
      } catch { flashNote('Не удалось скопировать файл'); }
      return;
    }
    if (it[2] === 'share') { flashNote(await shareTrackFile(t) ? 'Готово' : 'Не удалось отправить файл'); return; }
    const s = it[1];
    flashNote(await copyText(s) ? 'Скопировано: ' + s : 'Не удалось скопировать');
  });
  m.querySelector('button').focus();
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('#copyMenu')) closeCopyMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCopyMenu(); });
addEventListener('scroll', closeCopyMenu, true);
addEventListener('blur', closeCopyMenu);

document.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; } }, true);
window.addEventListener('blur', () => endDrag(false));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drag) { endDrag(false); return; }
  if (e.target.matches('input, select, textarea') || e.target.closest('.fire-pop')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#btnPlay').click(); }
});
/* =========================================================
   Выравнивание громкости — как ReplayGain / Auto Gain у диджейских программ.
   Каждый трек один раз измеряется в фоне по EBU R128 (LUFS — громкость «на слух»)
   и запоминается его пик. При игре трек подкручивается к среднему уровню библиотеки:
   громкие — тише, тихие — громче, но не выше пика −1 дБ (чтобы не было искажений).
   Файлы не меняются. Замеры хранятся в dj-data.json по ключу трека.
   ========================================================= */
const LOUD_SR = 22050;           // анализ на пониженной частоте: быстрее и меньше памяти, на громкость почти не влияет
const LOUD_MAX_BOOST = 9, LOUD_MAX_CUT = 15, LOUD_HEADROOM = 1;   // дБ
let actx = null, gainNode = null, loudBusy = false;

// громкость (LUFS, интегральная, с гейтированием) и пик (dBFS) одного трека
async function measureLoudness(t) { return loudnessOf(await (await fetch('/media/' + t.i)).arrayBuffer()); }
async function loudnessOf(data) {
  const dec = new OfflineAudioContext(2, LOUD_SR, LOUD_SR);
  const buf = await dec.decodeAudioData(data);
  const ch = buf.numberOfChannels, len = buf.length;
  let pk = 0;
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; } }
  // K-фильтр из BS.1770: срез низа ~38 Гц и подъём верха +4 дБ
  const off = new OfflineAudioContext(ch, len, LOUD_SR);
  const src = off.createBufferSource(); src.buffer = buf;
  const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
  const sh = off.createBiquadFilter(); sh.type = 'highshelf'; sh.frequency.value = 1500; sh.gain.value = 4;
  src.connect(hp).connect(sh).connect(off.destination); src.start();
  const out = await off.startRendering();
  // сумма квадратов по каналам (моно считаем как двойное моно — старые записи не будут казаться тише стерео)
  const P = new Float64Array(len + 1), monoK = ch === 1 ? 2 : 1;
  const chans = []; for (let c = 0; c < ch; c++) chans.push(out.getChannelData(c));
  for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < ch; c++) { const v = chans[c][i]; s += v * v; } P[i + 1] = P[i] + s * monoK; }
  // блоки 400 мс с шагом 100 мс; абсолютный порог −70 LUFS, относительный −10 LU
  const B = Math.round(0.4 * LOUD_SR), H = Math.round(0.1 * LOUD_SR), zs = [];
  for (let s = 0; s + B <= len; s += H) { const z = (P[s + B] - P[s]) / B; if (-0.691 + 10 * Math.log10(z) > -70) zs.push(z); }
  if (!zs.length) return { dur: Math.round(buf.duration), lu: -70, pk: pk ? 20 * Math.log10(pk) : -70 };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const rel = -0.691 + 10 * Math.log10(mean(zs)) - 10;
  const g = zs.filter(z => -0.691 + 10 * Math.log10(z) > rel);
  const lu = -0.691 + 10 * Math.log10(mean(g.length ? g : zs));
  return { dur: Math.round(buf.duration), lu: Math.round(lu * 10) / 10, pk: Math.round((pk ? 20 * Math.log10(pk) : -70) * 10) / 10 };
}

// целевой уровень: середина (медиана) уже измеренной библиотеки
function loudTarget() {
  const v = Object.values(S.loud || {}).map(r => r.lu).filter(x => x > -60).sort((a, b) => a - b);
  if (v.length < 5) return -16;
  return v[Math.floor(v.length / 2)];
}
// поправка в дБ для трека (0 — если выключено или ещё не измерен)
function gainDbOf(t) {
  if (!t || !S.settings.normOn) return 0;
  const r = S.loud && S.loud[t.key]; if (!r) return 0;
  let db = loudTarget() - r.lu;
  db = Math.min(db, -LOUD_HEADROOM - r.pk, LOUD_MAX_BOOST);
  return Math.round(Math.max(db, -LOUD_MAX_CUT) * 10) / 10;
}
// звук идёт: <audio> → усилитель → колонки. Собираем это по первому клику/клавише: браузер так требует
function ensureAudioGraph() {
  if (actx) { if (actx.state === 'suspended') actx.resume().catch(() => { }); return; }
  try {
    actx = new AudioContext();
    gainNode = actx.createGain();
    actx.createMediaElementSource(audio).connect(gainNode).connect(actx.destination);
    applyGain(true);
  } catch (e) { console.warn('Web Audio недоступен — громкость не выравнивается', e); actx = null; gainNode = null; }
}
document.addEventListener('pointerdown', ensureAudioGraph, true);
document.addEventListener('keydown', ensureAudioGraph, true);
audio.addEventListener('play', () => { if (actx && actx.state === 'suspended') actx.resume().catch(() => { }); });
// instant — при смене трека; иначе плавно за ~2 с (если замер пришёл посреди трека или переключили настройку)
function applyGain(instant) {
  const t = S.byKey.get(S.cur), db = gainDbOf(t);
  if (gainNode) {
    const g = Math.pow(10, db / 20), now = actx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    if (instant) gainNode.gain.setValueAtTime(g, now); else gainNode.gain.setTargetAtTime(g, now, 0.7);
  }
  renderLoudInfo();
}
function renderLoudInfo() {
  const el = $('#normInfo'); if (!el) return;
  const t = S.byKey.get(S.cur), r = t && S.loud[t.key];
  const all = S.tracks.length, done = S.tracks.filter(x => S.loud[x.key]).length;
  const fmt = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1).replace('.', ',');
  let s = `измерено ${done} из ${all}`;
  if (S.settings.normOn && t) s += r ? ` · этот трек ${fmt(gainDbOf(t))} дБ` : ' · этот трек ещё не измерен';
  if (!actx && S.settings.normOn) s += ' · заработает после первого клика по странице';
  el.textContent = s;
}
// фоновый замер: сначала играющий трек и очередь, потом вся библиотека; по одному треку, с паузами
async function loudLoop() {
  if (loudBusy) return; loudBusy = true;
  try {
    for (;;) {
      const pri = [S.cur, ...S.queue.map(q => q.key)].map(k => S.byKey.get(k)).filter(Boolean);
      const t = [...pri, ...S.tracks].find(x => !S.loud[x.key] && !x.loudFail);
      if (!t) break;
      try {
        S.loud[t.key] = await measureLoudness(t);
        saveState();
        if (t.key === S.cur) applyGain(false); else renderLoudInfo();
      } catch (e) { t.loudFail = true; console.warn('не удалось измерить громкость', t.p, e); }
      await new Promise(r => setTimeout(r, document.hidden ? 50 : 250));
    }
  } finally { loudBusy = false; renderLoudInfo(); }
}
$('#normOn').onchange = e => { S.settings.normOn = e.target.checked; saveState(); ensureAudioGraph(); applyGain(false); };

/* =========================================================
   Запуск
   ========================================================= */
async function scanTags() {
  const todo = S.tracks.filter(t => !t.tags);
  if (!todo.length) return;
  S.scanning = true;
  const bar = $('#scanBar'); bar.hidden = false;
  let done = 0, idx = 0;
  const show = () => { $('#scanFill').style.width = (done / todo.length * 100) + '%'; $('#scanText').textContent = `Читаю теги: ${done} / ${todo.length}`; };
  show();
  async function worker() {
    while (idx < todo.length) {
      const t = todo[idx++];
      t.tags = await readTags(t);
      applyTags(t); done++;
      if (done % 20 === 0 || done === todo.length) { show(); scheduleLibRender(); }
      if (done % 300 === 0) saveCache();
      if (done === 40 && !S.queue.length) refill(), renderQueue();
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  S.scanning = false; bar.hidden = true;
  await saveCacheNow();
  renderStats(); renderStyles(); replan(); renderHistory();
}

function renderAll() { renderSettings(); renderStats(); renderPlayer(); renderQueue(); renderHistory(); renderTinder(); renderLib(); }

/* =========================================================
   Пульт: телефон присылает команды через сервер, плеер их выполняет
   и публикует, что сейчас играет
   ========================================================= */
let remoteAfter = null, statusTimer = null;
// плеер может быть открыт в нескольких вкладках (Start.bat открывает новую при каждом запуске).
// Пульт слушается только одну — «главную»: последнюю открытую или ту, где нажали «Управлять отсюда».
const PLAYER_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let isLeader = true;
async function claimLeader() {
  try { await fetch('/api/remote/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: PLAYER_ID }) }); } catch { }
  setLeader(true); pushStatus();
}
function setLeader(on) {
  if (on === isLeader) return;
  isLeader = on;
  if (!on && !audio.paused) audio.pause(); // две вкладки не должны играть одновременно
  $('#leaderBar').hidden = on;
}
function scheduleStatus() { clearTimeout(statusTimer); statusTimer = setTimeout(pushStatus, 250); }
function trackInfo(t) {
  if (!t) return null;
  const k = styleOfT(t);
  return { key: t.key, title: titleOf(t), artist: artistOf(t), bpm: bpmOf(t), x: xOf(t), year: (t.tags && t.tags.y) || '',
           style: k >= 0 ? S.settings.styles[k].name : '', color: trackColor(t),
           tags: styleTags(t).map(g => ({ name: g.name, bg: g.bg, ink: g.ink })),
           // для меню трека на пульте (долгое нажатие): комментарий и ручные теги
           note: noteOf(t), tagsAdd: tagNames(t, 'tagsAdd'), tagsDel: tagNames(t, 'tagsDel') };
}
function pushStatus() {
  if (!S.settings || !isLeader) return;
  const st = S.settings;
  const s = {
    pid: PLAYER_ID, cur: trackInfo(S.byKey.get(S.cur)),
    paused: audio.paused, pos: audio.currentTime || 0, dur: audio.duration || 0,
    gap: !!gapTimer, blocked: !!S.playBlocked,
    volume: st.volume, energy: st.energy, energyUp: st.energyUp, mode: st.mode, autoNext: st.autoNext,
    styles: st.styles.map(x => ({ name: x.name, w: x.w, color: x.color, on: !!x.on })),
    queue: S.queue.slice(0, 15).map(q => Object.assign(trackInfo(S.byKey.get(q.key)) || { key: q.key, title: q.key }, { manual: !!q.manual })),
  };
  fetch('/api/remote/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) })
    .then(r => r.json()).then(d => { if (d && d.ok === false && d.leader && d.leader !== PLAYER_ID) setLeader(false); }).catch(() => { });
}
async function togglePlay() {
  if (!audio.src || !S.cur) return next(false);
  if (audio.paused) {
    if (audio.ended) return next(false);
    try { await audio.play(); S.playBlocked = false; } catch (e) { if (e.name === 'NotAllowedError') S.playBlocked = true; }
  } else audio.pause();
}
async function runRemote(c) {
  const qi = key => S.queue.findIndex(q => q.key === key);
  switch (c.cmd) {
    case 'toggle': await togglePlay(); break;
    case 'next': await next(true); break;
    case 'play': { const k = qi(c.key); if (k >= 0) await playFromQueue(k); else if (S.byKey.has(c.key)) playNow(c.key); break; }
    case 'queue': if (S.byKey.has(c.key)) addToQueue(c.key, true); break;   // с пульта — первым в очередь, со звездой
    case 'unqueue': { const k = qi(c.key); if (k >= 0) { S.queue.splice(k, 1); refill(); renderQueue(); scheduleLibRender(); } break; }
    // перетаскивание в очереди на пульте: from/to — места в очереди
    // теги трека из тиндера: add / del — списки названий стилей (как в настройках трека)
    case 'tags': { const o = S.overrides[c.key] || (S.overrides[c.key] = {}); if (Array.isArray(c.add) && c.add.length) o.tagsAdd = c.add; else delete o.tagsAdd; if (Array.isArray(c.del) && c.del.length) o.tagsDel = c.del; else delete o.tagsDel; setOverride(c.key, '_', null); replan(); break; }
    case 'move': { const f = c.from | 0, t = c.to | 0; if (f >= 0 && f < S.queue.length && t >= 0 && t < S.queue.length && f !== t) { const [it] = S.queue.splice(f, 1); it.manual = true; S.queue.splice(t, 0, it); renderQueue(); scheduleLibRender(); } break; }
    case 'up': { const k = qi(c.key); if (k > 0) { [S.queue[k - 1], S.queue[k]] = [S.queue[k], S.queue[k - 1]]; S.queue[k - 1].manual = true; renderQueue(); } break; }
    case 'roll': { const k = qi(c.key); if (k >= 0) reroll(k); break; }
    case 'note': if (S.byKey.has(c.key)) await setNoteFor(c.key, String(c.note || '').trim()); break;   // комментарий с пульта
    case 'trash': if (S.byKey.has(c.key)) await trashTracks([c.key]); break;   // «Не в моём вкусе» с пульта
    case 'replan': replan(); break;
    case 'energy': S.settings.energy = Math.max(0, Math.min(3, c.x | 0)); if (c.up != null) S.settings.energyUp = !!c.up; changed(); break;
    case 'preset': S.settings.styles.forEach((s, k) => { s.w = k === 0 ? +c.a : k === 1 ? +c.b : 0; }); changed(); break;
    // доли с пульта (полоса с ползунками): w — проценты по стилям, on — стиль стоит на полосе (в т. ч. с 0 %)
    case 'mix': if (Array.isArray(c.w)) { S.settings.styles.forEach((s, k) => { if (c.w[k] != null) s.w = Math.max(0, +c.w[k] || 0); if (Array.isArray(c.on) && c.on[k] != null) s.on = !!c.on[k]; }); changed(); } break;
    case 'volume': S.settings.volume = Math.max(0, Math.min(1, +c.v)); if (!fading) audio.volume = S.settings.volume; $('#vol').value = S.settings.volume; saveState(); break;
    case 'seek': if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration - 1, +c.t)); break;
    case 'setX': setFire(c.key || S.cur, c.x); break;
    case 'autoNext': S.settings.autoNext = !!c.on; $('#autoNext').checked = S.settings.autoNext; saveState(); break;
  }
  scheduleStatus();
}
async function pollRemote() {
  try {
    const d = await getJSON('/api/remote/cmd?after=' + (remoteAfter == null ? -1 : remoteAfter));
    if (d.leader && d.leader !== PLAYER_ID) { setLeader(false); remoteAfter = d.last; return; } // команды выполняет главная вкладка
    if (d.leader === PLAYER_ID) setLeader(true);
    if (remoteAfter == null) { remoteAfter = d.last; return; } // старые команды, присланные до открытия страницы, не выполняем
    for (const x of d.cmds || []) { remoteAfter = x.id; try { await runRemote(x.c); } catch (e) { console.warn('remote', e); } }
    if (d.last < remoteAfter) remoteAfter = d.last; // сервер перезапустили
  } catch { }
}

async function init() {
  let lib, state, cache, rat;
  try { [lib, state, cache, rat] = await Promise.all([getJSON('/api/tracks'), getJSON('/api/state'), getJSON('/api/cache'), getJSON('/api/ratings')]); }
  catch (e) { document.body.innerHTML = '<p style="padding:40px">Не удалось связаться с сервером. Запустите Start.bat.</p>'; return; }
  S.root = lib.root; S.cache = cache || {};
  applyRatings(rat);
  loadSettings(state.settings);
  S.overrides = state.overrides || {};
  S.loud = state.loud && typeof state.loud === 'object' ? state.loud : {};
  setInterval(pollRatings, 4000);
  claimLeader(); // новая вкладка становится главной для пульта
  audio.addEventListener('play', () => { if (!isLeader) claimLeader(); });
  $('#leaderTake').onclick = () => claimLeader();
  setInterval(pollRemote, 800);
  setInterval(pushStatus, 2000);
  window.addEventListener('focus', pollRatings);
  getJSON('/api/info').then(d => {
    const ips = d.ips || [];
    const link = (u, alt) => `<a href="${esc(u)}" target="_blank" class="${alt ? 'alt' : ''}">${esc(u)}</a>`;
    $('#phoneUrl').innerHTML = ips.length
      ? 'С телефона (тот же Wi-Fi):<br>🎛 пульт: ' + link(`http://${ips[0]}:${d.port}/remote`) +
        '<br>' + HEART + ' тиндер: ' + link(`http://${ips[0]}:${d.port}/tinder`) +
        (ips.length > 1 ? '<br><span class="hint">другие адреса компьютера: ' + ips.slice(1).map(esc).join(', ') + '</span>' : '')
      : 'Компьютер не подключён к сети — с телефона зайти не получится.';
  }).catch(() => { });
  S.history = Array.isArray(state.history) ? state.history : [];
  S.histSt = Array.isArray(state.histSt) && state.histSt.length === S.history.length ? state.histSt : S.history.map(() => -1);   // под какой стиль играл каждый трек
  S.mixSigV = mixSig();   // от этого набора долей и отсчитываем следующие изменения
  makeTracks(lib.tracks || []);
  document.querySelector('#panel').insertAdjacentHTML('beforeend', `<p class="hint">Папка с музыкой: ${esc(S.root)}</p>`);
  audio.volume = S.settings.volume;
  refill(); renderAll();
  await scanTags();
  loudLoop();
}
init();

/* ---------- фильтры библиотеки в стиле плеера: вместо системных списков — кнопка-«таблетка» и тёмный список ----------
   Сами <select> остаются (скрыты): из них берутся варианты, в них пишется выбор, их onchange перерисовывает библиотеку */
function renderFltBtns() {
  for (const id of ['fStyle', 'fX']) {
    const sel = $('#' + id); if (!sel) continue;
    let b = $('#' + id + 'Btn');
    if (!b) {
      b = document.createElement('button'); b.id = id + 'Btn'; b.className = 'flt-btn'; b.type = 'button';
      sel.after(b); sel.hidden = true;
      b.onclick = () => {
        const items = [...sel.options].map(o => {
          const k = id === 'fStyle' && /^\d+$/.test(o.value) ? +o.value : -1;
          return { v: o.value, name: o.textContent, color: k >= 0 ? S.settings.styles[k].color : '', on: o.value === sel.value, none: id === 'fStyle' && (o.value === 'none' || o.value === 'nobpm') };
        });
        openPickPop(b, items, v => { sel.value = v; renderFltBtns(); (sel.onchange || (() => {}))(); });
      };
    }
    const o = sel.options[sel.selectedIndex];
    b.innerHTML = `<span>${esc(o ? o.textContent : '')}</span><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
    b.classList.toggle('active', !!sel.value);
  }
}
renderFltBtns();

// плавный прогресс «таблетки»: timeupdate приходит ~4 раза в секунду — между ними двигаем заливку каждый кадр
(function smoothProgress() {
  const pill = $('#mainPill');
  const step = () => {
    if (!audio.paused && !(scrub && scrub.moved)) {
      const d = audio.duration, c = audio.currentTime || 0;
      if (isFinite(d) && d > 0) pill.style.setProperty('--p', Math.min(100, c / d * 100) + '%');
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})();
// комментарий играющего трека: кнопка слева от ⋯ открывает настройки трека сразу на поле «Комментарий»
document.addEventListener('click', e => { const b = e.target.closest('#nowNote'); if (b && S.cur) { e.stopPropagation(); openTrackPop(S.cur, b, '#tsNote'); } });
function setNowNote(t) {
  const b = $('#nowNote'), n = t ? noteOf(t) : '';
  b.innerHTML = ICON_NOTE; b.disabled = !t;
  b.classList.toggle('has', !!n); b.classList.toggle('note-ic', !!n);
  if (n) { b.dataset.note = n; b.title = ''; b.setAttribute('aria-label', 'Комментарий: ' + n + ' (нажмите, чтобы изменить)'); } else { delete b.dataset.note; b.title = 'Добавить комментарий'; b.setAttribute('aria-label', 'Добавить комментарий'); }
}
setNowNote(null);

/* ---------- перетащить файлы треков с компьютера прямо в окно ----------
   файл уходит на сервер → в папку «Новые» внутри папки с музыкой → библиотека пересканируется,
   теги и BPM разбираются как у остальных треков. Бросили на очередь — треки ещё и встают в очередь. */
const DROP_EXT = ['mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'webm', 'weba'];
// имя файла после скачивания часто с мусором: «Artist_-_Title (Official Video) [320 kbps] (site.com).mp3» → «Artist - Title.mp3»
function cleanTrackName(n) {
  const dot = n.lastIndexOf('.'), ext = dot > 0 ? n.slice(dot).toLowerCase() : '';
  let b = dot > 0 ? n.slice(0, dot) : n;
  b = b.replace(/_/g, ' ')
    .replace(/\s*[(\[](?:[^)\]]*\b(?:official|lyrics?|audio|video|clip|visuali[sz]er|hq|hd|\d{2,3}\s?kbps|kbps|mp3|free download)\b[^)\]]*)[)\]]/gi, '')
    .replace(/\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|ru|su|me|cc|io|fm|info|biz|top|pro|to|xyz)\b/gi, '')
    .replace(/[(\[]\s*[)\]]/g, '')
    .replace(/\s*[-–—]\s*[-–—]\s*/g, ' - ').replace(/\s+-\s*$|^\s*-\s+/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s{2,}/g, ' ').trim();
  return (b || 'track') + ext;
}
// имя файла в библиотеке: «BPM - Исполнитель - Название.mp3» — по тегам файла, а чего в тегах нет — из имени
const needBpmTag = new Map();   // ключ файла → BPM, который надо дописать в теги (в тегах его не было)
async function uploadName(f, cleaned) {
  const dot = cleaned.lastIndexOf('.'), ext = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : '';
  const tags = await readTagsFrom(new MemReader(new Uint8Array(await f.arrayBuffer())), ext, cleaned);
  const tagB = num(tags.b) || 0, b = tagB || fileBpm(cleaned);
  const fix = s => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s{2,}/g, ' ').trim();
  const parts = [b || '', fix(tags.a), fix(tags.t)].filter(Boolean);
  if (!fix(tags.t)) return { name: cleaned, bpm: tagB ? 0 : b };
  let base = parts.join(' - ');
  if (base.length > 150) base = base.slice(0, 150).trim();
  return { name: base + '.' + ext, bpm: tagB ? 0 : b };
}
const dropFiles = dt => [...(dt && dt.files || [])].filter(f => DROP_EXT.includes((f.name.split('.').pop() || '').toLowerCase()));
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dropDepth = 0;
function dropOverlay(on, toQueue) {
  if (on && $('#addWin') && !$('#addWin').hidden) on = false;   // открыто окно «Добавить треки» — у него своя рамка
  let el = $('#dropOverlay');
  if (!el) { el = document.createElement('div'); el.id = 'dropOverlay'; el.className = 'drop-overlay'; el.innerHTML = '<div class="drop-box"><b></b><span></span></div>'; document.body.appendChild(el); }
  el.hidden = !on;
  if (on) {
    el.querySelector('b').textContent = toQueue ? 'Отпустите — в очередь' : 'Отпустите — в библиотеку';
    el.querySelector('span').textContent = toQueue ? 'файлы попадут в папку с музыкой и встанут в очередь' : 'файлы попадут в папку с музыкой; бросьте на очередь, чтобы сразу поставить';
  }
  $('#queue').closest('.card').classList.toggle('drop-q', !!(on && toQueue));
}
document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dropDepth++; dropOverlay(true, !!e.target.closest('.card:has(#queue)')); });
document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; dropOverlay(true, !!e.target.closest('.card:has(#queue)')); });
document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dropDepth <= 0) { dropDepth = 0; dropOverlay(false); } });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dropDepth = 0; dropOverlay(false);
  const toQueue = !!e.target.closest('.card:has(#queue)');
  const all = [...e.dataTransfer.files], files = dropFiles(e.dataTransfer);
  if (!files.length) { flashNote(all.length ? 'Это не аудиофайлы — нужны mp3, flac, m4a, ogg, wav…' : 'Нет файлов'); return; }
  uploadTracks(files, toQueue, all.length - files.length);
});
async function uploadTracks(files, toQueue, skipped = 0) {
  const keys = [], fails = [];
  let dups = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let name = cleanTrackName(f.name), bpm = 0;
    flashNote(`Добавляю ${i + 1} из ${files.length}: ${name}`); clearTimeout(flashNote.t); addLog(`Добавляю ${i + 1} из ${files.length}: ${name}`);
    try { ({ name, bpm } = await uploadName(f, name)); } catch { }
    try {
      const r = await fetch('/api/upload?name=' + encodeURIComponent(name), { method: 'POST', body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { fails.push(f.name + (d.error === 'type' ? ' (формат не подходит)' : '')); continue; }
      if (d.dup) dups++;
      if (d.key) { keys.push(d.key); if (bpm) needBpmTag.set(d.key, bpm); }
    } catch (err) { fails.push(f.name); }
  }
  if (keys.length) {
    try {
      const d = await (await fetch('/api/tracks?rescan=1', { cache: 'no-store' })).json();
      makeTracks(d.tracks);
      S.queue = S.queue.filter(q => S.byKey.has(q.key));
      const got = keys.filter(k => S.byKey.has(k));
      if (toQueue) for (const k of got) addToQueue(k);
      renderAll();
      await scanTags();
      // BPM, которого не было в тегах файла (взят из имени), дописываем в теги; комментарий файла не трогается
      const tagList = [];
      for (const k of got) { const t = S.byKey.get(k), b = needBpmTag.get(k); if (t && b && TAGGABLE.includes(t.ext) && !(t.tags && +t.tags.b === b)) tagList.push({ key: k, b }); }
      needBpmTag.clear();
      if (tagList.length) postTags(tagList).then(r => { if (r.ok) refreshAfterTagWrite(); }).catch(() => { });
    } catch (err) { fails.push('пересканирование папки'); }
  }
  const added = keys.length - dups;
  const msg = [added ? `Добавлено треков: ${added}${toQueue ? ' (и в очередь)' : ''}` : '', dups ? `уже были: ${dups}` : '',
    skipped ? `не аудио: ${skipped}` : '', fails.length ? `не получилось: ${fails.join(', ')}` : ''].filter(Boolean).join(' · ');
  flashNote(msg || 'Ничего не добавлено'); addLog(msg || 'Ничего не добавлено');
  clearTimeout(flashNote.t); flashNote.t = setTimeout(() => { const el = $('#flashNote'); if (el) el.hidden = true; }, fails.length ? 6000 : 3500);
}
// то же без перетаскивания: кнопка «＋ файлы» в библиотеке
// окно «Добавить треки»: кнопка ＋ (над очередью и в шапке библиотеки) → перетащите файлы в рамку или выберите их
function openAddWin() {
  let w = $('#addWin');
  if (!w) {
    w = document.createElement('div'); w.id = 'addWin'; w.className = 'add-win';
    w.innerHTML = `<div class="add-box" role="dialog" aria-label="Добавить треки">
      <div class="add-head"><b>Добавить треки</b><button class="add-x" title="Закрыть">${ICON_X}</button></div>
      <label class="add-zone" id="addZone">
        <input type="file" multiple hidden accept="${DROP_EXT.map(x => '.' + x).join(',')}">
        <span class="add-ic">${ICON_PLUS}</span>
        <b>Перетащите файлы сюда</b>
        <span>или нажмите, чтобы выбрать · mp3, flac, m4a, ogg, opus, wav, webm</span>
      </label>
      <label class="add-q"><input type="checkbox" id="addToQ"> сразу поставить в очередь</label>
      <div class="add-hint">Треки попадут в папку со всей музыкой и будут названы «BPM - Исполнитель - Название». BPM и комментарии остаются в тегах файла.</div>
      <div class="add-log" id="addLog"></div>
    </div>`;
    document.body.appendChild(w);
    const zone = w.querySelector('#addZone'), inp = zone.querySelector('input');
    const go = list => { const fs = [...list].filter(f => DROP_EXT.includes((f.name.split('.').pop() || '').toLowerCase())); if (fs.length) uploadTracks(fs, $('#addToQ').checked, list.length - fs.length); else if (list.length) addLog('Это не аудиофайлы'); };
    inp.onchange = () => { go(inp.files); inp.value = ''; };
    zone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); dropDepth = 0; dropOverlay(false); go(e.dataTransfer.files); });
    w.querySelector('.add-x').onclick = closeAddWin;
    w.addEventListener('pointerdown', e => { if (e.target === w) closeAddWin(); });
  }
  w.hidden = false;
}
function closeAddWin() { const w = $('#addWin'); if (w) w.hidden = true; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAddWin(); });
function addLog(msg) { const l = $('#addLog'); if (l && !$('#addWin').hidden) l.textContent = msg; }
(function addFilesBtns() {
  const mk = id => { const b = document.createElement('button'); b.id = id; b.className = 'ghost add-btn'; b.innerHTML = ICON_PLUS; b.title = 'Добавить треки с компьютера (можно и просто перетащить файлы в окно)'; b.onclick = openAddWin; return b; };
  const rs = $('#rescan'); if (rs) rs.before(mk('addFiles'));
  const qs = $('#qSearch'); if (qs) qs.after(mk('addFilesQ'));
})();

/* ---------- поиск над очередью: все совпадения во всплывающем списке, ＋ — поставить в очередь ---------- */
const Q_MAX = 60;
function renderQResults() {
  const box = $('#qResults'), q = searchWords($('#qSearch').value);
  if (!q.length) { box.hidden = true; box.innerHTML = ''; return; }
  const all = S.tracks.filter(t => t.tags && !isDisliked(t) && q.every(w => searchHay(t).includes(w)));
  const rows = all.slice(0, Q_MAX);
  const inQ = new Set(S.queue.map(x => x.key));
  box.innerHTML = rows.length
    ? rows.map(t => `<div class="qr" data-key="${esc(t.key)}">
        <button class="qr-add" title="Поставить в очередь">${ICON_PLUS}</button>
        <span class="qr-m"><b>${esc(titleOf(t))}</b><span>${esc(artistOf(t) || '—')}${inQ.has(t.key) ? ' · <i>в очереди</i>' : ''}</span></span>
        <span class="qr-tags">${tagChips(styleTags(t))}</span>
        <span class="qr-b">${bpmOf(t) || '—'}</span>
        <span class="qr-x">${xBadge(xOf(t))}</span>
        <span class="qr-n">${noteBadge(t)}</span>
        <button class="qr-ed" data-qa="edit" title="Настройки трека: название, исполнитель, BPM, огоньки, комментарий, теги">${ICON_MORE}</button>
      </div>`).join('') + (all.length > Q_MAX ? `<div class="qr-more">ещё ${all.length - Q_MAX} — уточните запрос</div>` : '')
    : '<div class="qr-more">ничего не нашлось</div>';
  box.hidden = false;
}
$('#qSearch').addEventListener('input', debounce(renderQResults, 120));
$('#qSearch').addEventListener('focus', () => { if ($('#qSearch').value.trim()) renderQResults(); });
$('#qSearch').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#qSearch').value = ''; renderQResults(); $('#qSearch').blur(); }
  else if (e.key === 'Enter') { const r = $('#qResults .qr'); if (r) { addToQueue(r.dataset.key); flashNote('В очереди: ' + titleOf(S.byKey.get(r.dataset.key))); renderQResults(); } }
  e.stopPropagation();   // пробел и буквы не должны срабатывать как горячие клавиши плеера
});
$('#qResults').addEventListener('click', e => {
  const ed = e.target.closest('.qr-ed');
  if (ed) { e.stopPropagation(); openTrackPop(ed.closest('.qr').dataset.key, ed); return; }   // ⋯ — настройки трека, список остаётся открытым
  const b = e.target.closest('.qr-add'); if (!b) return;
  const key = b.closest('.qr').dataset.key, t = S.byKey.get(key); if (!t) return;
  addToQueue(key);
  b.classList.add('done'); flashNote('В очереди: ' + titleOf(t));
  setTimeout(renderQResults, 250);
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('#qSearchBox, #trackPop')) $('#qResults').hidden = true; });
// сохранили настройки трека из поиска — список обновляется (BPM, теги, огоньки, комментарий)
$('#tsSave').addEventListener('click', () => setTimeout(() => { if (!$('#qResults').hidden) renderQResults(); }, 400));
