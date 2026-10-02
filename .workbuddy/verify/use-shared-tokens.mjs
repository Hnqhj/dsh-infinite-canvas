/**
 * 把三个扫描脚本里的手抄 token 夹具换成 `loadDshTokens()`。
 *
 * 为什么做这个自动化：同一个「夹具漏 token → var() 断链 → 声明静默失效」
 * 的坑已经踩了两次（① 漏 static 层 ② 漏 button-contrast-fill 等 alias）。
 * 手抄 40 个 token 迟早还会漏第三次，所以统一从 app.asar 实抽。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'D:/dsh-infinite-canvas';
const targets = [
    { path: `${ROOT}/.workbuddy/verify/scan-panels.mjs`, name: 'DSH_TOKENS' },
    { path: `${ROOT}/.workbuddy/verify/ask-doodle-buttons.mjs`, name: 'TOKENS' },
    { path: `${ROOT}/.workbuddy/verify/theme-bridge.mjs`, name: 'DSH_TOKENS' },
];

for (const t of targets) {
    const src = readFileSync(t.path, 'utf8');
    const marker = `const ${t.name} = {`;
    const start = src.indexOf(marker);
    if (start < 0) { console.log(`! ${t.path} 里没找到 ${marker}，跳过`); continue; }

    // 从 marker 往上找它前面那段 JSDoc 的开头（不覆盖文档，只保证不留半个注释）。
    // 往下找与之配对的收尾 "};" —— 这两个夹具都是「对象字面量 + 顶层 } ;」，
    // 内部不含顶层 "};"，所以第一次出现就是收尾。
    const end = src.indexOf('\n};', start);
    if (end < 0) { console.log(`! ${t.path} 里找不到 ${t.name} 的收尾，跳过`); continue; }
    const endFull = end + 3;

    const replacement = [
        '/**',
        ' * DSH 官方 token 夹具 —— **从 app.asar 真身实抽，不手抄**。',
        ' *',
        ' * ⚠️ 这个夹具曾经两次漏 token，两次都是同一类静默故障：',
        ' *   ① 漏整个 static 层 → alias 层的 var() 断链 → 声明被丢弃；',
        ' *   ② 漏 button-contrast-fill / switch-thumb / state-error-primary',
        ' *      → 「完成」按钮底色变透明，扫描器报了一个查了三轮的假「对比度 1.13」。',
        ' * 详见 `dsh-tokens.mjs` 的文件头注释。',
        ' */',
        `const ${t.name} = loadDshTokens();`,
    ].join('\n');

    const out = src.slice(0, start) + replacement + src.slice(endFull);
    // 加 import（放在最后一个 import 之后）
    const lastImport = out.lastIndexOf("import ");
    const afterLine = out.indexOf('\n', lastImport) + 1;
    const withImport = out.slice(0, afterLine)
        + "import { loadDshTokens } from './dsh-tokens.mjs';\n"
        + out.slice(afterLine);
    writeFileSync(t.path, withImport, 'utf8');
    console.log(`✓ ${t.path.split('/').pop()} 换掉了手抄夹具（${src.length - withImport.length > 0 ? `省 ${src.length - withImport.length} 字节` : ''}）`);
}
