/**
 * 倒计时：**单个**、以「一段时长」为单位、计时器活在 Host 侧。
 *
 * 为什么必须放在 Host：用户会切去对话（LifeHud 组件被卸载）或把窗口挂后台——
 * 纯前端计时器随之消失，到点不会有任何提醒。只有 Host 在 DSH 运行期间一直活着，
 * 才能在页面不在时也把提醒发出去（Windows 系统通知）。
 *
 * 语义（用户 2026-11-19 定稿）：
 *   - 一段时长，"25 分钟后提醒我"，点开始才走；
 *   - 只有一 个倒计时，设新的覆盖旧的；
 *   - 上限 24 小时（再长进度条就看不出变化了）；
 *   - 落盘，刷新页面 / 重启 DSH 都继续走；
 *   - 到点弹系统通知；**重启后发现是"离开期间到点"的，补一条说明**；
 *   - 结束后停在 00:00，附「X 点结束 · 再来一次」。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

/** 上限：24 小时。超过直接不让开始。 */
export const COUNTDOWN_MAX_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 1000;

/** 当前状态（持久化的形状）。phase: idle | running | paused | done */
let state = null;
let storePath = '';
/** @type {NodeJS.Timeout|null} */
let timer = null;
/** 可注入，便于探针在不弹真通知的情况下断言。 */
let notifier = null;

const now = () => Date.now();

function emptyState() {
  return { phase: 'idle', totalMs: 0, endsAt: 0, remainingMs: 0, finishedAt: 0, notified: false, updatedAt: now() };
}

/** `HH:mm`（本机时区）。 */
function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 毫秒 → `25 分钟` / `1 小时 5 分钟`（用于通知文案）。 */
function human(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分钟`;
  if (h > 0) return `${h} 小时`;
  return `${m} 分钟`;
}

function persist() {
  if (!storePath || !state) return;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(state), 'utf8');
  } catch { /* 写不进去只影响"重启后还在不在"，不影响计时 */ }
}

function load() {
  if (state) return;
  state = emptyState();
  if (!storePath) return;
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    if (raw && typeof raw.phase === 'string') state = { ...emptyState(), ...raw };
  } catch { /* 没有就是首次运行 */ }
}

/* ------------------------------------------------------------ 通知（系统 toast） */

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 用 Windows PowerShell 5.1 + WinRT 发一条系统 toast。
 * 走 `-EncodedCommand`（UTF-16LE base64）是为了彻底绕开中文/引号在命令行里的编码问题；
 * 失败一律吞掉——提醒没发出去，绝不能反过来影响计时器。
 * @param {string} title @param {string} body
 */
function toast(title, body) {
  let ps = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const xml = '<toast activationType="foreground" scenario="reminder"><visual>'
    + '<binding template="ToastGeneric">'
    + `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>`
    + '</binding></visual><audio src="ms-winsoundevent:Notification.Reminder" /></toast>';
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml(@'\n${xml}\n'@)`,
    '$n = New-Object Windows.UI.Notifications.ToastNotification $x',
    // 用 DSH 自己的 AppID：零配置，通知里显示 DeepSeek Harness
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.deepseek.dsh').Show($n)`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    child.on?.('error', () => {});
    child.unref?.();
  } catch { /* 发通知失败不影响任何状态 */ }
}

/** 探针用：替换通知实现。传 null 恢复默认。 */
export function setCountdownNotifier(fn) {
  notifier = fn;
}

function notify(title, body) {
  if (typeof notifier === 'function') {
    try { notifier(title, body); } catch { /* 探针里的假实现不许影响状态机 */ }
    return;
  }
  toast(title, body);
}

