// Probe DSH client APIs for: layout service (navigate/collapse), sidebar collapse, session running status.
import { listFiles, extract } from '../research/evidence/asar-extract.mjs';
import fs from 'node:fs';
import path from 'node:path';

const DEST = 'spike/tmp2';
fs.mkdirSync(DEST, { recursive: true });

const want = listFiles().filter((f) =>
  /dsh-client-ui-sidebar|dsh-client-layout|dsh-api-session-controller/.test(f.path)
  && /\.js$/.test(f.path) && !f.unpacked && f.size < 1_500_000,
);
console.log('files:', want.map((f) => f.path).join('\n  '));

const patterns = [
  /collapse[A-Z]\w*/g,
  /sidebar\w*[Cc]ollaps\w*/g,
  /beginNavigation/g,
  /"layout"/g,
  /isRunning|status === "running"|running:/g,
];

for (const f of want) {
  const dest = path.join(DEST, f.path.replace(/[\\/]/g, '__'));
  try {
    extract(f.path, dest);
  } catch (e) {
    console.log('FAIL', f.path, e.message);
    continue;
  }
  const text = fs.readFileSync(dest, 'utf8');
  const found = new Set();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.add(m[0]);
  }
  if (found.size) console.log(`\n=== ${f.path} ===\n  ` + [...found].slice(0, 25).join(', '));
}
