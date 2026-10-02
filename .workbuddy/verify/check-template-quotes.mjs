/**
 * 静态检查：模板字符串**内部**的注释里有没有会提前闭合它的引号。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────────────
 * 写 CDP 探针时，页面代码是放在 JS 模板字符串里的（再 `Runtime.evaluate` 送进去）。
 * 这时模板字符串内部**任何**未转义的引号都会提前闭合外层模板：
 *   · `"`  →  闭合外层反引号模板 → Node 侧 SyntaxError，报错指向注释那行
 *   · `'`  →  同上（当外层被 `\'` 转义过一轮时，内层单引号会失衡）
 *   · 反引号 →  同上
 *
 * 实测在写 `scan-whole-page.mjs` 时**连续踩了三次**：
 *   ① 注释里写 `[aria-expanded="true"]`
 *   ② `el.matches(':hover')` 的单引号
 *   ③ 注释里写 `` `#4176e6` `` 的反引号
 * 三次的报错都指向「注释那一行」，非常误导 —— 第一次甚至怀疑是页面代码的问题。
 *
 * 所以这个脚本做**纯文本层面**的检查：找出模板字符串的起止范围，
 * 只在范围内扫注释行。它不需要跑页面，毫秒级，可以挂进测试。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = [resolve(ROOT, '.workbuddy/verify'), resolve(ROOT, 'build/tools'), resolve(ROOT, 'tools')];

/** 扫一遍文本，返回「模板字符串内部 + 注释行 + 含引号」的可疑行。 */
export function scanTemplateCommentQuotes(src) {
    const lines = src.split('\n');
    /** @type {boolean[]} 每行是否在某个反引号模板内部（粗略：数未转义反引号的奇偶） */
    const inTemplate = new Array(lines.length).fill(false);
    let tick = false;
    for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i];
        // 去掉行内注释外的部分，只数「代码里」的反引号
        const code = l.replace(/\\./g, '');
        const ticks = (code.match(/`/g) ?? []).length;
        inTemplate[i] = tick;
        if (ticks % 2 === 1) tick = !tick;
    }

    const bad = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!inTemplate[i]) continue;
        const t = lines[i].trim();
        const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
        if (!isComment) continue;
        // ⚠️ 必须**先剥掉转义**再判引号 —— 形如「反斜杠 + 反引号」的写法是
        //    正确���法。不剥就会把已转义的注释误报成隐患（实测误报过一次，
        //    差点去改本来正确的代码）。
        //
        //    注意本注释里刻意不写任何引号字符：这个文件自己也可能
        //    被别处当模板处理，保持「无引号」最省事。
        const bare = t.replace(/\\[`"']/g, '');
        const hasQuote = /`/.test(bare) || /"/.test(bare) || /(?<!\\)'(?![^']*')/.test(bare);
        if (hasQuote) bad.push({ line: i + 1, text: t.slice(0, 88) });
    }
    return bad;
}

let total = 0;
const files = [];
for (const d of DIRS) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
        if (!n.endsWith('.mjs') && !n.endsWith('.js')) continue;
        const p = join(d, n);
        if (statSync(p).size > 400_000) continue;
        files.push(p);
    }
}

for (const f of files) {
    const bad = scanTemplateCommentQuotes(readFileSync(f, 'utf8'));
    if (!bad.length) continue;
    total += bad.length;
    console.log(`\n✗ ${f.replace(ROOT, '.')}`);
    for (const b of bad) console.log(`   ${b.line}: ${b.text}`);
}

if (total === 0) {
    console.log(`✅ ${files.length} 个脚本：模板字符串内的注释里没有未转义的引号`);
} else {
    console.log(`\n共 ${total} 处可疑 —— 这些注释在模板字符串内，会提前闭合外层模板`);
    process.exitCode = 1;
}
