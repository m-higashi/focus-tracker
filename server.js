import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, ROOT, DB_PATH } from './src/db.js';
import * as L from './src/logic.js';

const PORT = Number(process.env.PORT || 3000);

// クラッシュ時に原因を data/error.log へ残す(黒い窓が消えたあとでも調査できるように)
function logFatal(kind, err) {
  try {
    fs.appendFileSync(path.join(ROOT, 'data', 'error.log'),
      `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`);
  } catch { /* ログ書き込み自体の失敗は握りつぶす */ }
}
process.on('uncaughtException', err => { logFatal('uncaughtException', err); console.error(err); process.exit(1); });
process.on('unhandledRejection', err => { logFatal('unhandledRejection', err); console.error(err); process.exit(1); });

// ---- セキュリティ: Host検証(DNSリバインディング対策)+クロスサイトPOST遮断 ----
// 脅威モデル: Tailscale VPN内・単独ユーザー。認証は置かず、
// 外部サイト経由のリクエストとルート外パスだけを確実に弾く。
const ALLOWED_HOSTS = (() => {
  const set = new Set(['localhost', os.hostname().toLowerCase()]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) set.add(a.address.toLowerCase());
  }
  return set;
})();

function hostnameOf(value) {
  if (!value) return '';
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch { return ''; }
}

function isAllowedHost(name) {
  return ALLOWED_HOSTS.has(name) || name.endsWith('.ts.net');
}

function checkRequest(req) {
  if (!isAllowedHost(hostnameOf(req.headers.host))) return 'forbidden host';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !isAllowedHost(hostnameOf(origin))) return 'cross-site request blocked';
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') return 'cross-site request blocked';
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function acceptsGzip(req) {
  return /(^|,)\s*gzip/.test(req?.headers['accept-encoding'] || '');
}

// テキスト系レスポンス送信(1KB超はgzip)。画像はここを通さない
function send(res, code, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { Vary: 'Accept-Encoding', ...headers };
  const type = h['Content-Type'] || '';
  if (buf.length > 1024 && acceptsGzip(res.req) && /^(text\/|application\/json)/.test(type)) {
    buf = zlib.gzipSync(buf);
    h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h);
  res.end(buf);
}

function json(res, code, data) {
  send(res, code, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        const v = buf ? JSON.parse(buf) : {};
        // JSONは object とは限らない(配列・数値・null もありうる)。
        // そのまま body.xxx を読むと undefined 扱いで意図しない既定値が通るため、空扱いにする
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function difficultyKeys() {
  return L.getSettings().difficulties.map(d => d.key);
}

// ---- 入力の検証 ----
// 時刻(ミリ秒)は 2000-01-01 〜 現在+1年 の整数だけ受け付ける。範囲外を素通しすると、
// 記録が1970年へ飛んだり(null→0)、JSの安全整数を超える値がDBに入って
// 以後その行を読むAPIが全部500になる(=UIから復旧できなくなる)ため、ここで弾く。
const TIME_MIN = new Date(2000, 0, 1).getTime();
function validTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.round(n);
  if (t < TIME_MIN || t > Date.now() + 366 * 86400000) return null;
  return t;
}

// 'YYYY-MM-DD' 以外の日付パラメータは受け付けない(空・未指定は既定日にフォールバック)
function validDay(v) {
  if (!v) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime()) ? v : null;
}

// メモなどの文字列。長さを切り、NUL・制御文字は落とす(CSV出力や表示が壊れるため)。
// 配列・オブジェクトは "[object Object]" のような文字列にせず、空にする
function textOf(v, max = 2000) {
  if (v == null || typeof v === 'object') return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

// WALを本体に反映してから backups/ へ複製し、ファイル名を返す。
// 作成のたびに古いものを間引いて直近30個だけ保持する(自動+手動+復元前退避の合計)
const BACKUP_KEEP = 30;

function makeBackup() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dir = path.join(ROOT, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = `focus-${stamp}.db`;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, path.join(dir, name));
  const all = fs.readdirSync(dir).filter(f => /^focus-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
  for (const f of all.slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 消せなくても本体処理は続行 */ }
  }
  return name;
}

