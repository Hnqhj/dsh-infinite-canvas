/**
 * 临时检查：按花括号配对切出所有 @media 块，看每块内容与 DSH 配色命中。
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('D:/dsh-infinite-canvas/build/overlay/src/dsh-shell.css', 'utf8');
const re = /@media[^{]*\{/g;
let m;
let n = 0;
while ((m = re.exec(css)) !== null) {
    n += 1;
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < css.length; j += 1) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const body = css.slice(m.index + m[0].length, j);
    const line = css.slice(0, m.index).split('\n').length;
    const hits = body.split('\n').filter((l) => /background:\s*var\(--dsw-/.test(l));
    console.log(`块 ${n} @第 ${line} 行  selector="${m[0].trim()}"  长度 ${body.length}  配色 ${hits.length}`);
    hits.forEach((l) => console.log('    →', l.trim()));
}
console.log('总块数:', n);
