'use strict';

// ================= ユーティリティ =================

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 難易度の色: 疲労度加算(score)の小さい順に、集中度グラデーションの緑側→赤側を均等に割り付ける
// (易しい=緑・重い=赤で意味が揃う。段階を追加・削除・score変更すると自動で割り付け直される。
//  既定の3段階なら 易=緑#3ec757 / 普通=青#3fa9f5 / 難=赤#ff5a6e で従来と同じ)
function diffColor(key) {
  const diffs = lastStatus?.settings.difficulties || [];
  const i = diffs.findIndex(d => d.key === key);
  if (i < 0 || diffs.length === 1) return heatColor(1.4); // 不明キー・1段階のみは緑
  const order = diffs.map((d, idx) => ({ idx, score: d.score }))
    .sort((a, b) => a.score - b.score || a.idx - b.idx) // 同点は定義順
    .map(o => o.idx);
  const t = 1 - order.indexOf(i) / (diffs.length - 1); // 低score→1(緑側)、高score→0(赤側)
  return heatColor(0.6 + 0.8 * t);
}
function diffLabel(key) {
  return (lastStatus?.settings.difficulties || []).find(d => d.key === key)?.label || key;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtHM(sec) { return `${Math.floor(sec / 3600)}:${pad2(Math.floor(sec / 60) % 60)}`; }
function fmtDur(sec) {
  if (sec == null) return '—';
  // 分と秒の区切りはコロンでなく'(アポストロフィ)。実働・連続の「時:分」と同じ見た目になり
  // 単位を取り違えるため(例: 5'02 = 5分02秒、3:32 = 3時間32分。ユーザー指定 2026-08-04)。
  // ※プライム記号U+2032は日本語フォントで全角になり桁が揃わないため半角の ' を使う
  if (sec >= 3600) return `${Math.floor(sec / 3600)}:${pad2(Math.floor(sec / 60) % 60)}'${pad2(sec % 60)}`;
  return `${Math.floor(sec / 60)}'${pad2(sec % 60)}`;
}
function fmtTime(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fmtTimeS(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// 'YYYY-MM-DD' を n 日ずらす(月またぎはDateに任せる)
function shiftDay(dayString, n) {
  const [y, m, d] = dayString.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function mdLabel(dayString) {
  return `${Number(dayString.slice(5, 7))}/${Number(dayString.slice(8))}(${'日月火水木金土'[new Date(dayString).getDay()]})`;
}
function ymdLabel(dayString) {
  return `${Number(dayString.slice(0, 4))}/${Number(dayString.slice(5, 7))}/${Number(dayString.slice(8))}`;
}
function timeToMs(dayString, hms) {
  const [y, m, d] = dayString.split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = hms.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi, s).getTime();
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(el, msg, ok = true) {
  el.textContent = msg;
  el.style.color = ok ? 'var(--ok)' : 'var(--danger)';
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

// 削除ボタンの2タップ確認(confirm()の代わり)。
// 1回目のタップで「削除?」表示になり、3秒以内の2回目で実行する。
function armDelete(btn, onConfirm) {
  if (btn.dataset.armed) {
    clearTimeout(btn._arm);
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = '🗑';
    onConfirm();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = '削除?';
  btn._arm = setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = '🗑';
  }, 3000);
}

// ================= タブ =================

let currentTab = 'main';

function showTab(tab) {
  // メインを離れるときは「本日の記録」を畳んでおく(開きっぱなしだと、
  // 戻ってきたときに下まで伸びた状態で表示されて位置を見失うため)。
  // 畳んだ状態はこの関数の末尾の saveUiState() で保存される
  if (currentTab === 'main' && tab !== 'main' && todayCard) todayCard.open = false;
  currentTab = tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['main', 'edit', 'stats', 'settings'].forEach(t =>
    $(`#tab-${t}`).classList.toggle('hidden', t !== tab));
  if (tab === 'main') updateCharacter(true); // 設定でキャラを変えた直後などに確実に反映する
  if (tab === 'edit') loadEditDay();
  if (tab === 'stats') loadStats();
  if (tab === 'settings') loadSettingsForm();
  saveUiState();
}

$$('#tabs button').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

// ---- UI状態の保存・復元(リロードしても開いていた場所に戻る) ----

const todayCard = document.querySelector('.today-card');

function saveUiState() {
  try {
    sessionStorage.setItem('ui-state', JSON.stringify({
      tab: currentTab,
      todayOpen: todayCard.open,
      editDate: $('#editDate').value,
      statsPeriod,
      statsOffset,
      scrollY: Math.round(window.scrollY),
    }));
  } catch { /* プライベートモード等でsessionStorage不可でも動作継続 */ }
}

function restoreUiState() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem('ui-state')); } catch {}
  if (!s) return;
  if (s.editDate) $('#editDate').value = s.editDate;
  if (s.statsPeriod) {
    statsPeriod = s.statsPeriod;
    statsOffset = s.statsOffset || 0;
    $$('.period-row button').forEach(x => x.classList.toggle('active', x.dataset.period === statsPeriod));
  }
  if (s.todayOpen) todayCard.open = true; // toggleイベント経由でリストが読み込まれる
  if (s.tab && s.tab !== 'main') showTab(s.tab);
  if (s.scrollY) setTimeout(() => window.scrollTo(0, s.scrollY), 150);
}

window.addEventListener('pagehide', saveUiState);
let scrollSaveTimer;
window.addEventListener('scroll', () => {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveUiState, 300);
}, { passive: true });

// ================= 状態ポーリング =================

let lastStatus = null;
let statusAt = 0;
let pollFails = 0; // 連続失敗回数(2回で「接続なし」表示)

async function refreshStatus() {
  try {
    applyStatus(await api('/api/status'));
    pollFails = 0;
  } catch (e) {
    console.error(e);
    // サーバーが落ちている・ネットワーク断のとき、最後の状態のまま固まらず気づけるようにする
    if (++pollFails >= 2) {
      const badge = $('#stateBadge');
      badge.className = 'badge badge-nolink';
      badge.textContent = '接続なし';
    }
  }
}

function applyStatus(st) {
  lastStatus = st;
  statusAt = Date.now();
  renderMain();
  checkAlerts();
  checkNotices();
  checkSleepPrompt();
  updateCharacter();
  updateBackground();
}

// 非表示タブではポーリングを止める(復帰時は visibilitychange で即時更新されるので抜けはない)
setInterval(() => { if (!document.hidden) refreshStatus(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });

// 連続チップ: タップで「経過」⇔「休憩までの残り」を切替
let contMode = localStorage.getItem('contMode') || 'elapsed';
$('#contChip').addEventListener('click', () => {
  contMode = contMode === 'elapsed' ? 'remain' : 'elapsed';
  try { localStorage.setItem('contMode', contMode); } catch {}
  renderContChip();
});

function renderContChip() {
  const st = lastStatus;
  if (!st || st.state !== 'working') {
    $('#mContLabel').textContent = '連続';
    $('#mCont').textContent = '—';
    return;
  }
  const sec = st.continuousSec + Math.floor((Date.now() - statusAt) / 1000);
  if (contMode === 'remain') {
    $('#mContLabel').textContent = '休憩まで';
    $('#mCont').textContent = fmtHM(Math.max(0, st.settings.alertFixedMin * 60 - sec));
  } else {
    $('#mContLabel').textContent = '連続';
    $('#mCont').textContent = fmtHM(sec);
  }
}

// 1秒ごとの表示更新(連続作業タイマー・時計)。非表示タブではスキップ
setInterval(() => {
  if (document.hidden) return;
  $('#clock').textContent = fmtTimeS(Date.now());
  if (lastStatus) renderContChip();
}, 1000);

// ================= メイン画面描画 =================

function renderMain() {
  const st = lastStatus;
  const badge = $('#stateBadge');
  badge.className = 'badge badge-' +
    (st.state === 'working' ? 'working' : st.state === 'break' ? 'break' : st.state === 'sleeping' ? 'sleep' : 'off');
  badge.textContent =
    st.state === 'working' ? '勤務中' : st.state === 'break' ? '休憩中' : st.state === 'sleeping' ? '睡眠中' : '勤務外';

  $('#mCount').textContent = st.todayCount;
  $('#mWork').textContent = fmtHM(st.workSec);
  renderContChip();
  $('#mAvg').textContent = st.avgDurationSec ? fmtDur(st.avgDurationSec) : '—';

  const focusEl = $('#mFocus');
  const c = st.concentration;
  focusEl.textContent = c != null ? c.toFixed(2) : '—';
  focusEl.style.color = c == null ? '' : c >= 1.1 ? 'var(--ok)' : c < 0.9 ? '#e8963a' : '';

  $('#mFatigue').textContent = st.fatigue;
  $('#mFatigueMax').textContent = st.settings.fatigueThreshold;
  const pct = Math.min(100, Math.round(st.fatigue / st.settings.fatigueThreshold * 100));
  $('#fatigueBar').style.width = pct + '%';

  // 勤務時間外(勤務外・睡眠中)は 休憩/再開 ボタンを 就寝/起床 に、勤務終了を 移動(背景の平日⇄休日)に切り替える
  const offDuty = st.state === 'off' || st.state === 'sleeping';
  const bs = $('#btnBreakStart'), be = $('#btnBreakEnd'), we = $('#btnWorkEnd');
  const mode = offDuty ? 'sleep' : 'break';
  if (bs.dataset.mode !== mode) {
    bs.dataset.mode = mode;
    be.dataset.mode = mode;
    we.dataset.mode = offDuty ? 'travel' : 'end';
    bs.innerHTML = offDuty
      ? '<span class="sb-ico">🛏</span><span class="sb-l">就寝</span>'
      : '<span class="sb-ico">☕</span><span class="sb-l">休憩</span>';
    be.innerHTML = offDuty
      ? '<span class="sb-ico">🌅</span><span class="sb-l">起床</span>'
      : '<span class="sb-ico">▶</span><span class="sb-l">再開</span>';
    we.innerHTML = offDuty
      ? '<span class="sb-ico">🚙</span><span class="sb-l">移動</span>'
      : '<span class="sb-ico">🏠</span><span class="sb-l">勤務終了</span>';
  }
  $('#btnWorkStart').disabled = st.state !== 'off';
  we.disabled = offDuty ? st.state !== 'off' : false;
  bs.disabled = offDuty ? st.state !== 'off' : st.state !== 'working';
  be.disabled = offDuty ? st.state !== 'sleeping' : st.state !== 'break';

  // 件数バッジは折りたたみ中でもstatusから更新(リスト本体は開いたときに取得)
  $('#todayListCount').textContent = st.todayCount ? `${st.todayCount}件` : '';

  renderDiffButtons(st);
}

let diffButtonsKey = '';
function renderDiffButtons(st) {
  const key = JSON.stringify(st.settings.difficulties) + '|' + (st.state === 'working');
  if (key === diffButtonsKey) return;
  diffButtonsKey = key;
  const wrap = $('#diffButtons');
  wrap.innerHTML = '';
  st.settings.difficulties.forEach(d => {
    const b = document.createElement('button');
    b.className = 'diff-btn';
    b.style.setProperty('--c', diffColor(d.key));
    b.innerHTML = `${esc(d.label)}<small>タップで記録</small>`;
    b.disabled = st.state !== 'working';
    b.addEventListener('click', () => recordInspection(d.key));
    wrap.appendChild(b);
  });
}

async function recordInspection(difficulty) {
  try {
    const r = await api('/api/inspections', { method: 'POST', body: { difficulty } });
    applyStatus(r.status);
    flashHappy();
    if (Math.random() < 0.34) say(SAY_LINES.record[Math.floor(Math.random() * SAY_LINES.record.length)], 2200);
    showToast($('#toast'), `記録しました(${diffLabel(difficulty)} / 所要 ${fmtDur(r.inspection.duration_sec)})`);
    loadTodayList();
  } catch (e) {
    showToast($('#toast'), e.message, false);
  }
}

$('#undoBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/undo', { method: 'POST' });
    applyStatus(r.status);
    showToast($('#toast'), `${fmtTime(r.undone.ended_at)} の「${diffLabel(r.undone.difficulty)}」を取り消しました`);
    loadTodayList();
  } catch (e) {
    showToast($('#toast'), e.message, false);
  }
});

