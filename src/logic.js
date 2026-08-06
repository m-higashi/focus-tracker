import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from './db.js';

export const EVENT_TYPES = ['work_start', 'work_end', 'break_start', 'break_end', 'sleep_start', 'sleep_end'];

export const DEFAULT_SETTINGS = {
  difficulties: [
    { key: 'easy', label: '易', score: 1 },
    { key: 'normal', label: '普通', score: 2 },
    { key: 'hard', label: '難', score: 4 },
  ],
  alertFixedMin: 50,     // 連続作業がこの分数を超えたら通知
  fatigueThreshold: 15,  // 疲労度スコアのしきい値
  fatiguePer10Min: 1,    // 連続作業10分ごとの加算
  snoozeMin: 5,
  forgetMin: 120,        // この分数、勤務中なのに記録がなければ押し忘れ確認(0で無効)
  maWindow: 5,           // 集中度の移動平均ウィンドウ
  minSamples: 5,         // これ未満のデータ数の中央値は「参考値」
  characterSet: 'cat',
  stageBg: 'auto',       // 'auto'=時間帯で自動、それ以外=assets/bg/内のファイル名で固定
  dailyExclude: [],      // 日替わりランダムの抽選から外すセット名(既定=全セット対象)
  sleepPromptHour: 0,    // 就寝促しを出し始める時刻(22〜23 or 0〜2。-1で無効)
};

export function getSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (!(r.key in s)) continue; // 廃止済みのキー(soundOn等)がDBに残っていても無視する
    try { s[r.key] = JSON.parse(r.value); } catch { /* 壊れた値は既定値のまま */ }
  }
  return s;
}

// 設定値の検証。数値は範囲内に丸め、構造が壊れている値(難易度が空など)は例外で拒否する
// (不正な値が保存されると記録ボタンが消える等、UIから復旧できなくなるため)
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function validateSetting(key, v, cur) {
  switch (key) {
    case 'difficulties': {
      if (!Array.isArray(v) || v.length === 0) throw new Error('難易度は1件以上必要です');
      return v.map(d => {
        const k = String(d?.key ?? '').trim();
        if (!k) throw new Error('難易度のキーが不正です');
        return { key: k, label: String(d.label ?? '').trim().slice(0, 20) || '?', score: clampNum(d.score, 0, 99, 1) };
      });
    }
    case 'alertFixedMin':   return clampNum(v, 1, 1440, cur);
    case 'fatigueThreshold': return clampNum(v, 1, 999, cur);
    case 'fatiguePer10Min': return clampNum(v, 0, 99, cur);
    case 'snoozeMin':       return clampNum(v, 1, 180, cur);
    case 'forgetMin':       return clampNum(v, 0, 1440, cur);
    case 'maWindow':        return clampNum(v, 1, 50, cur);
    case 'minSamples':      return clampNum(v, 1, 100, cur);
    case 'sleepPromptHour': return clampNum(v, -1, 23, cur);
    // キャラ・背景は実在するものだけ受け付ける(存在しない名前が保存されると
    // 画像が出ない状態になり、原因も分かりにくいため)
    case 'characterSet': {
      if (typeof v !== 'string' || v.length > 200) throw new Error('characterSet が不正です');
      if (!Object.hasOwn(characterSets(), v)) throw new Error('そのキャラクターセットはありません');
      return v;
    }
    case 'stageBg': {
      if (typeof v !== 'string' || v.length > 200) throw new Error('stageBg が不正です');
      // 'auto'=時間帯で自動(平日)、'auto_holiday'=同(休日)、それ以外は assets/bg 内のファイル名
      if (v === 'auto' || v === 'auto_holiday' || backgrounds().includes(v)) return v;
      throw new Error('その背景はありません');
    }
    case 'dailyExclude': {
      if (!Array.isArray(v)) throw new Error('dailyExclude が不正です');
      return v.map(String);
    }
  }
}

export function saveSettings(patch) {
  const cur = getSettings();
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    // hasOwn で見る。`k in` だと __proto__ や toString など Object.prototype 側の名前が
    // 素通りして、検証なしのまま保存処理へ落ちる
    if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue;
    const val = validateSetting(k, v, cur[k]);
    if (val === undefined) continue;
    stmt.run(k, JSON.stringify(val));
  }
  invalidateMedians(); // minSamples・難易度の変更が「参考値」判定に効くため
  return getSettings();
}

