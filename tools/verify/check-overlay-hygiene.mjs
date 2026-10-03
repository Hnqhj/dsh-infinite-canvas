/**
 * 覆盖层卫生检查：找完全重复的选择器、冒用官方前缀、token 位混写 hex。
 *
 * 「整体检查代码」的一部分 —— 覆盖层已经 1300+ 行，靠人眼查重复不现实。
 * 挂进测试前先作为独立工具跑。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 扫一遍覆盖层文本，返回问题清单（供测试导入；直接运行时走下面的主入口）。 */
export function checkOverlayHygiene(cssText) {
    /** 先剥注释再查（理由见上）。 */
    const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const problems = [];

    // ① 完全重复的选择器
    const rules = [...css.matchAll(/^([^@\s/][^{]+)\{/gm)].map((m) => m[1].trim().replace(/\s+/g, ' '));
    const seen = new Map();
    for (const r of rules) seen.set(r, (seen.get(r) ?? 0) + 1);
    for (const [s, n] of seen.entries()) {
        if (n > 1) problems.push(`完全重复的选择器 ${n} 次：${s.slice(0, 110)}`);
    }

    // ② 冒用官方前缀（官方 token 表里没有 radius / danger）
    if (/var\(--dsw-radius-/.test(css)) problems.push('冒用 --dsw-radius-*（官方没有任何 radius token）');
    if (/state-danger/.test(css)) problems.push('用了不存在的 state-danger（官方是 state-error-primary）');

    // ③ token 位混写 hex（颜色位写具体值 = 跟随不了主题）
    const hexBg = css.match(/background:\s*#[0-9a-fA-F]{3,8}/g) ?? [];
    const hexBorder = css.match(/border(-color)?:\s*#[0-9a-fA-F]{3,8}/g) ?? [];
    for (const h of [...hexBg, ...hexBorder]) problems.push(`颜色位混写 hex：${h}`);

    return { problems, ruleCount: rules.length };
}

// ── 主入口：直接运行时打印报告 ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const here = dirname(fileURLToPath(import.meta.url));
    const cssPath = resolve(here, '../../build/overlay/src/dsh-shell.css');
    const raw = readFileSync(cssPath, 'utf8');
    const { problems, ruleCount } = checkOverlayHygiene(raw);
    console.log(`规则总数：${ruleCount}`);
    if (problems.length === 0) {
        console.log('✅ 卫生检查通过');
    } else {
        console.log(`❌ ${problems.length} 类问题：`);
        for (const p of problems) console.log(`  ✗ ${p}`);
        process.exitCode = 1;
    }
}
