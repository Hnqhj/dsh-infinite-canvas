// 画布 CSS 浅色主题缺口扫描器（深底色 + 浅色文字两个维度）。
//
// 为什么需要它：改了三轮才改完，每一轮都是用户截图打回来的。
// 根因是同一件事 —— 上游 4 份画布 CSS 里有几百处硬编码深色，
// 我只能"看到一处改一处"，永远不知道还剩多少。
//
// 维度一（深底色）：看**底色类属性**里不透明且够暗的字面量。
//   · 只看 background / background-color / border / box-shadow
//     —— 文字色在浅色下本来就该深，按"暗"去扫它全是噪音。
//   · 相对亮度 < 0.30（约 #777 以下）才算，alpha 色不算（它自适应）。
//
// 维度二（浅色文字）：反过来，挑**亮**的。
//   容器一变白，写死的白字（color: #fff）就直接隐形 —— 这比深底色更隐蔽，
//   它不是一块突兀的深色，是一片"什么都没有"。判据是相对亮度 > 0.75。
//   这一维度必然有假警报（白字压在永远深色的东西上是对的），所以带白名单。
//
// 两个维度都再拿选择器去覆盖层里比对，列出"还有谁没被碰过"。
//
// 用法：node .workbuddy/verify/scan-dark-gap.mjs [--all]
//   --all  连已经被覆盖的也列出来（默认只列缺口）

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const CSS_DIR = join(ROOT, 'build/src/canvas');
const OVERLAY = join(ROOT, 'build/overlay/src/dsh-shell.css');

const SHOW_ALL = process.argv.includes('--all');

// ---- 相对亮度（sRGB，WCAG 口径）----
function relLum([r, g, b]) {
    const f = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// ---- 解析颜色字面量，拿不到就返回 null ----
function parseColor(raw) {
    const v = raw.trim();
    let m = /^#([0-9a-f]{3})$/i.exec(v);
    if (m) {
        const [a, b, c] = m[1];
        return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16), 1];
    }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
    if (m) {
        return [
            parseInt(m[1].slice(0, 2), 16),
            parseInt(m[1].slice(2, 4), 16),
            parseInt(m[1].slice(4, 6), 16),
            m[2] ? parseInt(m[2], 16) / 255 : 1,
        ];
    }
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
    if (m) {
        let a = 1;
        if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    }
    return null;
}

// ---- 剥注释，但要记录偏移，好在报错时报真实行号 ----
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.length));
}

// ---- 粗略但够用的 CSS 分块：选择器 { 声明 } ----
// 它能正确处理 @media 之类的 at-rule 吗？不能。但画布 CSS 里没有嵌套
// at-rule 包着_units（有 @keyframes，会被当成普通块跳过 —— 下面用
// 属性名有无来兜识别，无害）。
function splitRules(css) {
    const out = [];
    let i = 0;
    const n = css.length;
    while (i < n) {
        const brace = css.indexOf('{', i);
        if (brace === -1) break;
        const selEnd = css.lastIndexOf('}', brace) + 1;
        const sel = css.slice(i === 0 ? 0 : selEnd, brace).trim();
        let depth = 1;
        let j = brace + 1;
        while (j < n && depth > 0) {
            if (css[j] === '{') depth += 1;
            else if (css[j] === '}') depth -= 1;
            j += 1;
        }
        const body = css.slice(brace + 1, j - 1);
        if (sel && !sel.startsWith('@')) {
            const line = css.slice(0, brace).split('\n').length;
            out.push({ sel: sel.replace(/\s+/g, ' '), body, line });
        }
        i = j;
    }
    return out;
}

// ---- 底色类属性 ----
const BG_PROPS = /^(background|background-color|background-image)$/;
const SHADOW_PROPS = /^(box-shadow|text-shadow)$/;
const BORDER_PROPS = /^border(-top|-right|-bottom|-left)?(-color)?$/;

// ---- 第二维度：浅色**文字** ----
// 这是比深底色更隐蔽的一类：容器一变白，原本写死的浅色字就直接隐形。
// 扫它不能沿用"暗的才有问题"的思路，要反过来 —— 亮度高的才有问题。
const TEXT_PROPS = /^(color|-webkit-text-fill-color)$/;

const DARK_THRESHOLD = 0.3;
const LIGHT_THRESHOLD = 0.75;

/**
 * 把 CSS 属性归到「争夺同一处视觉」的组里，返回组名；不相干的返回 null。
 *
 * 为什么要分组而不是逐个属性比：`border: 1px solid #333` 是简写，覆盖层里
 * 写的却是 `border-color` —— 逐个比会判"覆盖层没改过 border"，误报。分组后
 * 两者同属 BORDER，正确互认。
 *
 * 反过来也不能把所有外观合成一大组：那会退化成刚才那个 bug —— 只改了描边
 * 就说"这块改过了"，深底色照样漏。
 */