/* ---------------------------------------------------------------- 状态机 */

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureTimer() {
  if (state?.phase !== 'running') { stopTimer(); return; }
  if (timer) return;
  timer = setInterval(() => {
    if (state?.phase !== 'running') { stopTimer(); return; }
    if (now() >= Number(state.endsAt)) finish(false);
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * 结束（一次性消费）。
 * @param {boolean} duringAbsence 是否是"DSH 没运行时到点"的补偿通知
 */
function finish(duringAbsence) {
  if (!state || state.phase === 'done') return;
  const finishedAt = Number(state.endsAt) || now();
  state = { ...state, phase: 'done', finishedAt, remainingMs: 0, notified: false, updatedAt: now() };
  stopTimer();
  persist();
  if (duringAbsence) {
    notify('倒计时已结束', `${human(state.totalMs)}的倒计时在你离开时到点了（${hhmm(finishedAt)}）`);
  } else {
    notify('倒计时结束', `${human(state.totalMs)}到了`);
  }
  state = { ...state, notified: true, updatedAt: now() };
  persist();
}

/**
 * 装机时调用一次：定好落盘路径、把上次的状态读回来、必要时补通知。
 * 幂等，重复调用只重设路径。
 * @param {{dataDir?:string}} config
 */
export function configureCountdown(config = {}) {
  const dir = String(config.dataDir ?? '') || join(process.env.USERPROFILE ?? '', '.dsh', 'lifehud');
  storePath = join(dir, 'countdown.json');
  load();
  // 离开期间到点：补一条说明，然后停在这里等用户「再来一次」/「取消」
  if (state.phase === 'running' && now() >= Number(state.endsAt)) {
    finish(true);
  } else {
    ensureTimer();
  }
  return countdownStatus();
}

/**
 * 给页面/接口看的状态。running 时 `remainingMs` 按当前时刻算，别信落盘里的旧值。
 */
export function countdownStatus() {
  load();
  const serverNow = now();
  let remainingMs = Number(state.remainingMs) || 0;
  if (state.phase === 'running') remainingMs = Math.max(0, Number(state.endsAt) - serverNow);
  if (state.phase === 'idle') remainingMs = 0;
  return {
    phase: state.phase,
    totalMs: Number(state.totalMs) || 0,
    remainingMs,
    endsAt: Number(state.endsAt) || 0,
    finishedAt: Number(state.finishedAt) || 0,
    maxMs: COUNTDOWN_MAX_MS,
    serverNow,
  };
}

/**
 * 开始（覆盖当前这 一个）。
 * @param {number} ms 时长；非法或超过上限则抛错，由路由返回 400
 * @returns {object} 新状态
 */
export function countdownStart(ms) {
  load();
  const duration = Math.round(Number(ms));
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('时长必须是正数');
  if (duration > COUNTDOWN_MAX_MS) throw new Error('时长不能超过 24 小时');
  const startedAt = now();
  state = {
    phase: 'running',
    totalMs: duration,
    endsAt: startedAt + duration,
    remainingMs: duration,
    startedAt,
    finishedAt: 0,
    notified: false,
    updatedAt: startedAt,
  };
  persist();
  ensureTimer();
  return countdownStatus();
}

/** 暂停：把剩余时间固化下来，页面刷新后也停在同一个数。 */
export function countdownPause() {
  load();
  if (state.phase !== 'running') return countdownStatus();
  const remainingMs = Math.max(0, Number(state.endsAt) - now());
  state = { ...state, phase: 'paused', remainingMs, endsAt: 0, updatedAt: now() };
  stopTimer();
  persist();
  return countdownStatus();
}

/** 继续：从现在起再走剩下的时间。 */
export function countdownResume() {
  load();
  if (state.phase !== 'paused') return countdownStatus();
  const remainingMs = Math.max(0, Number(state.remainingMs));
  if (remainingMs <= 0) { finish(false); return countdownStatus(); }
  state = { ...state, phase: 'running', endsAt: now() + remainingMs, updatedAt: now() };
  persist();
  ensureTimer();
  return countdownStatus();
}

/** 取消：回到待设置，清掉一切残留。 */
export function countdownCancel() {
  load();
  stopTimer();
  state = emptyState();
  persist();
  return countdownStatus();
}

/** 进程退出时收掉定时器（disposer 里调）。 */
export function disposeCountdown() {
  stopTimer();
}

/** 探针：模拟"进程重启"——清空内存态，下次 configure 会重新从磁盘读。 */
export function resetCountdownForTest() {
  stopTimer();
  state = null;
  storePath = '';
}

/** 探针：把状态机的时间基准拨动 `ms`（只改 endsAt/remainingMs，不碰真实时钟）。 */export function shiftCountdownForTest(ms) {
  load();
  if (state.phase === 'running') state = { ...state, endsAt: Number(state.endsAt) - ms };
  else if (state.phase === 'paused') state = { ...state, remainingMs: Math.max(0, Number(state.remainingMs) - ms) };
  persist();
  return countdownStatus();
}

/** 探针：直接驱动一次 tick 判定（不依赖真实 1 秒定时器）。 */
export function tickCountdownForTest() {
  load();
  if (state.phase === 'running' && now() >= Number(state.endsAt)) finish(false);
  return countdownStatus();
}
