'use strict';
/* ---------- версия: страница новее запущенного сервера → просим перезапустить ---------- */
const SERVER_VERSION = 17; // = $ServerVersion в server.ps1
async function checkServerVersion() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    const d = await r.json();
    if ((d.version | 0) >= SERVER_VERSION) return true;
  } catch { return true; } // нет связи — об этом скажут сами страницы
  let el = document.getElementById('oldServer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'oldServer';
    el.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:1000;padding:14px 16px;border-radius:12px;' +
      'background:#93000a;color:#ffdad6;font:500 15px/21px Roboto,"Segoe UI",sans-serif;box-shadow:0 4px 12px #0008;text-align:center';
    el.textContent = 'На компьютере работает старая версия SwingDJ. Закройте окно SwingDJ (PowerShell) и снова запустите Start.bat — иначе пульт и сохранение BPM не работают.';
    document.body.appendChild(el);
  }
  return false;
}
document.addEventListener('DOMContentLoaded', () => { checkServerVersion(); setInterval(checkServerVersion, 15000); });
/* ---------- Material: волна по нажатию на кнопку и заливка слайдеров ---------- */
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('button');
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span');
  s.className = 'md-ripple';
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  b.appendChild(s);
  setTimeout(() => s.remove(), 500);
}, true);
function paintRange(el) {
  const min = +el.min || 0, max = el.max === '' ? 100 : +el.max, v = +el.value;
  el.style.setProperty('--fill', ((v - min) / (max - min || 1) * 100) + '%');
}
document.addEventListener('input', e => { if (e.target.type === 'range') paintRange(e.target); }, true);
// слайдеры, у которых значение поменял код, а не пользователь
setInterval(() => document.querySelectorAll('input[type=range]').forEach(paintRange), 500);
/* SwingDJ — общий код плеера и тиндера: утилиты, чтение тегов, оценки. */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/* =========================================================
   Чтение тегов: ID3v1/v2 (mp3), FLAC, OGG/Opus, MP4/M4A
   ========================================================= */
const D8 = new TextDecoder('utf-8'), D8F = new TextDecoder('utf-8', { fatal: true });
const D16LE = new TextDecoder('utf-16le'), D16BE = new TextDecoder('utf-16be');
const D1252 = new TextDecoder('windows-1252'), D1251 = new TextDecoder('windows-1251');