// キャラのひとことセリフ
const SAY_LINES = {
  break_start: ['ゆっくり休んでくださいね ☕', 'コーヒーでもどうぞ ☕', '目を閉じてリラックス…'],
  break_end: ['おかえりなさい!', 'リフレッシュできましたか?', 'さあ、続きをやりましょう!'],
  record: ['ナイスです!', 'その調子!', 'おつかれさまです!', '順調ですね ✨', 'すごい集中力!'],
  sleep_start: ['おやすみなさい 🌙', 'ゆっくり休んでくださいね 💤', 'また明日!いい夢を ⭐'],
  sleep_end: ['おはようございます!☀', 'よく眠れましたか?', '今日も一日はじめましょう!'],
};

let sayTimer;
function say(text, ms = 3000) {
  const el = $('#charSay');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function greeting() {
  const h = new Date().getHours();
  if (h < 11) return 'おはようございます!今日もがんばりましょう 💪';
  if (h < 17) return 'ここから集中していきましょう!';
  return '遅くまでおつかれさまです!';
}

async function postEvent(type) {
  try {
    const r = await api('/api/events', { method: 'POST', body: { type } });
    applyStatus(r.status);
    if (type === 'work_start') { flashChar('stretch'); say(greeting()); }
    if (type === 'work_end') { flashChar('happy'); showDailyResult(); }
    if (type === 'break_start') say(SAY_LINES.break_start[Math.floor(Math.random() * SAY_LINES.break_start.length)]);
    if (type === 'break_end') say(SAY_LINES.break_end[Math.floor(Math.random() * SAY_LINES.break_end.length)]);
    // 就寝は happy→(睡眠中の)rest、起床は stretch→(勤務外の)idle にキャラが変わる
    if (type === 'sleep_start') { flashChar('happy'); say(SAY_LINES.sleep_start[Math.floor(Math.random() * SAY_LINES.sleep_start.length)]); }
    if (type === 'sleep_end') { flashChar('stretch'); say(SAY_LINES.sleep_end[Math.floor(Math.random() * SAY_LINES.sleep_end.length)]); }
    loadTodayList();
  } catch (e) {
    showToast($('#toast'), e.message, false);
  }
}
$('#btnWorkStart').addEventListener('click', () => postEvent('work_start'));
$('#btnWorkEnd').addEventListener('click', () =>
  $('#btnWorkEnd').dataset.mode === 'travel' ? toggleHolidayBg() : postEvent('work_end'));

// 勤務外の「移動🚙」: 自動背景を平日版⇄休日版で切り替える(設定はサーバー保存なので全端末に反映)
async function toggleHolidayBg() {
  const next = lastStatus?.settings.stageBg === 'auto_holiday' ? 'auto' : 'auto_holiday';
  try {
    await api('/api/settings', { method: 'PUT', body: { stageBg: next } });
    await refreshStatus(); // applyStatus経由でupdateBackground()が走る
    const sel = $('#setStageBg');
    if (sel.options.length) { sel.value = next; renderBgPreview(); }
    showToast($('#toast'), next === 'auto_holiday' ? '休日の背景に切り替えました 🚙' : '平日の背景に切り替えました 🚙');
  } catch (e) {
    showToast($('#toast'), e.message, false);
  }
}
$('#btnBreakStart').addEventListener('click', () =>
  postEvent($('#btnBreakStart').dataset.mode === 'sleep' ? 'sleep_start' : 'break_start'));
$('#btnBreakEnd').addEventListener('click', () =>
  postEvent($('#btnBreakEnd').dataset.mode === 'sleep' ? 'sleep_end' : 'break_end'));

// ---- 本日の記録一覧(メイン画面・インライン編集可) ----

async function loadTodayList() {
  if (!todayCard.open) return; // 折りたたみ中は取得しない(開いた瞬間に取得する)
  // 実効日+effective=1: 0時をまたいでも退勤までは前日からの続きを一覧に出す
  const base = lastStatus?.effectiveDay || todayStr();
  const { inspections } = await api('/api/day?date=' + base + '&effective=1');
  const wrap = $('#todayList');
  wrap.innerHTML = inspections.length ? '' : '<p class="muted">まだ記録がありません</p>';
  for (const r of [...inspections].reverse()) {
    wrap.appendChild(inspectionRow(r, false));
  }
}

todayCard.addEventListener('toggle', () => {
  if (todayCard.open) loadTodayList();
  saveUiState();
});

function difficultySelect(current) {
  const sel = document.createElement('select');
  sel.className = 'sel-diff';
  for (const d of lastStatus.settings.difficulties) {
    const o = document.createElement('option');
    o.value = d.key; o.textContent = d.label;
    // PCのドロップダウンはoptionがselectの文字色(=選択中の難易度色)を継承して全部同色になるため、
    // 各選択肢に自分の難易度色を明示する(スマホのネイティブピッカーには影響しない)
    o.style.color = diffColor(d.key);
    o.style.fontWeight = '700';
    if (d.key === current) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

function inspectionRow(r, withTimeEdit) {
  const row = document.createElement('div');
  row.className = 'rec-row';

  if (withTimeEdit) {
    const t = document.createElement('input');
    t.type = 'time'; // 秒は表示しない(編集すると秒は00になる)
    const d = new Date(r.ended_at);
    t.value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    t.addEventListener('change', () => patchInspection(r.id, { ended_at: timeToMs(currentEditDate(), t.value) }));
    row.appendChild(t);
  } else {
    const t = document.createElement('span');
    t.className = 'rec-time';
    t.textContent = fmtTime(r.ended_at);
    row.appendChild(t);
  }

  const sel = difficultySelect(r.difficulty);
  sel.style.color = diffColor(r.difficulty);
  sel.addEventListener('change', () => patchInspection(r.id, { difficulty: sel.value }));
  row.appendChild(sel);

  const dur = document.createElement('span');
  dur.className = 'rec-dur';
  dur.textContent = fmtDur(r.duration_sec);
  dur.title = '所要時間';
  row.appendChild(dur);

  const note = document.createElement('input');
  note.type = 'text';
  note.placeholder = 'メモ';
  note.value = r.note || '';
  note.addEventListener('change', () => patchInspection(r.id, { note: note.value }));
  row.appendChild(note);

  const del = document.createElement('button');
  del.className = 'rec-del';
  del.textContent = '🗑';
  del.title = '削除';
  del.addEventListener('click', () => armDelete(del, async () => {
    await api(`/api/inspections/${r.id}`, { method: 'DELETE' });
    showToast($('#toast'), `${fmtTime(r.ended_at)} の記録を削除しました`);
    refreshAfterEdit();
  }));
  row.appendChild(del);
  return row;
}

async function patchInspection(id, body) {
  try {
    await api(`/api/inspections/${id}`, { method: 'PATCH', body });
    refreshAfterEdit();
  } catch (e) { showToast($('#toast'), e.message, false); }
}

function refreshAfterEdit() {
  refreshStatus();
  loadTodayList();
  if (!$('#tab-edit').classList.contains('hidden')) loadEditDay();
}

// ================= 記録編集タブ =================

const EV_LABELS = { work_start: '🏢 勤務開始', work_end: '🏠 勤務終了', break_start: '☕ 休憩開始', break_end: '▶️ 休憩終了', sleep_start: '🛏 就寝', sleep_end: '🌅 起床' };

function currentEditDate() { return $('#editDate').value || todayStr(); }

$('#editDate').addEventListener('change', () => { loadEditDay(); saveUiState(); });

// ◀▶で前日・翌日へ(押し忘れ修正は「昨日」を開くことが多いため)
function shiftEditDate(n) {
  $('#editDate').value = shiftDay(currentEditDate(), n);
  loadEditDay();
  saveUiState();
}
$('#editPrev').addEventListener('click', () => shiftEditDate(-1));
$('#editNext').addEventListener('click', () => shiftEditDate(1));

async function loadEditDay() {
  if (!$('#editDate').value) $('#editDate').value = todayStr();
  const day = currentEditDate();
  const { inspections, events } = await api('/api/day?date=' + day);

  // 作業記録とイベントを分けず、1本の時系列リストにして表示する(ユーザー指定)
  const items = [
    ...inspections.map(r => ({ t: r.ended_at, node: () => inspectionRow(r, true) })),
    ...events.map(ev => ({ t: ev.at, node: () => eventRow(ev, day) })),
  ].sort((a, b) => a.t - b.t);
  const lw = $('#editList');
  lw.innerHTML = items.length ? '' : '<p class="muted">この日の記録はありません</p>';
  for (const it of items) lw.appendChild(it.node());

  const diffSel = $('#addInspDiff');
  diffSel.innerHTML = '';
  for (const d of lastStatus.settings.difficulties) {
    const o = document.createElement('option');
    o.value = d.key; o.textContent = d.label;
    o.style.color = diffColor(d.key); // ドロップダウンの選択肢にも各難易度の色を付ける
    o.style.fontWeight = '700';
    diffSel.appendChild(o);
  }
  diffSel.style.color = diffColor(diffSel.value); // 既存行と同じく難易度色の文字にする
}

function eventRow(ev, day) {
  const row = document.createElement('div');
  row.className = 'rec-row';

  // 作業記録と同じ「時刻→内容」の並び(ユーザー指定)。秒は表示しない(編集すると秒は00になる)
  const t = document.createElement('input');
  t.type = 'time';
  const d = new Date(ev.at);
  t.value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  t.addEventListener('change', () => patchEvent(ev.id, { at: timeToMs(day, t.value) }));
  row.appendChild(t);

  const sel = document.createElement('select');
  sel.className = 'sel-ev';
  for (const [v, l] of Object.entries(EV_LABELS)) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (v === ev.type) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => patchEvent(ev.id, { type: sel.value }));
  row.appendChild(sel);

  const note = document.createElement('input');
  note.type = 'text';
  note.placeholder = 'メモ';
  note.value = ev.note || '';
  note.addEventListener('change', () => patchEvent(ev.id, { note: note.value }));
  row.appendChild(note);

  const del = document.createElement('button');
  del.className = 'rec-del';
  del.textContent = '🗑';
  del.addEventListener('click', () => armDelete(del, async () => {
    await api(`/api/events/${ev.id}`, { method: 'DELETE' });
    showToast($('#toast'), `${EV_LABELS[ev.type]} ${fmtTime(ev.at)} を削除しました`);
    refreshAfterEdit();
  }));
  row.appendChild(del);
  return row;
}

async function patchEvent(id, body) {
  try {
    await api(`/api/events/${id}`, { method: 'PATCH', body });
    refreshAfterEdit();
  } catch (e) { showToast($('#toast'), e.message, false); }
}

// 追加行の難易度セレクトも選択中の難易度色で表示(既存行と同じ見た目)
$('#addInspDiff').addEventListener('change', () => {
  $('#addInspDiff').style.color = diffColor($('#addInspDiff').value);
});

// 入れ忘れた欄を光らせて、そこへカーソルを移す。トーストは小さく2秒で消えるため、
// Safariのように空の時刻欄が「入力済み」に見えるブラウザだと見落とされる
// (2026-08-05のmacOS実機検証。Safariは空欄に「12:30」のような見本を薄く表示する)
function needInput(el, msg) {
  showToast($('#toast'), msg, false);
  el.classList.add('need-input');
  el.focus();
  setTimeout(() => el.classList.remove('need-input'), 2500);
}

$('#addInspBtn').addEventListener('click', async () => {
  const t = $('#addInspTime').value;
  if (!t) return needInput($('#addInspTime'), '時刻を入力してください');
  try {
    await api('/api/inspections', {
      method: 'POST',
      body: { difficulty: $('#addInspDiff').value, at: timeToMs(currentEditDate(), t), note: $('#addInspNote').value },
    });
    // 入力欄は毎回空に戻す。時刻が残っていると、次の追加で前の時刻を
    // そのまま送ってしまいやすく、追加済みかどうかも分かりにくい
    $('#addInspTime').value = '';
    $('#addInspNote').value = '';
    showToast($('#toast'), '記録を追加しました');
    refreshAfterEdit();
  } catch (e) { showToast($('#toast'), e.message, false); }
});

$('#addEvBtn').addEventListener('click', async () => {
  const t = $('#addEvTime').value;
  if (!t) return needInput($('#addEvTime'), '時刻を入力してください');
  try {
    await api('/api/events', {
      method: 'POST',
      body: { type: $('#addEvType').value, at: timeToMs(currentEditDate(), t), note: $('#addEvNote').value },
    });
    $('#addEvTime').value = '';
    $('#addEvNote').value = '';
    showToast($('#toast'), 'イベントを追加しました');
    refreshAfterEdit();
  } catch (e) { showToast($('#toast'), e.message, false); }
});

// ================= アラート =================

// バナーのセリフは最大2行(あふれた分は省略記号になる)
const SUGGESTIONS = [
  '背伸びをしましょう 🙆',
  '肩をゆっくり回しましょう 💪',
  '窓の外など、遠くを見て目を休めましょう 👀',
  '立って少し歩きましょう 🚶',
  '首を左右にゆっくりストレッチしましょう',
  '深呼吸を3回しましょう 🍃',
  '水分補給をしましょう 🥤',
];

const alertCtl = {
  baseline: null,
  snoozeUntil: 0,
  active: false,
  dismissed: { fixed: false, score: false },
};

function checkAlerts() {
  const st = lastStatus;
  if (!st) return;

  if (st.baseline !== alertCtl.baseline) {
    // 休憩や勤務区切りでカウンタがリセットされた
    alertCtl.baseline = st.baseline;
    alertCtl.snoozeUntil = 0;
    alertCtl.dismissed = { fixed: false, score: false };
    hideAlert();
  }

  if (st.state !== 'working') { hideAlert(); return; }
  if (alertCtl.active || Date.now() < alertCtl.snoozeUntil) return;

  const fixedDue = st.continuousSec >= st.settings.alertFixedMin * 60 && !alertCtl.dismissed.fixed;
  const scoreDue = st.fatigue >= st.settings.fatigueThreshold && !alertCtl.dismissed.score;
  if (fixedDue || scoreDue) triggerAlert(fixedDue && scoreDue ? 'both' : fixedDue ? 'fixed' : 'score');
}

function triggerAlert(kind) {
  const st = lastStatus;
  alertCtl.active = true;
  alertCtl.kind = kind;
  // 1行目 = 理由チップ+提案文 の2行構成
  const chip = (kind === 'fixed')
    ? `連続${Math.floor(st.continuousSec / 60)}分`
    : `疲労 ${st.fatigue}`;
  const sug = SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)];
  $('#alertChip').textContent = chip;
  $('#alertSuggestion').textContent = sug;
  $('#alertSnoozeBtn').textContent = `${st.settings.snoozeMin}分後に再通知`;
  $('#alertBanner').classList.remove('hidden');
  updateCharacter();
}

