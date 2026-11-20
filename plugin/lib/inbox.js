/**
 * NowTree 收件箱录入（v1.1.8）——**LifeHud 唯一一处写别人的库**。
 *
 * 背景：任务卡右上角有个「+」，弹窗填标题/备注，直接记到 NowTree 的 Inbox。
 * 之前所有外部数据源都是只读（AGENTS §5.3），这是唯一的例外，所以约束写得死一点：
 *
 *   1. **只 INSERT 一条新记录**：不 UPDATE、不 DELETE、不碰任何已有行；
 *   2. 写入的字段与 NowTree 自己新建的 inbox 记录逐字段对齐（见 `INBOX_DEFAULTS`）；
 *   3. 表结构不对 / 库被锁 / 只读 → 抛 `InboxError`，页面拿到一句中文原因，绝不重试写；
 *   4. 打不开、写不进就什么都不做——宁可「没记上」，也不能写坏别人的库。
 *
 * NowTree 的 `transactions` 表（2026-11-20 实地读出来的口径）：
 *   - Inbox = `status='inbox'` + `category IS NULL` + `time_slot='none'`；
 *   - `created_time` 是 UTC、**9 位小数秒**、带 `+00:00` 偏移（`2026-11-20T02:01:39.097450900+00:00`），
 *     这里照抄同样的形状（毫秒后面补 0），免得它的 Rust 侧解析出岔子；
 *   - `sync_id` 是 uuid；`priority` 默认 1；`order_index` inbox 记录为 NULL。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

/** 标题/备注的长度上限（与页面弹窗的 maxLength 同一口径）。 */
export const INBOX_TITLE_MAX = 200;
export const INBOX_NOTE_MAX = 2000;

/**
 * 一条 inbox 记录的固定字段（除了 title/note/created_time/sync_id 之外都用这些）。
 * 全部与 NowTree 自己新建的记录一致，别按「我觉得合理」改。
 */
const INBOX_DEFAULTS = {
  category: null, // NULL = 还没分类（Inbox）
  status: 'inbox',
  deadlineType: 'none',
  priority: 1,
  showInNext: 0,
  timeSlot: 'none',
};

/** 带 reason 的收件箱错误：路由把它翻译成中文，页面只认 reason。 */
export class InboxError extends Error {
  /**
   * @param {'title-required'|'title-too-long'|'note-too-long'|'no-db'|'schema'|'busy'|'write'} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'InboxError';
    this.reason = reason;
  }
}

/**
 * NowTree 的时间戳形状：UTC + 9 位小数秒 + `+00:00`。
 * `toISOString()` 给的是毫秒（`…39.097Z`），这里把毫秒后面补 6 个 0 再换后缀。
 * @param {Date} [date]
 * @returns {string} e.g. `2026-11-20T02:01:39.097000000+00:00`
 */
export function nowtreeTimestamp(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 19)}${iso.slice(19, 23)}000000+00:00`;
}

/** 把 sqlite 的错误翻译成页面能读懂的一句人话。 */
function translateSqliteError(error) {
  if (error instanceof InboxError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table|no such column/i.test(message)) {
    return new InboxError('schema', `NowTree 的库结构对不上（${message}）`);
  }
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return new InboxError('busy', 'NowTree 正在写库，稍等一秒再试');
  }
  if (/readonly|SQLITE_READONLY/i.test(message)) {
    return new InboxError('write', `NowTree 的库是只读的（${message}）`);
  }
  return new InboxError('write', `写入失败：${message}`);
}

/**
 * 往 NowTree 的 Inbox 追加一条记录。
 *
 * @param {string} dbPath NowTree 的 `nowtree.sqlite`
 * @param {{title?:unknown,note?:unknown}} input 页面弹窗的两个字段
 * @returns {{id:number,title:string,note:string|null,createdTime:string}} 写进去的那条
 * @throws {InboxError} 参数不合法 / 库打不开 / 被锁 / 结构不对
 */
export function addInboxTask(dbPath, input = {}) {
  const path = String(dbPath ?? '');
  if (!path) throw new InboxError('no-db', '没配置 NowTree 的库路径');

  // 标题压成一行：NowTree 的标题是一行文本，换行/制表符会被它的列表吞掉。
  const title = String(input?.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new InboxError('title-required', '标题不能为空');
  if (title.length > INBOX_TITLE_MAX) {
    throw new InboxError('title-too-long', `标题最多 ${INBOX_TITLE_MAX} 个字`);
  }
  const rawNote = String(input?.note ?? '').trim();
  if (rawNote.length > INBOX_NOTE_MAX) {
    throw new InboxError('note-too-long', `备注最多 ${INBOX_NOTE_MAX} 个字`);
  }
  const note = rawNote ? rawNote : null;

  let db;
  try {
    // 路径不存在时 `new DatabaseSync(path)` 会**凭空造一个空库**——绝不能这样：
    // 那会在 NowTree 的目录里留一个没有表结构的假库。先确认文件真的在。
    if (!existsSync(path)) {
      throw new InboxError('no-db', `找不到 NowTree 的库：${path}`);
    }
    // 不传 readOnly：这是唯一一处真的写。库里是 rollback journal（不是 WAL），
    // 所以给自己的写事务留 3 秒等锁时间，别一撞上 NowTree 落盘就报错。
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 3000');
  } catch (error) {
    try { db?.close(); } catch { /* ignore */ }
    if (error instanceof InboxError) throw error;
    throw new InboxError('no-db', `打不开 NowTree 的库：${error instanceof Error ? error.message : String(error)}`);
  }

  const createdTime = nowtreeTimestamp();
  const syncId = randomUUID();
  try {
    db.exec('BEGIN IMMEDIATE');
    const info = db.prepare(`
      INSERT INTO transactions
        (title, note, category, status, deadline_type, priority, created_time,
         show_in_next, deleted, time_slot, sync_id, reminder_done)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
    `).run(
      title,
      note,
      INBOX_DEFAULTS.category,
      INBOX_DEFAULTS.status,
      INBOX_DEFAULTS.deadlineType,
      INBOX_DEFAULTS.priority,
      createdTime,
      INBOX_DEFAULTS.showInNext,
      INBOX_DEFAULTS.timeSlot,
      syncId,
    );
    db.exec('COMMIT');
    return { id: Number(info.lastInsertRowid), title, note, createdTime };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能压根没开起来 */ }
    throw translateSqliteError(error);
  } finally {
    try { db.close(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/**
 * 收件箱里还有多少条（只读，给任务卡底部那行「收件箱 N 条」用）。
 * 读不到就返回 null（卡片不显示这行），绝不因为计数让 /hud 挂掉。
 * @param {string} dbPath
 * @returns {number|null}
 */
export function countInboxTasks(dbPath) {
  const path = String(dbPath ?? '');
  if (!path) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const row = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE status = 'inbox' AND deleted = 0").get();
    const n = Number(row?.n);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