class RangeReader {
  constructor(url, size) { this.url = url; this.size = size; this.buf = null; this.at = 0; }
  async get(start, len) {
    if (start >= this.size || len <= 0) return new Uint8Array(0);
    len = Math.min(len, this.size - start);
    const b = this.buf;
    if (b && start >= this.at && start + len <= this.at + b.length) return b.subarray(start - this.at, start - this.at + len);
    const want = Math.min(Math.max(len, 131072), this.size - start);
    const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${start + want - 1}` } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200) { this.buf = data; this.at = 0; } else { this.buf = data; this.at = start; }
    return this.buf.subarray(start - this.at, start - this.at + len);
  }
}
class MemReader {
  constructor(u8) { this.b = u8; this.size = u8.length; }
  async get(s, l) { return this.b.subarray(s, Math.min(this.size, s + l)); }
}

const be32 = (b, o) => b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const ss32 = (b, o) => (b[o] & 0x7f) * 2097152 + ((b[o + 1] & 0x7f) << 14) + ((b[o + 2] & 0x7f) << 7) + (b[o + 3] & 0x7f);
const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function cutNull(b) { const i = b.indexOf(0); return i < 0 ? b : b.subarray(0, i); }
function deUnsync(b) {
  const out = new Uint8Array(b.length); let j = 0;
  for (let i = 0; i < b.length; i++) { out[j++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; }
  return out.subarray(0, j);
}
// «латиница» в ID3 часто на самом деле UTF-8 или cp1251 (русские коллекции)
function decLatin(b) {
  let hi = 0, c0 = 0;
  for (let k = 0; k < b.length; k++) { const x = b[k]; if (x >= 0x80) { hi++; if (x >= 0xc0) c0++; } }
  if (!hi) return D1252.decode(b);
  try { return D8F.decode(b); } catch { }
  if (c0 >= 3 && c0 >= hi * 0.6) return D1251.decode(b);
  return D1252.decode(b);
}
function decText(enc, b) {
  let s;
  if (enc === 1) {
    if (b[0] === 0xfe && b[1] === 0xff) s = D16BE.decode(b.subarray(2));
    else s = D16LE.decode(b);
  } else if (enc === 2) s = D16BE.decode(b);
  else if (enc === 3) s = D8.decode(b);
  else s = decLatin(b);
  return s.replace(/﻿/g, '').split('\u0000').map(x => x.trim()).filter(Boolean).join('; ');
}
// [enc][lang?][description\0][text]
function descText(b, p) {
  const enc = b[0], wide = enc === 1 || enc === 2;
  let q = p;
  if (wide) { while (q + 1 < b.length && !(b[q] === 0 && b[q + 1] === 0)) q += 2; }
  else { while (q < b.length && b[q] !== 0) q++; }
  return { desc: decText(enc, b.subarray(p, q)), text: decText(enc, b.subarray(q + (wide ? 2 : 1))) };
}
function num(v) { const n = parseFloat(String(v).replace(',', '.')); return n > 20 && n < 600 ? Math.round(n) : 0; }
function addComment(tags, text) {
  text = (text || '').trim(); if (!text) return;
  if (!tags.c) tags.c = text; else if (!tags.c.includes(text)) tags.c += ' | ' + text;
}
const cleanGenre = v => v.replace(/^\(\d+\)\s*/, '').trim();

const ID3_MAP = {
  TIT2: 't', TT2: 't', TPE1: 'a', TP1: 'a', TALB: 'al', TAL: 'al', TBPM: 'b', TBP: 'b',
  TCON: 'g', TCO: 'g', TIT1: 'gr', TT1: 'gr', TYER: 'y', TYE: 'y', TDRC: 'y', TORY: 'y', TDOR: 'y', TLEN: 'd', TLE: 'd',
};
function id3Frame(id, d, tags) {
  if (!d.length) return;
  if (id === 'COMM' || id === 'COM') {
    const { desc, text } = descText(d, 4);
    if (!/^(iTun|Songs-DB|MusicMatch)/i.test(desc)) addComment(tags, text);
    return;
  }
  if (id === 'TXXX' || id === 'TXX') {
    const { desc, text } = descText(d, 1), D = desc.toUpperCase();
    if ((D === 'BPM' || D === 'TEMPO') && !tags.b) tags.b = num(text);
    else if (D === 'COMMENT' || D === 'COMMENTS') addComment(tags, text);
    return;
  }
  const k = ID3_MAP[id]; if (!k) return;
  const v = decText(d[0], d.subarray(1)); if (!v) return;
  if (k === 'b') { if (!tags.b) tags.b = num(v); }
  else if (k === 'y') { if (!tags.y) tags.y = (v.match(/\d{4}/) || [''])[0]; }
  else if (k === 'd') { if (!tags.d) tags.d = Math.round(+v / 1000) || 0; }
  else if (k === 'g') { if (!tags.g) tags.g = cleanGenre(v); }
  else if (!tags[k]) tags[k] = v;
}
const ID3_WANT = new Set([...Object.keys(ID3_MAP), 'COMM', 'COM', 'TXXX', 'TXX']);
const validId = (b, o, n) => { for (let k = 0; k < n; k++) { const c = b[o + k]; if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false; } return true; };

async function parseID3(rd, tags) {
  const h = await rd.get(0, 10);
  if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return 0;
  const ver = h[3], flags = h[5], size = ss32(h, 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (ver < 2 || ver > 4 || (ver === 2 && flags & 0x40)) return total;
  let r = rd, pos = 10, end = 10 + size;
  if ((flags & 0x80) && ver < 4) { r = new MemReader(deUnsync(await rd.get(10, size))); pos = 0; end = r.size; }
  if ((flags & 0x40) && ver >= 3) { const e = await r.get(pos, 4); pos += ver === 4 ? ss32(e, 0) : be32(e, 0) + 4; }
  const hl = ver === 2 ? 6 : 10, il = ver === 2 ? 3 : 4;
  for (let guard = 0; guard < 400 && pos + hl <= end; guard++) {
    const fh = await r.get(pos, hl);
    if (fh.length < hl || fh[0] === 0 || !validId(fh, 0, il)) break;
    const id = String.fromCharCode(...fh.subarray(0, il));
    let fs = ver === 2 ? (fh[3] << 16 | fh[4] << 8 | fh[5]) : ver === 4 ? ss32(fh, 4) : be32(fh, 4);
    if (ver === 4 && fs > 127) { // некоторые программы пишут v2.4 без syncsafe
      const alt = be32(fh, 4);
      if (alt !== fs) {
        const nx = await r.get(pos + hl + fs, 4);
        if (nx.length === 4 && nx[0] !== 0 && !validId(nx, 0, 4)) {
          const nx2 = await r.get(pos + hl + alt, 4);
          if (nx2.length < 4 || nx2[0] === 0 || validId(nx2, 0, 4)) fs = alt;
        }
      }
    }
    const ff = ver === 2 ? 0 : fh[9], ds = pos + hl;
    if (ds + fs > end) break;
    if (fs > 0 && ID3_WANT.has(id)) {
      const packed = ver === 3 ? (ff & 0xc0) : ver === 4 ? (ff & 0x0c) : 0;
      if (!packed) {
        let d = await r.get(ds, Math.min(fs, 262144));
        if (ver === 4) { if (ff & 0x01) d = d.subarray(4); if ((ff & 0x02) || (flags & 0x80)) d = deUnsync(d); }
        try { id3Frame(id, d, tags); } catch { }
      }
    }
    pos = ds + fs;
  }
  return total;
}

async function parseID3v1(rd, tags) {
  if (rd.size < 128) return;
  const b = await rd.get(rd.size - 128, 128);
  if (b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return;
  const f = (s, l) => decLatin(cutNull(b.subarray(s, s + l))).trim();
  tags.t ||= f(3, 30); tags.a ||= f(33, 30); tags.al ||= f(63, 30); tags.y ||= f(93, 4);
  addComment(tags, f(97, b[125] === 0 && b[126] !== 0 ? 28 : 30));
}

function setVorbis(tags, key, val) {
  if (!val) return;
  switch (key) {
    case 'TITLE': tags.t ||= val; break;
    case 'ARTIST': tags.a = tags.a ? tags.a + '; ' + val : val; break;
    case 'ALBUM': tags.al ||= val; break;
    case 'DATE': case 'YEAR': case 'ORIGINALDATE': tags.y ||= (val.match(/\d{4}/) || [''])[0]; break;
    case 'BPM': case 'TEMPO': case 'TBPM': if (!tags.b) tags.b = num(val); break;
    case 'COMMENT': case 'DESCRIPTION': case 'COMMENTS': addComment(tags, val); break;
    case 'GENRE': tags.g ||= val; break;
    case 'GROUPING': case 'CONTENTGROUP': tags.gr ||= val; break;
  }
}
function parseVorbis(b, tags) {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 0;
    const vl = dv.getUint32(p, true); p += 4 + vl;
    const n = dv.getUint32(p, true); p += 4;
    for (let k = 0; k < n && p + 4 <= b.length; k++) {
      const l = dv.getUint32(p, true); p += 4;
      if (p + l > b.length) break;
      const s = D8.decode(b.subarray(p, p + l)); p += l;
      const e = s.indexOf('=');
      if (e > 0) setVorbis(tags, s.slice(0, e).toUpperCase(), s.slice(e + 1).trim());
    }
  } catch { }
}

async function parseFLAC(rd, off, tags) {
  const m = await rd.get(off, 4);
  if (m.length < 4 || str4(m, 0) !== 'fLaC') return;
  let pos = off + 4;
  for (let guard = 0; guard < 64 && pos + 4 <= rd.size; guard++) {
    const bh = await rd.get(pos, 4);
    const last = bh[0] & 0x80, type = bh[0] & 0x7f, len = bh[1] << 16 | bh[2] << 8 | bh[3];
    if (type === 0) {
      const si = await rd.get(pos + 4, 18);
      const sr = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
      const tot = (si[13] & 0x0f) * 4294967296 + be32(si, 14);
      if (sr) tags.d = Math.round(tot / sr);
    } else if (type === 4) parseVorbis(await rd.get(pos + 4, len), tags);
    pos += 4 + len;
    if (last) break;
  }
}

function indexOfBytes(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}
async function parseOGG(rd, tags) {
  const b = await rd.get(0, Math.min(rd.size, 262144));
  const parts = []; let p = 0, total = 0;
  while (p + 27 <= b.length && str4(b, p) === 'OggS' && parts.length < 60) {
    const ns = b[p + 26]; let L = 0;
    for (let k = 0; k < ns; k++) L += b[p + 27 + k];
    const ds = p + 27 + ns;
    const part = b.subarray(ds, Math.min(b.length, ds + L));
    parts.push(part); total += part.length; p = ds + L;
  }
  const all = new Uint8Array(total); let o = 0;
  for (const x of parts) { all.set(x, o); o += x.length; }
  let i = indexOfBytes(all, [3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]), skip = 7;
  if (i < 0) { i = indexOfBytes(all, [...'OpusTags'].map(c => c.charCodeAt(0))); skip = 8; }
  if (i >= 0) parseVorbis(all.subarray(i + skip), tags);
}

const MP4_KEYS = { '\xa9nam': 't', '\xa9ART': 'a', '\xa9alb': 'al', '\xa9day': 'y', 'tmpo': 'b', '\xa9cmt': 'c', '\xa9gen': 'g', '\xa9grp': 'gr' };
async function parseMP4(rd, tags) {
  async function kids(start, end) {
    const out = []; let p = start;
    while (p + 8 <= end && out.length < 400) {
      const h = await rd.get(p, 16); if (h.length < 8) break;
      let sz = be32(h, 0), hl = 8; const ty = str4(h, 4);
      if (sz === 1) { sz = be32(h, 8) * 4294967296 + be32(h, 12); hl = 16; } else if (sz === 0) sz = end - p;
      if (sz < hl) break;
      out.push({ ty, s: p + hl, e: Math.min(end, p + sz) }); p += sz;
    }
    return out;
  }
  const moov = (await kids(0, rd.size)).find(a => a.ty === 'moov'); if (!moov) return;
  const mk = await kids(moov.s, moov.e);
  const mvhd = mk.find(a => a.ty === 'mvhd');
  if (mvhd) {
    const d = await rd.get(mvhd.s, 32), v1 = d[0] === 1;
    const ts = v1 ? be32(d, 20) : be32(d, 12), du = v1 ? be32(d, 24) * 4294967296 + be32(d, 28) : be32(d, 16);
    if (ts) tags.d = Math.round(du / ts);
  }
  const udta = mk.find(a => a.ty === 'udta'); if (!udta) return;
  const meta = (await kids(udta.s, udta.e)).find(a => a.ty === 'meta'); if (!meta) return;
  let ms = meta.s; const pk = await rd.get(ms, 8);
  if (str4(pk, 4) !== 'hdlr') ms += 4; // full box: version+flags
  const ilst = (await kids(ms, meta.e)).find(a => a.ty === 'ilst'); if (!ilst) return;
  for (const it of await kids(ilst.s, ilst.e)) {
    const key = MP4_KEYS[it.ty]; if (!key) continue;
    const data = (await kids(it.s, it.e)).find(a => a.ty === 'data'); if (!data) continue;
    const d = await rd.get(data.s, Math.min(data.e - data.s, 65536)), v = d.subarray(8);
    if (key === 'b') { const n = v.length >= 2 ? (v[0] << 8 | v[1]) : v[0]; if (n) tags.b = n; continue; }
    const s = D8.decode(v).trim(); if (!s) continue;
    if (key === 'c') addComment(tags, s);
    else if (key === 'y') tags.y ||= (s.match(/\d{4}/) || [''])[0];
    else tags[key] ||= s;
  }
}

function fromFileName(name) {
  let n = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  n = n.replace(/^\s*\d{1,3}\s*[-.)]\s*/, '');
  const m = n.split(/\s+[-–—]\s+/);
  if (m.length >= 2) return { a: m[0].trim(), t: m.slice(1).join(' - ').trim() };
  return { t: n.trim() };
}

async function readTags(t) { return readTagsFrom(new RangeReader('/media/' + t.i, t.s), t.ext, t.name); }
// rd — RangeReader (файл на сервере) или MemReader (файл, который ещё только перетащили в окно)
async function readTagsFrom(rd, ext, name) {
  const t = { ext, name };
  const tags = {};
  let off = 0;
  try {
    off = await parseID3(rd, tags);
    if (t.ext === 'flac') await parseFLAC(rd, off, tags);
    else if (['m4a', 'mp4', 'm4b'].includes(t.ext)) await parseMP4(rd, tags);
    else if (['ogg', 'oga', 'opus'].includes(t.ext)) await parseOGG(rd, tags);
    if (t.ext === 'mp3' && !tags.t && !tags.a) await parseID3v1(rd, tags);
  } catch (e) { tags.err = 1; }
  const fb = fromFileName(t.name);
  if (!tags.t) tags.t = fb.t;
  if (!tags.a && fb.a) tags.a = fb.a;
  return tags;
}

/* =========================================================
   Модель
   ========================================================= */
function parseX(s) {
  if (!s) return 0;
  const m = s.match(/(?:^|[^\p{L}\p{N}])([1-3])\s?[xх×](?![\p{L}\p{N}])/iu)
         || s.match(/(?:^|[^\p{L}\p{N}])[xх×]\s?([1-3])(?![\p{L}\p{N}])/iu);
  if (m) return +m[1];
  const mx = s.match(/(?:^|[^\p{L}\p{N}])([XХ]{1,3})(?![\p{L}\p{N}])/u); // «X», «XX», «XXX» — так SwingDJ пишет огоньки в комментарий
  if (mx) return mx[1].length;
  const f = (s.match(/🔥|♥|❤/gu) || []).length; // огоньки или огоньки прямо в комментарии
  return Math.min(3, f);
}
// «102 Dean Martin - …» → 102; «03 - Song» (номер трека) не считается
function fileBpm(name) {
  // «158 Artist - Title» и «158 - Artist - Title» (так называются добавленные перетаскиванием)
  const m = name.match(/^(\d{2,3})(?:\s+(?![-–.)_\s])|\s*[-–]\s+(?=\S.*\s[-–]\s))/);
  const n = m ? +m[1] : 0;
  return n >= 40 && n <= 400 ? n : 0;
}
const isJunkComment = s => /^(\s*[0-9A-F]{8}){4,}\s*$/i.test(s);
const normText = s => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

/* =========================================================
   Модель трека (общая для плеера и тиндера; страница задаёт глобальный S
   с полями settings, overrides, ratings, cache, tracks, byKey)
   ========================================================= */
const DEFAULT_SETTINGS = {
  energy: 0, energyUp: false,
  // как часто играют треки: вес для «без огоньков», 🔥, 🔥🔥, 🔥🔥🔥
  fireW: [1, 2, 3, 4],
  mode: 'mix', bpmTarget: 150, bpmTol: 10,
  normOn: true,   // выравнивать громкость треков
  // kw — пометки в комментарии трека; byBpm — относить ли к стилю треки без пометки по темпу
  styles: [
    { name: 'Линди-хоп', min: 120, max: 180, w: 50, color: '#d93a4e', kw: ['линди', 'lindy'], byBpm: true },
    { name: 'Бальбоа', min: 181, max: 320, w: 50, color: '#2f7fd8', kw: ['бальбоа', 'balboa'], byBpm: true },
    { name: 'Фаст линди', min: 190, max: 260, w: 0, color: '#8b1a2b', kw: ['фаст линди', 'фастлинди', 'fast lindy'], byBpm: false },
    { name: 'Чиловый бальбоа', min: 150, max: 200, w: 0, color: '#5fb8ee', kw: ['чиловый бальбоа', 'чил бальбоа', 'chill balboa'], byBpm: false },
    { name: 'Буги', min: 150, max: 210, w: 0, color: '#3fb35a', kw: ['буги', 'boogie', 'рок н ролл', 'rock n roll', 'rock and roll', 'rock & roll', 'rockabilly'], byBpm: false, anyBpm: true },
    { name: 'Блюз', min: 50, max: 119, w: 0, color: '#8a52d4', kw: ['блюз', 'blues'], byBpm: true },
  ],
  window: 10, noRepeat: true, repeat: false, autoNext: true, gap: 3, volume: 0.9, queueLen: 20,
};
function loadSettings(saved) {
  S.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved || {});
  // переключателя «и выше» и полей весов больше нет — скрытые значения сбрасываем к стандартным
  S.settings.energyUp = false;
  S.settings.fireW = DEFAULT_SETTINGS.fireW.slice();
  migrateStyles();
}
// настройки из старой версии: добавляем пометки и новые стили по умолчанию
function migrateStyles() {
  const st = S.settings, v = st.sv | 0, defs = DEFAULT_SETTINGS.styles;
  if (v < 2) {
    // v2: пометки в комментарии, «по темпу» и новые стили по умолчанию
    for (const s of st.styles) {
      const d = defs.find(x => x.name === s.name);
      if (!s.kw) s.kw = d ? d.kw.slice() : [];
      if (s.byBpm == null) s.byBpm = d ? d.byBpm : true;
    }
    let blues = st.styles.findIndex(s => s.name === 'Блюз');
    for (const d of defs) if (!st.styles.some(s => s.name === d.name)) {
      const copy = JSON.parse(JSON.stringify(d));
      if (blues >= 0) st.styles.splice(blues++, 0, copy); else st.styles.push(copy);
    }
  }
  // v3: палитра — Линди красный/розовый, Бальбоа синий/голубой, Блюз фиолетовый
  if (v < 3) for (const s of st.styles || []) { const d = defs.find(x => x.name === s.name); if (d) s.color = d.color; }
  // v4: стиль «Буги» (зелёный) — перед «Блюзом», с долей 0 %
  if (v < 4 && !st.styles.some(s => s.name === 'Буги')) {
    const d = defs.find(x => x.name === 'Буги'), blues = st.styles.findIndex(s => s.name === 'Блюз');
    const copy = JSON.parse(JSON.stringify(d));
    if (blues >= 0) st.styles.splice(blues, 0, copy); else st.styles.push(copy);
  }
  // v5: «Буги» — без учёта темпа, пометки ищутся и в жанре (рок-н-ролл)
  if (v < 5) {
    const b = st.styles.find(s => s.name === 'Буги'), d = defs.find(x => x.name === 'Буги');
    if (b && d) { b.anyBpm = true; b.byBpm = false; for (const w of d.kw) if (!(b.kw || (b.kw = [])).includes(w)) b.kw.push(w); }
  }
  // v6: очередь на 13 треков (было 8) — над ней 13 кружков
  if (v < 6 && (st.queueLen || 8) < 13) st.queueLen = 13;
  // v7: очередь на 20 треков — над ней 20 кружков
  if (v < 7 && (st.queueLen || 8) < 20) st.queueLen = 20;
  // v8: Фаст линди — тёмно-красный вместо розового (если цвет не меняли)
  if (v < 8) { const f = st.styles.find(s => s.name === "Фаст линди"); if (f && /^#ee6fa6$/i.test(f.color)) f.color = "#8b1a2b"; }
  st.sv = 8;
}

const ov = t => S.overrides[t.key];
const ratingOf = t => S.ratings[t.key];
// ручной BPM: правка в плеере (bpm, bpmts) или натапанный в тиндере — действует более поздний
function manualBpm(t) {
  const o = ov(t), tap = S.bpmTaps && S.bpmTaps[t.key];
  const ob = o && o.bpm ? o.bpm : 0, ots = (o && o.bpmts) || 0;
  if (tap && tap.b && (!ob || (tap.t || 0) > ots)) return { b: tap.b, src: 'натапано с телефона' };
  if (ob) return { b: ob, src: 'исправлено вручную' };
  return null;
}
// приоритет: ручной > число в начале имени файла («158 Benny Goodman - …») > тег BPM
const bpmOf = t => { const m = manualBpm(t); return (m && m.b) || t.fileBpm || (t.tags && t.tags.b) || 0; };
const bpmSource = t => { const m = manualBpm(t); return m ? m.src : t.fileBpm ? 'из имени файла' : (t.tags && t.tags.b) ? 'из тегов' : ''; };
// свои огоньки трека: ручная правка / оценка в тиндере (действует более поздняя) / пометка в комментарии;
// null — у трека нет никакой оценки
function xOwn(t) {
  const o = ov(t), r = ratingOf(t);
  const ox = o && o.x != null ? o.x : null, ots = (o && o.xts) || 0;
  const rx = r && r.r === 'like' ? (r.x || 1) : null, rts = (r && r.t) || 0;
  if (rx != null && (ox == null || rts > ots)) return rx;
  if (ox != null) return ox;
  return t.autoX || null;
}
// трек без оценки считается на ♥
function xOf(t) { const x = xOwn(t); return x == null ? 1 : x; }
const isDisliked = t => { const r = ratingOf(t); return !!(r && r.r === 'dislike'); };
const isLater = t => { const r = ratingOf(t); return !!(r && r.r === 'later'); };
// название и исполнитель: ваша правка (настройки трека) важнее тегов файла
const artistOf = t => { const o = ov(t); return (o && o.artist != null) ? o.artist : (t.dispA || ''); };
const titleOf = t => { const o = ov(t); return (o && o.title) ? o.title : (t.dispT || t.name); };
// огонёк — векторная иконка (не эмодзи): энергия трека. HEART оставлен как имя — это теперь огонёк
const FLAME_PATH = '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>';
const HEART = '<svg class="ico fl" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
// иконка «замена» (две встречные стрелки) — у кнопок «другой трек» и «пересобрать»
const ICON_SWAP = '<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';
// ▶ и ⏸ — SVG: у символов шрифта центр гуляет; треугольник чуть сдвинут вправо внутри иконки (оптический центр)
const ICON_PLAY = '<svg class="ico pp" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.5 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4c-.7-.5-1.6 0-1.6.8z"/></svg>';
const ICON_PAUSE = '<svg class="ico pp" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';
// иконки панели трека — одним стилем: контур 2px, скруглённые концы (как у корзины)
const svgI = (d, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// наушники — «послушать на телефоне» (пульт)
const ICON_PHONES = svgI('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.6"/><rect x="17" y="14" width="4" height="7" rx="1.6"/>');
const ICON_NEXT = svgI('<path d="M5 5.5v13l9.5-6.5z"/><path d="M18.5 5v14"/>');
const ICON_X = svgI('<path d="M6 6l12 12M18 6 6 18"/>');   // ✕ — «нет» в тиндере
const ICON_CLOCK = svgI('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M5 4 2.5 6.5M19 4l2.5 2.5"/>');   // «позже»
const ICON_VOL = svgI('<path d="M11 5 6.5 9H3v6h3.5l4.5 4z"/><path d="M15.5 9.5a4 4 0 0 1 0 5"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>');
const ICON_MUTE = svgI('<path d="M11 5 6.5 9H3v6h3.5l4.5 4z"/><path d="m16 9.5 5 5"/><path d="m21 9.5-5 5"/>');
const ICON_MORE = svgI('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>');
const ICON_PLUS = svgI('<path d="M12 5v14M5 12h14"/>');   // «в очередь» — SVG, чтобы стоял по центру, как ▶ и ⋯
const ICON_REPEAT = svgI('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>');   // ↻ повторы
const HEART_PATH = FLAME_PATH;   // контур или заливка огонька (iconHeart)
const iconHeart = on => svgI(HEART_PATH.replace('<path ', on ? '<path fill="currentColor" ' : '<path '), 'ico hrt');
const fires = x => HEART.repeat(x);
// стиль только по темпу (для стилей с byBpm)
function styleOf(bpm) {
  if (!bpm) return -1;
  const st = S.settings.styles;
  for (let k = 0; k < st.length; k++) if (st[k].byBpm !== false && !st[k].anyBpm && bpm >= +st[k].min && bpm <= +st[k].max) return k;
  return -1;
}
// стиль по пометке в комментарии: побеждает самая длинная («фаст линди» сильнее «линди»)
// у стилей «без учёта темпа» пометки ищутся ещё и в жанре трека (жанр «Rock & Roll» → Буги);
// у обычных — только в комментарии, иначе жанр «Jump Blues» утащил бы линди в «Блюз»
function kwStyle(t) {
  if (!t.norm && !t.normG) return -1;
  let best = -1, len = 0;
  S.settings.styles.forEach((s, k) => {
    const hay = s.anyBpm ? (t.norm || '') + ' | ' + (t.normG || '') : (t.norm || '');
    for (const w of s.kw || []) { const n = normText(w); if (n && n.length > len && hay.includes(n)) { best = k; len = n.length; } }
  });
  return best;
}
// стиль «без учёта темпа» (Буги): трек в нём — только его, по темпу в другие направления не идёт
const isAnyBpmStyle = k => k >= 0 && !!(S.settings.styles[k] && S.settings.styles[k].anyBpm);
const isExclusiveTrack = t => isAnyBpmStyle(styleOfT(t));
const styleIndexByName = name => S.settings.styles.findIndex(s => s.name === name);
// итоговый стиль трека: ручной выбор > пометка в комментарии > темп
// стиль без ручных правок тегов: выбран вручную > пометка в комментарии > темп
function autoStyleOfT(t) {
  const o = ov(t);
  if (o && o.style) { const k = styleIndexByName(o.style); if (k >= 0) return k; }
  const k = kwStyle(t); if (k >= 0) return k;
  return styleOf(bpmOf(t));
}
// ручные правки тегов из настроек трека: tagsAdd — добавленные, tagsDel — убранные (по названию стиля)
const tagNames = (t, f) => { const o = ov(t); return (o && Array.isArray(o[f])) ? o[f] : []; };
const tagDeleted = (t, k) => k >= 0 && tagNames(t, 'tagsDel').includes(S.settings.styles[k].name);
const tagsAddedIdx = t => tagNames(t, 'tagsAdd').map(styleIndexByName).filter(k => k >= 0);
// основной стиль трека (для подбора очереди): автоматический, если его не убрали, иначе первый добавленный
const NO_STYLE = '-';   // особое значение ручного стиля: «Не указано»
function styleOfT(t) {
  // стиль, выбранный вручную в библиотеке, — главнее всего
  { const o = ov(t); if (o && o.style === NO_STYLE) return -1;   // «Не указано»: у трека нет стиля
    if (o && o.style) { const k = styleIndexByName(o.style); if (k >= 0 && !tagDeleted(t, k)) return k; } }
  // добавленный вручную стиль «без учёта темпа» (Буги) главнее темпа: трек — буги, а не линди
  const addAny = tagsAddedIdx(t).find(isAnyBpmStyle); if (addAny != null) return addAny;
  const a = autoStyleOfT(t);
  if (a >= 0 && !tagDeleted(t, a)) return a;
  const add = tagsAddedIdx(t); if (add.length) return add[0];
  // автоматический убран, добавленных нет — следующий подходящий по темпу, который не убран
  const rest = stylesForBpm(bpmOf(t)).filter(k => S.settings.styles[k].byBpm !== false && !tagDeleted(t, k));
  return rest.length ? rest[0] : -1;
}
function styleSource(t) {
  const o = ov(t), k = styleOfT(t), a = autoStyleOfT(t);
  if (k < 0) return '';
  if (k !== a || (o && o.style && styleIndexByName(o.style) >= 0)) return 'выбран вручную';
  if (kwStyle(t) >= 0) return 'по пометке в комментарии';
  return 'по темпу';
}
const styleColor = k => k >= 0 && S.settings.styles[k] ? S.settings.styles[k].color : '#cfcdc4';

/* ---------- цвет трека: оттенок — от стиля, яркость — от темпа ----------
   Чем медленнее, тем темнее: Бальбоа от синего (медленный) до голубого, Линди от красного до розового,
   Блюз — тёмно-фиолетовый. Если трек отнесён к стилю по темпу, а его BPM попадает в диапазоны
   нескольких стилей, цвет — градиент между ними. */
// светлота цвета (0–100) — чтобы тёмные цвета стилей оставались тёмными
function hexL(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 50; const n = parseInt(m[1], 16), r = n >> 16, g = n >> 8 & 255, b = n & 255; return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255 * 100; }
function hexHS(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [0, 0];
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (!d) return [0, 0];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round((h * 60 + 360) % 360), Math.round(Math.min(1, s) * 100)];
}
// яркость по темпу: 60 BPM → 28 %, 300 BPM → 74 %
const bpmLight = b => Math.max(28, Math.min(74, 28 + (b - 60) / 240 * 46));
// цвет стиля k для данного темпа (без темпа — средняя яркость)
function shadeOf(k, b) {
  if (!(k >= 0 && S.settings.styles[k])) return '#cfcdc4';
  const [h, s] = hexHS(S.settings.styles[k].color);
  const st = S.settings.styles[k], bb = b || (+st.min + +st.max) / 2;
  // тёмный цвет стиля (например, тёмно-красный Фаст линди) остаётся тёмным: яркость по темпу ужимается пропорционально
  const L = hexL(st.color), f = L < 45 ? L / 55 : 1;
  return `hsl(${h} ${Math.max(45, s)}% ${Math.round(bpmLight(bb) * f)}%)`;
}
// стили, в чей диапазон темпа попадает BPM (в порядке списка стилей)
const stylesForBpm = b => b ? S.settings.styles.map((s, k) => k).filter(k => !S.settings.styles[k].anyBpm && b >= +S.settings.styles[k].min && b <= +S.settings.styles[k].max) : [];
// цвет отметки трека: стиль трека, яркость по его темпу (один цвет, без градиентов)
function trackColor(t) {
  if (!t) return '#cfcdc4';
  return shadeOf(styleOfT(t), bpmOf(t));
}
// фон точки трека по его тегам: один тег — его цвет, несколько — круг делится горизонтально на равные части, нет тегов — серый
function tagsBg(t) {
  const g = styleTags(t).map(x => x.bg);
  // части — горизонтальными полосами сверху вниз: два тега — верхняя и нижняя половины, три — по трети
  return !g.length ? "#cfcdc4" : g.length === 1 ? g[0] : `linear-gradient(to bottom, ${g.map((c, i) => `${c} ${(i * 100 / g.length).toFixed(2)}% ${((i + 1) * 100 / g.length).toFixed(2)}%`).join(", ")})`;
}
// плашки-теги из списка { name, bg, ink } (так же они приходят на пульт в статусе)
const tagChips = (tags, cls = '') => (tags || []).map(g =>
  `<span class="stag ${cls}" style="background:${esc(g.bg)};color:${esc(g.ink)}" title="${esc(g.name)}">${esc(g.name)}</span>`).join('');
// теги стилей трека: сначала его стиль, затем все остальные, под чей диапазон темпа он подходит
function styleTags(t) {
  if (!t) return [];
  { const o = ov(t); if (o && o.style === NO_STYLE) return []; }   // «Не указано» — без тегов, даже по темпу
  // основной стиль, добавленные вручную, затем все подходящие по темпу; убранные вручную не показываются
  const b = bpmOf(t), main = styleOfT(t), ks = main >= 0 ? [main] : [];
  // трек стиля «без учёта темпа» (Буги) не получает тегов других направлений по темпу
  const byTempo = isAnyBpmStyle(main) ? [] : stylesForBpm(b);
  for (const k of [...tagsAddedIdx(t), ...byTempo]) if (!ks.includes(k) && !tagDeleted(t, k)) ks.push(k);
  return ks.map(k => ({ k, name: S.settings.styles[k].name, bg: shadeOf(k, b), ink: '#fff', main: k === main }));
}
// цвет текста поверх цвета трека: на тёмном — белый, на светлом — чёрный
const trackInk = t => '#fff';   // текст на тегах — всегда белый

function applyTags(t) {
  const g = t.tags || {};
  if (g.c) g.c = g.c.split(' | ').filter(x => !isJunkComment(x)).join(' | ');
  const strip = s => (s && t.fileBpm) ? s.replace(new RegExp('^' + t.fileBpm + '\\s+'), '') : (s || '');
  t.dispT = strip(g.t); t.dispA = strip(g.a);
  t.autoX = parseX((g.c || '') + ' ' + (g.gr || ''));
  t.norm = normText((g.c || '') + ' ' + (g.gr || ''));
  t.normG = normText((g.g || '').replace(/&/g, ' and '));   // жанр — для стилей «без учёта темпа»
  t.hay = [t.dispA, t.dispT, g.al, g.c, g.g, g.gr, g.y, t.p].join(' ').toLowerCase();
}

function makeTracks(list) {
  const old = S.byKey;
  S.tracks = list.map(x => {
    const name = x.p.split('\\').pop();
    const t = { i: x.i, p: x.p, s: x.s, m: x.m, name, ext: (name.split('.').pop() || '').toLowerCase(),
                key: x.p.toLowerCase(), ck: x.p + '|' + x.s + '|' + x.m, tags: null, autoX: 0, hay: '',
                fileBpm: fileBpm(name), dispT: '', dispA: '' };
    const prev = old.get(t.key);
    if (S.cache[t.ck]) t.tags = S.cache[t.ck];
    else if (prev && prev.ck === t.ck) t.tags = prev.tags;
    if (t.tags) applyTags(t);
    return t;
  });
  S.byKey = new Map(S.tracks.map(t => [t.key, t]));
}

/* ---------- оценки из тиндера: хранятся на сервере по трекам ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const t = await r.text();
  return t.trim() ? JSON.parse(t) : {};
}
// r: 'like' | 'dislike' | 'later' | null (забыть оценку); x — огоньки для лайка
async function postRating(key, r, x, rz) {
  const res = await fetch('/api/ratings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, r, x, rz: rz ? 1 : undefined }) });
  if (!res.ok) throw new Error('rating ' + res.status);
  const d = await res.json();
  applyRatings(d);
  return d;
}
function applyRatings(d) { S.ratings = (d && d.items) || {}; S.bpmTaps = (d && d.bpm) || {}; S.ratingsV = d && d.v; }
// натапанный темп; b = null — забыть его
async function postBpm(key, b) {
  const res = await fetch('/api/bpm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, b }) });
  if (!res.ok) throw new Error('bpm ' + res.status);
  const d = await res.json();
  applyRatings(d);
  return d;
}
// счётчик темпа по нажатиям: учитываются ВСЕ удары серии (хоть 5, хоть 100), темп — по среднему промежутку;
// пауза больше 2 с начинает новую серию
function makeTapper() {
  let taps = [];
  return {
    tap() {
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
      taps.push(now);
      return taps.length >= 4 ? Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))) : 0;
    },
    count: () => taps.length,
    reset() { taps = []; },
  };
}

/* ---------- селектор огоньков: всплывает под кнопкой ---------- */
// anchor — кнопка, cur — текущее число огоньков, onPick(x) — вызывается с 0..3
function openFirePicker(anchor, cur, onPick) {
  closeFirePicker();
  const pop = document.createElement('div');
  pop.className = 'fire-pop';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = [0, 1, 2, 3].map(x =>
    `<button role="menuitemradio" aria-checked="${x === cur}" data-x="${x}" class="${x === cur ? 'on' : ''}">${x ? '<span class="fires">' + fires(x) + '</span>' : 'без огоньков'}</button>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6); // не влезает снизу — показываем сверху
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.addEventListener('click', e => {
    const b = e.target.closest('button[data-x]'); if (!b) return;
    e.stopPropagation(); closeFirePicker(); onPick(+b.dataset.x);
  });
  setTimeout(() => {
    document.addEventListener('pointerdown', firePickerOutside, true);
    document.addEventListener('keydown', firePickerKey, true);
    window.addEventListener('scroll', closeFirePicker, { passive: true, once: true });
  }, 0);
  const first = pop.querySelector('button.on') || pop.querySelector('button'); first.focus();
}
function closeFirePicker() {
  document.querySelectorAll('.fire-pop').forEach(p => p.remove());
  document.removeEventListener('pointerdown', firePickerOutside, true);
  document.removeEventListener('keydown', firePickerKey, true);
}
function firePickerOutside(e) { if (!e.target.closest('.fire-pop')) closeFirePicker(); }
function firePickerKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeFirePicker(); }
  else if (/^[0-3]$/.test(e.key)) { const b = document.querySelector(`.fire-pop button[data-x="${e.key}"]`); if (b) { e.preventDefault(); b.click(); } }
}