function hideAlert() {
  if (!alertCtl.active) return;
  alertCtl.active = false;
  $('#alertBanner').classList.add('hidden');
  updateCharacter();
}

function dismissCurrent() {
  if (alertCtl.kind === 'fixed' || alertCtl.kind === 'both') alertCtl.dismissed.fixed = true;
  if (alertCtl.kind === 'score' || alertCtl.kind === 'both') alertCtl.dismissed.score = true;
}

$('#alertBreakBtn').addEventListener('click', () => { hideAlert(); postEvent('break_start'); });
$('#alertSnoozeBtn').addEventListener('click', () => {
  alertCtl.snoozeUntil = Date.now() + (lastStatus?.settings.snoozeMin || 5) * 60000;
  hideAlert();
});
$('#alertCloseBtn').addEventListener('click', () => { dismissCurrent(); hideAlert(); });

// ================= 押し忘れ通知 =================

const noticeCtl = { snoozeUntil: 0, action: null };

function checkNotices() {
  const st = lastStatus;
  const el = $('#noticeBanner');
  if (!st || Date.now() < noticeCtl.snoozeUntil) return;

  if (st.forgotten) {
    $('#noticeText').textContent = `${st.forgotten.day} の勤務終了を押し忘れています`;
    $('#noticeActionBtn').textContent = `🏠 ${fmtTime(st.forgotten.suggestedEnd)} で勤務終了にする`;
    noticeCtl.action = async () => {
      await api('/api/events', { method: 'POST', body: { type: 'work_end', at: st.forgotten.suggestedEnd } });
      showToast($('#toast'), '前日の勤務終了を記録しました');
      refreshAfterEdit();
    };
    el.classList.remove('hidden');
  } else if (st.state === 'working' && st.settings.forgetMin > 0 && st.idleSec >= st.settings.forgetMin * 60) {
    $('#noticeText').textContent = `${Math.floor(st.idleSec / 60)}分間 記録がありません。勤務終了を押し忘れていませんか?`;
    $('#noticeActionBtn').textContent = '🏠 勤務終了にする';
    noticeCtl.action = () => postEvent('work_end');
    el.classList.remove('hidden');
  } else if (st.state === 'sleeping' && st.sinceSec >= 14 * 3600) {
    // 就寝が14時間続いている → 起床の押し忘れの可能性が高い
    $('#noticeText').textContent = '就寝から14時間以上たっています。起床を押し忘れていませんか?(正確な時刻は記録タブで修正できます)';
    $('#noticeActionBtn').textContent = '🌅 いま起床にする';
    noticeCtl.action = () => postEvent('sleep_end');
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ---- 就寝促し(休憩アラートと同じ位置のバナー) ----

const sleepCtl = { snoozeUntil: 0, dismissedDay: null };

// 設定の開始時刻〜朝5時に起きている(勤務外・今日まだ起床していない)なら就寝を促す。-1は無効
function sleepPromptDue(st) {
  const sh = st.settings.sleepPromptHour ?? 0;
  if (sh < 0 || st.state !== 'off') return false;
  const h = new Date().getHours();
  const inWindow = sh >= 12 ? (h >= sh || h < 5) : (h >= sh && h < 5); // 22時開始などの日またぎに対応
  if (!inWindow) return false;
  if (sleepCtl.dismissedDay === todayStr()) return false; // ✕で閉じた夜はもう出さない
  const le = st.lastEvent;
  const wokeToday = le?.type === 'sleep_end' && new Date(le.at).toDateString() === new Date().toDateString();
  return !wokeToday;
}

function checkSleepPrompt() {
  const st = lastStatus;
  if (!st) return;
  const el = $('#sleepBanner');
  if (sleepPromptDue(st) && Date.now() >= sleepCtl.snoozeUntil) {
    if (el.classList.contains('hidden')) {
      $('#sleepChip').textContent = `${st.settings.sleepPromptHour}時すぎ`;
      el.classList.remove('hidden');
    }
  } else {
    el.classList.add('hidden');
  }
}

$('#sleepGoBtn').addEventListener('click', () => {
  $('#sleepBanner').classList.add('hidden');
  postEvent('sleep_start');
});
$('#sleepLaterBtn').addEventListener('click', () => {
  sleepCtl.snoozeUntil = Date.now() + 60 * 60000;
  $('#sleepBanner').classList.add('hidden');
});
$('#sleepCloseBtn').addEventListener('click', () => {
  sleepCtl.dismissedDay = todayStr();
  $('#sleepBanner').classList.add('hidden');
});

$('#noticeActionBtn').addEventListener('click', async () => {
  $('#noticeBanner').classList.add('hidden');
  try { await noticeCtl.action?.(); } catch (e) { showToast($('#toast'), e.message, false); }
});
$('#noticeDismissBtn').addEventListener('click', () => {
  noticeCtl.snoozeUntil = Date.now() + 60 * 60000; // 1時間後に再確認
  $('#noticeBanner').classList.add('hidden');
});

// ================= デイリーリザルト =================

async function showDailyResult() {
  try {
    const r = await api('/api/result');
    if (!r.total) return; // 記録ゼロの日はリザルトなし
    const setFiles = charSets[resolveSetName()] || {};
    $('#resultChar').src = setFiles.happy?.[0] || setFiles.idle?.[0] || placeholderSvg('happy');
    $('#resultTitle').textContent = new Date().getDay() === 5
      ? '今週もおつかれさまでした!🎉' : '今日もおつかれさまでした!';

    const diffs = lastStatus.settings.difficulties;
    const breakdown = diffs.map(d => chipHtml(d.key, `${d.label} ${r.counts[d.key] || 0}`)).join(' ');
    let rows = `
      <div class="result-row"><span class="rl">件数</span><span class="rv">${r.total} 件</span></div>
      <div class="result-row"><span class="rl">実働</span><span class="rv">${fmtHM(r.workSec)}</span></div>
      <div class="result-row"><span class="rl">平均所要</span><span class="rv">${r.avgDurationSec ? fmtDur(r.avgDurationSec) : '—'}</span></div>
      <div class="result-row"><span class="rl">集中度(平均/最高)</span><span class="rv">${r.avgIndex ?? '—'} / ${r.maxIndex ?? '—'}</span></div>
      <div class="result-row"><span class="rl">内訳</span><span>${breakdown}</span></div>`;
    if (r.isCountRecord && r.best.count > 1) rows += `<div class="result-record">🏆 件数の自己ベスト更新!(${r.total}件)</div>`;
    if (r.isIndexRecord) rows += `<div class="result-record">✨ 集中度の自己ベスト更新!(${r.avgIndex})</div>`;
    $('#resultBody').innerHTML = `<div class="result-rows">${rows}</div>`;
    $('#resultModal').classList.remove('hidden');
  } catch (e) { console.error(e); }
}

$('#resultCloseBtn').addEventListener('click', () => $('#resultModal').classList.add('hidden'));
$('#resultModal').addEventListener('click', e => {
  if (e.target === $('#resultModal')) $('#resultModal').classList.add('hidden');
});

// ================= キャラクター =================

let charSets = {};
let charDaily = null;   // サーバーが決めた「今日の日替わりセット」(全端末で一致)
let charCurrentSrc = '';
let flashState = null, flashUntil = 0; // 一時的な差分表示(記録時のhappy等)

async function loadCharacter() {
  try {
    const r = await api('/api/character');
    charSets = r.sets;
    charDaily = r.daily ?? null;
    updateCharacter(true);
  } catch (e) { console.error(e); }
}

// キャラ一覧と日替わり結果の自動再取得は24時間ごと(ユーザー指定)。
// ただし日付が変わった瞬間だけは即座に取り直す(日替わりキャラの切り替わり漏れ防止)
setInterval(loadCharacter, 24 * 60 * 60 * 1000);
let charLoadedDay = todayStr();
setInterval(() => {
  if (todayStr() !== charLoadedDay) {
    charLoadedDay = todayStr();
    loadCharacter();
  }
}, 60 * 1000);

function placeholderSvg(state) {
  const emoji = { idle: '🧑‍🔬', happy: '🎉', stretch: '🙆', rest: '☕' }[state] || '🙂';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='180'><rect width='100%' height='100%' rx='16' fill='%23e8edf9'/><text x='50%' y='45%' font-size='64' text-anchor='middle'>${emoji}</text><text x='50%' y='85%' font-size='18' text-anchor='middle' fill='%23667'>${state}</text></svg>`;
  return `data:image/svg+xml;utf8,${svg}`;
}

function charState() {
  if (flashState && Date.now() < flashUntil) return flashState;
  if (alertCtl.active) return 'stretch';
  if (lastStatus?.state === 'break' || lastStatus?.state === 'sleeping') return 'rest';
  return 'idle';
}

const DAILY_SET = '__daily__';

// 日替わりの当選セット。サーバー決定値を最優先(全端末で一致)。
// サーバー値が未取得の間だけ、同じ式でローカル計算にフォールバックする
function dailySetName() {
  if (charDaily) return charDaily;
  const names = Object.keys(charSets).sort();
  if (!names.length) return null;
  let h = 0;
  for (const c of todayStr()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return names[h % names.length];
}

function resolveSetName() {
  const name = lastStatus?.settings.characterSet;
  return name === DAILY_SET ? dailySetName() : name;
}

function updateCharacter(force = false) {
  const state = charState();
  $('.char-frame').dataset.state = state; // 呼吸アニメの切替に使う(CSS側で参照)
  const setName = resolveSetName();
  const files = charSets[setName] || charSets[Object.keys(charSets)[0]] || {};
  const pool = files[state] || files.idle || [];
  const src = pool.length ? pool[Math.floor(Math.random() * pool.length)] : placeholderSvg(state);
  const img = $('#charImg');
  const key = `${setName}|${state}`; // 日付が変わってセットが切り替わった場合も検知する
  if (!force && img.dataset.key === key) return;
  img.dataset.key = key;
  if (src === charCurrentSrc) return;
  charCurrentSrc = src;
  img.classList.add('fade');
  setTimeout(() => { img.src = src; img.classList.remove('fade'); }, 200);
}

function flashChar(state, ms = 3000) {
  flashState = state;
  flashUntil = Date.now() + ms;
  updateCharacter();
  setTimeout(updateCharacter, ms + 200);
}

function flashHappy() { flashChar('happy'); }

// ================= 統計 =================

let statsPeriod = 'today';
let statsOffset = 0; // 0=今、1=1つ前(日/週/月)、…。◀▶で移動
$$('.period-row button').forEach(b => b.addEventListener('click', () => {
  statsPeriod = b.dataset.period;
  statsOffset = 0; // 期間を切り替えたら「今」に戻る
  $$('.period-row button').forEach(x => x.classList.toggle('active', x === b));
  loadStats();
  saveUiState();
}));

$('#statsPrev').addEventListener('click', () => { statsOffset++; loadStats(); saveUiState(); });
$('#statsNext').addEventListener('click', () => {
  if (statsOffset > 0) { statsOffset--; loadStats(); saveUiState(); }
});

// 表示中の期間(日付・範囲)とナビのラベルを算出
function statsWindow() {
  if (statsPeriod === 'today') {
    // 「本日」= 実効日(0時をまたいでも退勤までは前日勤務の続き)
    const day = shiftDay(lastStatus?.effectiveDay || todayStr(), -statsOffset);
    return { day, label: statsOffset ? mdLabel(day) : '本日' };
  }
  const span = statsPeriod === 'week' ? 7 : statsPeriod === 'month' ? 30 : 365;
  const to = shiftDay(todayStr(), -span * statsOffset);
  const from = shiftDay(to, -(span - 1));
  const fmt = statsPeriod === 'year' ? ymdLabel : mdLabel; // 年は年付きラベルで曖昧さをなくす
  return { from, to, label: `${fmt(from)} 〜 ${statsOffset ? fmt(to) : '本日'}` };
}

// 休憩線の表示/非表示(状態は端末に記憶。グラフは再描画せずクラスで切替)
$('#statsBody').addEventListener('click', e => {
  const btn = e.target.closest('#brkToggle');
  if (!btn) return;
  const hidden = $('#concCard').classList.toggle('hide-brk');
  localStorage.setItem('showBreakLines', hidden ? '0' : '1');
});

async function loadStats() {
  const body = $('#statsBody');
  const win = statsWindow();
  $('#statsRangeLabel').textContent = win.label;
  $('#statsNext').disabled = statsOffset === 0;
  body.innerHTML = '<p class="muted">読み込み中...</p>';
  try {
    if (statsPeriod === 'today') {
      body.innerHTML = renderTodayStats(await api(`/api/stats/day?date=${win.day}`));
    } else {
      const st = await api(`/api/stats/range?from=${win.from}&to=${win.to}`);
      body.innerHTML = statsPeriod === 'year' ? renderYearStats(st) : renderRangeStats(st);
    }
  } catch (e) {
    body.innerHTML = `<p class="muted">読み込みに失敗しました: ${esc(e.message)}</p>`;
  }
}

function chipHtml(key, text) {
  return `<span class="chip" style="background:${diffColor(key)}">${esc(text)}</span>`;
}

function renderTodayStats(st) {
  const diffs = lastStatus.settings.difficulties;
  const isToday = st.day === (lastStatus?.effectiveDay || todayStr()); // ◀で過去の日を見ているときはラベルを変える
  const dl = isToday ? '本日' : 'この日';
  const breakdown = diffs.map(d => chipHtml(d.key, `${d.label} ${st.counts[d.key] || 0}`)).join(' ');
  const sleepCard = st.sleep
    ? `<div class="stat-card"><div class="v">${fmtHM(st.sleep.min * 60)}</div><div class="l">${isToday ? '昨夜' : '前夜'}の睡眠</div></div>`
    : '';
  const idxs = st.items.filter(i => i.index != null).map(i => i.index);
  const dayIndex = idxs.length ? (idxs.reduce((a, b) => a + b, 0) / idxs.length).toFixed(2) : null;
  let html = `
    <div class="stat-cards">
      <div class="stat-card"><div class="v">${st.total}</div><div class="l">${dl}の件数</div></div>
      <div class="stat-card"><div class="v">${dayIndex ?? '—'}</div><div class="l">${dl}の集中度</div></div>
      <div class="stat-card"><div class="v">${fmtHM(st.workSec)}</div><div class="l">実働時間</div></div>
      <div class="stat-card"><div class="v">${st.avgDurationSec ? fmtDur(st.avgDurationSec) : '—'}</div><div class="l">平均所要時間</div></div>
      <div class="stat-card"><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${breakdown}</div><div class="l">難易度内訳</div></div>
      ${sleepCard}
    </div>`;

  const pts = st.items.filter(i => i.index != null);
  const showBrk = localStorage.getItem('showBreakLines') !== '0';
  html += `<div class="card chart-card${showBrk ? '' : ' hide-brk'}" id="concCard">
    <div class="chart-head"><h2>集中度の推移(1.0 = 普段どおり)</h2>
    <button id="brkToggle" title="休憩線の表示/非表示">☕</button></div>`;
  if (pts.length >= 2) {
    html += concentrationChart(st.items, st.breaks || [], st.resumes || [], st.offs || []);
    html += `<div class="legend">${diffs.map(d => `<span><i style="background:${diffColor(d.key)}"></i>${esc(d.label)}</span>`).join('')}<span><i style="background:var(--text)"></i>移動平均</span><span class="brk-item"><i style="background:var(--break-line)"></i>休憩</span></div>`;
  } else {
    html += `<p class="muted">集中度を描くにはデータが不足しています。各難易度の記録が数件たまると表示されます。</p>`;
  }
  html += `</div>`;

  html += `<div class="card"><h2>難易度別の基準時間(中央値)</h2><table class="simple"><tr><th>難易度</th><th>基準時間</th><th>データ数</th></tr>`;
  for (const d of diffs) {
    const m = st.medians[d.key];
    html += `<tr><td>${chipHtml(d.key, d.label)}</td><td>${m.median ? fmtDur(m.median) : '—'}${m.provisional ? ' <span class="muted">(参考値)</span>' : ''}</td><td>${m.n}</td></tr>`;
  }
  html += `</table></div>`;
  return html;
}

// 集中度ラインチャート(SVG、X軸=時刻)
function concentrationChart(items, breaks = [], resumes = [], offs = []) {
  const pts = items.filter(it => it.index != null);
  const W = 420, H = 250, L = 42, R = 14, T = 18, B = 34;
  const vals = pts.flatMap(p => [p.index, p.ma]).filter(v => v != null);
  // 上端は0.5刻みに切り上げ(外れ値があってもグリッドが天井まで届く)
  const yMax = Math.max(1.6, Math.ceil(Math.max(...vals) * 1.08 * 2) / 2);
  // 2.0までは通常の間隔、2.0超(外れ値域)は半分の間隔に圧縮して描く
  const base = H - T - B;
  let ys;
  if (yMax > 2) {
    const p = base / (2 + (yMax - 2) / 2);
    ys = v => T + base - (v <= 2 ? v * p : 2 * p + (v - 2) * p / 2);
  } else {
    ys = v => T + base * (1 - v / yMax);
  }

  // 移動平均線のセグメント化: 昼休みなどの中断(長い休憩・勤務外)をまたいで線をつなげない
  const LONG_BREAK = 30 * 60000, LONG_GAP = 90 * 60000;
  const longBreaks = [...breaks, ...offs].filter(b => b.end != null && b.end - b.start >= LONG_BREAK);
  const splitBetween = (a, b) =>
    b.ended_at - a.ended_at > LONG_GAP ||
    longBreaks.some(br => br.start > a.ended_at && br.start < b.ended_at);
  const maPts = pts.filter(p => p.ma != null);
  const segs = [];
  let cur = [];
  for (const p of maPts) {
    if (cur.length && splitBetween(cur[cur.length - 1], p)) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  // 各区間の先頭に、直前の勤務開始/休憩明けの時刻から水平線を引くアンカーを追加
  let prevEnd = -Infinity;
  for (const seg of segs) {
    const first = seg[0];
    const cands = resumes.filter(t => t > prevEnd && t < first.ended_at && first.ended_at - t <= LONG_GAP);
    prevEnd = seg[seg.length - 1].ended_at;
    if (cands.length) seg.unshift({ ended_at: Math.max(...cands), ma: first.ma });
  }

  const t0 = Math.min(pts[0].ended_at, segs.length ? segs[0][0].ended_at : Infinity);
  const t1 = pts[pts.length - 1].ended_at;
  const xt = t => L + (W - L - R) * (t - t0) / Math.max(1, t1 - t0);

  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  // グリッドと目盛りは2.0まで(2.0超の圧縮域には線を引かず、外れ値の点だけ浮かべる)
  for (let g = 0.5; g <= Math.min(yMax, 2) + 1e-9; g += 0.5) {
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="${g === 1 ? '#b9c4dd' : '#e3e7f0'}" stroke-dasharray="${g === 1 ? '' : '4 4'}"/>`;
    s += `<text x="${L - 6}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g.toFixed(1)}</text>`;
  }
  // 時刻の目盛り: 毎正時の位置にラベルだけ置く(縦線は描かず、すっきりさせる)
  const d0 = new Date(t0);
  const firstHour = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), d0.getHours() + 1).getTime();
  let lastLb = -Infinity;
  for (let t = firstHour; t < t1; t += 3600000) {
    const x = xt(t);
    if (x - lastLb >= 30) {
      s += `<text x="${x.toFixed(1)}" y="${H - 10}" font-size="11" fill="#8a93a5" text-anchor="middle">${new Date(t).getHours()}時</text>`;
      lastLb = x;
    }
  }
  // 重なり順(下から): 軸・グリッド → 休憩線 → 移動平均 → プロット
  // 休憩マーカー: 全高の縦線(class="brk"。カードの hide-brk クラスで一括表示切替)
  for (const b of breaks) {
    if (b.start <= t0 || b.start >= t1) continue;  // グラフ範囲外は描かない
    const x = xt(b.start);
    s += `<line class="brk" x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${H - B}" stroke="var(--break-line)" stroke-width="1.5"/>`;
  }
  // 移動平均は白(ライトテーマでは黒)
  for (const seg of segs) {
    if (seg.length < 2) continue;
    s += `<polyline fill="none" stroke="var(--text)" stroke-width="3" stroke-linejoin="round" opacity=".9" points="${seg.map(p => `${xt(p.ended_at).toFixed(1)},${ys(p.ma)}`).join(' ')}"/>`;
  }
  // 点は控えめ(小さめ・半透明)にして移動平均線を主役にする
  s += pts.map(p => `<circle cx="${xt(p.ended_at).toFixed(1)}" cy="${ys(p.index)}" r="3" opacity=".65" fill="${diffColor(p.difficulty)}"><title>${fmtTime(p.ended_at)} ${diffLabel(p.difficulty)} ${p.index}</title></circle>`).join('');
  s += `</svg>`;
  return s;
}

