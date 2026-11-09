// Probe: how big/slow is an 84-day window-events pull from ActivityWatch?
const BASE = 'http://127.0.0.1:5600';
const b = await (await fetch(`${BASE}/api/0/buckets/`)).json();
const ids = Object.keys(b);
const winId = ids.find((i) => i.startsWith('aw-watcher-window_'));
const afkId = ids.find((i) => i.startsWith('aw-watcher-afk_'));
const end = new Date();
const start = new Date(end.getTime() - 84 * 86400 * 1000);
const iso = (d) => d.toISOString().slice(0, 19);
const q = `?start=${iso(start)}&end=${iso(end)}&limit=200000`;

for (const [label, id] of [['window', winId], ['afk', afkId]]) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/0/buckets/${encodeURIComponent(id)}/events${q}`);
  const text = await res.text();
  const ms = Date.now() - t0;
  const arr = JSON.parse(text);
  console.log(`${label}: ${arr.length} events, ${(text.length / 1024 / 1024).toFixed(2)} MB, ${ms} ms, status=${res.status}`);
}