/* ---------- отправить файл трека: системное «Поделиться» (Telegram, почта, Файлы…) ----------
   Если браузер не умеет делиться файлами — файл просто скачивается. Возвращает true, если всё прошло */
// имя файла для «Копировать файл» / «Отправить файл»: «BPM - Исполнитель - Название.mp3» из библиотеки
// (свои правки названия, исполнителя и BPM учитываются); BPM не известен — «Исполнитель - Название.mp3»
function exportName(t) {
  const fix = s => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s{2,}/g, ' ').trim();
  const ext = t.ext || ((t.p || '').split('.').pop() || 'mp3').toLowerCase();
  const base = [bpmOf(t) || '', fix(artistOf(t)), fix(titleOf(t))].filter(Boolean).join(' - ');
  return (base || fix((t.p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '')) || 'track') + '.' + ext;
}
// что сервер пишет в теги копии: BPM, огоньки, свои название / исполнитель / комментарий (комментарий файла сохраняется)
function exportBody(t) {
  const o = ov(t) || {}, b = bpmOf(t), x = xOwn(t);
  const d = { key: t.key, name: exportName(t) };
  if (b) d.b = b;
  if (x) d.x = x;
  if (o.title) d.title = o.title;
  if (o.artist != null) d.artist = o.artist;
  if (o.note != null) d.note = o.note;
  return d;
}
async function shareTrackFile(t) {
  if (!t) return false;
  const name = exportName(t);
  try {
    let r = await fetch('/api/exportfile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportBody(t)) });
    if (!r.ok) r = await fetch('/media/' + t.i);   // старый сервер — отправляем файл как есть
    const blob = await r.blob();
    const file = new File([blob], name, { type: blob.type || 'audio/mpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: titleOf(t) });
      return true;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  } catch (e) { return e && e.name === 'AbortError'; }   // «Отмена» в меню «Поделиться» — не ошибка
}

/* ---------- заметка (комментарий) трека ----------
   своя заметка из настроек трека (⋯ → «Комментарий») или комментарий файла без пометки огоньков X/XX/XXX и старых «2x», ♥♥ */
const noteOf = t => { if (!t) return ''; const o = ov(t); if (o && o.note != null) return o.note; const c = (t.tags && t.tags.c) || '';
  return c.replace(/(?:^|[^\p{L}\p{N}])(?:[XХ]{1,3}|[1-3]\s?[xх×]|[xх×]\s?[1-3])(?![\p{L}\p{N}])/gu, ' ').replace(/[♥❤♡🔥]︎?/gu, '').replace(/\s{2,}/g, ' ').trim(); };
// строка для поиска: теги файла плюс свои правки (название, исполнитель, заметка)
// все поля: имя файла, теги (альбом, жанр, год, комментарий), свои правки, стили, BPM; «ё» = «е»
const searchHay = t => { const o = ov(t) || {}; return ((t.hay || (t.p || '').toLowerCase()) + ' ' + [o.title, o.artist, o.note, styleTags(t).map(g => g.name).join(' '), bpmOf(t) || ''].filter(Boolean).join(' ').toLowerCase()).replace(/ё/g, 'е'); };
const searchWords = q => q.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
// значок «есть комментарий»: наведите (или нажмите) — видно сам комментарий; написать или изменить — ⋯ → «Трек»
const ICON_NOTE = svgI('<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 9.5h8M8 12.5h5"/>', 'ico note-svg');
const noteBadge = t => { const n = noteOf(t); return n ? `<span class="note-ic" data-note="${esc(n)}" aria-label="Комментарий: ${esc(n)}">${ICON_NOTE}</span>` : ''; };
const noteBtnAttrs = t => { const n = noteOf(t); return n ? ` class="note-btn has note-ic" data-note="${esc(n)}" title="" aria-label="Комментарий: ${esc(n)} (нажмите, чтобы изменить)"` : ` class="note-btn" title="Добавить комментарий"`; };
(function noteTips() {
  let tip = null;
  const show = el => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'note-tip'; document.body.appendChild(tip); }
    tip.textContent = el.dataset.note; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = Math.min(320, innerWidth - 16); tip.style.maxWidth = w + 'px';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2)) + 'px';
    tip.style.top = (r.top - th - 8 > 8 ? r.top - th - 8 : r.bottom + 8) + 'px';
  };
  const hide = () => { if (tip) tip.hidden = true; };
  document.addEventListener('mouseover', e => { const el = e.target.closest && e.target.closest('.note-ic'); if (el) show(el); });
  document.addEventListener('mouseout', e => { if (e.target.closest && e.target.closest('.note-ic')) hide(); });
  // на телефоне наведения нет: нажатие на значок показывает комментарий (и не включает трек, не открывает «поделиться»)
  document.addEventListener('click', e => { const el = e.target.closest && e.target.closest('.note-ic'); if (el && el.tagName !== 'BUTTON') { e.stopPropagation(); e.preventDefault(); show(el); setTimeout(hide, 3500); } else hide(); }, true);
  addEventListener('scroll', hide, true);
})();

/* ---------- подписи для экранного диктора ----------
   у кнопок-значков (▶ ⏭ ⋯ ✕ ⇆ ＋ огоньки…) есть подсказка title, но нет текста — копируем её в aria-label.
   Работает и для кнопок, которые рисуются позже (очередь, поиск, меню) */
(function ariaFromTitle() {
  const fix = root => {
    root.querySelectorAll('button[title]:not([aria-label])').forEach(b => {
      if (!/\p{L}{2,}/u.test(b.textContent)) b.setAttribute('aria-label', b.title);
    });
  };
  let queued = false;
  const run = () => { queued = false; fix(document); };
  const start = () => { fix(document); new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(run); } }).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
