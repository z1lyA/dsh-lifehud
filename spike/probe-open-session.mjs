// Probe DSH asar for the client-side "open session" API used by the native sidebar.
// Read-only: writes only into spike/tmp/.
import { listFiles, extract } from '../research/evidence/asar-extract.mjs';
import fs from 'node:fs';
import path from 'node:path';

const DEST = 'spike/tmp';
fs.mkdirSync(DEST, { recursive: true });

const candidates = listFiles().filter((f) =>
  /dsh-client-ui-workspace/.test(f.path) && /\.js$/.test(f.path) && !f.unpacked,
);
console.log('candidate files:', candidates.length);
for (const f of candidates) console.log(' ', f.size, f.path);

for (const f of candidates) {
  if (f.size > 2_000_000) continue;
  const dest = path.join(DEST, f.path.replace(/[\\/]/g, '__'));
  try {
    extract(f.path, dest);
    const text = fs.readFileSync(dest, 'utf8');
    const hits = [...text.matchAll(/.{0,160}openSession.{0,160}/g)].slice(0, 6);
    if (hits.length) {
      console.log(`\n===== ${f.path} =====`);
      for (const m of hits) console.log(m[0].replace(/\n/g, ' '));
    }
  } catch (e) {
    console.log('FAIL', f.path, e.message);
  }
}