// 日付軸の目盛りラベル。月をまたぐかに関わらず常に「8/3」形式で統一(ユーザー指定)
function dateTickLabel(dayStr) {
  return `${Number(dayStr.slice(5, 7))}/${Number(dayStr.slice(8))}`;
}
function isDateTick(dayStr) {
  return Number(dayStr.slice(8)) % 5 === 0;
}
// 日付軸の下段に添える曜日(全チャート共通の色・サイズ)
function weekdayTick(dayStr) {
  return '日月火水木金土'[new Date(dayStr).getDay()];
}

function renderRangeStats(st) {
  const diffs = lastStatus.settings.difficulties;
  let html = '';

  // 日別件数(難易度で積み上げ)
  html += `<div class="card chart-card"><h2>日別件数</h2>${stackedBarChart(st.days, diffs)}`;
  html += `<div class="legend legend-center">${diffs.map(d => `<span><i style="background:${diffColor(d.key)}"></i>${esc(d.label)}</span>`).join('')}</div></div>`;

  // 難易度別 平均所要時間の推移
  html += `<div class="card chart-card"><h2>難易度別の平均所要時間(分)</h2>${durationLinesChart(st.days, diffs)}`;
  html += `<div class="legend legend-center">${diffs.map(d => `<span><i style="background:${diffColor(d.key)}"></i>${esc(d.label)}</span>`).join('')}</div></div>`;

  // 日別の集中度(日平均の折れ線)
  const idxDays = st.days.filter(d => d.avgIndex != null);
  html += `<div class="card chart-card"><h2>日別の集中度(1.0 = 普段どおり)</h2>`;
  if (idxDays.length >= 2) html += indexBarChart(st.days);
  else html += `<p class="muted">データが不足しています(集中度が算出できた日が2日以上必要)。</p>`;
  html += `</div>`;

  // 連続作業時間と集中度(1点=1件。アラート設定値の検証用)
  html += `<div class="card chart-card"><h2>連続作業時間と集中度</h2>`;
  if ((st.gapPts || []).length >= 5) {
    html += gapScatter(st.gapPts, lastStatus.settings.alertFixedMin);
    html += `<details class="help"><summary>この図の見方</summary><p class="muted">点は1件の記録(色=難易度)。横軸は直前の勤務開始・休憩明けから何分連続で働いていたかです。縦の紫線は連続作業アラートの設定値で、線より右で集中度が下がっていれば、アラートを早めるサインです。</p></details>`;
  } else {
    html += `<p class="muted">データが不足しています(休憩・勤務イベントのある記録が5件以上必要)。</p>`;
  }
  html += `</div>`;

  // 休憩と集中度(1点=1勤務。半日勤務・夜枠がある日に対応するため日単位でなく勤務単位)
  const sessWithData = (st.sessions || []).filter(sn => sn.avgIndex != null);
  html += `<div class="card chart-card"><h2>休憩回数と集中度の関係</h2>`;
  if (sessWithData.length >= 2) {
    html += breaksScatter(sessWithData);
    html += `<details class="help"><summary>この図の見方</summary><p class="muted">横軸は1回の勤務(勤務開始から勤務終了まで)中に取った休憩の回数、縦軸はその勤務の集中度です。終了していない勤務は含まれません。</p></details>`;
  } else {
    html += `<p class="muted">データが不足しています(集中度が算出できた勤務が2回以上必要)。</p>`;
  }
  html += `</div>`;

  // ヒートマップ
  html += `<div class="card"><h2>時間帯 × 曜日の集中度</h2>${heatmapHtml(st.heatmap)}
    <div class="legend"><span><i style="background:${heatColor(0.6)}"></i>低調</span><span><i style="background:${heatColor(1)}"></i>普段どおり</span><span><i style="background:${heatColor(1.4)}"></i>好調</span><span><i style="background:var(--gauge-track);border:1px solid var(--border)"></i>データなし</span></div>
    <details class="help"><summary>この図の見方</summary><p class="muted">マスの色は集中度に応じて赤(低調)〜青(普段どおり)〜緑(好調)へなめらかに変わります。</p></details></div>`;

  // 睡眠の記録(就寝〜起床の帯。色 = その日の集中度)
  const sleepDays = st.days.filter(d => d.sleepMin != null);
  // 見出しに平均睡眠を併記(平均就寝・起床は表示しない)
  const sleepAvg = sleepDays.length ? fmtHM(Math.round(sleepDays.reduce((a, d) => a + d.sleepMin, 0) / sleepDays.length) * 60) : null;
  html += `<div class="card chart-card"><h2>睡眠の記録${sleepAvg ? `(平均睡眠 ${sleepAvg})` : ''}</h2>`;
  if (sleepDays.length) {
    html += sleepBandChart(st.days);
    html += `<div class="legend"><span><i style="background:${heatColor(0.6)}"></i>低調</span><span><i style="background:${heatColor(1)}"></i>普段どおり</span><span><i style="background:${heatColor(1.4)}"></i>好調</span><span><i style="background:var(--gauge-track);border:1px solid var(--border)"></i>集中度なし</span></div>`;
    html += `<details class="help"><summary>この図の見方</summary><p class="muted">縦の帯が就寝から起床までの睡眠時間帯です(上=前日の夜、下=当日の朝)。帯の色はその日(起床した日)の集中度で、緑=好調・青=普段どおり・赤=低調を表します。夜ふかしや睡眠不足の翌日に赤へ寄っていないか見てみましょう。</p></details>`;
  } else {
    html += `<p class="muted">睡眠の記録がまだありません。勤務外に「🛏 就寝」「🌅 起床」ボタンで記録すると、集中力との関係が見られるようになります。</p>`;
  }
  html += `</div>`;

  // 睡眠時間と集中度
  const slIdx = sleepDays.filter(d => d.avgIndex != null);
  html += `<div class="card chart-card"><h2>睡眠時間と集中度の関係</h2>`;
  if (slIdx.length >= 2) {
    html += sleepScatter(slIdx);
    html += `<details class="help"><summary>この図の見方</summary><p class="muted">点は1日(横=前夜の睡眠時間、縦=その日の集中度)。自分に合う睡眠時間の目安が見えてきます。</p></details>`;
  } else {
    html += `<p class="muted">データが不足しています(睡眠と集中度がそろった日が2日以上必要)。</p>`;
  }
  html += `</div>`;

  html += csvRowHtml();
  return html;
}