// ---- 時刻ユーティリティ(サーバーPCのローカル時刻 = Asia/Tokyo 前提) ----

export function dayStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayRange(day) {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, start + 86400000];
}

// ---- 勤務の0時またぎ対応 ----
// ユーザー指定(2026-08-03): 0時をまたいでも退勤(勤務終了)を押すまでは前日の勤務の続きとして扱う。
// 記録・実働・リザルト・本日サマリは勤務を開始した日に帰属し、睡眠とヒートマップは実時刻のまま。

// t時点で勤務が開いていれば(退勤がまだなら)その勤務開始時刻を返す(休憩中も勤務は開いたまま)
function openSessionAt(t) {
  const ev = db.prepare(
    "SELECT type, at FROM work_events WHERE deleted = 0 AND type IN ('work_start','work_end') AND at < ? ORDER BY at DESC, id DESC LIMIT 1"
  ).get(t);
  return ev && ev.type === 'work_start' ? ev.at : null;
}

// tが帰属する日 = tを含んで開いている勤務があればその開始日、なければtの暦日
export function effectiveDayStr(t = Date.now()) {
  return dayStr(openSessionAt(t) ?? t);
}

// 暦日dayの実効範囲[start, end)。0時に開いていた前日勤務の記録は退勤まで前日に譲り、
// この日に始まって0時をまたいだ勤務は退勤まで(未退勤なら現在まで)この日が引き取る
export function effectiveRange(day, now = Date.now()) {
  const [s, e] = dayRange(day);
  // 開いている勤務が終わる時刻。通常は次の退勤だが、退勤を押し忘れたまま
  // 次の勤務開始が来た場合は、そこで前の勤務は終わっている
  // (これを見ないと、月曜の退勤を押し忘れただけで火曜の記録が全部月曜に吸われ、
  //  火曜が「0件・実働0」と表示される)
  const firstCloseAfter = t => db.prepare(
    "SELECT at, type FROM work_events WHERE deleted = 0 AND type IN ('work_end','work_start') AND at >= ? ORDER BY at, id LIMIT 1"
  ).get(t);
  let start = s, end = e;
  if (openSessionAt(s) != null) {
    const close = firstCloseAfter(s);
    // 退勤で閉じるならその直後から、次の勤務開始で閉じるならその時刻からがこの日の取り分。
    // どちらも無ければ前日勤務が続いているので、この日の取り分はまだ無い
    start = close ? (close.type === 'work_end' ? close.at + 1 : close.at) : e;
  }
  const openE = openSessionAt(e);
  if (openE != null && openE >= s) {
    const close = firstCloseAfter(e);
    end = close ? (close.type === 'work_end' ? close.at + 1 : close.at) : Math.max(e, now + 1);
  }
  return [start, end];
}

// 各記録の帰属日を一括で割り当てる(rows: ended_at昇順 / evs: work_start・work_endのat昇順 /
// openStart0: 先頭時点で開いていた勤務の開始時刻)。1件ずつopenSessionAtを引くとN回クエリになるため
function effDaysFor(rows, evs, openStart0 = null) {
  const out = [];
  let openStart = openStart0, j = 0;
  for (const r of rows) {
    while (j < evs.length && evs[j].at < r.ended_at) {
      openStart = evs[j].type === 'work_start' ? evs[j].at : null;
      j++;
    }
    out.push(dayStr(openStart ?? r.ended_at));
  }
  return out;
}

// リザルトの既定日 = 最後に勤務開始した日(0時またぎの退勤直後でも、その勤務の開始日を指す)
export function lastWorkDayStr(now = Date.now()) {
  const ev = db.prepare(
    "SELECT at FROM work_events WHERE deleted = 0 AND type = 'work_start' AND at <= ? ORDER BY at DESC, id DESC LIMIT 1"
  ).get(now);
  return dayStr(ev ? ev.at : now);
}

