// Spike probe: read NowTree's slot boundaries from the WebView2 localStorage (LevelDB).
// Key: nowtree_slot_bounds, value: {"morningStart":6,"noonStart":13,"eveningStart":18}
// Chrome/WebView2 stores localStorage values in LevelDB, UTF-16 or Latin-1 encoded.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOWTREE_LEVELDB } from './paths.mjs';

const DIR = NOWTREE_LEVELDB;
const KEY = 'nowtree_slot_bounds';

let files = [];
try {
  files = readdirSync(DIR).filter((f) => /\.(ldb|log)$/i.test(f));
} catch (error) {
  console.log('leveldb dir not readable:', error.message);
  process.exit(0);
}
console.log('files:', files.join(', '));

for (const file of files) {
  const buf = readFileSync(join(DIR, file));
  // Ascii occurrence
  const needle = Buffer.from(KEY, 'latin1');
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    const window = buf.subarray(Math.max(0, idx - 64), Math.min(buf.length, idx + 200));
    // Try utf16le decode of the window, then look for a JSON object
    const utf16 = window.toString('utf16le');
    const latin = window.toString('latin1');
    const m = (utf16 + ' ' + latin).match(/\{[^{}]*"morningStart"[^{}]*\}/);
    console.log(`\n[${file}] hit at ${idx}`);
    console.log('utf16 sample:', JSON.stringify(utf16.slice(0, 160)));
    console.log('latin sample:', JSON.stringify(latin.slice(0, 160)));
    if (m) console.log('FOUND JSON:', m[0]);
    idx = buf.indexOf(needle, idx + 1);
  }
}
