// Spike probe: exercise buildHud() without DSH, so the host logic can be iterated fast.
// Run: node spike/probe-hud.mjs
import { buildHud } from '../plugin/index.js';
import { NOWTREE_DB, NOWTREE_LEVELDB } from './paths.mjs';

const payload = await buildHud({
  nowtreeDb: NOWTREE_DB,
  leveldbDir: NOWTREE_LEVELDB,
  latitude: 39.9042,
  longitude: 116.4074,
  sessionLimit: 5,
});

console.log('clock   :', JSON.stringify(payload.clock));
console.log('tasks   :', payload.tasks.label, payload.tasks.range, `${payload.tasks.items.length} 条`);
for (const t of payload.tasks.items) console.log('   -', t.title, t.next ? '[NEXT]' : '');
console.log('weather :', payload.weather ? payload.weather.summary : 'null');
console.log('hourly  :', payload.weather ? payload.weather.hourly.length + ' 点' : '-');
console.log('sessions:', payload.sessions.length);
for (const s of payload.sessions) console.log('   -', s.title, '|', new Date(s.at).toLocaleString('zh-CN'));
console.log('warnings:', payload.warnings);
