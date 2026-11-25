#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SwingDJ local server for macOS, Linux, and Windows.
Serves the web UI, the list of music files, and the audio itself.
Listens on all network interfaces so a phone on the same Wi-Fi can open http://<host-ip>:<port>/
"""

import os
import sys
import json
import time
import struct
import re
import socket
import subprocess
import shutil
import unicodedata
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime

# ----------------- Paths & Config -----------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, 'web')
STATE_PATH = os.path.join(APP_DIR, 'dj-data.json')
CACHE_PATH = os.path.join(APP_DIR, 'tags-cache.json')
RATING_PATH = os.path.join(APP_DIR, 'ratings.json')
CONFIG_PATH = os.path.join(APP_DIR, 'config.json')

MUSIC_ROOT = '..'
PORT = 8765
OPEN_BROWSER = True

if os.path.isfile(CONFIG_PATH):
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
            if 'musicRoot' in cfg and cfg['musicRoot']:
                MUSIC_ROOT = cfg['musicRoot']
            if 'port' in cfg and cfg['port']:
                PORT = int(cfg['port'])
            if 'openBrowser' in cfg:
                OPEN_BROWSER = bool(cfg['openBrowser'])
    except Exception as e:
        print(f"config.json is broken, using defaults: {e}")

if not os.path.isabs(MUSIC_ROOT):
    MUSIC_ROOT = os.path.normpath(os.path.join(APP_DIR, MUSIC_ROOT))
MUSIC_ROOT = os.path.abspath(MUSIC_ROOT)

CRINGE_NAME = "Не в моём вкусе"
OLD_CRINGE_NAME = "Кринж"
CRINGE_DIR = os.path.join(MUSIC_ROOT, CRINGE_NAME)
OLD_CRINGE_DIR = os.path.join(MUSIC_ROOT, OLD_CRINGE_NAME)

if os.path.isdir(OLD_CRINGE_DIR) and not os.path.isdir(CRINGE_DIR):
    try:
        os.rename(OLD_CRINGE_DIR, CRINGE_DIR)
    except Exception:
        pass

AUDIO_TYPES = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff'
}
WEB_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
}
MAX_CHUNK = 1024 * 1024  # 1MB
SERVER_VERSION = 14

# ----------------- State & Library -----------------
files_list = []      # list of dict: {'full': str, 'rel': str, 'size': int, 'mtime': int, 'ext': str, 'name': str}
by_key = {}          # key (lower rel with \) -> index
gone_set = set()     # set of indexes marked gone
tag_pending = {}     # key -> {'b': int, 'x': int, 'txt': dict}
now_key = ''
tracks_json = '{"root":"","tracks":[]}'

# Remote control state
cmd_list = []
cmd_seq = 0
remote_status = 'null'
remote_at = None
leader = ''

def scan_library():
    global files_list, by_key, gone_set
    t0 = time.time()
    print(f"Scanning {MUSIC_ROOT} ...")

    app_prefix = os.path.abspath(APP_DIR)
    norm_cringe = unicodedata.normalize('NFC', os.path.abspath(CRINGE_DIR))
    norm_old_cringe = unicodedata.normalize('NFC', os.path.abspath(OLD_CRINGE_DIR))

    res = []
    for root, dirs, files in os.walk(MUSIC_ROOT):
        abs_root = os.path.abspath(root)
        norm_root = unicodedata.normalize('NFC', abs_root)

        # Skip application directory
        if abs_root == app_prefix or abs_root.startswith(app_prefix + os.sep):
            dirs.clear()
            continue
        # Skip cringe folders
        if norm_root == norm_cringe or norm_root.startswith(norm_cringe + os.sep):
            dirs.clear()
            continue
        if norm_root == norm_old_cringe or norm_root.startswith(norm_old_cringe + os.sep):
            dirs.clear()
            continue
        # Skip trash / system volume information
        if re.search(r'[/\\](\$RECYCLE\.BIN|System Volume Information)[/\\]?', abs_root, re.IGNORECASE):
            dirs.clear()
            continue

        for f in files:
            if f.startswith('._'):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext in AUDIO_TYPES:
                full_path = os.path.join(root, f)
                try:
                    st = os.stat(full_path)
                    # Convert to backslashes so keys and filenames match existing ratings.json & web JS
                    rel = os.path.relpath(full_path, MUSIC_ROOT).replace('/', '\\')
                    res.append({
                        'full': full_path,
                        'rel': rel,
                        'size': st.st_size,
                        'mtime': int(st.st_mtime),
                        'ext': ext,
                        'name': f
                    })
                except Exception:
                    pass

    files_list = res
    gone_set = set()
    by_key = {f['rel'].lower(): i for i, f in enumerate(files_list)}
    build_tracks_json()
    print(f"\033[92mFound {len(files_list)} tracks in {time.time() - t0:.1f} s\033[0m")

def build_tracks_json():
    global tracks_json
    tracks = []
    for i, f in enumerate(files_list):
        if i in gone_set:
            continue
        tracks.append({
            'i': i,
            'p': f['rel'],
            's': f['size'],
            'm': f['mtime']
        })
    tracks_json = json.dumps({'root': MUSIC_ROOT, 'tracks': tracks}, ensure_ascii=False)

def save_text(path, text):
    tmp = f"{path}.tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)

def load_text(path, fallback='{}'):
    if os.path.isfile(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception:
            pass
    return fallback

# ----------------- Ratings & BPM -----------------
ratings_dict = {}
tap_bpm_dict = {}
ratings_ver = 0

try:
    loaded = json.loads(load_text(RATING_PATH, '{}'))
    if isinstance(loaded, dict):
        if 'items' in loaded and isinstance(loaded['items'], dict):
            ratings_dict = loaded['items']
        if 'bpm' in loaded and isinstance(loaded['bpm'], dict):
            tap_bpm_dict = loaded['bpm']
        if 'v' in loaded:
            ratings_ver = int(loaded['v'])
except Exception as e:
    print(f"ratings.json is broken, starting empty: {e}")

def get_ratings_json():
    return json.dumps({
        'v': ratings_ver,
        'items': ratings_dict,
        'bpm': tap_bpm_dict
    }, ensure_ascii=False)

def save_ratings():
    global ratings_ver
    ratings_ver += 1
    save_text(RATING_PATH, get_ratings_json())

# ----------------- Audio Tag Writing -----------------
def syncsafe_get(b, o):
    return ((b[o] & 0x7f) << 21) | ((b[o+1] & 0x7f) << 14) | ((b[o+2] & 0x7f) << 7) | (b[o+3] & 0x7f)

def syncsafe_bytes(n):
    return bytes([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])

def be32_bytes(n):
    return struct.pack('>I', n)

def le32_bytes(n):
    return struct.pack('<I', n)

ENERGY_RX = re.compile(
    r'(?<![\w])(?:[1-3]\s?[xX\u0445\u0425\u00d7]|[xX\u0445\u0425\u00d7]\s?[1-3]|[X\u0425]{1,3})(?![\w])|(?:\u2665|\u2764|\u2661|\U0001F525)[\uFE0E\uFE0F]?',
    re.UNICODE
)
X_RUN_RX = re.compile(r'(?<![\w])([X\u0425]{1,3})(?![\w])')
COMM_LANG = 'rus'

def energy_comment(old, x):
    old = str(old or '')
    if re.match(r'^(\s*[0-9A-Fa-f]{8}){4,}\s*$', old):
        old = ''
    rest = ENERGY_RX.sub(' ', old)
    rest = re.sub(r'\s{2,}', ' ', rest).strip(" ,;| -")
    x = max(0, min(3, x))
    mark = 'X' * x
    if mark and rest:
        return f"{mark} {rest}"
    if mark:
        return mark
    return rest

def build_comment(old, x, note):
    old = str(old or '')
    old_x = 0
    m = X_RUN_RX.search(old)
    if m:
        old_x = len(m.group(1))
    old_note = energy_comment(old, 0)
    if x < 0:
        x = old_x
    if note is None:
        note = old_note
    x = max(0, min(3, x))
    mark = 'X' * x
    note_str = str(note).strip() if note is not None else ''
    if mark and note_str:
        return f"{mark} {note_str}"
    if mark:
        return mark
    return note_str

def id3_decode(enc, b, o, n):
    if n <= 0 or o >= len(b):
        return ''
    sub = bytes(b[o:o+n])
    if enc == 1:
        if len(sub) >= 2 and sub[:2] in (b'\xfe\xff', b'\xff\xfe'):
            try:
                return sub.decode('utf-16').rstrip('\x00')
            except Exception:
                pass
        try:
            return sub.decode('utf-16le').rstrip('\x00')
        except Exception:
            return sub.decode('utf-16', errors='replace').rstrip('\x00')
    elif enc == 2:
        try:
            return sub.decode('utf-16be').rstrip('\x00')
        except Exception:
            return sub.decode('utf-16be', errors='replace').rstrip('\x00')
    elif enc == 3:
        return sub.decode('utf-8', errors='replace').rstrip('\x00')
    else:
        if any(c >= 0x80 for c in sub):
            try:
                return sub.decode('cp1251').rstrip('\x00')
            except Exception:
                pass
        return sub.decode('latin1', errors='replace').rstrip('\x00')

def comm_parse(d):
    if len(d) < 4:
        return {'lang': 'XXX', 'desc': '', 'text': '', 'enc': 0}
    enc = d[0]
    lang = bytes(d[1:4]).decode('ascii', errors='replace')
    p = 4
    wide = (enc == 1 or enc == 2)
    q = p
    if wide:
        while q + 1 < len(d) and not (d[q] == 0 and d[q+1] == 0):
            q += 2
        desc_end = q
        q += 2
    else:
        while q < len(d) and d[q] != 0:
            q += 1
        desc_end = q
        q += 1
    desc = id3_decode(enc, d, p, desc_end - p)
    text = id3_decode(enc, d, q, len(d) - q) if q < len(d) else ''
    return {'lang': lang, 'desc': desc, 'text': text, 'enc': enc}

def id3_frame(fid, data, ver):
    fid_bytes = fid.encode('ascii')[:4]
    szb = syncsafe_bytes(len(data)) if ver == 4 else be32_bytes(len(data))
    return fid_bytes + szb + b'\x00\x00' + data

def comm_data(lang, text, ver):
    lang_b = lang.encode('ascii')[:3]
    if len(lang_b) < 3:
        lang_b = lang_b.ljust(3, b'X')
    desc_part = b'\xff\xfe\x00\x00'
    text_part = b'\xff\xfe' + text.encode('utf-16le')
    return b'\x01' + lang_b + desc_part + text_part

def text_data(text):
    return b'\x01\xff\xfe' + text.encode('utf-16le')

def rebuild_file(path, src_f, head, pad, audio_start):
    tmp = f"{path}.swingdj.tmp"
    with open(tmp, 'wb') as out:
        out.write(head)
        if pad > 0:
            out.write(b'\x00' * pad)
        src_f.seek(audio_start)
        shutil.copyfileobj(src_f, out)
    os.replace(tmp, path)

def set_mp3_tags(path, bpm, x, allow_rebuild, txt):
    if not txt:
        txt = {}
    do_comm = (x >= 0) or (txt.get('note') is not None)

    with open(path, 'r+b') as fs:
        h = fs.read(10)
        if len(h) < 10:
            return 'unsupported'
        has_tag = (h[0] == 0x49 and h[1] == 0x44 and h[2] == 0x33)
        frames = []
        unsync = False
        ver = 3
        size = 0
        audio_start = 0
        old_bpm = ''
        plain = []
        old_title = None
        old_artist = None

        if has_tag:
            ver = h[3]
            flags = h[5]
            if ver not in (3, 4):
                return 'unsupported'
            if flags & 0x40:
                return 'unsupported'
            unsync = bool(flags & 0x80) and (ver == 3)
            if (flags & 0x80) and not unsync:
                return 'unsupported'
            size = syncsafe_get(h, 6)
            tag = bytearray(fs.read(size))
            if unsync:
                plain_tag = bytearray()
                k = 0
                while k < len(tag):
                    plain_tag.append(tag[k])
                    if tag[k] == 0xFF and k + 1 < len(tag) and tag[k+1] == 0x00:
                        k += 1
                    k += 1
                tag = plain_tag.ljust(size, b'\x00')
            audio_start = 10 + size
            if flags & 0x10:
                audio_start += 10

            p = 0
            while p + 10 <= len(tag) and tag[p] != 0:
                fid = bytes(tag[p:p+4]).decode('ascii', errors='replace')
                if ver == 4:
                    fsz = syncsafe_get(tag, p + 4)
                else:
                    fsz = (tag[p+4] << 24) | (tag[p+5] << 16) | (tag[p+6] << 8) | tag[p+7]
                if fsz < 0 or p + 10 + fsz > len(tag):
                    break
                drop = False
                frame_data = tag[p+10:p+10+fsz]
                if fid == 'TBPM' and bpm > 0:
                    old_bpm = bytes(frame_data[1:]).decode('ascii', errors='replace').strip('\x00 ')
                    drop = True
                elif (fid == 'TIT2' and txt.get('title') is not None) or (fid == 'TPE1' and txt.get('artist') is not None):
                    v = id3_decode(frame_data[0], frame_data, 1, len(frame_data) - 1) if len(frame_data) > 1 else ''
                    if fid == 'TIT2':
                        old_title = v
                    else:
                        old_artist = v
                    drop = True
                elif fid == 'COMM' and do_comm and fsz >= 5:
                    c = comm_parse(frame_data)
                    if not c['desc'].startswith('iTun'):
                        plain.append(c)
                        drop = True
                if not drop:
                    frames.append(bytes(tag[p:p+10+fsz]))
                p += 10 + fsz

        new_comm = None
        comm_same = True
        comm_lang = COMM_LANG
        if do_comm:
            main = None
            for c in plain:
                if not c['desc'] and c['lang'] == comm_lang:
                    main = c
                    break
            if not main:
                for c in plain:
                    if not c['desc']:
                        main = c
                        break
            new_comm = build_comment(main['text'] if main else '', x, txt.get('note'))
            if new_comm:
                comm_same = (len(plain) == 1 and not plain[0]['desc'] and plain[0]['lang'] == comm_lang
                             and plain[0]['enc'] == 1 and plain[0]['text'] == new_comm)
            else:
                comm_same = (len(plain) == 0)

        bpm_same = (bpm <= 0) or (old_bpm == str(bpm))
        title_same = (txt.get('title') is None) or (old_title == txt.get('title'))
        artist_same = (txt.get('artist') is None) or (old_artist == txt.get('artist'))

        if bpm_same and comm_same and title_same and artist_same:
            return 'same'

        body = bytearray()
        if txt.get('title'):
            body.extend(id3_frame('TIT2', text_data(txt['title']), ver))
        if txt.get('artist'):
            body.extend(id3_frame('TPE1', text_data(txt['artist']), ver))
        if bpm > 0:
            body.extend(id3_frame('TBPM', b'\x00' + str(bpm).encode('ascii'), ver))
        if do_comm and new_comm:
            body.extend(id3_frame('COMM', comm_data(comm_lang, new_comm, ver), ver))
        for fr in frames:
            body.extend(fr)

        if has_tag and len(body) <= size:
            if unsync:
                fs.seek(5)
                fs.write(b'\x00')
            fs.seek(10)
            fs.write(body)
            pad_len = size - len(body)
            if pad_len > 0:
                fs.write(b'\x00' * pad_len)
            return 'ok'

        if not allow_rebuild:
            return 'later'

        new_size = len(body) + 4096
        hd = bytearray(b'ID3') + bytes([ver, 0, 0]) + syncsafe_bytes(new_size) + body
        rebuild_file(path, fs, hd, 4096, audio_start)
        return 'ok'

def set_flac_tags(path, bpm, x, allow_rebuild, txt):
    if not txt:
        txt = {}
    do_comm = (x >= 0) or (txt.get('note') is not None)

    with open(path, 'r+b') as fs:
        sig = fs.read(4)
        if sig != b'fLaC':
            return 'unsupported'
        blocks = []
        while True:
            bh = fs.read(4)
            if len(bh) < 4:
                return 'unsupported'
            last = bool(bh[0] & 0x80)
            btype = bh[0] & 0x7f
            blen = (bh[1] << 16) | (bh[2] << 8) | bh[3]
            bdata = fs.read(blen)
            blocks.append({'t': btype, 'd': bdata})
            if last:
                break
        audio_start = fs.tell()
        old_total = audio_start - 4

        vc = next((b for b in blocks if b['t'] == 4), None)
        vendor = b'SwingDJ'
        items = []
        old_bpm = ''
        comms = []
        old_title = None
        old_artist = None

        if vc:
            d = vc['d']
            p = 0
            if len(d) >= 4:
                vl = struct.unpack('<I', d[p:p+4])[0]
                p += 4
                vendor = d[p:p+vl]
                p += vl
                if p + 4 <= len(d):
                    n = struct.unpack('<I', d[p:p+4])[0]
                    p += 4
                    for _ in range(n):
                        if p + 4 > len(d):
                            break
                        cl = struct.unpack('<I', d[p:p+4])[0]
                        p += 4
                        cs = d[p:p+cl].decode('utf-8', errors='replace')
                        p += cl
                        m_bpm = re.match(r'^(?i)BPM=(.*)$', cs)
                        m_comm = re.match(r'^(?i)(COMMENT|COMMENTS|DESCRIPTION)=(.*)$', cs)
                        m_title = re.match(r'^(?i)TITLE=(.*)$', cs)
                        m_artist = re.match(r'^(?i)ARTIST=(.*)$', cs)
                        if bpm > 0 and m_bpm:
                            old_bpm = m_bpm.group(1).strip()
                        elif do_comm and m_comm:
                            comms.append(m_comm.group(2))
                        elif txt.get('title') is not None and m_title:
                            if old_title is None:
                                old_title = m_title.group(1)
                        elif txt.get('artist') is not None and m_artist:
                            if old_artist is None:
                                old_artist = m_artist.group(1)
                        else:
                            items.append(cs.encode('utf-8'))

        new_comm = None
        comm_same = True
        if do_comm:
            first_comm = comms[0] if comms else ''
            new_comm = build_comment(first_comm, x, txt.get('note'))
            if new_comm:
                comm_same = (len(comms) == 1 and comms[0] == new_comm)
            else:
                comm_same = (len(comms) == 0)

        bpm_same = (bpm <= 0) or (old_bpm == str(bpm))
        title_same = (txt.get('title') is None) or (old_title == txt.get('title'))
        artist_same = (txt.get('artist') is None) or (old_artist == txt.get('artist'))

        if bpm_same and comm_same and title_same and artist_same:
            return 'same'

        if do_comm and new_comm:
            items.insert(0, f"COMMENT={new_comm}".encode('utf-8'))
        if bpm > 0:
            items.insert(0, f"BPM={bpm}".encode('utf-8'))
        if txt.get('artist'):
            items.insert(0, f"ARTIST={txt['artist']}".encode('utf-8'))
        if txt.get('title'):
            items.insert(0, f"TITLE={txt['title']}".encode('utf-8'))

        vc_data = bytearray(le32_bytes(len(vendor)) + vendor + le32_bytes(len(items)))
        for c in items:
            vc_data.extend(le32_bytes(len(c)) + c)

        keep = []
        for b in blocks:
            if b['t'] == 1:
                continue
            if b['t'] == 4:
                keep.append({'t': 4, 'd': bytes(vc_data)})
            else:
                keep.append(b)
            if b['t'] == 0 and not vc:
                keep.append({'t': 4, 'd': bytes(vc_data)})

        used = sum(4 + len(b['d']) for b in keep)
        free = old_total - used
        in_place = (free == 0 or free >= 4)
        if not in_place and not allow_rebuild:
            return 'later'

        if in_place:
            has_pad = (free >= 4)
            pad = max(0, free - 4)
        else:
            has_pad = True
            pad = 4096

        out = bytearray()
        for k, b in enumerate(keep):
            hb = b['t']
            if not has_pad and (k == len(keep) - 1):
                hb |= 0x80
            out.append(hb)
            L = len(b['d'])
            out.extend([(L >> 16) & 0xff, (L >> 8) & 0xff, L & 0xff])
            out.extend(b['d'])

        if has_pad:
            out.append(0x81)
            out.extend([(pad >> 16) & 0xff, (pad >> 8) & 0xff, pad & 0xff])

        if in_place:
            fs.seek(4)
            fs.write(out)
            if pad > 0:
                fs.write(b'\x00' * pad)
            return 'ok'

        head = bytearray(sig) + out
        rebuild_file(path, fs, head, pad, audio_start)
        return 'ok'

def write_tags(key, bpm, x, txt=None):
    global tag_pending
    key = key.lower()
    if txt is None:
        txt = {}
    if bpm != -1 and (bpm < 40 or bpm > 400):
        return 'error:bpm'
    if x > 3:
        return 'error:x'
    if key not in by_key:
        return 'error:not-found'

    if key in tag_pending:
        pd = tag_pending[key]
        if bpm == -1:
            bpm = pd['b']
        if x < 0:
            x = pd['x']
        for f0 in ('title', 'artist', 'note'):
            if txt.get(f0) is None and pd.get('txt') and pd['txt'].get(f0) is not None:
                txt[f0] = pd['txt'][f0]

    if bpm == -1 and x < 0 and txt.get('title') is None and txt.get('artist') is None and txt.get('note') is None:
        return 'same'

    idx = by_key[key]
    f = files_list[idx]
    ext = f['ext']
    rebuild = (key != now_key)
    r = 'unsupported'
    try:
        if ext == '.mp3':
            r = set_mp3_tags(f['full'], bpm, x, rebuild, txt)
        elif ext == '.flac':
            r = set_flac_tags(f['full'], bpm, x, rebuild, txt)
    except Exception as e:
        r = f'error:{e}'

    if r == 'later':
        tag_pending[key] = {'b': bpm, 'x': x, 'txt': txt}
    elif r in ('ok', 'same'):
        tag_pending.pop(key, None)

    if r == 'ok':
        try:
            st = os.stat(f['full'])
            f['size'] = st.st_size
            f['mtime'] = int(st.st_mtime)
            build_tracks_json()
        except Exception:
            pass
        what = []
        if bpm > 0:
            what.append(f"BPM {bpm}")
        if x >= 0:
            what.append(f"hearts {x}")
        for f0 in ('title', 'artist', 'note'):
            if txt.get(f0):
                what.append(f0)
        print(f"\033[36mTags ({', '.join(what)}) -> {f['name']}\033[0m")
    elif r.startswith('error:'):
        print(f"\033[33mTag write failed for {f['name']}: {r}\033[0m")

    return r

def flush_tag_pending():
    for k in list(tag_pending.keys()):
        if k == now_key:
            continue
        pd = tag_pending.pop(k)
        write_tags(k, pd['b'], pd['x'], pd['txt'])

# ----------------- LAN Addresses -----------------
def get_lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith('127.') and not ip.startswith('169.254.'):
            ips.append(ip)
    except Exception:
        pass

    try:
        out = subprocess.check_output(['ifconfig'], text=True, stderr=subprocess.DEVNULL)
        found = re.findall(r'inet\s+(\d+\.\d+\.\d+\.\d+)', out)
        for ip in found:
            if not ip.startswith('127.') and not ip.startswith('169.254.') and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ':' not in ip and not ip.startswith('127.') and not ip.startswith('169.254.') and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    def rank(ip):
        if ip.startswith('192.168.'):
            return 0
        if ip.startswith('10.'):
            return 1
        if re.match(r'^172\.(1[6-9]|2\d|3[01])\.', ip):
            return 2
        return 3

    ips.sort(key=rank)
    return ips

# ----------------- HTTP Handler -----------------
class SwingDJHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        # Silence routine request logging to keep output clean like in PowerShell
        pass

    def send_bytes(self, data, ctype='application/json; charset=utf-8', code=200, extra=None):
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'keep-alive')
            self.send_header('Cache-Control', 'no-store')
            if extra:
                for k, v in extra.items():
                    self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD' and data:
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_text(self, text, ctype='application/json; charset=utf-8', code=200):
        self.send_bytes(text.encode('utf-8'), ctype, code)

    def read_body(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length > 64 * 1024 * 1024:
                return b''
            return self.rfile.read(length)
        except Exception:
            return b''

    def send_file_range(self, path, ctype):
        try:
            fs = open(path, 'rb')
        except OSError:
            self.send_text('not found', 'text/plain', 404)
            return

        try:
            fs.seek(0, os.SEEK_END)
            total = fs.tell()
            start = 0
            end = total - 1
            code = 200
            extra = {'Accept-Ranges': 'bytes'}

            range_hdr = self.headers.get('Range')
            if range_hdr:
                m = re.match(r'^bytes=(\d*)-(\d*)$', range_hdr.strip())
                if m:
                    s_str, e_str = m.groups()
                    if s_str:
                        start = int(s_str)
                        if e_str:
                            end = int(e_str)
                        else:
                            end = min(total - 1, start + MAX_CHUNK - 1)
                    elif e_str:
                        start = max(0, total - int(e_str))

                    if end >= total:
                        end = total - 1
                    if start >= total or start > end:
                        self.send_response(416)
                        self.send_header('Content-Type', 'text/plain')
                        self.send_header('Content-Range', f'bytes */{total}')
                        self.send_header('Content-Length', '0')
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        return
                    code = 206
                    extra['Content-Range'] = f'bytes {start}-{end}/{total}'

            count = end - start + 1
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(count))
            self.send_header('Cache-Control', 'no-store')
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()

            if self.command == 'HEAD':
                return

            fs.seek(start)
            left = count
            buf_size = 65536
            while left > 0:
                chunk = fs.read(min(buf_size, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            fs.close()

    def do_HEAD(self):
        self.handle_req()

    def do_GET(self):
        self.handle_req()

    def do_POST(self):
        self.handle_req()

    def handle_req(self):
        global leader, cmd_seq, cmd_list, remote_status, remote_at, now_key
        u = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(u.path)
        query = urllib.parse.parse_qs(u.query)
        method = self.command

        if path == '/':
            path = '/index.html'
        elif path in ('/tinder', '/t'):
            path = '/tinder.html'
        elif path in ('/remote', '/r', '/pult'):
            path = '/remote.html'

        # Remote Claim
        if path == '/api/remote/claim' and method == 'POST':
            pid2 = ''
            try:
                o = json.loads(self.read_body().decode('utf-8'))
                pid2 = str(o.get('pid', ''))
            except Exception:
                pass
            if not pid2:
                self.send_text('{"error":"pid"}', 'application/json', 400)
                return
            leader = pid2
            self.send_text(json.dumps({'ok': True, 'leader': leader}))
            return

        # Remote Cmd
        if path == '/api/remote/cmd':
            if method == 'POST':
                text = self.read_body().decode('utf-8')
                try:
                    json.loads(text)
                except Exception:
                    self.send_text('{"error":"json"}', 'application/json', 400)
                    return
                cmd_seq += 1
                cmd_list.append({'id': cmd_seq, 'j': text})
                if len(cmd_list) > 50:
                    cmd_list.pop(0)
                self.send_text(json.dumps({'ok': True, 'id': cmd_seq}))
            else:
                after = -1
                if 'after' in query:
                    try:
                        after = int(query['after'][0])
                    except Exception:
                        pass
                parts = []
                for c in cmd_list:
                    if c['id'] > after:
                        parts.append(f'{{"id":{c["id"]},"c":{c["j"]}}}')
                cmds_json = ','.join(parts)
                leader_json = json.dumps(leader)
                self.send_text(f'{{"last":{cmd_seq},"leader":{leader_json},"cmds":[{cmds_json}]}}')
            return

        # Remote Status
        if path == '/api/remote/status':
            if method == 'POST':
                text = self.read_body().decode('utf-8')
                try:
                    o = json.loads(text)
                except Exception:
                    self.send_text('{"error":"json"}', 'application/json', 400)
                    return
                from_pid = str(o.get('pid', ''))
                if not leader and from_pid:
                    leader = from_pid
                if from_pid and from_pid != leader:
                    self.send_text(json.dumps({'ok': False, 'leader': leader}))
                    return
                remote_status = text
                remote_at = time.time()
                nk = ''
                try:
                    if o.get('cur') and 'key' in o['cur']:
                        nk = str(o['cur']['key']).lower()
                except Exception:
                    pass
                if nk != now_key:
                    now_key = nk
                    if tag_pending:
                        flush_tag_pending()
                self.send_text('{"ok":true}')
            else:
                age = -1
                if remote_at is not None:
                    age = int((time.time() - remote_at) * 1000)
                self.send_text(f'{{"age":{age},"s":{remote_status}}}')
            return

        # Audio streaming
        if path.startswith('/media/'):
            try:
                fid = int(path[7:])
                if 0 <= fid < len(files_list) and fid not in gone_set:
                    f = files_list[fid]
                    if not os.path.isfile(f['full']):
                        self.send_text('gone', 'text/plain', 404)
                        return
                    self.send_file_range(f['full'], AUDIO_TYPES.get(f['ext'], 'audio/mpeg'))
                else:
                    self.send_text('not found', 'text/plain', 404)
            except Exception:
                self.send_text('not found', 'text/plain', 404)
            return

        # API Tracks
        if path == '/api/tracks':
            if query.get('rescan', ['0'])[0] == '1':
                scan_library()
            self.send_text(tracks_json)
            return

        # API State
        if path == '/api/state':
            if method == 'POST':
                save_text(STATE_PATH, self.read_body().decode('utf-8'))
                self.send_text('{"ok":true}')
            else:
                self.send_text(load_text(STATE_PATH, '{}'))
            return

        # API Cache
        if path == '/api/cache':
            if method == 'POST':
                save_text(CACHE_PATH, self.read_body().decode('utf-8'))
                self.send_text('{"ok":true}')
            else:
                self.send_text(load_text(CACHE_PATH, '{}'))
            return

        # API Ratings
        if path == '/api/ratings':
            if method == 'POST':
                try:
                    d = json.loads(self.read_body().decode('utf-8'))
                except Exception:
                    self.send_text('{"error":"json"}', 'application/json', 400)
                    return
                key = str(d.get('key', ''))
                if not key:
                    self.send_text('{"error":"key"}', 'application/json', 400)
                    return
                if d.get('r') is None:
                    ratings_dict.pop(key, None)
                else:
                    r = str(d['r'])
                    if r not in ('like', 'dislike', 'later', 'keep'):
                        self.send_text('{"error":"r"}', 'application/json', 400)
                        return
                    rec = {
                        'r': r,
                        't': int(time.time() * 1000)
                    }
                    if d.get('x') is not None:
                        rec['x'] = int(d['x'])
                    if d.get('rz'):
                        rec['rz'] = 1
                    ratings_dict[key] = rec
                    if r == 'like' and 'x' in rec:
                        write_tags(key, -1, int(rec['x']))
                save_ratings()
                self.send_text(get_ratings_json())
            else:
                self.send_text(get_ratings_json())
            return

        # API BPM
        if path == '/api/bpm':
            if method != 'POST':
                self.send_text(get_ratings_json())
                return
            try:
                d = json.loads(self.read_body().decode('utf-8'))
            except Exception:
                self.send_text('{"error":"json"}', 'application/json', 400)
                return
            key = str(d.get('key', ''))
            if not key:
                self.send_text('{"error":"key"}', 'application/json', 400)
                return
            if d.get('b') is None:
                tap_bpm_dict.pop(key, None)
            else:
                b = int(d['b'])
                if b < 40 or b > 400:
                    self.send_text('{"error":"b"}', 'application/json', 400)
                    return
                tap_bpm_dict[key] = {
                    'b': b,
                    't': int(time.time() * 1000)
                }
                write_tags(key, b, -1)
            save_ratings()
            self.send_text(get_ratings_json())
            return

        # API Tags
        if path in ('/api/tagbpm', '/api/tags'):
            if method != 'POST':
                self.send_text('{}', 'application/json', 405)
                return
            try:
                d = json.loads(self.read_body().decode('utf-8'))
            except Exception:
                self.send_text('{"error":"json"}', 'application/json', 400)
                return
            res = {'ok': 0, 'same': 0, 'later': 0, 'unsupported': 0, 'failed': 0}
            errs = []
            for it in d.get('items', []):
                if not it:
                    continue
                tb = int(it['b']) if it.get('b') is not None else -1
                tx = int(it['x']) if it.get('x') is not None else -1
                tt = {}
                for f0 in ('title', 'artist', 'note'):
                    if it.get(f0) is not None:
                        tt[f0] = str(it[f0]).strip()
                r = write_tags(str(it.get('key', '')), tb, tx, tt)
                if r.startswith('error:'):
                    res['failed'] += 1
                    if len(errs) < 5:
                        errs.append(f"{it.get('key')}: {r[6:]}")
                else:
                    if r in res:
                        res[r] += 1
            res['errors'] = errs
            self.send_text(json.dumps(res))
            return

        # API Info
        if path == '/api/info':
            self.send_text(json.dumps({
                'port': PORT,
                'ips': get_lan_ips(),
                'version': SERVER_VERSION
            }))
            return

        # API Trash
        if path == '/api/trash':
            if method != 'POST':
                self.send_text('{}', 'application/json', 405)
                return
            try:
                d = json.loads(self.read_body().decode('utf-8'))
            except Exception:
                self.send_text('{"error":"json"}', 'application/json', 400)
                return
            key = str(d.get('key', '')).lower()
            if key not in by_key:
                self.send_text('{"error":"not-found"}', 'application/json', 404)
                return
            idx = by_key[key]
            f = files_list[idx]
            if os.path.isfile(f['full']):
                try:
                    os.makedirs(CRINGE_DIR, exist_ok=True)
                    base, ext = os.path.splitext(f['name'])
                    dest = os.path.join(CRINGE_DIR, f['name'])
                    k = 2
                    while os.path.exists(dest):
                        dest = os.path.join(CRINGE_DIR, f"{base} ({k}){ext}")
                        k += 1
                    shutil.move(f['full'], dest)
                    print(f"\033[33mMoved to the cringe folder: {dest}\033[0m")
                except Exception as e:
                    self.send_text(json.dumps({'error': f'move: {e}'}), 'application/json', 500)
                    return
            gone_set.add(idx)
            by_key.pop(key, None)
            build_tracks_json()
            ratings_dict.pop(key, None)
            save_ratings()
            self.send_text('{"ok":true}')
            return

        # Static files from web/
        name = path.lstrip('/')
        if re.match(r'^[A-Za-z0-9_\-]+\.[a-z]+$', name):
            file_path = os.path.join(WEB_DIR, name)
            ext = os.path.splitext(name)[1].lower()
            if os.path.isfile(file_path) and ext in WEB_TYPES:
                try:
                    with open(file_path, 'rb') as sf:
                        self.send_bytes(sf.read(), WEB_TYPES[ext])
                    return
                except Exception:
                    pass

        self.send_text('not found', 'text/plain', 404)

# ----------------- Main Entrypoint -----------------
def main():
    global PORT
    scan_library()

    server = None
    for p in range(PORT, PORT + 20):
        try:
            server = ThreadingHTTPServer(('0.0.0.0', p), SwingDJHandler)
            server.daemon_threads = True
            PORT = p
            break
        except OSError:
            continue

    if not server:
        print(f"\033[91mCould not open a port {PORT}..{PORT+19}\033[0m")
        sys.exit(1)

    url = f"http://localhost:{PORT}/"
    print()
    print(f"\033[36m  SwingDJ is running:  {url}\033[0m")
    ips = get_lan_ips()
    if ips:
        print(f"\033[36m  Phone remote:        http://{ips[0]}:{PORT}/remote\033[0m")
        print(f"\033[36m  Phone tinder:        http://{ips[0]}:{PORT}/tinder\033[0m")
        if len(ips) > 1:
            print(f"\033[90m  Other LAN addresses: {', '.join(ips[1:])}\033[0m")
    print("\033[90m  Keep this window open. Press Ctrl+C or close the window to stop.\033[0m")
    print()

    if OPEN_BROWSER:
        try:
            if sys.platform == 'darwin':
                subprocess.Popen(['open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                import webbrowser
                webbrowser.open(url)
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping SwingDJ...")
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
