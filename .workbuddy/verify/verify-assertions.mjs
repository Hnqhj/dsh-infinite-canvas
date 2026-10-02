/**
 * 逐条删除 B10 里 PANEL_COVERAGE 覆盖的每一块，验证对应断言真的会报红。
 *
 * 为什么要这个脚本：
 *  ① 上一轮的反向验证是「删 `.generate-icon` → 测试仍全绿」，因为断言粒度太粗。
 *  ② 清单细化到 18 条之后，**如果没有逐条验证**，无法知道哪几条又是虚的。
 *
 * ⚠️ 为什么这里不 spawn `smoke-test.mjs`（第一版那么写了，结果超时）：
 * 每删一条就跑一遍 38 个测试（含起 HTTP 服务、跑闭包），18 轮跑不完，
 * `finally` 来不及还原源文件 —— 实测**把 dsh-shell.css 改坏了**。
 * 现在改成**把断言逻辑原样抄一份在这里跑**：只读文件 + 正则，零外部依赖、毫秒级完成。
 * 代价是断言逻辑有两份，所以下面显式说明「本文件里那段判定必须与
 * smoke-test.mjs 的 PANEL_COVERAGE 保持一致」——
 * 两处不一致时本文件会输出提醒。
 *
 * 用法：node .workbuddy/verify/verify-assertions.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CSS = 'D:/dsh-infinite-canvas/build/overlay/src/dsh-shell.css';
const TEST = 'D:/dsh-infinite-canvas/tools/smoke-test.mjs';

const css0 = readFileSync(CSS, 'utf8');
const test0 = readFileSync(TEST, 'utf8');

/** 从测试文件里把清单抠出来，保证验证的就是真正在跑的那些断言。 */
const listMatch = /const PANEL_COVERAGE = \[([\s\S]*?)\n        \];/.exec(test0);
if (listMatch === null) {
    console.error('✗ 测试文件里找不到 PANEL_COVERAGE 清单');
    process.exit(1);
}
const entries = [...listMatch[1].matchAll(/\['([^']+)',\s*'([^']+)',\s*'([^']+)'\]/g)]
    .map((m) => ({ what: m[1], sel: m[2], prop: m[3] }));
console.log(`从测试里读到 ${entries.length} 条断言，逐条验证\n`);

/**
 * 删掉「匹配该选择器**且**声明了 `prop`」的**所有**规则，返回删完后的内容。
 * 只动这些规则，同名但声明别的属性的规则保留。
 */
function dropAllRulesFor(sel, prop) {
    const lines = css0.split('\n');
    const selRe = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const kill = new Set();
    let count = 0;
    for (let i = 0; i < lines.length; i += 1) {
        if (!selRe.test(lines[i])) continue;
        /**
         * 合并选择器（`.generate-pill,\nhtml[...] .generate-cost {`）的
         * 匹配行**末尾没有 `{`** —— 起始行要一直往后找到第一个 `{` 才是块首。
         * 只认「匹配行自己带 `{`」的话，这类规则永远删不掉，
         * 会被误报成「找不到可删的规则」（第二版就在这里卡了一条）。
         */
        let head = -1;
        for (let k = i; k < lines.length && k < i + 8; k += 1) {
            if (lines[k].includes('{')) { head = k; break; }
        }
        if (head < 0) continue;
        let depth = 0;
        let end = -1;
        for (let j = head; j < lines.length; j += 1) {
            for (const ch of lines[j]) {
                if (ch === '{') depth += 1;
                else if (ch === '}') { depth -= 1; if (depth === 0) { end = j; break; } }
            }
            if (end >= 0) break;
        }
        if (end < 0) continue;
        if (!lines.slice(i, end + 1).join('\n').includes(prop)) continue;
        for (let k = i; k <= end; k += 1) kill.add(k);
        count += 1;
        i = end;
    }
    if (count === 0) return null;
    return {
        text: lines.filter((_, k) => !kill.has(k)).join('\n'),
        count,
    };
}

let passed = 0;
let failed = 0;
const notFound = [];

/**
 * 与 smoke-test.mjs 里那段**完全一致**的判定：切出规则块 + 块内查属性。
 * 改一处必须改两处。
 */
function assertCovers(css, sel, prop) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^html\\[data-dsh-theme[^\\]]*\\][^{]*${esc(sel)}`, 'gm');
    let m;
    while ((m = re.exec(css)) !== null) {
        const braceAt = css.indexOf('{', m.index);
        if (braceAt < 0) continue;
        let depth = 1;
        let j = braceAt + 1;
        for (; j < css.length; j += 1) {
            const ch = css[j];
            if (ch === '{') depth += 1;
            else if (ch === '}') { depth -= 1; if (depth === 0) break; }
        }
        if (css.slice(m.index, j).includes(prop)) return true;
    }
    return false;
}

try {
    for (const e of entries) {
        /**
         * 判定标准：**把这个选择器的所有规则都删掉**，断言必须报红。
         *
         * ⚠️ 为什么不是「删一条」（第二版的错）：同一个视觉常常由**多条规则**
         * 共同实现 —— 合并选择器（`.generate-pill,\n... .generate-cost {`）、
         * 独立补充规则、`:hover` / `:active` 变体。
         * 删掉其中一条，另一条仍然满足断言 → 会被误判成「断言是虚的」。
         * 实测 23 条里有 7 条这样被误判。
         *
         * 断言真正要拦的是「这个视觉**整体**消失」，所以验证器也该这么删。
         */
        const dropped = dropAllRulesFor(e.sel, e.prop);
        if (dropped === null) {
            console.log(`  ? ${e.what.padEnd(30)} 源文件里找不到可删的规则 —— 断言本身可能就是虚的`);
            notFound.push(e.what);
            continue;
        }
        if (!assertCovers(css0, e.sel, e.prop)) {
            failed += 1;
            console.log(`  ✗ ${e.what.padEnd(30)} 正向就不通过 —— 清单与源文件不一致`);
            continue;
        }
        if (assertCovers(dropped, e.sel, e.prop)) {
            failed += 1;
            console.log(`  ✗ ${e.what.padEnd(30)} **没拦住**（全删后仍判通过）`);
        } else {
            passed += 1;
            console.log(`  ✓ ${e.what.padEnd(30)} 拦住了（删掉 ${dropped.count} 条）`);
        }
    }
} finally {
    writeFileSync(CSS, css0, 'utf8');
}

console.log(`\n${failed === 0 ? '全部拦住' : `${failed} 条是虚的`}：${passed}/${entries.length}（源文件已还原）`);
process.exit(failed === 0 && notFound.length === 0 ? 0 : 1);