function groupOf(prop) {
    if (TEXT_PROPS.test(prop)) return 'TEXT';
    if (BG_PROPS.test(prop)) return 'BG';
    if (SHADOW_PROPS.test(prop)) return 'SHADOW';
    if (BORDER_PROPS.test(prop)) return 'BORDER';
    return null;
}

// 一个声明值里可能出现多个颜色（渐变、多重阴影），全取出来。
function colorsIn(value) {
    const hits = [];
    const re = /#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
    let m;
    while ((m = re.exec(value)) !== null) hits.push(m[0]);
    return hits;
}

// ---- 覆盖层里出现过的关键选择器，收集成一个集合 ----
//
// 比对方式：从选择器里挑出**最后一个类选择器**去覆盖层原文里找。
//
// 为什么是"最后一个类选择器"而不是"最后一段"：`.canvas-page .panel-tabs b`
// 的最后一段是元素选择器 `b` —— 单字母、毫无区分度，拿它去匹配等于把
// 整份覆盖层的每个 b 都算命中，又会导致每个 `.xxx b` 都被判成"已覆盖"。
// 所以跳过纯元素段，取它前面的类名 `panel-tabs`。
/**
 * 把 `:is(A, B)` / `:where(A, B)` 展平成 N 个分支。
 *
 * 不做这一步，`:is(.canvas-menu-card, .canvas-context-menu)` 会被当成一个
 * 整体 —— 它不是 `.` 开头，于是 lastSimple 一路往左取到了祖先 `.canvas-page`，
 * 结果是：菜单卡改过了也说没改过。
 */
function expandPseudo(selText) {
    let list = [selText];
    for (let pass = 0; pass < 4; pass += 1) {
        const next = [];
        let found = false;
        for (const s of list) {
            const m = /:(?:is|where|matches|-webkit-any|-moz-any)\(([^()]*)\)/.exec(s);
            if (!m) { next.push(s); continue; }
            found = true;
            for (const part of m[1].split(',')) {
                next.push(s.slice(0, m.index) + part.trim() + s.slice(m.index + m[0].length));
            }
        }
        list = next;
        if (!found) break;
    }
    return list;
}