// ---- 所要時間の再計算 ----
// 各件の所要時間 = 「前件の終了時刻 / 勤務開始 / 休憩終了 のうち最も遅い時刻」から自件の終了時刻まで。
// 勤務区間外・休憩中に記録された件は null(画面では「—」表示、イベント修正後に再計算される)。
export function recomputeDay(day) {
  invalidateMedians(); // 記録・イベントの全書き込みはここを通る(duration_secが変わる=中央値も変わる)
  const [s, e] = dayRange(day);
  const insp = db.prepare(
    'SELECT id, ended_at FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at, id'
  ).all(s, e);
  const evs = db.prepare(
    'SELECT type, at FROM work_events WHERE deleted = 0 AND at >= ? AND at < ? ORDER BY at, id'
  ).all(s, e);
  const upd = db.prepare('UPDATE inspections SET duration_sec = ? WHERE id = ?');

  // 0時またぎ: 前日から勤務中(休憩明け含む)のまま日付が変わっている場合は状態と起点を引き継ぐ
  let inWork = false, boundary = null, i = 0;
  const prev = db.prepare(
    'SELECT type, at FROM work_events WHERE deleted = 0 AND at < ? ORDER BY at DESC, id DESC LIMIT 1'
  ).get(s);
  if (prev && (prev.type === 'work_start' || prev.type === 'break_end')) {
    inWork = true;
    boundary = prev.at;
    const pi = db.prepare(
      'SELECT ended_at FROM inspections WHERE deleted = 0 AND ended_at < ? ORDER BY ended_at DESC, id DESC LIMIT 1'
    ).get(s);
    if (pi && pi.ended_at > boundary) boundary = pi.ended_at;
  }
  for (const x of insp) {
    while (i < evs.length && evs[i].at <= x.ended_at) {
      const ev = evs[i++];
      if (ev.type === 'work_start' || ev.type === 'break_end') { inWork = true; boundary = ev.at; }
      else { inWork = false; }
    }
    let dur = null;
    if (inWork && boundary != null && x.ended_at > boundary) {
      dur = Math.round((x.ended_at - boundary) / 1000);
    }
    upd.run(dur, x.id);
    if (inWork) boundary = x.ended_at;
  }

  // 勤務が開いたまま日をまたいでいるなら、翌日の所要時間は今日の状態に依存するので連鎖して再計算
  // (退勤で閉じた日で止まるので、実質1〜2日ぶん。今日より先へは進まない)
  if (e <= Date.now() && openSessionAt(e) != null) {
    const hasNext = db.prepare(
      'SELECT id FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? LIMIT 1'
    ).get(e, e + 86400000);
    if (hasNext) recomputeDay(dayStr(e));
  }
}

// ---- 現在の状態(メイン画面ポーリング用) ----