// ---- APIハンドラ ----

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/status' && method === 'GET') {
    return json(res, 200, L.computeStatus());
  }

  if (p === '/api/settings') {
    if (method === 'GET') return json(res, 200, L.getSettings());
    if (method === 'PUT') {
      const body = await readBody(req);
      try {
        return json(res, 200, L.saveSettings(body));
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) }); // 検証エラー(難易度が空 等)
      }
    }
  }

  if (p === '/api/day' && method === 'GET') {
    const dayParam = validDay(url.searchParams.get('date'));
    if (dayParam === null) return json(res, 400, { error: '日付が不正です' });
    const day = dayParam || L.dayStr(Date.now());
    // effective=1: 0時またぎの勤務を開始日側に含めた範囲(メイン画面の「本日の記録一覧」用)。
    // 省略時は暦日どおり(記録タブの編集画面用)
    const [s, e] = url.searchParams.get('effective') === '1' ? L.effectiveRange(day) : L.dayRange(day);
    const inspections = db.prepare(
      'SELECT id, ended_at, duration_sec, difficulty, note FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at, id'
    ).all(s, e);
    const events = db.prepare(
      'SELECT id, type, at, note FROM work_events WHERE deleted = 0 AND at >= ? AND at < ? ORDER BY at, id'
    ).all(s, e);
    return json(res, 200, { day, inspections, events });
  }

  if (p === '/api/inspections' && method === 'POST') {
    const body = await readBody(req);
    if (!difficultyKeys().includes(body.difficulty)) {
      return json(res, 400, { error: '不明な難易度です' });
    }
    const at = body.at === undefined || body.at === null ? Date.now() : validTime(body.at);
    if (at === null) return json(res, 400, { error: '時刻が不正です' });
    const info = db.prepare(
      'INSERT INTO inspections (ended_at, difficulty, note, created_at) VALUES (?, ?, ?, ?)'
    ).run(at, body.difficulty, textOf(body.note), Date.now());
    L.recomputeDay(L.dayStr(at));
    const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(info.lastInsertRowid);
    return json(res, 201, { inspection: row, status: L.computeStatus() });
  }

  let m = p.match(/^\/api\/inspections\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM inspections WHERE id = ? AND deleted = 0').get(id);
    if (!row) return json(res, 404, { error: '記録が見つかりません' });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const difficulty = body.difficulty !== undefined ? body.difficulty : row.difficulty;
      if (!difficultyKeys().includes(difficulty)) return json(res, 400, { error: '不明な難易度です' });
      let endedAt = row.ended_at;
      if (body.ended_at !== undefined) {
        endedAt = validTime(body.ended_at);
        if (endedAt === null) return json(res, 400, { error: '時刻が不正です' });
      }
      const note = body.note !== undefined ? textOf(body.note) : row.note;
      db.prepare('UPDATE inspections SET ended_at = ?, difficulty = ?, note = ? WHERE id = ?')
        .run(endedAt, difficulty, note, id);
      L.recomputeDay(L.dayStr(row.ended_at));
      if (L.dayStr(endedAt) !== L.dayStr(row.ended_at)) L.recomputeDay(L.dayStr(endedAt));
      return json(res, 200, db.prepare('SELECT * FROM inspections WHERE id = ?').get(id));
    }
    if (method === 'DELETE') {
      db.prepare('UPDATE inspections SET deleted = 1 WHERE id = ?').run(id);
      L.recomputeDay(L.dayStr(row.ended_at));
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/undo' && method === 'POST') {
    // 0時またぎの勤務中は前日ぶんの記録も「本日」として取り消せる
    const [s, e] = L.effectiveRange(L.effectiveDayStr());
    const row = db.prepare(
      'SELECT * FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at DESC, id DESC LIMIT 1'
    ).get(s, e);
    if (!row) return json(res, 404, { error: '本日の記録がありません' });
    db.prepare('UPDATE inspections SET deleted = 1 WHERE id = ?').run(row.id);
    L.recomputeDay(L.dayStr(row.ended_at));
    return json(res, 200, { undone: row, status: L.computeStatus() });
  }

  if (p === '/api/events' && method === 'POST') {
    const body = await readBody(req);
    if (!L.EVENT_TYPES.includes(body.type)) return json(res, 400, { error: '不明なイベント種別です' });
    const at = body.at === undefined || body.at === null ? Date.now() : validTime(body.at);
    if (at === null) return json(res, 400, { error: '時刻が不正です' });
    // その日最初の勤務開始なら自動バックアップ(挿入前に判定し、挿入後に作成)
    let firstStartOfDay = false;
    if (body.type === 'work_start') {
      const [ds, de] = L.dayRange(L.dayStr(at));
      firstStartOfDay = !db.prepare(
        "SELECT id FROM work_events WHERE deleted = 0 AND type = 'work_start' AND at >= ? AND at < ? LIMIT 1"
      ).get(ds, de);
    }
    const info = db.prepare('INSERT INTO work_events (type, at, note) VALUES (?, ?, ?)').run(body.type, at, textOf(body.note));
    L.recomputeDay(L.dayStr(at));
    if (firstStartOfDay) {
      try { makeBackup(); } catch (e) { console.log(`  warn: auto backup failed (${e.message})`); }
    }
    const row = db.prepare('SELECT * FROM work_events WHERE id = ?').get(info.lastInsertRowid);
    return json(res, 201, { event: row, status: L.computeStatus() });
  }

  m = p.match(/^\/api\/events\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM work_events WHERE id = ? AND deleted = 0').get(id);
    if (!row) return json(res, 404, { error: 'イベントが見つかりません' });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const type = body.type !== undefined ? body.type : row.type;
      if (!L.EVENT_TYPES.includes(type)) return json(res, 400, { error: '不明なイベント種別です' });
      let at = row.at;
      if (body.at !== undefined) {
        at = validTime(body.at);
        if (at === null) return json(res, 400, { error: '時刻が不正です' });
      }
      const note = body.note !== undefined ? textOf(body.note) : row.note;
      db.prepare('UPDATE work_events SET type = ?, at = ?, note = ? WHERE id = ?').run(type, at, note, id);
      L.recomputeDay(L.dayStr(row.at));
      if (L.dayStr(at) !== L.dayStr(row.at)) L.recomputeDay(L.dayStr(at));
      return json(res, 200, db.prepare('SELECT * FROM work_events WHERE id = ?').get(id));
    }
    if (method === 'DELETE') {
      db.prepare('UPDATE work_events SET deleted = 1 WHERE id = ?').run(id);
      L.recomputeDay(L.dayStr(row.at));
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/stats/day' && method === 'GET') {
    const d = validDay(url.searchParams.get('date'));
    if (d === null) return json(res, 400, { error: '日付が不正です' });
    return json(res, 200, L.statsDay(d || L.dayStr(Date.now())));
  }

  if (p === '/api/result' && method === 'GET') {
    // 既定日は「最後に勤務開始した日」(0時またぎで退勤した直後でも前日のリザルトを出す)
    const d = validDay(url.searchParams.get('date'));
    if (d === null) return json(res, 400, { error: '日付が不正です' });
    return json(res, 200, L.dailyResult(d || L.lastWorkDayStr()));
  }

  if (p === '/api/stats/range' && method === 'GET') {
    const toParam = validDay(url.searchParams.get('to'));
    const fromParam = validDay(url.searchParams.get('from'));
    if (toParam === null || fromParam === null) return json(res, 400, { error: '日付が不正です' });
    const to = toParam || L.dayStr(Date.now());
    // 日数は1〜1000にクランプ(未検証の値をそのまま使うと、10万日ぶんの空データを
    // 生成して返そうとしてブラウザごと固まる)
    const rawDays = Math.round(Number(url.searchParams.get('days') ?? 7));
    const days = Number.isFinite(rawDays) ? Math.min(1000, Math.max(1, rawDays)) : 7;
    const from = fromParam || L.dayStr(L.dayRange(to)[0] - (days - 1) * 86400000);
    return json(res, 200, L.statsRange(from, to));
  }

  if (p === '/api/export.csv' && method === 'GET') {
    return send(res, 200, L.exportCSV(), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inspections-${L.dayStr(Date.now())}.csv"`,
    });
  }

  if (p === '/api/export-events.csv' && method === 'GET') {
    return send(res, 200, L.exportEventsCSV(), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="events-${L.dayStr(Date.now())}.csv"`,
    });
  }

  if (p === '/api/character' && method === 'GET') {
    return json(res, 200, {
      sets: L.characterSets(),
      current: L.getSettings().characterSet,
      daily: L.dailySetName(),   // 日替わりの当選セット(全端末で一致させるためサーバーで決定)
    });
  }

  if (p === '/api/backgrounds' && method === 'GET') {
    return json(res, 200, { files: L.backgrounds(), current: L.getSettings().stageBg });
  }

  if (p === '/api/backup' && method === 'POST') {
    const name = makeBackup();
    return json(res, 201, { ok: true, file: `backups/${name}`, size: fs.statSync(path.join(ROOT, 'backups', name)).size });
  }

  if (p === '/api/backups' && method === 'GET') {
    const dir = path.join(ROOT, 'backups');
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir)
          .filter(f => /^focus-\d{8}-\d{6}\.db$/.test(f))
          .sort().reverse()
          .map(f => ({ file: f, size: fs.statSync(path.join(dir, f)).size }))
      : [];
    return json(res, 200, { backups: files });
  }

  if (p === '/api/restore' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.file || '');
    if (!/^focus-\d{8}-\d{6}\.db$/.test(name)) return json(res, 400, { error: 'invalid backup name' });
    const bakPath = path.join(ROOT, 'backups', name);
    if (!fs.existsSync(bakPath)) return json(res, 404, { error: 'backup not found' });

    const safety = makeBackup(); // 復元前の状態も自動退避(復元自体をやり直せるように)
    db.exec(`ATTACH DATABASE '${bakPath.replaceAll("'", "''")}' AS bak`);
    try {
      const integ = Object.values(db.prepare('PRAGMA bak.integrity_check').get())[0];
      if (integ !== 'ok') throw new Error(`バックアップが破損しています: ${integ}`);
      const tables = db.prepare(
        "SELECT name FROM bak.sqlite_master WHERE type = 'table' AND name IN ('inspections','work_events','settings')"
      ).all().map(r => r.name);
      if (tables.length !== 3) throw new Error('バックアップに必要なテーブルがありません');

      db.exec('BEGIN IMMEDIATE');
      try {
        for (const t of ['inspections', 'work_events', 'settings']) {
          db.exec(`DELETE FROM main.${t}; INSERT INTO main.${t} SELECT * FROM bak.${t};`);
        }
        // AUTOINCREMENTの連番も戻す(ID振り直し禁止の方針を復元後も維持)
        const hasSeq = db.prepare("SELECT COUNT(*) AS n FROM bak.sqlite_master WHERE name = 'sqlite_sequence'").get().n;
        if (hasSeq) {
          db.exec(`DELETE FROM main.sqlite_sequence WHERE name IN ('inspections','work_events');
                   INSERT INTO main.sqlite_sequence SELECT name, seq FROM bak.sqlite_sequence
                   WHERE name IN ('inspections','work_events');`);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      db.exec('DETACH DATABASE bak');
    }
    L.invalidateMedians(); // 全データが入れ替わったのでキャッシュを破棄
    return json(res, 200, {
      ok: true,
      restored: name,
      safety: `backups/${safety}`,
      inspections: Object.values(db.prepare('SELECT COUNT(*) FROM inspections WHERE deleted = 0').get())[0],
      events: Object.values(db.prepare('SELECT COUNT(*) FROM work_events WHERE deleted = 0').get())[0],
    });
  }

  if (p === '/api/health' && method === 'GET') {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const dir = path.join(ROOT, 'backups');
    const backups = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().reverse().slice(0, 5)
      : [];
    return json(res, 200, {
      integrity: Object.values(integrity)[0],
      inspections: Object.values(db.prepare('SELECT COUNT(*) FROM inspections WHERE deleted = 0').get())[0],
      events: Object.values(db.prepare('SELECT COUNT(*) FROM work_events WHERE deleted = 0').get())[0],
      dbSize: fs.statSync(DB_PATH).size,
      backups,
    });
  }

  return json(res, 404, { error: 'not found' });
}

// ---- 静的ファイル ----

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.csv', '.txt', '.md']);

// 内容ハッシュ(?v= 用)。mtimeが変わったら再計算するので、差し替えるだけで新版が配信される
const hashCache = new Map();
function fileHash(absPath) {
  try {
    const st = fs.statSync(absPath);
    const c = hashCache.get(absPath);
    if (c && c.mtimeMs === st.mtimeMs) return c.hash;
    const hash = crypto.createHash('md5').update(fs.readFileSync(absPath)).digest('hex').slice(0, 10);
    hashCache.set(absPath, { mtimeMs: st.mtimeMs, hash });
    return hash;
  } catch { return null; }
}

// index.html は CSS/JS リンクに内容ハッシュの ?v= を付けて返す
function serveIndex(req, res, filePath) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    for (const f of ['style.css', 'app.js']) {
      const h = fileHash(path.join(ROOT, 'public', f));
      if (h) html = html.replace(`"/${f}"`, `"/${f}?v=${h}"`);
    }
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
}

function serveStatic(req, res, filePath, query) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;

    let cacheControl = 'no-cache';
    if ((ext === '.js' || ext === '.css') && query.get('v') && query.get('v') === fileHash(filePath)) {
      cacheControl = 'public, max-age=31536000, immutable'; // 内容ハッシュ付きは不変として長期キャッシュ
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      cacheControl = 'max-age=60'; // 画像差し替え反映の即時性を優先(再検証はETagで安価)
    }

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'Vary': 'Accept-Encoding',
    };

    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if (inm === etag || (!inm && ims && st.mtimeMs <= Date.parse(ims) + 999)) {
      res.writeHead(304, headers);
      return res.end();
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    if (COMPRESSIBLE.has(ext) && st.size > 512 && acceptsGzip(req)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      stream.pipe(zlib.createGzip()).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      stream.pipe(res);
    }
  });
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  try {
    const denied = checkRequest(req);
    if (denied) return json(res, 403, { error: denied });
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    let base, sub;
    if (rel.startsWith('/assets/')) {
      base = path.join(ROOT, 'assets');
      sub = rel.slice('/assets/'.length);
    } else {
      base = path.join(ROOT, 'public');
      sub = rel.slice(1);
    }
    const filePath = path.normalize(path.join(base, sub));
    // Windowsは大文字小文字を同一視するので、接頭辞チェックも小文字化して比較する
    if (!filePath.toLowerCase().startsWith((base + path.sep).toLowerCase())) {
      res.writeHead(403);
      return res.end();
    }
    if (filePath === path.join(ROOT, 'public', 'index.html')) {
      serveIndex(req, res, filePath);
    } else {
      serveStatic(req, res, filePath, url.searchParams);
    }
  } catch (err) {
    // 入力起因のものは 4xx で返す(500だとサーバー側の不具合と区別が付かない)
    const msg = String(err.message || err);
    const code = msg === 'invalid JSON' ? 400 : msg === 'body too large' ? 413 : 500;
    json(res, code, { error: msg });
  }
};

