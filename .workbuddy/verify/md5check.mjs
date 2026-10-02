import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.USERPROFILE;
const prof = join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-infinite-canvas');
const h = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

const pairs = [
  ['D:/dsh-infinite-canvas/client.js', join(prof, 'client.js')],
  ['D:/dsh-infinite-canvas/index.js', join(prof, 'index.js')],
  ['D:/dsh-infinite-canvas/lib/embed/index.html', join(prof, 'lib', 'embed', 'index.html')],
];

let bad = 0;
for (const [a, b] of pairs) {
  const ok = existsSync(b) && h(a) === h(b);
  if (!ok) bad += 1;
  const size = existsSync(b) ? statSync(b).size : 0;
  const shortPath = b.replace(home, '~');
  console.log((ok ? 'OK   ' : 'DIFF ') + a.split('/').slice(-2).join('/') + '  ->  ' + shortPath + '  [' + size + ' B]');
}
console.log(bad === 0 ? '\n全部一致' : '\n' + bad + ' 处不一致');
