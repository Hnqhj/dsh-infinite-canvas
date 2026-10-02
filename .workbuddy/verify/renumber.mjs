/**
 * 按「主题相邻」重排技能里 §3 的小节，并把编号归到连续。
 *
 * 起因：多轮追加时把新小节插在了中间，导致顺序乱（讲浅色化的排在讲 token 两层
 * 前面）且编号跳号。编号与顺序乱会让「看目录找东西」失效。
 *
 * 只搬整段（标题行到下一个标题之前）并改标题里的数字，**正文一个字不动**。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'C:/Users/Administrator/.workbuddy/skills/dsh-client-plugin-surfaces/SKILL.md';
const lines = readFileSync(FILE, 'utf8').split('\n');

// 收集所有 `### 3.x` 标题的位置
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
    const m = /^### (3\.\d+)\s/.exec(lines[i]);
    if (m !== null) starts.push({ at: i, num: m[1] });
}

// 段 = 标题行到下一个 `###`（或 `##`）之前
const segs = starts.map((s, k) => ({
    num: s.num,
    body: lines.slice(s.at, k + 1 < starts.length ? starts[k + 1].at : lines.length),
}));

// 期望顺序：机制 → token 两层 → 浅色化 → 断点 → CDP → 验证 → 构建
const ORDER = [
    '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8',
    '3.12', '3.9', '3.10', '3.11', '3.13', '3.14',
];

const byNum = new Map(segs.map((s) => [s.num, s]));
const missing = ORDER.filter((n) => !byNum.has(n));
if (missing.length > 0) {
    console.error('✗ 这些编号不存在：', missing.join(', '));
    console.error('  实际存在：', [...byNum.keys()].join(', '));
    process.exit(1);
}
const extra = segs.filter((s) => !ORDER.includes(s.num));
if (extra.length > 0) {
    console.error('✗ 有未列入 ORDER 的小节：', extra.map((s) => `${s.num} → ${s.body[0]}`).join(' | '));
    process.exit(1);
}

const out = [];
ORDER.forEach((n, k) => {
    const seg = byNum.get(n);
    seg.body[0] = seg.body[0].replace(/^### 3\.\d+/, `### 3.${k + 1}`);
    out.push(...seg.body);
});

writeFileSync(FILE, out.join('\n'), 'utf8');
console.log('✓ §3 已按主题重排并重新编号：');
ORDER.forEach((n, k) => {
    const title = byNum.get(n).body[0].replace(/^### 3\.\d+\s*/, '');
    console.log(`  3.${k + 1}  ${title.slice(0, 48)}`);
});