// ---- 起動: Tailscale IP を自動検出してバインド ----
// Tailscale の IPv4 は CGNAT 帯 (100.64.0.0/10)。アダプタ名に "Tailscale" を含むものを優先する。
function tailscaleIPv4() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) {
        candidates.push({ address: a.address, named: /tailscale/i.test(name) });
      }
    }
  }
  candidates.sort((a, b) => Number(b.named) - Number(a.named));
  return candidates[0]?.address || null;
}

function listenOn(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(PORT, host, () => {
      console.log(`  http://${host}:${PORT}`);
      resolve(server);
    });
  });
}

// バナーはASCIIのみ(cmdの既定コードページで文字化けさせない)
console.log('=== Focus Tracker ===');
console.log(`  data: ${DB_PATH}`);
if (process.env.HOST) {
  await listenOn(process.env.HOST);
} else {
  const ts = tailscaleIPv4();
  if (ts) {
    try {
      await listenOn('127.0.0.1');
      await listenOn(ts);
      console.log('  bind: Tailscale + localhost only (not exposed to office LAN)');
    } catch (err) {
      console.log(`  warn: bind to Tailscale IP failed (${err.message}), falling back to 0.0.0.0`);
      await listenOn('0.0.0.0');
    }
  } else {
    console.log('  warn: Tailscale IP not found, listening on 0.0.0.0 (all interfaces)');
    await listenOn('0.0.0.0');
  }
}
console.log('Ready. Keep this window open. Close it to stop the app.');