function lastSimple(sel) {
    const out = new Set();
    // 顺序很重要：**先**展开 :is()，**再**切逗号。
    // 反过来的话 `:is(A, B)` 内部的那个逗号会被当成选择器分隔符，切成
    // `.parent :is(A` 和 `B)` 两截 —— 前截找不到配对的右括号，展开直接失效，
    // 退化成取祖先类名。
    for (const branch of expandPseudo(sel)) {
        for (const s of branch.split(',')) {
            const toks = s.trim().split(/[\s>~+]+/).filter(Boolean);
            for (let i = toks.length - 1; i >= 0; i -= 1) {
                if (/^[.#[]/.test(toks[i])) { out.add(toks[i]); break; }
            }
        }
    }
    return [...out];
}

// View Transitions 的合成层容器：只有跑根过渡的那一瞬才存在，平时压根
// 不在渲染树里，改它没有意义也看不到。 ::view-transition-* 整族忽略。
const IGNORE_SEL = /^::view-transition/;

// 浅色文字这一维度必然有假警报：**白字本身不是问题，白字压在浅底上才是。**
// 下面这几个"底从来不会变浅"，所以它们的 #fff 是对的，改了反而坏：
//
//   .card-video-playbtn    rgba(15,15,15,.55) 的半黑圆，**盖在视频/图片缩略图上**
//                          —— 底就是媒体本身，永远是深色/不确定色，白图标才有对比。
//   .canvas-lightbox-close 全屏灯箱遮罩（teleport 到 body）上的关闭钮，`rgba(255,255,255,.1)`
//                          的圆叠在近黑遮罩上。灯箱是"黑场看图"，不该跟着画布改白。
//
// 判据：这个元素是不是**永远坐在深色/不确定色上**。是 → 白字保留。
const TEXT_IGNORE = new Set(['card-video-playbtn', 'canvas-lightbox-close']);

/**
 * 全量扫一遍，返回 { bgGaps, textGaps }（两个维度的未覆盖清单）。
 * 直接运行时走文件末尾的主入口；测试里走 `import { scanGap }`。
 */
export function scanGap() {
    const rows = [];
    const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).sort();
    const overlayRaw = stripComments(readFileSync(OVERLAY, 'utf8'));

    // 覆盖层索引：类名 -> 它**实际被改写过的属性组**。
    //
    // 为什么不能只用"类名有没有出现在覆盖层里"：实测打脸过一次 ——
    // `.panel-tabs b { background: #3a3d45 }` 的覆盖被删掉后，扫描器仍然判
    // 它"已覆盖"，只因为另一条 `:is(hr, .panel-tabs)` 的分隔线规则顺带提到
    // 了这个类名。那等于「只要在本文件里被提过一嘴就算改过」，会把大量真
    // 缺口判成已覆盖 —— 断言永远绿，但什么都拦不住。
    //
    // 所以按**属性组**匹配：背景 / 描边 / 阴影 / 文字 各算一组，覆盖层必须
    // 改过同一组才算覆盖。
    const overlayIdx = new Map();
    for (const { sel, body } of splitRules(overlayRaw)) {
        const groups = new Set();
        for (const decl of body.split(';')) {
            const c = decl.indexOf(':');
            if (c === -1) continue;
            groups.add(groupOf(decl.slice(0, c).trim()));
        }
        if (groups.size === 0) continue;
        for (const key of lastSimple(sel)) {
            const core = key.replace(/^[.#]/, '').split(/[:[(]/)[0];
            if (core.length < 3) continue;
            const bag = overlayIdx.get(core) ?? new Set();
            for (const g of groups) bag.add(g);
            overlayIdx.set(core, bag);
        }
    }

    for (const f of files) {
        const css = stripComments(readFileSync(join(CSS_DIR, f), 'utf8'));
        for (const { sel, body, line } of splitRules(css)) {
            if (IGNORE_SEL.test(sel)) continue;
            const keys = lastSimple(sel);

            for (const decl of body.split(';')) {
                const c = decl.indexOf(':');
                if (c === -1) continue;
                const prop = decl.slice(0, c).trim();
                const value = decl.slice(c + 1).trim();
                const group = groupOf(prop);
                if (group === null) continue;

                // 覆盖层里必须对**同一组属性**写过再说。
                const covered = keys.some((k) => {
                    const core = k.replace(/^[.#]/, '').split(/[:[(]/)[0];
                    if (core.length < 3) return false;
                    return (overlayIdx.get(core) ?? new Set()).has(group);
                });

                const isBg = BG_PROPS.test(prop) || SHADOW_PROPS.test(prop) || BORDER_PROPS.test(prop);
                const isText = TEXT_PROPS.test(prop);
                if (!isBg && !isText) continue;

                for (const lit of colorsIn(value)) {
                    const col = parseColor(lit);
                    if (col === null) continue;
                    const [r, g, b, a] = col;
                    if (a < 0.95) continue;           // alpha 色不算，它在任意底上都自适应
                    const lum = relLum([r, g, b]);
                    // 底色挑暗的，文字挑亮的 —— 方向相反，别写反了。
                    if (isBg && lum >= DARK_THRESHOLD) continue;
                    if (isText && lum <= LIGHT_THRESHOLD) continue;
                    if (isText && keys.some((k) => TEXT_IGNORE.has(k.replace(/^[.#]/, '')))) continue;
                    rows.push({ file: f, line, sel, prop, lit, covered, kind: isBg ? 'bg' : 'text' });
                }
            }
        }
    }

    return {
        files,
        rows,
        bgRows: rows.filter((r) => r.kind === 'bg'),
        textRows: rows.filter((r) => r.kind === 'text'),
        bgGaps: rows.filter((r) => r.kind === 'bg' && !r.covered),
        textGaps: rows.filter((r) => r.kind === 'text' && !r.covered),
    };
}

// ── 主入口 ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { files, bgRows, textRows, bgGaps, textGaps } = scanGap();
    console.log('=== 画布 CSS 浅色主题缺口扫描 ===\n');
    console.log(`扫了 ${files.length} 份文件：${files.join(', ')}\n`);
    report('深底色（不透明且相对亮度 < 0.30）', bgRows, bgGaps);
    report('浅色文字（不透明且相对亮度 > 0.75，白底上会隐形）', textRows, textGaps);

    if (SHOW_ALL) {
        for (const r of bgRows.concat(textRows).filter((x) => x.covered)) {
            console.log(`  ${r.file}  ${r.kind}  ${r.prop}: ${r.lit.padEnd(22)} ${r.sel}`);
        }
        console.log('');
    }
}

function report(title, all, gaps) {
    console.log(`--- ${title} ---`);
    console.log(`共 ${all.length} 处，已覆盖 ${all.length - gaps.length} 处，缺口 ${gaps.length} 处`);
    if (gaps.length === 0) {
        console.log('没有缺口。\n');
        return;
    }
    const byFile = new Map();
    for (const r of gaps) {
        if (!byFile.has(r.file)) byFile.set(r.file, []);
        byFile.get(r.file).push(r);
    }
    for (const [file, list] of byFile) {
        console.log(`\n  ${file}  ${list.length} 处`);
        const seen = new Set();   // 同一选择器重复出现只报一行，避免刷屏
        for (const r of list) {
            const key = r.sel + '|' + r.prop;
            if (seen.has(key)) continue;
            seen.add(key);
            console.log(`    ${r.prop}: ${r.lit.padEnd(22)} ${r.sel}`);
        }
    }
    console.log('');
}

