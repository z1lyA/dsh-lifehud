// Spike S3 probe: can we read NowTree's sqlite from Node, read-only, while NowTree runs?
// Run: node spike/probe-nowtree.mjs
import { DatabaseSync } from 'node:sqlite';
import { NOWTREE_DB } from './paths.mjs';

const DB = NOWTREE_DB;

const db = new DatabaseSync(DB, { readOnly: true });

const all = db.prepare('SELECT COUNT(*) AS n FROM transactions').get();
const today = db.prepare(`
  SELECT id, title, category, status, show_in_next, time_slot, deadline_type, deadline_date
  FROM transactions
  WHERE deleted = 0 AND status = 'active' AND show_in_next = 1
  ORDER BY CASE time_slot WHEN 'morning' THEN 0 WHEN 'noon' THEN 1 WHEN 'evening' THEN 2 ELSE 3 END, order_index, id
`).all();

console.log('total rows:', all.n);
console.log('active+next:', today.length);
for (const r of today) {
  console.log(`  [${r.time_slot}] ${r.title}  (id=${r.id}, deadline=${r.deadline_type}${r.deadline_date ? ':' + r.deadline_date : ''})`);
}

// What slots actually exist among active rows (helps the card's empty-state design)
const slots = db.prepare(`
  SELECT COALESCE(time_slot, 'null') AS slot, COUNT(*) AS n
  FROM transactions WHERE deleted = 0 AND status = 'active'
  GROUP BY slot ORDER BY n DESC
`).all();
console.log('active by slot:', JSON.stringify(slots));

db.close();
console.log('OK: read-only open worked while DB file is in use by NowTree.');