// CSVダウンロード(週/月/年ビューの一番下。記録=作業記録、打刻=勤務・休憩・睡眠イベント)
function csvRowHtml() {
  return `<div class="csv-row">
    <a href="/api/export.csv" class="btn-link" download>⬇ 記録CSV</a>
    <a href="/api/export-events.csv" class="btn-link" download>⬇ 打刻CSV</a>
  </div>`;
}

// ================= 年ビュー(直近12ヶ月を月単位に集約) =================
// 日単位の棒は365本で1px以下になり読めないため、月単位のグラフで見せる

function renderYearStats(st) {
  const diffs = lastStatus.settings.difficulties;
  const months = aggregateMonths(st.days);
  let html = '';

  html += `<div class="card chart-card"><h2>月別件数</h2>${monthlyBarChart(months, diffs)}`;
  html += `<div class="legend legend-center">${diffs.map(d => `<span><i style="background:${diffColor(d.key)}"></i>${esc(d.label)}</span>`).join('')}</div></div>`;

  html += `<div class="card chart-card"><h2>難易度別の平均所要時間(分)</h2>${monthlyDurationChart(months, diffs)}`;
  html += `<div class="legend legend-center">${diffs.map(d => `<span><i style="background:${diffColor(d.key)}"></i>${esc(d.label)}</span>`).join('')}</div></div>`;

  html += `<div class="card chart-card"><h2>月別の集中度(1.0 = 普段どおり)</h2>`;
  if (months.filter(m => m.idxN).length >= 2) html += monthlyValueChart(months, 'index');
  else html += `<p class="muted">データが不足しています(集中度が算出できた月が2ヶ月以上必要)。</p>`;
  html += `</div>`;

  html += `<div class="card"><h2>時間帯 × 曜日の集中度</h2>${heatmapHtml(st.heatmap)}
    <div class="legend"><span><i style="background:${heatColor(0.6)}"></i>低調</span><span><i style="background:${heatColor(1)}"></i>普段どおり</span><span><i style="background:${heatColor(1.4)}"></i>好調</span><span><i style="background:var(--gauge-track);border:1px solid var(--border)"></i>データなし</span></div></div>`;

  html += `<div class="card chart-card"><h2>月別の平均睡眠時間</h2>`;
  if (months.filter(m => m.sleepN).length >= 2) {
    html += monthlyValueChart(months, 'sleep');
    html += `<div class="legend"><span><i style="background:${heatColor(0.6)}"></i>低調</span><span><i style="background:${heatColor(1)}"></i>普段どおり</span><span><i style="background:${heatColor(1.4)}"></i>好調</span><span><i style="background:var(--gauge-track);border:1px solid var(--border)"></i>集中度なし</span></div>`;
  } else {
    html += `<p class="muted">データが不足しています(睡眠を記録した月が2ヶ月以上必要)。</p>`;
  }
  html += `</div>`;

  const slIdx = st.days.filter(d => d.sleepMin != null && d.avgIndex != null);
  html += `<div class="card chart-card"><h2>睡眠時間と集中度の関係</h2>`;
  if (slIdx.length >= 2) {
    html += sleepScatter(slIdx);
    html += `<details class="help"><summary>この図の見方</summary><p class="muted">点は1日(横=前夜の睡眠時間、縦=その日の集中度)。自分に合う睡眠時間の目安が見えてきます。</p></details>`;
  } else {
    html += `<p class="muted">データが不足しています(睡眠と集中度がそろった日が2日以上必要)。</p>`;
  }
  html += `</div>`;

  html += csvRowHtml();
  return html;
}

// 日別データを月単位(YYYY-MM)に集約。集中度は「日平均の平均」、睡眠は記録がある日の平均、
// 所要時間は件数で重み付けした月平均(難易度別)
function aggregateMonths(days) {
  const map = new Map();
  for (const d of days) {
    const ym = d.day.slice(0, 7);
    let m = map.get(ym);
    if (!m) map.set(ym, m = { ym, counts: {}, total: 0, idxSum: 0, idxN: 0, sleepSum: 0, sleepN: 0, durSum: {}, durN: {} });
    for (const [k, c] of Object.entries(d.counts)) m.counts[k] = (m.counts[k] || 0) + c;
    m.total += d.total;
    if (d.avgIndex != null) { m.idxSum += d.avgIndex; m.idxN++; }
    if (d.sleepMin != null) { m.sleepSum += d.sleepMin; m.sleepN++; }
    for (const [k, v] of Object.entries(d.avgDur)) {
      const c = d.counts[k] || 1;
      m.durSum[k] = (m.durSum[k] || 0) + v * c;
      m.durN[k] = (m.durN[k] || 0) + c;
    }
  }
  return [...map.values()]; // daysが昇順なので月も昇順
}

// 月の目盛りラベル。下段の年は最初と年が変わった月にだけ表示
function monthAxisLabels(months, xAt, H) {
  let s = '', prevY = '';
  months.forEach((m, i) => {
    const [y, mo] = m.ym.split('-');
    const x = xAt(i);
    s += `<text x="${x.toFixed(1)}" y="${H - 22}" font-size="11" fill="#8a93a5" text-anchor="middle">${Number(mo)}月</text>`;
    if (y !== prevY) {
      prevY = y;
      s += `<text x="${x.toFixed(1)}" y="${H - 8}" font-size="11" fill="#b7bfce" text-anchor="middle">${y}</text>`;
    }
  });
  return s;
}

function monthlyBarChart(months, diffs) {
  const W = 420, H = 210, L = 34, R = 6, T = 10, B = 40;
  const maxTotal = Math.max(1, ...months.map(m => m.total));
  const bw = (W - L - R) / months.length;
  const ys = v => T + (H - T - B) * (1 - v / maxTotal);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  const gridStep = maxTotal > 800 ? 400 : maxTotal > 400 ? 200 : maxTotal > 200 ? 100 :
    maxTotal > 80 ? 40 : maxTotal > 40 ? 20 : maxTotal > 20 ? 10 : maxTotal > 8 ? 5 : 2;
  for (let g = gridStep; g <= maxTotal; g += gridStep) {
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="#e3e7f0"/><text x="${L - 5}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g}</text>`;
  }
  months.forEach((m, i) => {
    let acc = 0;
    const x = L + i * bw + bw * 0.15;
    const segs = diffs.map(df => ({ df, c: m.counts[df.key] || 0 })).filter(v => v.c);
    segs.forEach((v, si) => {
      const y1 = ys(acc + v.c), y0 = ys(acc);
      s += `<path d="${barPath(x, y1, bw * 0.7, y0 - y1, si === segs.length - 1 ? 2 : 0, si === 0 ? 2 : 0)}" fill="${diffColor(v.df.key)}"><title>${m.ym.replace('-', '/')} ${v.df.label}: ${v.c}件</title></path>`;
      acc += v.c;
    });
  });
  s += monthAxisLabels(months, i => L + i * bw + bw * 0.5, H);
  s += `</svg>`;
  return s;
}

