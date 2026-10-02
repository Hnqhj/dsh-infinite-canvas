/**
 * 切掉 theme-bridge.mjs 里残留的旧探针块（第 231~308 行那一片）。
 *
 * 为什么需要这个脚本：手写替换时新旧两段同时留在文件里，
 * 而报错（`undefined is not valid JSON`）完全指不到「有一段是重复的」这种问题。
 * 用行号锚点做切除，比再手写一遍 80 行更不容易出错。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'D:/dsh-infinite-canvas/.workbuddy/verify/theme-bridge.mjs';
const lines = readFileSync(FILE, 'utf8').split('\n');

/** 1-based → 0-based。 */
const JOIN_LINE = 231;   // ].join("\n") + `; NAMES0.length;
const RES_LINE = 309;   // const res = await s.send('Runtime.evaluate', ...
if (!lines[JOIN_LINE - 1].includes('].join(')) {
    console.error('✗ 起始锚点不对，行内容：', lines[JOIN_LINE - 1]);
    process.exit(1);
}
if (!lines[RES_LINE - 1].includes("Runtime.evaluate")) {
    console.error('✗ 结束锚点不对，行内容：', lines[RES_LINE - 1]);
    process.exit(1);
}

const simple = [
    '    ].join(\'\\n\');',
    '    // 包成 IIFE 并把 NAMES0 作为参数传进去（页面里没有这个词）。',
    '    const probe = `(() => {\\n${probeBody}\\n})(${JSON.stringify(NAMES0)})`;',
];

const next = [
    ...lines.slice(0, JOIN_LINE - 1),
    ...simple,
    ...lines.slice(RES_LINE - 1),
];

writeFileSync(FILE, next.join('\n'), 'utf8');
console.log(`✓ 已切除 ${RES_LINE - JOIN_LINE} 行残留，旧探针与重复的发送代码都清掉了`);