export function computeStatus(now = Date.now()) {
  const settings = getSettings();
  // 「本日」= 実効日(0時をまたいでも退勤までは勤務開始日の続き扱い)
  const effDay = effectiveDayStr(now);
  const [s, e] = effectiveRange(effDay, now);

  const last = db.prepare(
    'SELECT type, at FROM work_events WHERE deleted = 0 AND at <= ? ORDER BY at DESC, id DESC LIMIT 1'
  ).get(now);

  let state = 'off';
  if (last) {
    if (last.type === 'work_start' || last.type === 'break_end') state = 'working';
    else if (last.type === 'break_start') state = 'break';
    else if (last.type === 'sleep_start') state = 'sleeping';
  }

  const baseline = state === 'working' ? last.at : null; // 連続作業の起点(勤務開始 or 休憩終了)
  const continuousSec = baseline ? Math.floor((now - baseline) / 1000) : 0;
  const sinceSec = last ? Math.floor((now - last.at) / 1000) : 0; // 休憩経過などの表示用

  const coeff = Object.fromEntries(settings.difficulties.map(d => [d.key, d.score]));
  let fatigue = 0;
  if (state === 'working') {
    const items = db.prepare(
      'SELECT difficulty FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at <= ?'
    ).all(baseline, now);
    for (const it of items) fatigue += coeff[it.difficulty] ?? 0;
    fatigue += Math.floor(continuousSec / 600) * settings.fatiguePer10Min;
  }

  const todays = db.prepare(
    'SELECT difficulty, duration_sec FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at, id'
  ).all(s, e);
  const counts = {};
  for (const t of todays) counts[t.difficulty] = (counts[t.difficulty] || 0) + 1;
  const durs = todays.filter(t => t.duration_sec > 0);
  const avgDurationSec = durs.length
    ? Math.round(durs.reduce((a, b) => a + b.duration_sec, 0) / durs.length) : null;

  // 集中度 = 直近の移動平均(statsDayと同じ定義。1.0が普段どおり)
  const med = medians();
  const idxs = [];
  for (const t of todays) {
    const m = med[t.difficulty]?.median;
    if (m && t.duration_sec > 0) idxs.push(m / t.duration_sec);
  }
  let concentration = null;
  if (idxs.length) {
    const win = idxs.slice(-settings.maWindow);
    concentration = +(win.reduce((a, b) => a + b, 0) / win.length).toFixed(2);
  }

  const lastInsp = db.prepare(
    'SELECT ended_at FROM inspections WHERE deleted = 0 ORDER BY ended_at DESC, id DESC LIMIT 1'
  ).get();

  // 押し忘れ検知①: 勤務が日をまたぎ、かつ記録もイベントも長時間止まっている
  // (0時またぎの夜勤自体は正常なので、日付が変わっただけでは出さない。ユーザー指定 2026-08-03)
  let forgotten = null;
  const lastActivityAt = Math.max(last?.at || 0, lastInsp?.ended_at || 0);
  if (last && (state === 'working' || state === 'break') &&
      dayStr(lastActivityAt) !== dayStr(now) && now - lastActivityAt >= FORGOT_IDLE_MS) {
    forgotten = { day: dayStr(lastActivityAt), suggestedEnd: lastActivityAt };
  }

  // 押し忘れ検知②: 勤務中なのに長時間記録がない(最後の記録 or 勤務再開からの経過)
  const idleSec = state === 'working'
    ? Math.floor((now - Math.max(baseline || 0, lastInsp?.ended_at || 0)) / 1000)
    : 0;

  return {
    now, state, baseline, continuousSec, sinceSec, fatigue, concentration, forgotten, idleSec,
    effectiveDay: effDay, // クライアントの「本日」判定用(0時またぎ勤務中は前日を指す)
    lastEvent: last ? { type: last.type, at: last.at } : null, // 就寝促しの抑制判定などに使う
    todayCount: todays.length, counts, avgDurationSec,
    workSec: workSecInRange(s, e, now),
    settings: {
      difficulties: settings.difficulties,
      alertFixedMin: settings.alertFixedMin,
      fatigueThreshold: settings.fatigueThreshold,
      snoozeMin: settings.snoozeMin,
      forgetMin: settings.forgetMin,
      characterSet: settings.characterSet,
      stageBg: settings.stageBg,
      sleepPromptHour: settings.sleepPromptHour,
    },
  };
}

// assets/bg/ 内の背景画像一覧(季節イベント用の画像を置くとここに出る)
export function backgrounds() {
  const dir = path.join(ROOT, 'assets', 'bg');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(png|webp|jpe?g|gif)$/i.test(f)).sort();
}

// ---- デイリーリザルト(勤務終了時の1日サマリ+自己ベスト判定) ----

export function dailyResult(day) {
  const st = statsDay(day);
  const med = st.medians;
  const rows = db.prepare(
    'SELECT ended_at, duration_sec, difficulty FROM inspections WHERE deleted = 0 ORDER BY ended_at, id'
  ).all();
  // 自己ベストの日別集計も実効日(0時またぎの勤務は開始日)で数える
  const wsWe = db.prepare(
    "SELECT type, at FROM work_events WHERE deleted = 0 AND type IN ('work_start','work_end') ORDER BY at, id"
  ).all();
  const effD = effDaysFor(rows, wsWe);
  const byDay = {};
  for (const [ri, r] of rows.entries()) {
    const d = effD[ri];
    byDay[d] ??= { count: 0, idxSum: 0, idxN: 0 };
    byDay[d].count++;
    const m = med[r.difficulty]?.median;
    if (m && r.duration_sec > 0) {
      byDay[d].idxSum += m / r.duration_sec;
      byDay[d].idxN++;
    }
  }
  let bestCount = 0, bestCountDay = null, bestIdx = 0, bestIdxDay = null;
  for (const [d, v] of Object.entries(byDay)) {
    if (v.count > bestCount) { bestCount = v.count; bestCountDay = d; }
    if (v.idxN) {
      const ai = v.idxSum / v.idxN;
      if (ai > bestIdx) { bestIdx = ai; bestIdxDay = d; }
    }
  }
  const t = byDay[day];
  const avgIndex = t?.idxN ? +(t.idxSum / t.idxN).toFixed(2) : null;
  const maxIndex = st.items.reduce((a, i) => Math.max(a, i.index ?? 0), 0) || null;
  return {
    ...st,
    avgIndex,
    maxIndex,
    best: {
      count: bestCount, countDay: bestCountDay,
      avgIndex: bestIdx ? +bestIdx.toFixed(2) : null, avgIndexDay: bestIdxDay,
    },
    isCountRecord: st.total > 0 && bestCountDay === day,
    isIndexRecord: avgIndex != null && bestIdxDay === day,
  };
}