// 月別の難易度別平均所要時間(分)。1点=1ヶ月(件数で重み付けした月平均)。
// Y軸の圧縮ルール・色は週/月のdurationLinesChartと同じ
function monthlyDurationChart(months, diffs) {
  const W = 420, H = 210, L = 34, R = 10, T = 10, B = 40;
  const avg = (m, k) => (m.durN[k] ? m.durSum[k] / m.durN[k] : null);
  const allMin = months.flatMap(m => diffs.map(df => avg(m, df.key))).filter(v => v != null).map(v => v / 60);
  if (!allMin.length) return '<p class="muted">データがありません。</p>';
  const yMax = Math.max(...allMin) * 1.15;
  const xs = i => L + (W - L - R) * (i + 0.5) / months.length; // 他の月別チャートと同じスロット中央
  // 30分までは通常の間隔、30分超(外れ値域)は半分の間隔に圧縮して描く
  const base = H - T - B;
  let ys;
  if (yMax > 30) {
    const p = base / (30 + (yMax - 30) / 2);
    ys = v => T + base - (v <= 30 ? v * p : 30 * p + (v - 30) * p / 2);
  } else {
    ys = v => T + base * (1 - v / yMax);
  }
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  const gridStep = yMax > 16 ? 10 : 5;
  for (let g = gridStep; g <= yMax; g += gridStep) {
    const dash = g > 30 ? ' stroke-dasharray="4 4"' : '';  // 圧縮域は破線で区別
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="#e3e7f0"${dash}/><text x="${L - 5}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g}</text>`;
  }
  // 難易度色の点のみ(線では繋がない=ユーザー指定。週/月版と同じ)
  for (const df of diffs) {
    const pts = months.map((m, i) => ({ i, v: avg(m, df.key) })).filter(p => p.v != null);
    s += pts.map(p => `<circle cx="${xs(p.i).toFixed(1)}" cy="${ys(p.v / 60).toFixed(1)}" r="3.5" fill="${diffColor(df.key)}"><title>${months[p.i].ym.replace('-', '/')} ${df.label}: ${fmtDur(Math.round(p.v))}</title></circle>`).join('');
  }
  s += monthAxisLabels(months, xs, H);
  s += `</svg>`;
  return s;
}

// 月別の棒グラフ。mode 'index'=集中度(白/黒一色、1.0強調・0.5刻み) /
// 'sleep'=平均睡眠(時間、2時間刻み。棒の色=その月の集中度平均のheatColor=睡眠の記録の帯と同じルール)
function monthlyValueChart(months, mode) {
  const W = 420, H = 210, L = 42, R = 14, T = 14, B = 40;
  const getV = mode === 'index'
    ? m => (m.idxN ? m.idxSum / m.idxN : null)
    : m => (m.sleepN ? m.sleepSum / m.sleepN / 60 : null);
  const pts = months.map((m, i) => ({ i, v: getV(m), ym: m.ym })).filter(p => p.v != null);
  const xs = i => L + (W - L - R) * (i + 0.5) / months.length; // 棒グラフと同じスロット中央
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  let ys;
  if (mode === 'index') {
    const yMax = Math.max(1.6, Math.ceil(Math.max(...pts.map(p => p.v)) * 1.08 * 2) / 2);
    ys = v => T + (H - T - B) * (1 - v / yMax);
    for (let g = 0.5; g <= yMax + 1e-9; g += 0.5) {
      s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="${g === 1 ? '#b9c4dd' : '#e3e7f0'}" stroke-dasharray="${g === 1 ? '' : '4 4'}"/>`;
      s += `<text x="${L - 6}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g.toFixed(1)}</text>`;
    }
  } else {
    const yMax = Math.max(9, Math.ceil(Math.max(...pts.map(p => p.v)) + 1));
    ys = v => T + (H - T - B) * (1 - v / yMax);
    for (let g = 2; g <= yMax; g += 2) {
      s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="#e3e7f0" stroke-dasharray="4 4"/>`;
      s += `<text x="${L - 6}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g}h</text>`;
    }
  }
  if (mode === 'index') {
    // 集中度は白/黒一色の棒(日別の集中度と同じ表現=ユーザー指定)
    const bw = (W - L - R) / months.length;
    for (const p of pts) {
      const x = L + p.i * bw + bw * 0.15;
      s += `<path d="${barPath(x, ys(p.v), bw * 0.7, ys(0) - ys(p.v), 2, 2)}" fill="var(--text)"><title>${p.ym.replace('-', '/')}: ${p.v.toFixed(2)}</title></path>`;
    }
  } else {
    // 平均睡眠の棒。色=その月の集中度平均(集中度がない月はデータなし色)
    const bw = (W - L - R) / months.length;
    for (const p of pts) {
      const m = months[p.i];
      const idx = m.idxN ? +(m.idxSum / m.idxN).toFixed(2) : null;
      const x = L + p.i * bw + bw * 0.15;
      s += `<path d="${barPath(x, ys(p.v), bw * 0.7, ys(0) - ys(p.v), 2, 2)}" fill="${heatColor(idx)}"><title>${p.ym.replace('-', '/')}: 睡眠 ${fmtHM(Math.round(p.v * 60) * 60)} / 集中度 ${idx ?? '—'}</title></path>`;
    }
  }
  s += monthAxisLabels(months, i => xs(i), H);
  s += `</svg>`;
  return s;
}

// 睡眠時間帯チャート: 1日1本の縦帯(就寝→起床)、色=その日の集中度(heatColor)
function sleepBandChart(days) {
  const W = 420, H = 250, L = 42, R = 6, T = 10, B = 40;
  // 縦軸=時刻。上端=前日18時、下端=当日12時の18時間(起床日の0時が rel 6)
  const relH = (t, day) => {
    const [y, m, d] = day.split('-').map(Number);
    return (t - new Date(y, m - 1, d).getTime()) / 3600000 + 6;
  };
  const ys = rel => T + (H - T - B) * rel / 18;
  const bw = (W - L - R) / days.length;
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  for (let g = 0; g <= 18; g += 3) {
    const lbl = (18 + g) % 24;
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="${lbl === 0 ? '#b9c4dd' : '#e3e7f0'}" stroke-dasharray="${lbl === 0 ? '' : '4 4'}"/>`;
    s += `<text x="${L - 6}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${lbl}時</text>`;
  }
  days.forEach((d, i) => {
    const x = L + i * bw + bw * 0.15;
    if (days.length <= 7 || isDateTick(d.day)) {
      s += `<text x="${x + bw * 0.35}" y="${H - 22}" font-size="11" fill="#8a93a5" text-anchor="middle">${dateTickLabel(d.day)}</text>`;
      s += `<text x="${x + bw * 0.35}" y="${H - 8}" font-size="11" fill="#b7bfce" text-anchor="middle">${weekdayTick(d.day)}</text>`;
    }
    if (d.sleepMin == null) return;
    const r0 = Math.max(0, relH(d.bedAt, d.day));
    const r1 = Math.min(18, relH(d.wakeAt, d.day));
    if (r1 <= r0) return;
    s += `<rect x="${x.toFixed(1)}" y="${ys(r0).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${(ys(r1) - ys(r0)).toFixed(1)}" rx="3" fill="${heatColor(d.avgIndex)}"><title>${d.day} 就寝${fmtTime(d.bedAt)} → 起床${fmtTime(d.wakeAt)}(睡眠 ${fmtHM(d.sleepMin * 60)} / 集中度 ${d.avgIndex ?? '—'})</title></rect>`;
  });
  s += `</svg>`;
  return s;
}

// 睡眠時間(前夜)× 集中度(当日)の散布図
function sleepScatter(days) {
  const W = 420, H = 230, L = 42, R = 14, T = 14, B = 34;
  const hrs = days.map(d => d.sleepMin / 60);
  const xMin = Math.max(0, Math.floor(Math.min(...hrs, 5)) - 1);
  const xMax = Math.ceil(Math.max(...hrs, 9)) + 1;
  const yMax = Math.max(1.6, Math.ceil(Math.max(...days.map(d => d.avgIndex)) * 1.08 * 2) / 2);
  const xs = v => L + (W - L - R) * (v - xMin) / (xMax - xMin);
  const ys = v => T + (H - T - B) * (1 - v / yMax);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  // 基準線(1.0)は実線、グリッドは破線4 4(全チャート共通の線種ルール)
  s += `<line class="grid" x1="${L}" y1="${ys(1)}" x2="${W - R}" y2="${ys(1)}" stroke="#b9c4dd"/><text x="${L - 6}" y="${ys(1) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">1.0</text>`;
  const step = xMax - xMin > 8 ? 2 : 1;
  for (let g = xMin; g <= xMax; g += step) {
    const anchor = g === xMin ? 'start' : g === xMax ? 'end' : 'middle';
    s += `<text x="${xs(g)}" y="${H - 10}" font-size="11" fill="#8a93a5" text-anchor="${anchor}">${g}時間</text>`;
    if (g > xMin) s += `<line class="grid" x1="${xs(g)}" y1="${T}" x2="${xs(g)}" y2="${H - B}" stroke="#e3e7f0" stroke-dasharray="4 4"/>`;
  }
  // 点はテーマの白/黒一色(集中度は縦位置で読む。日別の棒グラフと同じルール、ユーザー指定)
  s += days.map(d => `<circle cx="${xs(d.sleepMin / 60).toFixed(1)}" cy="${ys(d.avgIndex).toFixed(1)}" r="5" fill="var(--text)" opacity=".85"><title>${d.day}: 睡眠 ${fmtHM(d.sleepMin * 60)} / 集中度 ${d.avgIndex}</title></circle>`).join('');
  s += `</svg>`;
  return s;
}

// 日別の平均集中度の棒グラフ(週・月ビュー)。棒はテーマの白/黒一色(値は高さで読む。ユーザー指定)
function indexBarChart(days) {
  const W = 420, H = 210, L = 42, R = 14, T = 14, B = 40; // 日付+曜日の2段ラベルぶんの下余白
  const pts = days.map((d, i) => ({ i, v: d.avgIndex, day: d.day })).filter(p => p.v != null);
  const yMax = Math.max(1.6, Math.ceil(Math.max(...pts.map(p => p.v)) * 1.08 * 2) / 2);
  const bw = (W - L - R) / days.length;
  const ys = v => T + (H - T - B) * (1 - v / yMax);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  for (let g = 0.5; g <= yMax + 1e-9; g += 0.5) {
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="${g === 1 ? '#b9c4dd' : '#e3e7f0'}" stroke-dasharray="${g === 1 ? '' : '4 4'}"/>`;
    s += `<text x="${L - 6}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g.toFixed(1)}</text>`;
  }
  for (const p of pts) {
    const x = L + p.i * bw + bw * 0.15;
    s += `<path d="${barPath(x, ys(p.v), bw * 0.7, ys(0) - ys(p.v), 2, 2)}" fill="var(--text)"><title>${p.day}: ${p.v}</title></path>`;
  }
  // 日付ラベルは件数の棒グラフと同じスロット中央方式
  days.forEach((d, i) => {
    if (days.length > 7 && !isDateTick(d.day)) return;
    const x = L + i * bw + bw * 0.5;
    s += `<text x="${x.toFixed(1)}" y="${H - 22}" font-size="11" fill="#8a93a5" text-anchor="middle">${dateTickLabel(d.day)}</text>`;
    s += `<text x="${x.toFixed(1)}" y="${H - 8}" font-size="11" fill="#b7bfce" text-anchor="middle">${weekdayTick(d.day)}</text>`;
  });
  s += `</svg>`;
  return s;
}

// 折れ線チャート用の日付+曜日の2段ラベル(棒グラフと同じ見た目。端は内向きに寄せて見切れを防ぐ)
function dayAxisLabels(days, xs, W, H, L, R) {
  let s = '';
  days.forEach((d, i) => {
    if (days.length > 7 && !isDateTick(d.day)) return;
    const x = xs(i);
    const anchor = x < L + 24 ? 'start' : x > W - R - 24 ? 'end' : 'middle';
    const tx = anchor === 'start' ? x - 4 : anchor === 'end' ? x + 4 : x;
    s += `<text x="${tx}" y="${H - 22}" font-size="11" fill="#8a93a5" text-anchor="${anchor}">${dateTickLabel(d.day)}</text>`;
    s += `<text x="${tx}" y="${H - 8}" font-size="11" fill="#b7bfce" text-anchor="${anchor}">${weekdayTick(d.day)}</text>`;
  });
  return s;
}

