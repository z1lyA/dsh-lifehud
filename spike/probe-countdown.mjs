/**
 * 倒计时链路自检（v1.1.6）。不碰真网络、不弹真通知、不写真实 dataDir。
 *
 * 覆盖：状态机（开始/暂停/继续/取消/到点）、24h 上限、落盘与"重启后读回"、
 *       「离开期间到点」的补偿通知、通知只发一次、结束后可再来一次。
 *
 * Run: node spike/probe-countdown.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  configureCountdown, countdownStatus, countdownStart, countdownPause, countdownResume,
  countdownCancel, setCountdownNotifier, shiftCountdownForTest, tickCountdownForTest,
  resetCountdownForTest, disposeCountdown, COUNTDOWN_MAX_MS,
} from '../plugin/index.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'lifehud-cd-'));
const cfg = { dataDir: workDir };
const storeFile = join(workDir, 'countdown.json');

/** 捕获通知：不弹真 toast。 */
const toasts = [];
setCountdownNotifier((title, body) => toasts.push({ title, body }));

const near = (a, b, tol = 1500) => Math.abs(Number(a) - Number(b)) <= tol;

try {
  /* ---------------------------------------------------------------- 1. 初始 */
  resetCountdownForTest();
  configureCountdown(cfg);
  check('初始是 idle', countdownStatus().phase === 'idle', countdownStatus().phase);
  check('上限是 24 小时', COUNTDOWN_MAX_MS === 24 * 3600 * 1000, String(COUNTDOWN_MAX_MS));

  /* ------------------------------------------------------------ 2. 开始/计时 */
  const t0 = Date.now();
  let st = countdownStart(25 * 60000);
  check('start 后进入 running', st.phase === 'running', st.phase);
  check('totalMs = 25 分钟', st.totalMs === 25 * 60000, String(st.totalMs));
  check('endsAt ≈ 现在 + 25 分钟', near(st.endsAt, t0 + 25 * 60000, 2000), String(st.endsAt));
  check('remainingMs ≈ 25 分钟', near(st.remainingMs, 25 * 60000, 2000), String(st.remainingMs));

  /* -------------------------------------------------------------- 3. 上限/非法 */
  let threw = '';
  try { countdownStart(COUNTDOWN_MAX_MS + 1); } catch (e) { threw = e.message; }
  check('超过 24 小时被拒', /24 小时/.test(threw), threw);
  threw = '';
  try { countdownStart(0); } catch (e) { threw = e.message; }
  check('0 时长被拒', threw.length > 0, threw);

  /* ---------------------------------------------------------- 4. 暂停 / 继续 */
  disposeCountdown();
  st = countdownPause();
  check('pause 后变成 paused', st.phase === 'paused', st.phase);
  check('暂停后 endsAt 清空', st.endsAt === 0, String(st.endsAt));
  const frozen = st.remainingMs;
  check('暂停后 remaining 固化下来', frozen > 0, String(frozen));

  st = countdownResume();
  check('resume 回到 running', st.phase === 'running', st.phase);
  check('resume 后 endsAt = 现在 + 剩余', near(st.endsAt, Date.now() + frozen, 2000), String(st.endsAt));

  /* -------------------------------------------------------------- 5. 落盘 */
  check('状态已落盘', existsSync(storeFile), storeFile);
  const disk = JSON.parse(readFileSync(storeFile, 'utf8'));
  check('落盘内容 phase=running', disk.phase === 'running', disk.phase);

  /* -------------------------------------- 6. 到点：一次通知 + 变 done */
  toasts.length = 0;
  countdownStart(60000);
  shiftCountdownForTest(60000);
  st = tickCountdownForTest();
  check('到点后 phase=done', st.phase === 'done', st.phase);
  check('到点后 remaining=0', st.remainingMs === 0, String(st.remainingMs));
  check('到点发了 1 条通知', toasts.length === 1, JSON.stringify(toasts[0] ?? null));
  check('通知标题是「倒计时结束」', toasts[0]?.title === '倒计时结束', toasts[0]?.title ?? '-');
  check('通知正文带时长', /1 分钟/.test(String(toasts[0]?.body)), toasts[0]?.body ?? '-');

  // 再 tick 一次不应重复通知
  tickCountdownForTest();
  check('重复 tick 不会重复通知', toasts.length === 1, `toasts=${toasts.length}`);

  /* ---------------------------------- 7. 结束后「再来一次」 */
  const lastTotal = st.totalMs;
  st = countdownStart(lastTotal);
  check('再来一次：用同样时长重新跑', st.phase === 'running' && st.totalMs === lastTotal, `${st.phase}/${st.totalMs}`);

  /* ------------------------------- 8. 重启后读回（模拟进程重启） */
  toasts.length = 0;
  resetCountdownForTest();
  configureCountdown(cfg);
  st = countdownStatus();
  check('重启后状态从磁盘读回', st.phase === 'running', st.phase);
  check('重启不会误发通知', toasts.length === 0, `toasts=${toasts.length}`);

  /* --------------------------- 9. 离开期间到点：启动时补一条说明 */
  toasts.length = 0;
  countdownCancel();
  resetCountdownForTest();
  writeFileSync(storeFile, JSON.stringify({
    phase: 'running',
    totalMs: 5 * 60000,
    endsAt: Date.now() - 10 * 60000,
    remainingMs: 5 * 60000,
    startedAt: Date.now() - 15 * 60000,
    finishedAt: 0,
    notified: false,
    updatedAt: Date.now() - 15 * 60000,
  }), 'utf8');
  configureCountdown(cfg);
  st = countdownStatus();
  check('离开期间到点 → 启动即 done', st.phase === 'done', st.phase);
  check('补偿通知发了 1 条', toasts.length === 1, `toasts=${toasts.length}`);
  check('补偿文案提到「离开」', /离开/.test(String(toasts[0]?.body)), toasts[0]?.body ?? '-');
  check('补偿通知标题是「倒计时已结束」', toasts[0]?.title === '倒计时已结束', toasts[0]?.title ?? '-');

  /* ------------------------------------------------ 10. 取消回 idle */
  st = countdownCancel();
  check('取消后回到 idle', st.phase === 'idle', st.phase);
  check('取消后 remaining=0', st.remainingMs === 0, String(st.remainingMs));
  check('取消后落盘也是 idle', JSON.parse(readFileSync(storeFile, 'utf8')).phase === 'idle');
} finally {
  setCountdownNotifier(null);
  disposeCountdown();
  resetCountdownForTest();
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(60)}`);
console.log(`probe-countdown: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  process.exitCode = 1;
}
