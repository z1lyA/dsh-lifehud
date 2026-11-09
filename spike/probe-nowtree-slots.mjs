// Probe: which NowTree rows does NowTree's own Next view consider, per slot?
import { DatabaseSync } from 'node:sqlite';
import { NOWTREE_DB } from './paths.mjs';

const db = new DatabaseSync(NOWTREE_DB, { readOnly: true });
const rows = db.prepare(`
  SELECT id, title, category, parent_id, show_in_next, time_slot, status, deleted
  FROM transactions WHERE deleted = 0 AND status = 'active'
`).all();

const next = rows.filter((r) => (r.category === 'next_action' && r.parent_id === null) || r.show_in_next === 1);
const by = new Map();
for (const r of next) {
  const k = r.time_slot ?? 'null';
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(r.title);
}
console.log('active rows:', rows.length, '| next-semantics rows:', next.length);
for (const [k, v] of by) console.log(' slot', k, '->', v.length, '|', v.slice(0, 6).join(' / '));

const all = new Map();
for (const r of rows) {
  const k = r.time_slot ?? 'null';
  if (!all.has(k)) all.set(k, 0);
  all.set(k, all.get(k) + 1);
}
console.log('ALL active by slot:', [...all.entries()].map(([k, n]) => `${k}=${n}`).join(', '));
db.close();