// 連続作業時間(直前の勤務開始・休憩明けからの分数)× 集中度の散布図
function gapScatter(gapPts, alertMin) {
  const W = 420, H = 230, L = 42, R = 14, T = 14, B = 34;
  const maxGap = Math.max(...gapPts.map(p => p.gap));
  const xMax = Math.max(60, Math.ceil(Math.min(maxGap, 180) * 1.05 / 10) * 10);
  const vals = gapPts.map(p => p.index);
  const yMax = Math.max(1.6, Math.ceil(Math.max(...vals) * 1.08 * 2) / 2);
  const xs = v => L + (W - L - R) * Math.min(v, xMax) / xMax;
  const ys = v => T + (H - T - B) * (1 - v / yMax);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  // 基準線(1.0・アラート)は実線、グリッドは破線4 4(全チャート共通の線種ルール)
  s += `<line class="grid" x1="${L}" y1="${ys(1)}" x2="${W - R}" y2="${ys(1)}" stroke="#b9c4dd"/><text x="${L - 6}" y="${ys(1) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">1.0</text>`;
  const gStep = xMax > 120 ? 60 : 30;
  for (let g = 0; g <= xMax; g += gStep) {
    const anchor = g === 0 ? 'start' : g === xMax ? 'end' : 'middle';
    s += `<text x="${xs(g)}" y="${H - 10}" font-size="11" fill="#8a93a5" text-anchor="${anchor}">${g}分</text>`;
    if (g > 0) s += `<line class="grid" x1="${xs(g)}" y1="${T}" x2="${xs(g)}" y2="${H - B}" stroke="#e3e7f0" stroke-dasharray="4 4"/>`;
  }
  if (alertMin && alertMin <= xMax) {
    s += `<line x1="${xs(alertMin)}" y1="${T}" x2="${xs(alertMin)}" y2="${H - B}" stroke="var(--heading)" stroke-width="2" opacity=".8"/>`;
  }
  s += gapPts.map(p => `<circle cx="${xs(p.gap).toFixed(1)}" cy="${ys(p.index).toFixed(1)}" r="4" fill="${diffColor(p.difficulty)}" opacity=".65"><title>連続${Math.round(p.gap)}分 ${diffLabel(p.difficulty)} ${p.index}</title></circle>`).join('');
  s += `</svg>`;
  return s;
}

// 上端・下端だけ個別に丸められる棒のパス(SVGのrectは4隅一括でしか丸められないため)
function barPath(x, y, w, h, rTop, rBot) {
  const n = v => v.toFixed(1);
  const lim = Math.min(w / 2, h / 2);
  // 半径は先に丸めてから使う(辺の長さと桁がズレて1本だけ0.1pxはみ出すのを防ぐ)
  const rt = +n(Math.max(0, Math.min(rTop, lim))), rb = +n(Math.max(0, Math.min(rBot, lim)));
  return `M${n(x)},${n(y + rt)}` +
    (rt ? ` a${n(rt)},${n(rt)} 0 0 1 ${n(rt)},${n(-rt)}` : '') +
    ` h${n(w - rt * 2)}` +
    (rt ? ` a${n(rt)},${n(rt)} 0 0 1 ${n(rt)},${n(rt)}` : '') +
    ` v${n(h - rt - rb)}` +
    (rb ? ` a${n(rb)},${n(rb)} 0 0 1 ${n(-rb)},${n(rb)}` : '') +
    ` h${n(-(w - rb * 2))}` +
    (rb ? ` a${n(rb)},${n(rb)} 0 0 1 ${n(-rb)},${n(-rb)}` : '') +
    ' z';
}

function stackedBarChart(days, diffs) {
  const W = 420, H = 210, L = 30, R = 6, T = 10, B = 40;
  const maxTotal = Math.max(1, ...days.map(d => d.total));
  const bw = (W - L - R) / days.length;
  const ys = v => T + (H - T - B) * (1 - v / maxTotal);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  const gridStep = maxTotal > 20 ? 10 : maxTotal > 8 ? 5 : 2;
  for (let g = gridStep; g <= maxTotal; g += gridStep) {
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="#e3e7f0"/><text x="${L - 5}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g}</text>`;
  }
  days.forEach((d, i) => {
    let acc = 0;
    const x = L + i * bw + bw * 0.15;
    // 積み上げの内側の境目は直角のまま、棒全体の上端と下端だけ丸める(下から順に描く)
    const segs = diffs.map(df => ({ df, c: d.counts[df.key] || 0 })).filter(v => v.c);
    segs.forEach((v, si) => {
      const y1 = ys(acc + v.c), y0 = ys(acc);
      const rTop = si === segs.length - 1 ? 2 : 0, rBot = si === 0 ? 2 : 0;
      s += `<path d="${barPath(x, y1, bw * 0.7, y0 - y1, rTop, rBot)}" fill="${diffColor(v.df.key)}"><title>${d.day} ${v.df.label}: ${v.c}件</title></path>`;
      acc += v.c;
    });
    // 週表示(7本以下)は全日ラベル、月表示は定規式(5日刻み)
    if (days.length <= 7 || isDateTick(d.day)) {
      s += `<text x="${x + bw * 0.35}" y="${H - 22}" font-size="11" fill="#8a93a5" text-anchor="middle">${dateTickLabel(d.day)}</text>`;
      s += `<text x="${x + bw * 0.35}" y="${H - 8}" font-size="11" fill="#b7bfce" text-anchor="middle">${weekdayTick(d.day)}</text>`;
    }
  });
  s += `</svg>`;
  return s;
}

function durationLinesChart(days, diffs) {
  const W = 420, H = 210, L = 34, R = 10, T = 10, B = 40; // 日付+曜日の2段ラベルぶんの下余白
  const allMin = days.flatMap(d => Object.values(d.avgDur)).map(v => v / 60);
  if (!allMin.length) return '<p class="muted">データがありません。</p>';
  const yMax = Math.max(...allMin) * 1.15;
  const xs = i => L + (W - L - R) * (days.length === 1 ? 0.5 : i / (days.length - 1));
  // 30分までは通常の間隔、30分超(外れ値域)は半分の間隔に圧縮して描く
  const base = H - T - B;
  let ys;
  if (yMax > 30) {
    const p = base / (30 + (yMax - 30) / 2);
    ys = v => T + base - (v <= 30 ? v * p : 30 * p + (v - 30) * p / 2);
  } else {
    ys = v => T + base * (1 - v / yMax);
  }
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  const gridStep = yMax > 16 ? 10 : 5;
  for (let g = gridStep; g <= yMax; g += gridStep) {
    const dash = g > 30 ? ' stroke-dasharray="4 4"' : '';  // 圧縮域は破線で区別
    s += `<line class="grid" x1="${L}" y1="${ys(g)}" x2="${W - R}" y2="${ys(g)}" stroke="#e3e7f0"${dash}/><text x="${L - 5}" y="${ys(g) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">${g}</text>`;
  }
  // 難易度色の点のみ(線では繋がない=ユーザー指定)
  for (const df of diffs) {
    const pts = days.map((d, i) => ({ i, v: d.avgDur[df.key] })).filter(p => p.v != null);
    s += pts.map(p => `<circle cx="${xs(p.i)}" cy="${ys(p.v / 60)}" r="3.5" fill="${diffColor(df.key)}"><title>${days[p.i].day} ${df.label}: ${fmtDur(p.v)}</title></circle>`).join('');
  }
  s += dayAxisLabels(days, xs, W, H, L, R);
  s += `</svg>`;
  return s;
}

// 集中度の色スケール: 難易度ボタンの3色に完全対応させる(ユーザー指定):
//   低調0.6=難の赤(#ff5a6e)/ 普段どおり1.0=普通の青(#3fa9f5)/ 好調1.4=易の緑(#3ec757)。
// 中央が有彩色なので、中間は色相を滑らかに回して繋ぐ(赤→マゼンタ→紫→青→シアン→ティール→緑)。
// 作画資料の教え(彩度80%超を乱用しない・少しずつ色をずらす)に沿い、中間の彩度は55〜75%に抑え、
// 明度はほぼ一定(51〜68%)に保って「濁り」と「白飛び」を避ける
const HEAT_STOPS = [
  [0.000, [255, 90, 110]],  // 0.6  難の赤 #ff5a6e = hsl(353,100%,68%)
  [0.125, [233, 103, 199]], //      マゼンタ hsl(316,75%,66%)
  [0.250, [181, 104, 223]], //      紫 hsl(279,65%,64%)
  [0.375, [95, 90, 231]],   //      青紫 hsl(242,75%,63%)
  [0.500, [63, 169, 245]],  // 1.0  普通の青 #3fa9f5 = hsl(205,90%,60%)
  [0.625, [54, 209, 226]],  //      シアン hsl(186,75%,55%)
  [0.750, [53, 212, 180]],  //      ティール hsl(168,65%,52%)
  [0.875, [58, 203, 128]],  //      青緑 hsl(149,58%,51%)
  [1.000, [62, 199, 87]],   // 1.4  易の緑 #3ec757 = hsl(131,55%,51%)
];

function heatColor(v) {
  if (v == null) return 'var(--gauge-track)'; // ライト/ダーク両対応の「データなし」色(中央が青になったので有彩マスと紛れない)
  const t = Math.max(0, Math.min(1, (v - 0.6) / 0.8)); // 0.6〜1.4 を 0〜1 に
  let i = 1;
  while (i < HEAT_STOPS.length - 1 && HEAT_STOPS[i][0] < t) i++;
  const [p0, c0] = HEAT_STOPS[i - 1];
  const [p1, c1] = HEAT_STOPS[i];
  const u = (t - p0) / (p1 - p0);
  const c = c0.map((a, k) => Math.round(a + (c1[k] - a) * u));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// SVG描画(CSSグリッドは端数ピクセルの丸めで列幅が不揃いに見えるため)
function heatmapHtml(heat) {
  const rows = ['日', '月', '火', '水', '木', '金', '土'];
  const L = 20, T = 16, R = 2, ch = 17, gap = 2;
  const W = 420, H = T + 7 * ch;
  const cw = (W - L - R) / 24;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="heatmap-svg">`;
  for (let h = 0; h < 24; h += 3) {
    s += `<text x="${L + h * cw + (cw - gap) / 2}" y="${T - 5}" font-size="9" fill="#8a93a5" text-anchor="middle">${h}</text>`;
  }
  for (let w = 0; w < 7; w++) {
    const y = T + w * ch;
    s += `<text x="${L - 6}" y="${y + ch / 2 + 3}" font-size="9" fill="#8a93a5" text-anchor="end">${rows[w]}</text>`;
    for (let h = 0; h < 24; h++) {
      const v = heat[w][h];
      s += `<rect x="${(L + h * cw).toFixed(2)}" y="${y}" width="${(cw - gap).toFixed(2)}" height="${ch - gap}" rx="2.5" fill="${heatColor(v)}"><title>${rows[w]}曜 ${h}時: ${v ?? 'データなし'}</title></rect>`;
    }
  }
  s += `</svg>`;
  return s;
}

function breaksScatter(sessions) {
  const W = 420, H = 210, L = 34, R = 10, T = 14, B = 32;
  const xMax = Math.max(3, ...sessions.map(d => d.breaks)) + 0.5;
  const vals = sessions.map(d => d.avgIndex);
  const yMax = Math.max(1.4, ...vals) * 1.1;
  const xs = v => L + (W - L - R) * v / xMax;
  const ys = v => T + (H - T - B) * (1 - v / yMax);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  s += `<line class="grid" x1="${L}" y1="${ys(1)}" x2="${W - R}" y2="${ys(1)}" stroke="#b9c4dd"/><text x="${L - 5}" y="${ys(1) + 4}" font-size="11" fill="#8a93a5" text-anchor="end">1.0</text>`;
  // 単位は各目盛りに付ける(右端の説明ラベルは目盛りと重なるため廃止。他の散布図と同じ方式)
  for (let b = 0; b <= Math.floor(xMax); b++) {
    s += `<text x="${xs(b)}" y="${H - 10}" font-size="11" fill="#8a93a5" text-anchor="middle">${b}回</text>`;
  }
  // 点=1勤務。テーマの白/黒一色(集中度は縦位置で読む。日別の棒グラフと同じルール、ユーザー指定)
  s += sessions.map(d => `<circle cx="${xs(d.breaks)}" cy="${ys(d.avgIndex)}" r="6" fill="var(--text)" opacity=".85"><title>${d.day} ${fmtTime(d.start)}〜${fmtTime(d.end)}: 休憩${d.breaks}回 / 集中度${d.avgIndex}</title></circle>`).join('');
  s += `</svg>`;
  return s;
}

// ================= 設定 =================

async function loadSettingsForm() {
  const s = await api('/api/settings');
  const wrap = $('#setDiffList');
  wrap.innerHTML = '';
  s.difficulties.forEach(d => wrap.appendChild(diffSettingRow(d)));
  $('#setFixedMin').value = s.alertFixedMin;
  $('#setThreshold').value = s.fatigueThreshold;
  $('#setPer10').value = s.fatiguePer10Min;
  $('#setSnooze').value = s.snoozeMin;
  $('#setForgetMin').value = s.forgetMin;
  $('#setSleepPrompt').value = String(s.sleepPromptHour ?? 0);
  $('#setMaWindow').value = s.maWindow;
  $('#setMinSamples').value = s.minSamples;

  const charSel = $('#setCharSet');
  charSel.innerHTML = '';
  const daily = document.createElement('option');
  daily.value = DAILY_SET;
  daily.textContent = '🎲 日替わりランダム';
  if (s.characterSet === DAILY_SET) daily.selected = true;
  charSel.appendChild(daily);
  for (const name of Object.keys(charSets)) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    if (name === s.characterSet) o.selected = true;
    charSel.appendChild(o);
  }
  renderCharPreview();

  // 背景の選択肢(assets/bg/ のファイル一覧)
  try {
    const bg = await api('/api/backgrounds');
    const bgSel = $('#setStageBg');
    bgSel.innerHTML = '';
    for (const [v, label] of [['auto', '🕐 時間帯で自動・平日'], ['auto_holiday', '🚙 時間帯で自動・休日']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if (bg.current === v) o.selected = true;
      bgSel.appendChild(o);
    }
    for (const f of bg.files) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f;
      if (f === bg.current) o.selected = true;
      bgSel.appendChild(o);
    }
    renderBgPreview();
  } catch {}

  loadBackupList();
}

// 復元候補のバックアップ一覧(新しい順)
async function loadBackupList() {
  const sel = $('#restoreSelect');
  try {
    const r = await api('/api/backups');
    sel.innerHTML = '';
    if (!r.backups.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'バックアップはまだありません';
      sel.appendChild(o);
      return;
    }
    for (const b of r.backups) {
      const m = b.file.match(/^focus-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
      const o = document.createElement('option');
      o.value = b.file;
      o.textContent = m
        ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}(${Math.round(b.size / 1024)} KB)`
        : b.file;
      sel.appendChild(o);
    }
  } catch {
    sel.innerHTML = '<option value="">一覧の取得に失敗しました</option>';
  }
}