// 押し忘れバナーを出す基準(日をまたぎ、かつこの時間なにも操作がない)
export const FORGOT_IDLE_MS = 2 * 3600000;
// 実働の集計を打ち切る基準。バナーより長くとる。
// バナーと同じ2時間で切ると、夜勤で記録の間隔が空いただけの「本当に勤務中」の実働まで
// 止まって見えてしまう。12時間なにも押していない勤務は、実際には退勤済みとみなす
const STALE_WORK_MS = 12 * 3600000;

// まだ閉じていない勤務区間を、どこまで実働として数えるか。
// 通常は範囲の終わり(=勤務中ならいま)まで数えるが、放置された勤務は最後の活動時刻で打ち切る。
// (打ち切らないと、退勤を押し忘れた過去の1日が「実働3778時間」のように表示される)
// [from, to) の最後の活動時刻(記録の終了時刻・打刻のうち最も遅いもの)。無ければ from
function lastActivityIn(from, to) {
  const lastInsp = db.prepare(
    'SELECT ended_at AS t FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at DESC, id DESC LIMIT 1'
  ).get(from, to)?.t ?? 0;
  const lastEv = db.prepare(
    'SELECT at AS t FROM work_events WHERE deleted = 0 AND at >= ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1'
  ).get(from, to)?.t ?? 0;
  return Math.max(from, lastInsp, lastEv);
}

function workSecInRange(s, e, now) {
  const end = Math.min(e, now);
  const evs = db.prepare(
    'SELECT type, at FROM work_events WHERE deleted = 0 AND at >= ? AND at < ? ORDER BY at, id'
  ).all(s, end);
  let total = 0, openAt = null;
  for (const ev of evs) {
    if (ev.type === 'work_start' || ev.type === 'break_end') {
      if (openAt == null) { openAt = ev.at; continue; }
      // 勤務が開いたままなのに次の勤務開始が来た = 前の勤務の退勤を押し忘れている。
      // 前の勤務は「新しい勤務開始より前の最後の活動」で終わったものとして数える
      // (そのまま繋げると、月曜の退勤を押し忘れただけで火曜の退勤まで一続きの
      //  勤務になり、実働が数十〜数千時間として表示されてしまう)
      if (ev.type === 'work_start') {
        total += Math.max(0, lastActivityIn(openAt, ev.at) - openAt);
        openAt = ev.at;
      }
    } else if (openAt != null) {
      total += ev.at - openAt;
      openAt = null;
    }
  }
  // 閉じていない勤務。放置(STALE_WORK_MS以上なにも操作なし)なら最後の活動で打ち切る
  if (openAt != null) {
    const last = lastActivityIn(openAt, end);
    total += Math.max(0, (now - last >= STALE_WORK_MS ? last : end) - openAt);
  }
  return Math.floor(total / 1000);
}

// ---- 統計 ----

// 中央値はデータ全件のソートを伴うため、書き込みがあるまでキャッシュする
// (無効化: recomputeDay=記録・イベントの全書き込み経路 / saveSettings / restore)
let mediansCache = null;
export function invalidateMedians() { mediansCache = null; }

export function medians() {
  if (mediansCache) return mediansCache;
  const settings = getSettings();
  const out = {};
  for (const d of settings.difficulties) {
    const rows = db.prepare(
      'SELECT duration_sec FROM inspections WHERE deleted = 0 AND difficulty = ? AND duration_sec > 0 ORDER BY duration_sec'
    ).all(d.key);
    const n = rows.length;
    let median = null;
    if (n) {
      median = n % 2
        ? rows[(n - 1) / 2].duration_sec
        : Math.round((rows[n / 2 - 1].duration_sec + rows[n / 2].duration_sec) / 2);
    }
    out[d.key] = { median, n, provisional: n < settings.minSamples };
  }
  mediansCache = out;
  return out;
}

