# SwingDJ local server. Pure PowerShell 5.1, no installs, no admin rights.
# Serves the web UI, the list of music files and the audio itself.
# Listens on all network interfaces so a phone on the same Wi-Fi can open http://<pc-ip>:<port>/

$ErrorActionPreference = 'Stop'
$AppDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$WebDir     = Join-Path $AppDir 'web'
$StatePath  = Join-Path $AppDir 'dj-data.json'
$CachePath  = Join-Path $AppDir 'tags-cache.json'
$RatingPath = Join-Path $AppDir 'ratings.json'
$ConfigPath = Join-Path $AppDir 'config.json'

Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName Microsoft.VisualBasic
$Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Json.MaxJsonLength = [int]::MaxValue

$MusicRoot = '..'
$Port = 8765
$OpenBrowser = $true
if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $cfg = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($cfg.musicRoot) { $MusicRoot = [string]$cfg.musicRoot }
        if ($cfg.port) { $Port = [int]$cfg.port }
        if ($cfg.openBrowser -eq $false) { $OpenBrowser = $false }
    } catch { Write-Host "config.json is broken, using defaults: $_" -ForegroundColor Yellow }
}
if (-not [IO.Path]::IsPathRooted($MusicRoot)) { $MusicRoot = Join-Path $AppDir $MusicRoot }
$MusicRoot = [IO.Path]::GetFullPath($MusicRoot).TrimEnd('\') + '\'
$AppPrefix = [IO.Path]::GetFullPath($AppDir).TrimEnd('\') + '\'
# deleted tracks are moved here ("Ne v moyom vkuse" in Cyrillic) instead of the Recycle Bin; the scan skips this folder
$CringeName = -join ([char[]](0x041D, 0x0435, 0x0020, 0x0432, 0x0020, 0x043C, 0x043E, 0x0451, 0x043C, 0x0020, 0x0432, 0x043A, 0x0443, 0x0441, 0x0435))
$CringeDir = $MusicRoot + $CringeName + [IO.Path]::DirectorySeparatorChar
# the old folder name ("Krinzh") is renamed once to the new one; if both exist, the old one is still skipped by the scan
$OldCringeDir = $MusicRoot + (-join ([char[]](0x041A, 0x0440, 0x0438, 0x043D, 0x0436))) + [IO.Path]::DirectorySeparatorChar
if ((Test-Path -LiteralPath $OldCringeDir) -and -not (Test-Path -LiteralPath $CringeDir)) { try { [IO.Directory]::Move($OldCringeDir.TrimEnd('\'), $CringeDir.TrimEnd('\')) } catch { } }

$AudioTypes = @{
    '.mp3' = 'audio/mpeg'; '.flac' = 'audio/flac'; '.m4a' = 'audio/mp4'; '.mp4' = 'audio/mp4';
    '.aac' = 'audio/aac'; '.ogg' = 'audio/ogg'; '.oga' = 'audio/ogg'; '.opus' = 'audio/ogg';
    '.wav' = 'audio/wav'; '.aif' = 'audio/aiff'; '.aiff' = 'audio/aiff'
}
$WebTypes = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.json' = 'application/json; charset=utf-8' }
$MaxChunk = 1MB   # open-ended ranges are answered in pieces so one stream never blocks the server
$Utf8 = New-Object Text.UTF8Encoding $false
# bump together with SERVER_VERSION in web/common.js: pages show "restart Start.bat" when they differ
$ServerVersion = 14
$Reasons = @{ 200 = 'OK'; 206 = 'Partial Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 416 = 'Range Not Satisfiable'; 500 = 'Internal Server Error' }

$script:Files = @()
$script:ByKey = @{}
$script:TracksJson = '{"root":"","tracks":[]}'

function Esc([string]$s) { return $s.Replace('\', '\\').Replace('"', '\"') }

function Scan-Library {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "Scanning $MusicRoot ..."
    $list = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
    Get-ChildItem -LiteralPath $MusicRoot -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $f = $_
        if ($AudioTypes.ContainsKey($f.Extension.ToLowerInvariant()) -and
            -not $f.Name.StartsWith('._') -and
            -not $f.FullName.StartsWith($AppPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            -not $f.FullName.StartsWith($CringeDir, [StringComparison]::OrdinalIgnoreCase) -and
            -not $f.FullName.StartsWith($OldCringeDir, [StringComparison]::OrdinalIgnoreCase) -and
            $f.FullName -notmatch '\\(\$RECYCLE\.BIN|System Volume Information)\\') {
            $list.Add($f)
        }
    }
    $script:Files = $list.ToArray()
    $script:Gone = @{}
    $script:ByKey = @{}
    for ($i = 0; $i -lt $script:Files.Length; $i++) {
        $script:ByKey[$script:Files[$i].FullName.Substring($MusicRoot.Length).ToLowerInvariant()] = $i
    }
    Build-TracksJson
    Write-Host ("Found {0} tracks in {1:N1} s" -f $script:Files.Length, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
}
# indices stay stable until the next rescan; deleted files are just left out
function Build-TracksJson {
    $epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('{"root":"').Append((Esc $MusicRoot)).Append('","tracks":[')
    $first = $true
    for ($i = 0; $i -lt $script:Files.Length; $i++) {
        if ($script:Gone.ContainsKey($i)) { continue }
        $f = $script:Files[$i]
        if (-not $first) { [void]$sb.Append(',') }
        $first = $false
        $rel = $f.FullName.Substring($MusicRoot.Length)
        $m = [long]($f.LastWriteTimeUtc - $epoch).TotalSeconds
        [void]$sb.Append('{"i":').Append($i).Append(',"p":"').Append((Esc $rel)).Append('","s":').Append($f.Length).Append(',"m":').Append($m).Append('}')
    }
    [void]$sb.Append(']}')
    $script:TracksJson = $sb.ToString()
}

# ---------- files ----------
function Save-Text([string]$path, [string]$text) {
    $tmp = "$path.tmp"
    [IO.File]::WriteAllText($tmp, $text, $Utf8)
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
}
function Load-Text([string]$path, [string]$fallback) {
    if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) }
    return $fallback
}

# ---------- ratings (tinder): merged per track on the server, so phone and PC never overwrite each other ----------
# ::new() instead of New-Object: New-Object wraps the result in a PSObject, which the JSON serializer cannot handle
$script:Ratings = [System.Collections.Generic.Dictionary[string,object]]::new()
$script:TapBpm = [System.Collections.Generic.Dictionary[string,object]]::new()   # BPM tapped in tinder: key -> { b, t }
$script:RatingsVer = 0
try {
    $loaded = $Json.DeserializeObject((Load-Text $RatingPath '{}'))
    if ($loaded -and $loaded.ContainsKey('items')) { foreach ($k in $loaded['items'].Keys) { $script:Ratings.Add([string]$k, $loaded['items'][$k]) } }
    if ($loaded -and $loaded.ContainsKey('bpm')) { foreach ($k in $loaded['bpm'].Keys) { $script:TapBpm.Add([string]$k, $loaded['bpm'][$k]) } }
    if ($loaded -and $loaded.ContainsKey('v')) { $script:RatingsVer = [int]$loaded['v'] }
} catch { Write-Host "ratings.json is broken, starting empty: $_" -ForegroundColor Yellow }
function Ratings-Json {
    $top = [System.Collections.Generic.Dictionary[string,object]]::new()
    $top.Add('v', [int]$script:RatingsVer)
    $top.Add('items', $script:Ratings)
    $top.Add('bpm', $script:TapBpm)
    return $Json.Serialize($top)
}
function Save-Ratings { $script:RatingsVer++; Save-Text $RatingPath (Ratings-Json) }


# ---------- writing into the audio file's own tags (MP3 ID3v2.3/2.4, FLAC Vorbis comments) ----------
# BPM -> TBPM / BPM=.  Hearts -> the comment, which then holds ONLY "X", "XX" or "XXX" (all other comments are removed,
# except iTunes service data).  -1 means "leave this field alone".
# If the tag has free padding, only the tag bytes are overwritten in place: same file size, safe while playing.
# Otherwise the file is rebuilt with extra padding via a temp file; that is never done to the track playing now.
$script:TagPending = @{}   # key -> @{ b; x }, rebuilds postponed until the track stops playing
$script:NowKey = ''        # key of the track the player tab reports as playing

function Read-Exact([IO.Stream]$s, [int]$n) {
    $b = New-Object byte[] $n; $o = 0
    while ($o -lt $n) { $r = $s.Read($b, $o, $n - $o); if ($r -le 0) { throw 'unexpected end of file' }; $o += $r }
    return ,$b
}
function SyncSafe-Get([byte[]]$b, [int]$o) { return ([int]$b[$o] -shl 21) -bor ([int]$b[$o+1] -shl 14) -bor ([int]$b[$o+2] -shl 7) -bor [int]$b[$o+3] }
function SyncSafe-Bytes([int]$n) { return [byte[]]@((($n -shr 21) -band 0x7f), (($n -shr 14) -band 0x7f), (($n -shr 7) -band 0x7f), ($n -band 0x7f)) }
function BE32-Bytes([int]$n) { return [byte[]]@((($n -shr 24) -band 0xff), (($n -shr 16) -band 0xff), (($n -shr 8) -band 0xff), ($n -band 0xff)) }
function LE32-Bytes([int]$n) { return [byte[]]@(($n -band 0xff), (($n -shr 8) -band 0xff), (($n -shr 16) -band 0xff), (($n -shr 24) -band 0xff)) }

# energy marks the player understands: 2x / x2 (latin x, cyrillic kha, multiplication sign), X / XX / XXX, hearts, fire
$EnergyRx = New-Object Text.RegularExpressions.Regex ('(?<![\p{L}\p{N}])(?:[1-3]\s?[xX\u0445\u0425\u00d7]|[xX\u0445\u0425\u00d7]\s?[1-3]|[X\u0425]{1,3})(?![\p{L}\p{N}])' +
    '|(?:\u2665|\u2764|\u2661|\uD83D\uDD25)[\uFE0E\uFE0F]?')
# comment language = Windows UI language (rus on Russian Windows): Explorer shows only the comment in its own language
$CommLang = ''
try {
    Add-Type -Namespace SwingDJ -Name Lang -MemberDefinition '[DllImport("kernel32.dll")] public static extern ushort GetUserDefaultUILanguage();' -ErrorAction Stop
    $CommLang = [Globalization.CultureInfo]::new([int][SwingDJ.Lang]::GetUserDefaultUILanguage()).ThreeLetterISOLanguageName
} catch { try { $CommLang = [Globalization.CultureInfo]::InstalledUICulture.ThreeLetterISOLanguageName } catch { } }
if ($CommLang -notmatch '^[a-z]{3}$') { $CommLang = 'XXX' }
function Energy-Comment([string]$old, [int]$x) {
    if ($old -match '^(\s*[0-9A-Fa-f]{8}){4,}\s*$') { $old = '' }   # ripper junk like 00000A3B 00000C12 ...
    $rest = $EnergyRx.Replace([string]$old, ' ')
    $rest = ($rest -replace '\s{2,}', ' ').Trim().Trim(',', ';', '|', '-', ' ')
    $mark = 'X' * [Math]::Max(0, [Math]::Min(3, $x))
    if ($mark -and $rest) { return "$mark $rest" }
    if ($mark) { return $mark }
    return $rest
}

# rebuild: new header bytes + padding + the audio part of the original file -> temp file -> replace original
function Rebuild-File([string]$path, [IO.Stream]$src, [byte[]]$head, [int]$pad, [long]$audioStart) {
    $tmp = "$path.swingdj.tmp"
    $out = [IO.File]::Open($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $out.Write($head, 0, $head.Length)
        if ($pad -gt 0) { $z = New-Object byte[] $pad; $out.Write($z, 0, $pad) }
        $src.Position = $audioStart
        $src.CopyTo($out)
    } finally { $out.Close() }
    $src.Close()
    try { [IO.File]::Replace($tmp, $path, [NullString]::Value) }
    catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
}

# ID3 text in the given encoding byte; Latin-1 with high bytes is treated as cp1251 (common in Russian libraries)
$Cp1251 = [Text.Encoding]::GetEncoding(1251)
function Id3-Decode([int]$enc, [byte[]]$b, [int]$o, [int]$n) {
    if ($n -le 0) { return '' }
    switch ($enc) {
        1 { if ($n -ge 2 -and $b[$o] -eq 0xFE -and $b[$o+1] -eq 0xFF) { return [Text.Encoding]::BigEndianUnicode.GetString($b, $o + 2, $n - 2).TrimEnd([char]0) }
            if ($n -ge 2 -and $b[$o] -eq 0xFF -and $b[$o+1] -eq 0xFE) { return [Text.Encoding]::Unicode.GetString($b, $o + 2, $n - 2).TrimEnd([char]0) }
            return [Text.Encoding]::Unicode.GetString($b, $o, $n).TrimEnd([char]0) }
        2 { return [Text.Encoding]::BigEndianUnicode.GetString($b, $o, $n).TrimEnd([char]0) }
        3 { return [Text.Encoding]::UTF8.GetString($b, $o, $n).TrimEnd([char]0) }
        default {
            $hi = $false; for ($k = $o; $k -lt $o + $n; $k++) { if ($b[$k] -ge 0x80) { $hi = $true; break } }
            if ($hi) { return $Cp1251.GetString($b, $o, $n).TrimEnd([char]0) }
            return [Text.Encoding]::GetEncoding(28591).GetString($b, $o, $n).TrimEnd([char]0)
        }
    }
}
# COMM frame data -> description, text (the description ends with a 1- or 2-byte zero)
function Comm-Parse([byte[]]$d) {
    $enc = [int]$d[0]; $lang = [Text.Encoding]::ASCII.GetString($d, 1, 3); $p = 4
    $wide = ($enc -eq 1 -or $enc -eq 2)
    $q = $p
    if ($wide) { while ($q + 1 -lt $d.Length -and -not ($d[$q] -eq 0 -and $d[$q+1] -eq 0)) { $q += 2 }; $descEnd = $q; $q += 2 }
    else { while ($q -lt $d.Length -and $d[$q] -ne 0) { $q++ }; $descEnd = $q; $q += 1 }
    $desc = Id3-Decode $enc $d $p ($descEnd - $p)
    $text = if ($q -lt $d.Length) { Id3-Decode $enc $d $q ($d.Length - $q) } else { '' }
    return @{ lang = $lang; desc = $desc; text = $text; enc = $enc }
}
function Id3-Frame([string]$id, [byte[]]$data, [int]$ver) {
    if ($ver -eq 4) { $szb = SyncSafe-Bytes $data.Length } else { $szb = BE32-Bytes $data.Length }
    $ms = New-Object IO.MemoryStream
    $ms.Write([Text.Encoding]::ASCII.GetBytes($id), 0, 4); $ms.Write($szb, 0, 4); $ms.WriteByte(0); $ms.WriteByte(0); $ms.Write($data, 0, $data.Length)
    return ,$ms.ToArray()
}
function Comm-Data([string]$lang, [string]$text, [int]$ver) {
    $ms = New-Object IO.MemoryStream
    # UTF-16 with BOM and an empty description in both ID3v2.3 and v2.4: Windows Explorer does not show UTF-8 comments
    $ms.WriteByte(1); $ms.Write([Text.Encoding]::ASCII.GetBytes($lang), 0, 3); $ms.Write([byte[]]@(0xFF, 0xFE, 0, 0), 0, 4)
    $t = [byte[]]@(0xFF, 0xFE) + [Text.Encoding]::Unicode.GetBytes($text)
    $ms.Write($t, 0, $t.Length)
    return ,$ms.ToArray()
}

# the hearts mark at the start of a comment: X / XX / XXX (latin X or cyrillic kha)
$XRunRx = New-Object Text.RegularExpressions.Regex ('(?<![\p{L}\p{N}])([X' + [char]0x0425 + ']{1,3})(?![\p{L}\p{N}])')
# comment = hearts mark + the user's note.  $x / $note: new values, or -1 / $null to keep what the old comment had
function Build-Comment([string]$old, [int]$x, $note) {
    $oldX = 0; $m = $XRunRx.Match([string]$old); if ($m.Success) { $oldX = $m.Groups[1].Length }
    $oldNote = Energy-Comment ([string]$old) 0          # old text without energy marks and ripper junk
    if ($x -lt 0) { $x = $oldX }
    if ($null -eq $note) { $note = $oldNote }
    $mark = 'X' * [Math]::Max(0, [Math]::Min(3, $x))
    return ("$mark " + ([string]$note).Trim()).Trim()
}
# ID3 text frame data: UTF-16 with BOM (fine in v2.3 and v2.4)
function Text-Data([string]$text) { return ,([byte[]](,1 + [byte[]](0xFF, 0xFE) + [Text.Encoding]::Unicode.GetBytes($text))) }

# $txt: @{ title; artist; note } - $null means "leave alone"
function Set-Mp3Tags([string]$path, [int]$bpm, [int]$x, [bool]$allowRebuild, $txt) {
    if (-not $txt) { $txt = @{} }
    $doComm = ($x -ge 0) -or ($null -ne $txt.note)
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try {
        $h = Read-Exact $fs 10
        $frames = New-Object System.Collections.Generic.List[byte[]]
        $unsync = $false; $ver = 3; $size = 0; $audioStart = [long]0; $oldBpm = ''; $plain = New-Object System.Collections.Generic.List[object]
        $oldTitle = $null; $oldArtist = $null
        $hasTag = ($h[0] -eq 0x49 -and $h[1] -eq 0x44 -and $h[2] -eq 0x33)
        if ($hasTag) {
            $ver = [int]$h[3]; $flags = [int]$h[5]
            if ($ver -ne 3 -and $ver -ne 4) { return 'unsupported' }       # ID3v2.2 is too old to touch
            if ($flags -band 0x40) { return 'unsupported' }                  # extended header
            $unsync = (($flags -band 0x80) -ne 0) -and $ver -eq 3        # v2.4 marks it per frame: not handled
            if (($flags -band 0x80) -and -not $unsync) { return 'unsupported' }
            $size = SyncSafe-Get $h 6
            $tag = Read-Exact $fs $size
            if ($unsync) {
                # old unsynchronised tag (v2.3): every FF 00 inside is really FF; decode it, write it back plain
                $um = New-Object IO.MemoryStream ($size)
                for ($k = 0; $k -lt $size; $k++) { $um.WriteByte($tag[$k]); if ($tag[$k] -eq 0xFF -and $k + 1 -lt $size -and $tag[$k + 1] -eq 0) { $k++ } }
                $plainTag = $um.ToArray(); $tag = New-Object byte[] $size; [Array]::Copy($plainTag, $tag, $plainTag.Length)
            }
            $audioStart = 10 + $size; if ($flags -band 0x10) { $audioStart += 10 }
            $p = 0
            while ($p + 10 -le $size -and $tag[$p] -ne 0) {
                $id = [Text.Encoding]::ASCII.GetString($tag, $p, 4)
                if ($ver -eq 4) { $fsz = SyncSafe-Get $tag ($p + 4) }
                else { $fsz = ([int]$tag[$p+4] -shl 24) -bor ([int]$tag[$p+5] -shl 16) -bor ([int]$tag[$p+6] -shl 8) -bor [int]$tag[$p+7] }
                if ($fsz -lt 0 -or $p + 10 + $fsz -gt $size) { break }
                $drop = $false
                if ($id -eq 'TBPM' -and $bpm -gt 0) {
                    $oldBpm = [Text.Encoding]::ASCII.GetString($tag, $p + 11, [Math]::Max(0, $fsz - 1)).Trim([char]0, ' '); $drop = $true
                }
                elseif (($id -eq 'TIT2' -and $null -ne $txt.title) -or ($id -eq 'TPE1' -and $null -ne $txt.artist)) {
                    $v = if ($fsz -gt 1) { Id3-Decode ([int]$tag[$p + 10]) $tag ($p + 11) ($fsz - 1) } else { '' }
                    if ($id -eq 'TIT2') { $oldTitle = $v } else { $oldArtist = $v }
                    $drop = $true
                }
                elseif ($id -eq 'COMM' -and $doComm -and $fsz -ge 5) {
                    $d = New-Object byte[] $fsz; [Array]::Copy($tag, $p + 10, $d, 0, $fsz)
                    $c = Comm-Parse $d
                    # every comment goes away except iTunes service data (loudness, gapless): those are not shown anywhere
                    if (-not ($c.desc -like 'iTun*')) { $plain.Add($c); $drop = $true }
                }
                if (-not $drop) { $fr = New-Object byte[] (10 + $fsz); [Array]::Copy($tag, $p, $fr, 0, 10 + $fsz); $frames.Add($fr) }
                $p += 10 + $fsz
            }
        }
        # the comment: hearts mark + the user's note, in the Windows UI language, UTF-16, no description
        $newComm = $null; $commSame = $true
        if ($doComm) {
            $main = $null
            foreach ($c in $plain) { if (-not $c.desc -and $c.lang -eq $CommLang) { $main = $c; break } }
            if (-not $main) { foreach ($c in $plain) { if (-not $c.desc) { $main = $c; break } } }
            $newComm = Build-Comment ($(if ($main) { $main.text } else { '' })) $x $txt.note
            if ($newComm) { $commSame = ($plain.Count -eq 1 -and -not $plain[0].desc -and $plain[0].lang -eq $CommLang -and $plain[0].enc -eq 1 -and $plain[0].text -ceq $newComm) }
            else { $commSame = ($plain.Count -eq 0) }
        }
        $bpmSame = ($bpm -le 0) -or ($oldBpm -eq "$bpm")
        $titleSame = ($null -eq $txt.title) -or ([string]$oldTitle -ceq [string]$txt.title)
        $artistSame = ($null -eq $txt.artist) -or ([string]$oldArtist -ceq [string]$txt.artist)
        if ($bpmSame -and $commSame -and $titleSame -and $artistSame) { return 'same' }
        $ms = New-Object IO.MemoryStream
        # our frames go first, so they win over any other field of the same kind
        if ($null -ne $txt.title -and $txt.title) { $fr = Id3-Frame 'TIT2' (Text-Data $txt.title) $ver; $ms.Write($fr, 0, $fr.Length) }
        if ($null -ne $txt.artist -and $txt.artist) { $fr = Id3-Frame 'TPE1' (Text-Data $txt.artist) $ver; $ms.Write($fr, 0, $fr.Length) }
        if ($bpm -gt 0) { $fr = Id3-Frame 'TBPM' ([byte[]](,0 + [Text.Encoding]::ASCII.GetBytes("$bpm"))) $ver; $ms.Write($fr, 0, $fr.Length) }
        if ($doComm -and $newComm) { $fr = Id3-Frame 'COMM' (Comm-Data $CommLang $newComm $ver) $ver; $ms.Write($fr, 0, $fr.Length) }
        foreach ($fr in $frames) { $ms.Write($fr, 0, $fr.Length) }
        $body = $ms.ToArray()
        if ($hasTag -and $body.Length -le $size) {
            if ($unsync) { $fs.Position = 5; $fs.WriteByte(0) }   # the tag is written back without unsynchronisation
            $fs.Position = 10; $fs.Write($body, 0, $body.Length)
            $z = New-Object byte[] ($size - $body.Length); $fs.Write($z, 0, $z.Length)
            return 'ok'
        }
        if (-not $allowRebuild) { return 'later' }
        $newSize = $body.Length + 4096
        $hd = New-Object IO.MemoryStream
        $hd.Write([byte[]]@(0x49, 0x44, 0x33, [byte]$ver, 0, 0), 0, 6); $hd.Write((SyncSafe-Bytes $newSize), 0, 4); $hd.Write($body, 0, $body.Length)
        Rebuild-File $path $fs $hd.ToArray() 4096 $audioStart
        return 'ok'
    } finally { $fs.Close() }
}

function Set-FlacTags([string]$path, [int]$bpm, [int]$x, [bool]$allowRebuild, $txt) {
    if (-not $txt) { $txt = @{} }
    $doComm = ($x -ge 0) -or ($null -ne $txt.note)
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try {
        $sig = Read-Exact $fs 4
        if ([Text.Encoding]::ASCII.GetString($sig) -ne 'fLaC') { return 'unsupported' }
        $blocks = New-Object System.Collections.Generic.List[object]
        do {
            $bh = Read-Exact $fs 4
            $last = ($bh[0] -band 0x80) -ne 0; $type = [int]($bh[0] -band 0x7f)
            $len = ([int]$bh[1] -shl 16) -bor ([int]$bh[2] -shl 8) -bor [int]$bh[3]
            $blocks.Add([pscustomobject]@{ t = $type; d = (Read-Exact $fs $len) })
        } while (-not $last)
        $audioStart = $fs.Position
        $oldTotal = $audioStart - 4
        # Vorbis comment: vendor + list of NAME=value (little-endian lengths)
        $vc = $null; foreach ($b in $blocks) { if ($b.t -eq 4) { $vc = $b; break } }
        $vendor = [Text.Encoding]::UTF8.GetBytes('SwingDJ'); $items = New-Object System.Collections.Generic.List[byte[]]
        $oldBpm = ''; $comms = New-Object System.Collections.Generic.List[string]; $oldTitle = $null; $oldArtist = $null
        if ($vc) {
            $d = $vc.d; $p = 0
            $vl = [BitConverter]::ToInt32($d, $p); $p += 4; $vendor = New-Object byte[] $vl; [Array]::Copy($d, $p, $vendor, 0, $vl); $p += $vl
            $n = [BitConverter]::ToInt32($d, $p); $p += 4
            for ($k = 0; $k -lt $n; $k++) {
                $cl = [BitConverter]::ToInt32($d, $p); $p += 4
                $s = [Text.Encoding]::UTF8.GetString($d, $p, $cl)
                if ($bpm -gt 0 -and $s -match '^(?i)BPM=(.*)$') { $oldBpm = $Matches[1].Trim() }
                elseif ($doComm -and $s -match '^(?i)(COMMENT|COMMENTS|DESCRIPTION)=(.*)$') { $comms.Add($Matches[2]) }   # all comments go away
                elseif ($null -ne $txt.title -and $s -match '^(?i)TITLE=(.*)$') { if ($null -eq $oldTitle) { $oldTitle = $Matches[1] } }
                elseif ($null -ne $txt.artist -and $s -match '^(?i)ARTIST=(.*)$') { if ($null -eq $oldArtist) { $oldArtist = $Matches[1] } }
                else { $c = New-Object byte[] $cl; [Array]::Copy($d, $p, $c, 0, $cl); $items.Add($c) }
                $p += $cl
            }
        }
        # the comment: hearts mark + the user's note
        $newComm = $null; $commSame = $true
        if ($doComm) {
            $newComm = Build-Comment ($(if ($comms.Count) { $comms[0] } else { '' })) $x $txt.note
            if ($newComm) { $commSame = ($comms.Count -eq 1 -and $comms[0] -ceq $newComm) } else { $commSame = ($comms.Count -eq 0) }
        }
        $bpmSame = ($bpm -le 0) -or ($oldBpm -eq "$bpm")
        $titleSame = ($null -eq $txt.title) -or ([string]$oldTitle -ceq [string]$txt.title)
        $artistSame = ($null -eq $txt.artist) -or ([string]$oldArtist -ceq [string]$txt.artist)
        if ($bpmSame -and $commSame -and $titleSame -and $artistSame) { return 'same' }
        if ($doComm -and $newComm) { $items.Insert(0, [Text.Encoding]::UTF8.GetBytes("COMMENT=$newComm")) }
        if ($bpm -gt 0) { $items.Insert(0, [Text.Encoding]::UTF8.GetBytes("BPM=$bpm")) }
        if ($null -ne $txt.artist -and $txt.artist) { $items.Insert(0, [Text.Encoding]::UTF8.GetBytes("ARTIST=" + $txt.artist)) }
        if ($null -ne $txt.title -and $txt.title) { $items.Insert(0, [Text.Encoding]::UTF8.GetBytes("TITLE=" + $txt.title)) }
        $ms = New-Object IO.MemoryStream
        $ms.Write((LE32-Bytes $vendor.Length), 0, 4); $ms.Write($vendor, 0, $vendor.Length); $ms.Write((LE32-Bytes $items.Count), 0, 4)
        foreach ($c in $items) { $ms.Write((LE32-Bytes $c.Length), 0, 4); $ms.Write($c, 0, $c.Length) }
        $vcData = $ms.ToArray()
        # new block list: everything except padding, with the new comment block (right after STREAMINFO if there was none)
        $keep = New-Object System.Collections.Generic.List[object]
        foreach ($b in $blocks) {
            if ($b.t -eq 1) { continue }
            if ($b.t -eq 4) { $keep.Add([pscustomobject]@{ t = 4; d = $vcData }) } else { $keep.Add($b) }
            if ($b.t -eq 0 -and -not $vc) { $keep.Add([pscustomobject]@{ t = 4; d = $vcData }) }
        }
        $used = 0; foreach ($b in $keep) { $used += 4 + $b.d.Length }
        $free = $oldTotal - $used
        $inPlace = ($free -eq 0 -or $free -ge 4)
        if (-not $inPlace -and -not $allowRebuild) { return 'later' }
        if ($inPlace) { $hasPad = ($free -ge 4); $pad = [Math]::Max(0, $free - 4) } else { $hasPad = $true; $pad = 4096 }
        $out = New-Object IO.MemoryStream
        for ($k = 0; $k -lt $keep.Count; $k++) {
            $b = $keep[$k]
            $hb = [int]$b.t; if ((-not $hasPad) -and ($k -eq $keep.Count - 1)) { $hb = $hb -bor 0x80 }
            $out.WriteByte([byte]$hb)
            $L = $b.d.Length; $out.Write([byte[]]@((($L -shr 16) -band 0xff), (($L -shr 8) -band 0xff), ($L -band 0xff)), 0, 3)
            $out.Write($b.d, 0, $L)
        }
        if ($hasPad) { $out.WriteByte(0x81); $out.Write([byte[]]@((($pad -shr 16) -band 0xff), (($pad -shr 8) -band 0xff), ($pad -band 0xff)), 0, 3) }
        $meta = $out.ToArray()
        if ($inPlace) {
            $fs.Position = 4; $fs.Write($meta, 0, $meta.Length)
            if ($pad -gt 0) { $z = New-Object byte[] $pad; $fs.Write($z, 0, $pad) }
            return 'ok'
        }
        $head = New-Object byte[] (4 + $meta.Length); [Array]::Copy($sig, 0, $head, 0, 4); [Array]::Copy($meta, 0, $head, 4, $meta.Length)
        Rebuild-File $path $fs $head $pad $audioStart
        return 'ok'
    } finally { $fs.Close() }
}

# one track: $bpm 40..400 or -1, $x 0..3 or -1, $txt @{ title; artist; note } ($null = keep);
# returns ok | same | later | unsupported | error:...
function Write-Tags([string]$key, [int]$bpm, [int]$x, $txt) {
    $key = $key.ToLowerInvariant()
    if (-not $txt) { $txt = @{} }
    if ($bpm -ne -1 -and ($bpm -lt 40 -or $bpm -gt 400)) { return 'error:bpm' }
    if ($x -gt 3) { return 'error:x' }
    if (-not $script:ByKey.ContainsKey($key)) { return 'error:not-found' }
    # merge with a postponed write for the same file
    if ($script:TagPending.ContainsKey($key)) {
        $pd = $script:TagPending[$key]
        if ($bpm -eq -1) { $bpm = $pd.b }
        if ($x -lt 0) { $x = $pd.x }
        foreach ($f0 in @('title', 'artist', 'note')) { if ($null -eq $txt[$f0] -and $pd.txt -and $null -ne $pd.txt[$f0]) { $txt[$f0] = $pd.txt[$f0] } }
    }
    if ($bpm -eq -1 -and $x -lt 0 -and $null -eq $txt.title -and $null -eq $txt.artist -and $null -eq $txt.note) { return 'same' }
    $idx = $script:ByKey[$key]; $f = $script:Files[$idx]
    $ext = $f.Extension.ToLowerInvariant()
    $rebuild = ($key -ne $script:NowKey)
    $r = 'unsupported'
    try {
        if ($ext -eq '.mp3') { $r = Set-Mp3Tags $f.FullName $bpm $x $rebuild $txt }
        elseif ($ext -eq '.flac') { $r = Set-FlacTags $f.FullName $bpm $x $rebuild $txt }
    } catch { $r = 'error:' + $_.Exception.Message }
    if ($r -eq 'later') { $script:TagPending[$key] = @{ b = $bpm; x = $x; txt = $txt } }
    elseif ($r -eq 'ok' -or $r -eq 'same') { [void]$script:TagPending.Remove($key) }
    if ($r -eq 'ok') {
        $f.Refresh(); Build-TracksJson
        $what = @(); if ($bpm -gt 0) { $what += "BPM $bpm" }; if ($x -ge 0) { $what += "hearts $x" }
        foreach ($f0 in @('title', 'artist', 'note')) { if ($null -ne $txt[$f0]) { $what += $f0 } }
        Write-Host "Tags ($($what -join ', ')) -> $($f.Name)" -ForegroundColor DarkCyan
    } elseif ($r -like 'error:*') { Write-Host "Tag write failed for $($f.Name): $r" -ForegroundColor DarkYellow }
    return $r
}
function Write-TagBpm([string]$key, [int]$bpm) { return Write-Tags $key $bpm -1 }
# postponed rebuilds: run once their track is no longer playing
function Flush-TagPending {
    foreach ($k in @($script:TagPending.Keys)) {
        if ($k -eq $script:NowKey) { continue }
        $pd = $script:TagPending[$k]; [void]$script:TagPending.Remove($k)
        [void](Write-Tags $k $pd.b $pd.x $pd.txt)
    }
}

# ---------- remote control: the phone queues commands, the player page on the laptop picks them up ----------
$script:Cmds = [System.Collections.Generic.List[object]]::new()
$script:CmdSeq = 0
$script:RemoteStatus = 'null'
$script:RemoteAt = $null
# only one player tab is "live" for the remote: the newest one (or the one where the user pressed "control from here")
$script:Leader = ''

function Lan-Addresses {
    $out = @()
    try {
        foreach ($ni in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($ni.OperationalStatus -ne 'Up' -or $ni.NetworkInterfaceType -eq 'Loopback') { continue }
            if ($ni.Description -match 'Virtual|VMware|VirtualBox|Hyper-V|vEthernet|TAP|WSL|Bluetooth') { continue }
            foreach ($ua in $ni.GetIPProperties().UnicastAddresses) {
                $a = $ua.Address
                if ($a.AddressFamily -eq 'InterNetwork' -and -not $a.ToString().StartsWith('169.254.')) { $out += $a.ToString() }
            }
        }
    } catch { }
    # home Wi-Fi addresses first, VPN-like ones (26.x, 100.x ...) last
    $rank = { param($a) if ($a -like '192.168.*') { 0 } elseif ($a -like '10.*') { 1 } elseif ($a -match '^172\.(1[6-9]|2\d|3[01])\.') { 2 } else { 3 } }
    $out = @($out | Sort-Object { & $rank $_ })
    return ,$out
}

# ---------- tiny HTTP over TcpListener ----------
function Read-Request($stream) {
    $buf = New-Object byte[] 8192
    $ms = New-Object IO.MemoryStream
    $headEnd = -1
    while ($headEnd -lt 0) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { return $null }
        $ms.Write($buf, 0, $n)
        # ASCII decoding keeps 1 byte = 1 char, so the index is also the byte offset
        $headEnd = [Text.Encoding]::ASCII.GetString($ms.GetBuffer(), 0, [int]$ms.Length).IndexOf("`r`n`r`n")
        if ($headEnd -lt 0 -and $ms.Length -gt 65536) { return $null }
    }
    $all = $ms.ToArray()
    $lines = [Text.Encoding]::ASCII.GetString($all, 0, $headEnd) -split "`r`n"
    $parts = $lines[0] -split ' '
    if ($parts.Length -lt 2) { return $null }
    $hdr = @{}
    foreach ($l in $lines[1..($lines.Length - 1)]) {
        $c = $l.IndexOf(':')
        if ($c -gt 0) { $hdr[$l.Substring(0, $c).Trim().ToLowerInvariant()] = $l.Substring($c + 1).Trim() }
    }
    $target = $parts[1]; $path = $target; $query = @{}
    $q = $target.IndexOf('?')
    if ($q -ge 0) {
        $path = $target.Substring(0, $q)
        foreach ($kv in $target.Substring($q + 1) -split '&') {
            if (-not $kv) { continue }
            $e = $kv.IndexOf('=')
            if ($e -ge 0) { $query[[Uri]::UnescapeDataString($kv.Substring(0, $e))] = [Uri]::UnescapeDataString($kv.Substring($e + 1).Replace('+', ' ')) }
            else { $query[[Uri]::UnescapeDataString($kv)] = '' }
        }
    }
    $body = [byte[]]@()
    if ($hdr.ContainsKey('content-length')) {
        $len = [int]$hdr['content-length']
        if ($len -gt 64MB) { return $null }
        $body = New-Object byte[] $len
        $got = [Math]::Min($len, $all.Length - ($headEnd + 4))
        if ($got -gt 0) { [Array]::Copy($all, $headEnd + 4, $body, 0, $got) } else { $got = 0 }
        while ($got -lt $len) { $n = $stream.Read($body, $got, $len - $got); if ($n -le 0) { break }; $got += $n }
    }
    return @{ Method = $parts[0].ToUpperInvariant(); Path = [Uri]::UnescapeDataString($path); Query = $query; Headers = $hdr; Body = $body }
}

function Write-Head($ctx, [int]$code, [string]$ctype, [long]$len, [hashtable]$extra = @{}) {
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append("HTTP/1.1 $code $($Reasons[$code])`r`n")
    [void]$sb.Append("Content-Type: $ctype`r`nContent-Length: $len`r`nConnection: close`r`nCache-Control: no-store`r`n")
    foreach ($k in $extra.Keys) { [void]$sb.Append("${k}: $($extra[$k])`r`n") }
    [void]$sb.Append("`r`n")
    $b = [Text.Encoding]::ASCII.GetBytes($sb.ToString())
    $ctx.Stream.Write($b, 0, $b.Length)
}
function Send-Bytes($ctx, [byte[]]$bytes, [string]$ctype, [int]$code = 200) {
    Write-Head $ctx $code $ctype $bytes.Length
    if ($ctx.Req.Method -ne 'HEAD' -and $bytes.Length) { $ctx.Stream.Write($bytes, 0, $bytes.Length) }
}
function Send-Text($ctx, [string]$text, [string]$ctype = 'application/json; charset=utf-8', [int]$code = 200) {
    Send-Bytes $ctx ($Utf8.GetBytes($text)) $ctype $code
}
function Body-Text($ctx) { return $Utf8.GetString($ctx.Req.Body) }

function Send-File($ctx, [string]$path, [string]$ctype) {
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $len = $fs.Length
        $start = [long]0; $end = $len - 1; $code = 200
        $extra = @{ 'Accept-Ranges' = 'bytes' }
        $range = $ctx.Req.Headers['range']
        if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
            if ($Matches[1] -ne '') {
                $start = [long]$Matches[1]
                if ($Matches[2] -ne '') { $end = [long]$Matches[2] } else { $end = [Math]::Min($len - 1, $start + $MaxChunk - 1) }
            } elseif ($Matches[2] -ne '') {
                $start = [Math]::Max([long]0, $len - [long]$Matches[2])
            }
            if ($end -ge $len) { $end = $len - 1 }
            if ($start -ge $len -or $start -gt $end) {
                Write-Head $ctx 416 'text/plain' 0 @{ 'Content-Range' = "bytes */$len" }
                return
            }
            $code = 206
            $extra['Content-Range'] = "bytes $start-$end/$len"
        }
        $count = $end - $start + 1
        Write-Head $ctx $code $ctype $count $extra
        if ($ctx.Req.Method -eq 'HEAD') { return }
        $fs.Position = $start
        $buf = New-Object byte[] 65536
        $left = $count
        while ($left -gt 0) {
            $n = $fs.Read($buf, 0, [int][Math]::Min([long]$buf.Length, $left))
            if ($n -le 0) { break }
            $ctx.Stream.Write($buf, 0, $n)
            $left -= $n
        }
    } finally { $fs.Close() }
}

function Handle($ctx) {
    $req = $ctx.Req
    $path = $req.Path
    $method = $req.Method
    if ($path -eq '/') { $path = '/index.html' }
    if ($path -eq '/tinder' -or $path -eq '/t') { $path = '/tinder.html' }
    if ($path -eq '/remote' -or $path -eq '/r' -or $path -eq '/pult') { $path = '/remote.html' }

    if ($path -eq '/api/remote/claim' -and $method -eq 'POST') {
        $pid2 = ''
        try { $o = $Json.DeserializeObject((Body-Text $ctx)); $pid2 = [string]$o['pid'] } catch { }
        if (-not $pid2) { Send-Text $ctx '{"error":"pid"}' 'application/json' 400; return }
        $script:Leader = $pid2
        Send-Text $ctx ('{"ok":true,"leader":' + $Json.Serialize($script:Leader) + '}')
        return
    }
    if ($path -eq '/api/remote/cmd') {
        if ($method -eq 'POST') {
            $text = Body-Text $ctx
            try { [void]$Json.DeserializeObject($text) } catch { Send-Text $ctx '{"error":"json"}' 'application/json' 400; return }
            $script:CmdSeq++
            $script:Cmds.Add([pscustomobject]@{ id = $script:CmdSeq; j = $text })
            if ($script:Cmds.Count -gt 50) { $script:Cmds.RemoveAt(0) }
            Send-Text $ctx ('{"ok":true,"id":' + $script:CmdSeq + '}')
        } else {
            $after = -1; [void][int]::TryParse([string]$req.Query['after'], [ref]$after)
            $parts = foreach ($c in $script:Cmds) { if ($c.id -gt $after) { '{"id":' + $c.id + ',"c":' + $c.j + '}' } }
            Send-Text $ctx ('{"last":' + $script:CmdSeq + ',"leader":' + $Json.Serialize($script:Leader) + ',"cmds":[' + (@($parts) -join ',') + ']}')
        }
        return
    }
    if ($path -eq '/api/remote/status') {
        if ($method -eq 'POST') {
            $text = Body-Text $ctx
            $o = $null
            try { $o = $Json.DeserializeObject($text) } catch { Send-Text $ctx '{"error":"json"}' 'application/json' 400; return }
            $from = ''; try { $from = [string]$o['pid'] } catch { }
            if (-not $script:Leader -and $from) { $script:Leader = $from }
            if ($from -and $from -ne $script:Leader) { Send-Text $ctx ('{"ok":false,"leader":' + $Json.Serialize($script:Leader) + '}'); return }
            $script:RemoteStatus = $text; $script:RemoteAt = [DateTime]::UtcNow
            $nk = ''; try { if ($o['cur']) { $nk = ([string]$o['cur']['key']).ToLowerInvariant() } } catch { }
            if ($nk -ne $script:NowKey) { $script:NowKey = $nk; if ($script:TagPending.Count) { Flush-TagPending } }
            Send-Text $ctx '{"ok":true}'
        } else {
            $age = -1; if ($script:RemoteAt) { $age = [int]([DateTime]::UtcNow - $script:RemoteAt).TotalMilliseconds }
            Send-Text $ctx ('{"age":' + $age + ',"s":' + $script:RemoteStatus + '}')
        }
        return
    }

    if ($path -like '/media/*') {
        $id = 0
        if ([int]::TryParse($path.Substring(7), [ref]$id) -and $id -ge 0 -and $id -lt $script:Files.Length -and -not $script:Gone.ContainsKey($id)) {
            $f = $script:Files[$id]
            if (-not (Test-Path -LiteralPath $f.FullName)) { Send-Text $ctx 'gone' 'text/plain' 404; return }
            Send-File $ctx $f.FullName $AudioTypes[$f.Extension.ToLowerInvariant()]
        } else { Send-Text $ctx 'not found' 'text/plain' 404 }
        return
    }

    switch ($path) {
        '/api/tracks' {
            if ($req.Query['rescan'] -eq '1') { Scan-Library }
            Send-Text $ctx $script:TracksJson; return
        }
        '/api/state' {
            if ($method -eq 'POST') { Save-Text $StatePath (Body-Text $ctx); Send-Text $ctx '{"ok":true}' }
            else { Send-Text $ctx (Load-Text $StatePath '{}') }
            return
        }
        '/api/cache' {
            if ($method -eq 'POST') { Save-Text $CachePath (Body-Text $ctx); Send-Text $ctx '{"ok":true}' }
            else { Send-Text $ctx (Load-Text $CachePath '{}') }
            return
        }
        '/api/ratings' {
            if ($method -eq 'POST') {
                # body: { "key": "...", "r": "like"|"dislike"|"later"|"keep"|null, "x": 0..3 }  (keep = seen, hearts unchanged; r null = forget the rating)
                $d = $Json.DeserializeObject((Body-Text $ctx))
                $key = [string]$d['key']
                if (-not $key) { Send-Text $ctx '{"error":"key"}' 'application/json' 400; return }
                if ($null -eq $d['r']) { [void]$script:Ratings.Remove($key) }
                else {
                    $r = [string]$d['r']
                    if ($r -notin @('like', 'dislike', 'later', 'keep')) { Send-Text $ctx '{"error":"r"}' 'application/json' 400; return }
                    $rec = [System.Collections.Generic.Dictionary[string,object]]::new()
                    $rec.Add('r', $r)
                    $rec.Add('t', [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
                    if ($d.ContainsKey('x') -and $null -ne $d['x']) { $rec.Add('x', [int]$d['x']) }
                    if ($d.ContainsKey('rz') -and $d['rz']) { $rec.Add('rz', 1) }   # the track went through the 'third heart' deck
                    $script:Ratings[$key] = $rec
                    if ($r -eq 'like' -and $rec.ContainsKey('x')) { [void](Write-Tags $key -1 ([int]$rec['x'])) }   # hearts also go into the file's comment
                }
                Save-Ratings
                Send-Text $ctx (Ratings-Json)
            } else { Send-Text $ctx (Ratings-Json) }
            return
        }
        '/api/bpm' {
            # body: { "key": "...", "b": 40..400 | null }  (null = forget the tapped tempo)
            if ($method -ne 'POST') { Send-Text $ctx (Ratings-Json); return }
            $d = $Json.DeserializeObject((Body-Text $ctx))
            $key = [string]$d['key']
            if (-not $key) { Send-Text $ctx '{"error":"key"}' 'application/json' 400; return }
            if ($null -eq $d['b']) { [void]$script:TapBpm.Remove($key) }
            else {
                $b = [int]$d['b']
                if ($b -lt 40 -or $b -gt 400) { Send-Text $ctx '{"error":"b"}' 'application/json' 400; return }
                $rec = [System.Collections.Generic.Dictionary[string,object]]::new()
                $rec.Add('b', $b)
                $rec.Add('t', [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
                $script:TapBpm[$key] = $rec
                [void](Write-TagBpm $key $b)   # the tapped tempo also goes into the file's tag
            }
            Save-Ratings
            Send-Text $ctx (Ratings-Json)
            return
        }
        { $_ -eq '/api/tagbpm' -or $_ -eq '/api/tags' } {
            # body: { "items": [ { "key": "...", "b": 40..400 }, ... ] } -> write BPM into the files' tags
            if ($method -ne 'POST') { Send-Text $ctx '{}' 'application/json' 405; return }
            $d = $Json.DeserializeObject((Body-Text $ctx))
            $res = [System.Collections.Generic.Dictionary[string,object]]::new()
            foreach ($nm in @('ok', 'same', 'later', 'unsupported', 'failed')) { $res.Add($nm, 0) }
            $errs = New-Object System.Collections.Generic.List[string]
            foreach ($it in @($d['items'])) {
                if ($null -eq $it) { continue }
                $tb = -1; if ($it.ContainsKey('b') -and $null -ne $it['b']) { $tb = [int]$it['b'] }
                $tx = -1; if ($it.ContainsKey('x') -and $null -ne $it['x']) { $tx = [int]$it['x'] }
                $tt = @{}; foreach ($f0 in @('title', 'artist', 'note')) { if ($it.ContainsKey($f0) -and $null -ne $it[$f0]) { $tt[$f0] = ([string]$it[$f0]).Trim() } }
                $r = Write-Tags ([string]$it['key']) $tb $tx $tt
                if ($r -like 'error:*') { $res['failed']++; if ($errs.Count -lt 5) { $errs.Add(([string]$it['key']) + ': ' + $r.Substring(6)) } }
                else { $res[$r]++ }
            }
            $res.Add('errors', $errs.ToArray())
            Send-Text $ctx ($Json.Serialize($res))
            return
        }
        '/api/info' {
            $info = [System.Collections.Generic.Dictionary[string,object]]::new()
            $info.Add('port', [int]$Port); $info.Add('ips', [string[]](Lan-Addresses)); $info.Add('version', [int]$ServerVersion)
            Send-Text $ctx ($Json.Serialize($info)); return
        }
        '/api/trash' {
            # the file is only moved to the 'not my taste' folder (it can be moved back), so the phone (tinder) may do it too
            if ($method -ne 'POST') { Send-Text $ctx '{}' 'application/json' 405; return }
            $d = $Json.DeserializeObject((Body-Text $ctx))
            $key = ([string]$d['key']).ToLowerInvariant()
            if (-not $script:ByKey.ContainsKey($key)) { Send-Text $ctx '{"error":"not-found"}' 'application/json' 404; return }
            $idx = $script:ByKey[$key]
            $f = $script:Files[$idx]
            if (Test-Path -LiteralPath $f.FullName) {
                # into the Krinzh folder next to the music (created on first use); a name clash gets " (2)", " (3)"...
                try {
                    if (-not (Test-Path -LiteralPath $CringeDir)) { [void][IO.Directory]::CreateDirectory($CringeDir) }
                    $base = [IO.Path]::GetFileNameWithoutExtension($f.Name); $ext = $f.Extension
                    $dest = Join-Path $CringeDir $f.Name; $k = 2
                    while (Test-Path -LiteralPath $dest) { $dest = Join-Path $CringeDir ("$base ($k)$ext"); $k++ }
                    [IO.File]::Move($f.FullName, $dest)
                    Write-Host "Moved to the cringe folder: $dest" -ForegroundColor DarkYellow
                } catch {
                    Send-Text $ctx ('{"error":' + $Json.Serialize('move: ' + $_.Exception.Message) + '}') 'application/json' 500; return
                }
            }
            $script:Gone[$idx] = $true; $script:ByKey.Remove($key); Build-TracksJson
            [void]$script:Ratings.Remove($key); Save-Ratings
            Send-Text $ctx '{"ok":true}'
            return
        }
    }

    # static files from web/ (only plain names, no traversal)
    $name = $path.TrimStart('/')
    if ($name -match '^[A-Za-z0-9_\-]+\.[a-z]+$') {
        $file = Join-Path $WebDir $name
        $ext = [IO.Path]::GetExtension($name).ToLowerInvariant()
        if ((Test-Path -LiteralPath $file) -and $WebTypes.ContainsKey($ext)) {
            Send-Bytes $ctx ([IO.File]::ReadAllBytes($file)) $WebTypes[$ext]
            return
        }
    }
    Send-Text $ctx 'not found' 'text/plain' 404
}

# ---------- start ----------
Scan-Library

$listener = $null
for ($p = $Port; $p -lt $Port + 20; $p++) {
    try {
        $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $p)
        $l.Start(); $listener = $l; $Port = $p; break
    } catch { }
}
if (-not $listener) { Write-Host "Could not open a port $Port..$($Port+19)" -ForegroundColor Red; exit 1 }

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  SwingDJ is running:  $url" -ForegroundColor Cyan
$ips = Lan-Addresses
if ($ips.Count) {
    Write-Host "  Phone remote:        http://$($ips[0]):$Port/remote" -ForegroundColor Cyan
    Write-Host "  Phone tinder:        http://$($ips[0]):$Port/tinder" -ForegroundColor Cyan
    if ($ips.Count -gt 1) { Write-Host "  Other PC addresses:  $($ips[1..($ips.Count-1)] -join ', ')" -ForegroundColor DarkGray }
}
Write-Host "  If Windows asks about network access, allow it for PRIVATE networks." -ForegroundColor DarkGray
Write-Host "  Keep this window open. Close it to stop." -ForegroundColor DarkGray
Write-Host ""
if ($OpenBrowser) { Start-Process $url }

function Serve-Client($client) {
    try {
        $client.NoDelay = $true
        $client.ReceiveTimeout = 5000; $client.SendTimeout = 30000
        $stream = $client.GetStream()
        $req = Read-Request $stream
        if ($req) {
            $remote = $client.Client.RemoteEndPoint.Address
            $ctx = @{ Req = $req; Stream = $stream; Local = [Net.IPAddress]::IsLoopback($remote) }
            try { Handle $ctx; $stream.Flush() }
            catch {
                # The browser often drops an audio download on purpose (track switched, seek, next card).
                # That is not an error: just stop sending.
                $ex = $_.Exception; $dropped = $false
                while ($ex) { if ($ex -is [IO.IOException] -or $ex -is [Net.Sockets.SocketException] -or $ex -is [ObjectDisposedException]) { $dropped = $true; break }; $ex = $ex.InnerException }
                if (-not $dropped) {
                    Write-Host "Error on $($req.Method) $($req.Path): $($_.Exception.Message)" -ForegroundColor DarkRed
                    try { Send-Text $ctx '{"error":"server"}' 'application/json' 500 } catch { }
                }
            }
        }
    } catch {
        # client closed the connection mid-stream, timeouts, etc.
    } finally { try { $client.Close() } catch { } }
}

# Browsers open spare connections in advance and may send nothing on them for a while.
# We only serve a connection once its request has arrived, so an idle socket never blocks the others.
$waiting = New-Object System.Collections.ArrayList
$accept = $listener.AcceptTcpClientAsync()
try {
    while ($true) {
        $busy = $false
        if ($accept.IsCompleted) {
            try { [void]$waiting.Add(@{ c = $accept.GetAwaiter().GetResult(); t = [DateTime]::UtcNow }) } catch { }
            $accept = $listener.AcceptTcpClientAsync()
            $busy = $true
        }
        for ($i = $waiting.Count - 1; $i -ge 0; $i--) {
            $w = $waiting[$i]; $ready = $false; $dead = $false
            try { $ready = $w.c.Available -gt 0; if (-not $ready) { $dead = ([DateTime]::UtcNow - $w.t).TotalSeconds -gt 20 } } catch { $dead = $true }
            if ($ready) { $waiting.RemoveAt($i); Serve-Client $w.c; $busy = $true }
            elseif ($dead) { $waiting.RemoveAt($i); try { $w.c.Close() } catch { } }
        }
        if (-not $busy) { Start-Sleep -Milliseconds 4 }
    }
} finally {
    foreach ($w in $waiting) { try { $w.c.Close() } catch { } }
    $listener.Stop()
}
