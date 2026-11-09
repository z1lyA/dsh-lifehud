// 发布前自查：扫工作树里有没有不该公开的东西（绝对路径 / Windows 用户名 / 邮箱 / 设备号 / 会话文件）。
// 用法：node spike/prepublish-check.mjs
// 退出码：0 = 干净；1 = 有命中（逐条打印文件:行）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** 只看这些后缀（其余是二进制/锁文件，没有可比对的意义）。 */
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt', '.html', '.svg', '.css']);
/** 这些目录不参与发布，不检查。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'spike/tmp', 'spike/tmp2', 'research', 'mind']);

/** 命中即 FAIL 的模式。`allow` 用来放行占位符（例如 `C:\Users\<你>\…`、`blt.3.xxxxxxxx`）。 */
const RULES = [
  { name: 'Windows 绝对路径（C:\\Users\\…）', re: /C:\\\\?Users\\\\?[^\\\s'"`]+/i, allow: /C:\\\\?Users\\\\?</i },
  { name: '任意盘的绝对路径（D:\\… / E:\\…）', re: /[D-Z]:\\\\?Users\\\\?[^\\\s'"`]+/ },
  { name: '小米设备号（blt.3.*）', re: /blt\.3\.[a-z0-9]{6,}/i, allow: /blt\.3\.([xX*]+|<)/ },
  { name: 'QQ/邮箱地址', re: /[A-Za-z0-9._%+-]+@(qq|163|126|gmail|outlook)\.com/i },
  { name: '疑似会话字段值（serviceToken 后面像真值）', re: /"serviceToken"\s*:\s*"[A-Za-z0-9+/=]{40,}"/ },
  { name: '疑似 ssecurity 值', re: /"ssecurity"\s*:\s*"[A-Za-z0-9+/=]{16,}"/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
];
/** 只在"文件存在"层面检查（内容里提到文件名是正常的）。 */
const FORBIDDEN_FILES = ['mi-session.json', 'lifehud-weight.db', 'lifehud-settings.json', 'lifehud-photo.bin'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(REPO, full).replace(/\\/g, '/');
    if ([...SKIP_DIRS].some((skip) => rel === skip || rel.startsWith(`${skip}/`))) continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) walk(full, out);
    else out.push({ full, rel });
  }
  return out;
}

const files = walk(REPO).filter((f) => f.rel !== 'spike/prepublish-check.mjs');
const hits = [];
let scanned = 0;
for (const { full, rel } of files) {
  if (!TEXT_EXT.has(extname(rel).toLowerCase())) continue;
  scanned += 1;
  let text;
  try { text = readFileSync(full, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (rule.allow && rule.allow.test(line)) continue;
      hits.push({ rel, line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) });
    }
  });
}

const fileHits = files.filter((f) => FORBIDDEN_FILES.includes(f.rel.split('/').pop()));
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
} catch { /* 不是 git 仓库也能跑 */ }
const badTracked = tracked.filter((name) => FORBIDDEN_FILES.includes(name.split('/').pop()));

console.log(`扫描 ${scanned} 个文本文件（跳过 research/ mind/ node_modules/ spike/tmp*）`);
if (badTracked.length) {
  console.log('\n❌ 这些运行时文件被 git 跟踪了，必须移出版本控制：');
  for (const name of badTracked) console.log(`   ${name}`);
}
if (fileHits.length) {
  for (const f of fileHits) console.log(`   （工作树里存在 ${f.rel}，未跟踪就没关系）`);
}
if (hits.length === 0 && badTracked.length === 0) {
  console.log('✅ 没有发现绝对路径 / 邮箱 / 设备号 / 凭据值；可以发布。');
  process.exit(0);
}
if (hits.length) {
  console.log('\n❌ 命中：');
  for (const h of hits) console.log(`  ${h.rel}:${h.line}  [${h.rule}]\n     ${h.text}`);
}
console.log(`\n共 ${hits.length} 处命中，${badTracked.length} 个不该跟踪的文件。`);
process.exit(1);