export function statsDay(day) {
  const settings = getSettings();
  const med = medians();
  const [cs, ce] = dayRange(day);        // 暦日の範囲(睡眠の帰属用)
  const [s, e] = effectiveRange(day);    // 実効範囲(0時またぎの勤務は開始日に帰属)
  const rows = db.prepare(
    'SELECT id, ended_at, duration_sec, difficulty, note FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at, id'
  ).all(s, e);

  const items = rows.map(r => {
    const m = med[r.difficulty]?.median;
    return { ...r, index: (m && r.duration_sec > 0) ? +(m / r.duration_sec).toFixed(2) : null };
  });

  const breaks = pairEvents(s, e, 'break_start', 'break_end');
  const offs = pairEvents(s, e, 'work_end', 'work_start');  // 勤務外の中断(昼休みを勤務終了で取る運用に対応)
  // 長い中断(30分以上の休憩・勤務外、または90分超の記録空白)では移動平均の窓をリセットする
  // (午後の線が朝の値を引きずって高い位置から始まるのを防ぐ。グラフの分断条件と同じしきい値)
  const longPauses = [...breaks, ...offs].filter(p => p.end != null && p.end - p.start >= 30 * 60000);
  const window = [];
  let prevAt = null;
  for (const it of items) {
    it.ma = null;
    if (it.index != null) {
      if (prevAt != null && (it.ended_at - prevAt > 90 * 60000 ||
          longPauses.some(p => p.start > prevAt && p.start < it.ended_at))) {
        window.length = 0;
      }
      window.push(it.index);
      const win = window.slice(-settings.maWindow);
      it.ma = +(win.reduce((a, b) => a + b, 0) / win.length).toFixed(2);
      prevAt = it.ended_at;
    }
  }

  const counts = {};
  for (const r of rows) counts[r.difficulty] = (counts[r.difficulty] || 0) + 1;
  const durs = rows.filter(r => r.duration_sec > 0);
  return {
    day, items, medians: med, counts, total: rows.length,
    workSec: workSecInRange(s, e, Date.now()),
    avgDurationSec: durs.length ? Math.round(durs.reduce((a, b) => a + b.duration_sec, 0) / durs.length) : null,
    // 勤務開始・休憩明けの時刻一覧(グラフの各区間の起点アンカーに使う)
    resumes: db.prepare(
      "SELECT at FROM work_events WHERE deleted = 0 AND type IN ('work_start','break_end') AND at >= ? AND at < ? ORDER BY at"
    ).all(s, e).map(r => r.at),
    breaks, offs,
    sleep: (() => {
      const sl = sleepByDay(cs, ce)[day]; // 睡眠は暦日(起床日)のまま
      return sl ? { min: sl.min, bedAt: sl.main.start, wakeAt: sl.main.end } : null;
    })(),
  };
}

// ---- 睡眠 ----
// 就寝→起床のペアを取り出す。睡眠は「起床した日」に帰属させる(前夜就寝〜今朝起床がその日の睡眠)。
// 起床が範囲内のスパンだけ返す。18時間超・1分未満は打刻ミスとみなして除外。
export function sleepSpans(s, e) {
  const evs = db.prepare(
    "SELECT type, at FROM work_events WHERE deleted = 0 AND type IN ('sleep_start','sleep_end') AND at >= ? AND at < ? ORDER BY at, id"
  ).all(s - 18 * 3600000, e);
  const spans = [];
  let start = null;
  for (const ev of evs) {
    if (ev.type === 'sleep_start') start = ev.at;
    else if (start != null) {
      const dur = ev.at - start;
      if (dur >= 60000 && dur <= 18 * 3600000) spans.push({ start, end: ev.at });
      start = null;
    }
  }
  return spans.filter(sp => sp.end >= s && sp.end < e);
}

// 日ごとの睡眠まとめ: min=合計分、main=最長スパン(就寝・起床時刻の代表値)
function sleepByDay(s, e) {
  const map = {};
  for (const sp of sleepSpans(s, e)) {
    const d = dayStr(sp.end);
    const rec = (map[d] ??= { min: 0, main: null });
    rec.min += Math.round((sp.end - sp.start) / 60000);
    if (!rec.main || sp.end - sp.start > rec.main.end - rec.main.start) rec.main = sp;
  }
  return map;
}