function renderBgPreview() {
  const v = $('#setStageBg').value;
  $('#bgPreview').innerHTML = (v === 'auto' || v === 'auto_holiday')
    ? '<p class="muted">朝・昼・夕・夜に画像が自動的に切り替わります。</p>'
    : `<figure><img src="/assets/bg/${encodeURIComponent(v)}" alt="" style="height:110px;border-radius:8px"><figcaption>${esc(v)}</figcaption></figure>`;
}

// 背景も選んだ瞬間に保存して即反映
$('#setStageBg').addEventListener('change', async () => {
  renderBgPreview();
  try {
    await api('/api/settings', { method: 'PUT', body: { stageBg: $('#setStageBg').value } });
    await refreshStatus(); // applyStatus経由でupdateBackground()が走る
    showToast($('#saveToast'), '背景を変更しました');
  } catch (e) { showToast($('#saveToast'), e.message, false); }
});

function diffSettingRow(d) {
  const row = document.createElement('div');
  row.className = 'diff-setting-row';
  row.dataset.key = d.key;
  row.innerHTML = `
    <input type="text" class="ds-label" value="${esc(d.label)}" placeholder="ラベル">
    <label class="muted">疲労度加算 <input type="number" class="ds-score" value="${d.score}" min="0"></label>
    <button class="rec-del" title="削除">🗑</button>`;
  const delBtn = row.querySelector('.rec-del');
  delBtn.addEventListener('click', () => {
    if ($('#setDiffList').children.length <= 1) {
      return showToast($('#saveToast'), '難易度は最低1つ必要です', false);
    }
    armDelete(delBtn, () => {
      row.remove();
      saveSettingsNow(); // 2タップ確認が済んでいるのでそのまま確定
    });
  });
  return row;
}

$('#setDiffAdd').addEventListener('click', () => {
  $('#setDiffList').appendChild(diffSettingRow({ key: 'd' + Date.now(), label: '', score: 1 }));
});

// キャラクターは選んだ瞬間に保存して即反映(保存ボタン不要)
$('#setCharSet').addEventListener('change', async () => {
  renderCharPreview();
  try {
    await api('/api/settings', { method: 'PUT', body: { characterSet: $('#setCharSet').value } });
    await refreshStatus();
    updateCharacter(true);
    showToast($('#saveToast'), 'キャラクターを変更しました');
  } catch (e) { showToast($('#saveToast'), e.message, false); }
});

function renderCharPreview() {
  let name = $('#setCharSet').value;
  let note = '';
  if (name === DAILY_SET) {
    name = dailySetName();
    note = `<p class="muted">毎日ちがうキャラが選ばれます(今日は <b>${esc(name ?? 'なし')}</b>)</p>`;
  }
  const files = charSets[name] || {};
  const states = ['idle', 'happy', 'stretch', 'rest'];
  $('#charPreview').innerHTML = note + states.map(st => {
    const src = files[st]?.[0] || placeholderSvg(st);
    return `<figure><img src="${src}" alt="${st}"><figcaption>${st}</figcaption></figure>`;
  }).join('');
}

$('#backupBtn').addEventListener('click', async () => {
  const out = $('#dataToolResult');
  try {
    const r = await api('/api/backup', { method: 'POST' });
    out.textContent = `✅ バックアップを作成しました: ${r.file}(${Math.round(r.size / 1024)} KB)`;
    loadBackupList();
  } catch (e) { out.textContent = `⚠ バックアップに失敗しました: ${e.message}`; }
});

// 復元も2タップ確認(1回目で「もう一度タップで復元」、5秒以内の2回目で実行)
$('#restoreBtn').addEventListener('click', async () => {
  const btn = $('#restoreBtn');
  const out = $('#dataToolResult');
  const file = $('#restoreSelect').value;
  const idle = '⏪ このバックアップに復元';
  if (!file) { out.textContent = '復元できるバックアップがありません'; return; }

  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = 'もう一度タップで復元します';
    btn._arm = setTimeout(() => {
      delete btn.dataset.armed;
      btn.classList.remove('armed');
      btn.textContent = idle;
    }, 5000);
    return;
  }
  clearTimeout(btn._arm);
  delete btn.dataset.armed;
  btn.classList.remove('armed');
  btn.textContent = idle;

  try {
    out.textContent = '復元しています…';
    const r = await api('/api/restore', { method: 'POST', body: { file } });
    out.textContent = `✅ 復元しました(記録 ${r.inspections}件・イベント ${r.events}件)。復元前の状態は ${r.safety} に保存済み。画面を更新します…`;
    setTimeout(() => location.reload(), 1500);
  } catch (e) { out.textContent = `⚠ 復元に失敗しました: ${e.message}`; }
});

$('#healthBtn').addEventListener('click', async () => {
  const out = $('#dataToolResult');
  try {
    const r = await api('/api/health');
    const okMark = r.integrity === 'ok' ? '✅ 整合性OK' : `⚠ 整合性: ${r.integrity}`;
    const latest = r.backups.length ? `最新バックアップ ${r.backups[0]}` : 'バックアップはまだありません';
    out.textContent = `${okMark} / 記録 ${r.inspections}件・イベント ${r.events}件 / DB ${Math.round(r.dbSize / 1024)} KB / ${latest}`;
  } catch (e) { out.textContent = `⚠ 点検に失敗しました: ${e.message}`; }
});

// 設定は変更した瞬間に保存する(保存ボタンなし。押し忘れ事故を防ぐ)
async function saveSettingsNow() {
  const known = new Set((lastStatus?.settings.difficulties || []).map(d => d.key));
  const difficulties = $$('#setDiffList .diff-setting-row').map(row => ({
    key: row.dataset.key,
    label: row.querySelector('.ds-label').value.trim(),
    score: Number(row.querySelector('.ds-score').value) || 0,
  }))
    // 追加直後でラベル未入力の行は保存対象にしない(ラベルを入れた時点で保存される)
    .filter(d => d.label || known.has(d.key))
    .map(d => ({ ...d, label: d.label || '?' }));
  const body = {
    difficulties,
    alertFixedMin: Number($('#setFixedMin').value) || 50,
    fatigueThreshold: Number($('#setThreshold').value) || 15,
    fatiguePer10Min: Number($('#setPer10').value) || 0,
    snoozeMin: Number($('#setSnooze').value) || 5,
    forgetMin: Math.max(0, Number($('#setForgetMin').value) || 0),
    sleepPromptHour: Number($('#setSleepPrompt').value),
    maWindow: Number($('#setMaWindow').value) || 5,
    minSamples: Number($('#setMinSamples').value) || 5,
  };
  try {
    await api('/api/settings', { method: 'PUT', body });
    showToast($('#saveToast'), '保存しました');
    diffButtonsKey = '';
    await refreshStatus();
  } catch (e) {
    showToast($('#saveToast'), e.message, false);
  }
}

for (const sel of ['#setFixedMin', '#setThreshold', '#setPer10', '#setSnooze', '#setForgetMin',
  '#setSleepPrompt', '#setMaWindow', '#setMinSamples']) {
  $(sel).addEventListener('change', saveSettingsNow);
}
// 難易度のラベル・疲労度加算も入力確定(change)で即保存
$('#setDiffList').addEventListener('change', saveSettingsNow);

// ================= 時間帯で背景を変える =================

const BG_THEMES = {
  dawn:    ['#5a6ba8', '#b58fb8', '#f2b98c'], // 早朝 4-6時
  morning: ['#a3d9ff', '#ffe6b8', '#ffd1dc'], // 朝 6-10時
  day:     ['#8ecdff', '#b6c3ff', '#e3c9ff'], // 昼 10-16時
  evening: ['#ff9d6b', '#e88fb8', '#7d6bc4'], // 夕方 16-19時
  night:   ['#28325e', '#463f7d', '#6b5799'], // 夜 19-4時
};

// ステージ背景画像(assets/bg/*.png)。早朝は朝の画像を使う
const STAGE_BG = { dawn: 'morning', morning: 'morning', day: 'day', evening: 'evening', night: 'night' };

function updateBackground() {
  const h = new Date().getHours();
  const theme =
    h < 4 ? 'night' :
    h < 6 ? 'dawn' :
    h < 10 ? 'morning' :
    h < 16 ? 'day' :
    h < 19 ? 'evening' : 'night';
  const [a, b, c] = BG_THEMES[theme];
  const root = document.documentElement.style;
  root.setProperty('--bg1', a);
  root.setProperty('--bg2', b);
  root.setProperty('--bg3', c);
  // 手動指定(季節イベント等)があればそれを、なければ時間帯で自動(平日版/休日版=_holiday)
  const manual = lastStatus?.settings.stageBg;
  const isAuto = !manual || manual === 'auto' || manual === 'auto_holiday';
  const file = isAuto ? `${STAGE_BG[theme]}${manual === 'auto_holiday' ? '_holiday' : ''}.png` : manual;
  root.setProperty('--stage-bg', `url(/assets/bg/${encodeURIComponent(file)})`);
}

updateBackground();
setInterval(updateBackground, 5 * 60 * 1000);

// ================= 起動 =================

(async () => {
  await refreshStatus();
  await loadCharacter();
  restoreUiState(); // 開いていたタブ・折りたたみ・スクロール位置を復元(リスト取得もここから)
})();
