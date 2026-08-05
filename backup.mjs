// アプリを開かずにバックアップを作る。
// 中身は設定タブの「💾 バックアップ作成」ボタンとまったく同じ処理:
//   ①WAL(書きかけ)を本体に畳む ②backups/focus-日時.db として1ファイルに複製 ③30世代を超えた古いものを消す
// 同じ形式で作るので、アプリの「バックアップの復元」からそのまま戻せる。
// backup.cmd / backup.command から呼ばれる(直接 node backup.mjs でも可)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(ROOT, 'data', 'focus.db');
const DIR = path.join(ROOT, 'backups');
const KEEP = 30;   // server.js の BACKUP_KEEP と揃えること

if (!fs.existsSync(DB_PATH)) {
  console.error('data/focus.db が見つかりません。先にアプリを一度起動してください。');
  process.exit(1);
}

const d = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const name = `focus-${stamp}.db`;

fs.mkdirSync(DIR, { recursive: true });

// アプリが動いていても実行できる。書き込み中でチェックポイントできなかった場合でも、
// 本体ファイル単体は「少し古いが壊れていない状態」として有効(SQLiteのWALの性質)。
const src = new DatabaseSync(DB_PATH);
try {
  src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch {
  console.log('注意: アプリが書き込み中のため、直前の数件が含まれない可能性があります。');
} finally {
  src.close();
}
fs.copyFileSync(DB_PATH, path.join(DIR, name));

// 作った控えが壊れていないことを確かめてから、古いものを消す
const dst = path.join(DIR, name);
const check = new DatabaseSync(dst, { readOnly: true });
let ok = false;
let count = 0;
try {
  const integ = Object.values(check.prepare('PRAGMA integrity_check').get())[0];
  ok = integ === 'ok';
  if (!ok) console.error(`作成した控えが壊れています(${integ})。古い控えは消しません。`);
  else count = Object.values(check.prepare('SELECT COUNT(*) FROM inspections WHERE deleted = 0').get())[0];
} finally {
  check.close();
  // 開いた拍子にできる -wal / -shm を残さない(控えは1ファイルで完結させる)
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(dst + suffix, { force: true }); } catch { /* 残っても実害はない */ }
  }
}
if (!ok) process.exit(1);
console.log(`バックアップしました: backups/${name}(作業記録 ${count} 件)`);

const all = fs.readdirSync(DIR).filter(f => /^focus-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
for (const f of all.slice(KEEP)) {
  try { fs.unlinkSync(path.join(DIR, f)); } catch { /* 消せなくても本体処理は続行 */ }
}