// 開始/終了イベントをペア化(終了未打刻は end: null)
function pairEvents(s, e, startType, endType) {
  const evs = db.prepare(
    'SELECT type, at FROM work_events WHERE deleted = 0 AND type IN (?, ?) AND at >= ? AND at < ? ORDER BY at, id'
  ).all(startType, endType, s, e);
  const list = [];
  for (const ev of evs) {
    if (ev.type === startType) list.push({ start: ev.at, end: null });
    else if (list.length && list[list.length - 1].end == null) list[list.length - 1].end = ev.at;
  }
  return list;
}

export function statsRange(fromDay, toDay) {
  const med = medians();
  const [s] = dayRange(fromDay);
  const [, e] = dayRange(toDay);
  // 末日の勤務が0時をまたいでいれば退勤まで取り込む。先頭側は、前日から続く勤務の記録を
  // 実効日(範囲外の前日)に帰属させることで自然に除外される
  const [, eExt] = effectiveRange(toDay);
  const rows = db.prepare(
    'SELECT ended_at, duration_sec, difficulty FROM inspections WHERE deleted = 0 AND ended_at >= ? AND ended_at < ? ORDER BY ended_at'
  ).all(s, eExt);
  const wsWe = db.prepare(
    "SELECT type, at FROM work_events WHERE deleted = 0 AND type IN ('work_start','work_end') AND at >= ? AND at < ? ORDER BY at, id"
  ).all(s, eExt);
  const effD = effDaysFor(rows, wsWe, openSessionAt(s));

  const days = {};
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, n: 0 })));
  // 各記録の「連続作業時間」= 直前の勤務開始/休憩明けからの経過分(rowsと同じ昇順で走査)
  const resumes = db.prepare(
    "SELECT at FROM work_events WHERE deleted = 0 AND type IN ('work_start','break_end') AND at < ? ORDER BY at"
  ).all(eExt).map(r => r.at);
  const gapPts = [];
  let ri = -1;
  for (const [rowIdx, r] of rows.entries()) {
    const d = effD[rowIdx];
    days[d] ??= { counts: {}, dur: {}, idxSum: 0, idxN: 0 };
    const rec = days[d];
    rec.counts[r.difficulty] = (rec.counts[r.difficulty] || 0) + 1;
    if (r.duration_sec > 0) (rec.dur[r.difficulty] ??= []).push(r.duration_sec);
    const m = med[r.difficulty]?.median;
    if (m && r.duration_sec > 0) {
      const idx = m / r.duration_sec;
      rec.idxSum += idx;
      rec.idxN++;
      const dt = new Date(r.ended_at);
      const cell = heat[dt.getDay()][dt.getHours()];
      cell.sum += idx;
      cell.n++;
      while (ri + 1 < resumes.length && resumes[ri + 1] <= r.ended_at) ri++;
      if (ri >= 0) {
        const gapMin = (r.ended_at - resumes[ri]) / 60000;
        // 打刻忘れなどの異常値(10時間超)は散布図から除外
        if (gapMin <= 600) {
          gapPts.push({ gap: +gapMin.toFixed(1), index: +idx.toFixed(2), difficulty: r.difficulty });
        }
      }
    }
  }

  // 1勤務(勤務開始→勤務終了)ごとの休憩回数と集中度。半日勤務や夜枠など1日複数勤務に対応するため
  // 日単位でなく勤務単位で数える。終了未打刻の勤務(進行中・押し忘れ)は集計しない。
  // 0時またぎの勤務も退勤(eExt)まで含めて1勤務として拾う。
  const sessions = [];
  const workSpans = pairEvents(s, eExt, 'work_start', 'work_end').filter(p => p.end != null);
  const breakStarts = db.prepare(
    "SELECT at FROM work_events WHERE deleted = 0 AND type = 'break_start' AND at >= ? AND at < ? ORDER BY at"
  ).all(s, eExt).map(r => r.at);
  let rj = 0, bj = 0;
  for (const sp of workSpans) {
    while (rj < rows.length && rows[rj].ended_at < sp.start) rj++;
    let idxSum = 0, idxN = 0;
    for (let k = rj; k < rows.length && rows[k].ended_at < sp.end; k++) {
      const m = med[rows[k].difficulty]?.median;
      if (m && rows[k].duration_sec > 0) { idxSum += m / rows[k].duration_sec; idxN++; }
    }
    while (bj < breakStarts.length && breakStarts[bj] < sp.start) bj++;
    let breaks = 0;
    for (let k = bj; k < breakStarts.length && breakStarts[k] < sp.end; k++) breaks++;
    sessions.push({
      day: dayStr(sp.start), start: sp.start, end: sp.end, breaks,
      avgIndex: idxN ? +(idxSum / idxN).toFixed(2) : null,
    });
  }

  const sleepMap = sleepByDay(s, e);

  const list = [];
  for (let t = s; t < e; t += 86400000) {
    const d = dayStr(t);
    const rec = days[d];
    const sl = sleepMap[d];
    list.push({
      day: d,
      counts: rec?.counts || {},
      total: rec ? Object.values(rec.counts).reduce((a, b) => a + b, 0) : 0,
      avgDur: rec
        ? Object.fromEntries(Object.entries(rec.dur).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]))
        : {},
      avgIndex: rec && rec.idxN ? +(rec.idxSum / rec.idxN).toFixed(2) : null,
      sleepMin: sl ? sl.min : null,
      bedAt: sl ? sl.main.start : null,
      wakeAt: sl ? sl.main.end : null,
    });
  }
  return {
    from: fromDay, to: toDay, days: list, medians: med,
    heatmap: heat.map(row => row.map(c => (c.n ? +(c.sum / c.n).toFixed(2) : null))),
    gapPts, sessions,
  };
}

export function exportCSV() {
  const settings = getSettings();
  const labels = Object.fromEntries(settings.difficulties.map(d => [d.key, d.label]));
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['id,日付,終了時刻,難易度,所要時間_秒,メモ'];
  for (const r of db.prepare(
    'SELECT id, ended_at, duration_sec, difficulty, note FROM inspections WHERE deleted = 0 ORDER BY ended_at, id'
  ).all()) {
    const d = new Date(r.ended_at);
    const hms = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    lines.push([r.id, dayStr(r.ended_at), hms, labels[r.difficulty] ?? r.difficulty, r.duration_sec ?? '', esc(r.note)].join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

// 勤務・休憩・睡眠イベントのCSV(睡眠時間の分析などを外部ツールでできるように)
const EV_CSV_LABELS = {
  work_start: '勤務開始', work_end: '勤務終了',
  break_start: '休憩開始', break_end: '休憩終了',
  sleep_start: '就寝', sleep_end: '起床',
};

export function exportEventsCSV() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['id,日付,時刻,種別,メモ'];
  for (const r of db.prepare(
    'SELECT id, type, at, note FROM work_events WHERE deleted = 0 ORDER BY at, id'
  ).all()) {
    const d = new Date(r.at);
    const hms = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    lines.push([r.id, dayStr(r.at), hms, EV_CSV_LABELS[r.type] ?? r.type, esc(r.note)].join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// ---- キャラクター画像のスキャン ----
// assets/character/ 直下のファイル → セット "default"、サブフォルダ → フォルダ名のセット。
// ファイル名は idle / happy / stretch / rest で始まるもの(idle_01.png 等のバリエーション可)。
// 日替わりランダムの「今日のセット」をサーバー側で決定する。
// 端末ごとにキャラ一覧の読み込みタイミングが違っても、全端末で同じ結果になる
export function dailySetName() {
  const excl = new Set(getSettings().dailyExclude || []);
  const names = Object.keys(characterSets()).filter(n => !excl.has(n)).sort();
  if (!names.length) return null;
  let h = 0;
  for (const c of dayStr(Date.now())) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return names[h % names.length];
}

export function characterSets() {
  const dir = path.join(ROOT, 'assets', 'character');
  const stateOf = f => {
    const m = /^(idle|happy|stretch|rest)([._-].*)?\.(png|webp|jpe?g|gif|svg)$/i.exec(f);
    return m ? m[1].toLowerCase() : null;
  };
  const sets = {};
  if (fs.existsSync(dir)) {
    const flat = {};
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const files = {};
        for (const g of fs.readdirSync(path.join(dir, ent.name))) {
          const st = stateOf(g);
          if (st) (files[st] ??= []).push(`/assets/character/${ent.name}/${g}`);
        }
        if (Object.keys(files).length) sets[ent.name] = files;
      } else {
        const st = stateOf(ent.name);
        if (st) (flat[st] ??= []).push(`/assets/character/${ent.name}`);
      }
    }
    if (Object.keys(flat).length) sets.default = flat;
  }
  return sets;
}
