/**
 * 实测：画布页里到底哪些元素带着 box-shadow、值是多少、命中的是哪条规则。
 *
 * 为什么不用 grep 猜：阴影可能来自
 *   ① 上游 canvas-chrome.css（为深底设计，浅色下就成了一团重影）
 *   ② editorial-redesign.css 的 `--rd-shadow-2 !important`
 *   ③ dsh-shell.css 自己的覆盖
 * 三处都能写 box-shadow，而 `!important` 会压掉 ①③。
 * 只有量 computed +枚举命中规则才能知道真实生效的是哪一条。
 *
 * 用法：node .workbuddy/verify/probe-shadow.mjs [--narrow]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe';
const BASE = 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-theme-profile');

const NARROW = process.argv.includes('--narrow');
const VIEWPORT = NARROW ? { width: 460, height: 860 } : { width: 1000, height: 860 };

const DSH_TOKENS = {
    dark: {
        '--dsw-static-neutral-bluish-00': '#ffffff',
        '--dsw-static-neutral-bluish-50': '#f9fafb',
        '--dsw-static-neutral-bluish-1000': '#0f1115',
        '--dsw-static-neutral-bluish-300': '#cfd3d6',
        '--dsw-static-neutral-bluish-875': '#232324',
        '--dsw-static-neutral-bluish-850': '#2c2c2e',
        '--dsw-static-neutral-bluish-950': '#151517',
        '--dsw-static-deepseek-400': '#7aaaff',
        '--dsw-static-deepseek-500': '#4176e6',
        '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-950)',
        '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-875)',
        '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-850)',
        '--dsw-alias-label-primary': 'var(--dsw-static-neutral-bluish-50)',
        '--dsw-alias-label-secondary': 'var(--dsw-static-neutral-bluish-300)',
        '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.06)',
        '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
        '--dsw-alias-state-business-primary': 'var(--dsw-static-deepseek-400)',
    },
    light: {
        '--dsw-static-neutral-bluish-00': '#ffffff',
        '--dsw-static-neutral-bluish-50': '#f9fafb',
        '--dsw-static-neutral-bluish-1000': '#0f1115',
        '--dsw-static-neutral-bluish-700': '#61666b',
        '--dsw-static-neutral-bluish-300': '#cfd3d6',
        '--dsw-static-neutral-bluish-875': '#ffffff',
        '--dsw-static-neutral-bluish-850': '#f5f6f7',
        '--dsw-static-neutral-bluish-300b': '#ebeef2',
        '--dsw-static-neutral-bluish-950': '#ffffff',
        '--dsw-static-deepseek-400': '#7aaaff',
        '--dsw-static-deepseek-500': '#4176e6',
        '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-950)',
        '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-875)',
        '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-850)',
        '--dsw-alias-label-primary': 'var(--dsw-static-neutral-bluish-1000)',
        '--dsw-alias-label-secondary': 'var(--dsw-static-neutral-bluish-700)',
        '--dsw-alias-border-l1': 'rgba(0, 0, 0, 0.04)',
        '--dsw-alias-border-l2': 'rgba(0, 0, 0, 0.10)',
        '--dsw-alias-state-business-primary': 'var(--dsw-static-deepseek-500)',
    },
};

function cdp() {
    return new Promise((resolvePort, reject) => {
        const child = spawn(EDGE, [
            '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            `--user-data-dir=${PROFILE}`,
            '--remote-debugging-port=0', '--remote-allow-origins=*',
            'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let buf = '';
        const timer = setTimeout(() => reject(new Error('CDP 端口没出现')), 30_000);
        child.stderr.on('data', (chunk) => {
            buf += String(chunk);
            const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
            if (m !== null) { clearTimeout(timer); resolvePort({ child, port: Number(m[1]) }); }
        });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`浏览器退出 ${code}`)); });
    });
}

async function session(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const waiters = new Map();
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((r) => {
        id += 1; waiters.set(id, r); ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    return { send, close: () => ws.close() };
}

const PROBE = [
    "const page = document.querySelector('.canvas-page');",
    'if (page === null) return JSON.stringify({ error: "没有 .canvas-page" });',
    'const rules = [];',
    'for (const sheet of document.styleSheets) {',
    '    let list;',
    '    try { list = sheet.cssRules; } catch (e) { continue; }',
    '    const walk = (rs) => {',
    '        for (const r of rs) {',
    '            if (r.cssRules !== undefined && r.cssRules !== null) { walk(r.cssRules); continue; }',
    '            if (r.selectorText === undefined || r.style === undefined) continue;',
    '            if (!r.style.boxShadow && !r.style.boxShadowImportant) continue;',
    '            rules.push({ sel: r.selectorText, shadow: r.style.boxShadow, important: r.style.getPropertyPriority("box-shadow") });',
    '        }',
    '    };',
    '    walk(list);',
    '}',
    'const out = { sheets: document.styleSheets.length, rulesWithShadow: rules.length, hits: [], bars: [] };',
    '/* 三组工具条各自的真实几何 + 图标数 —— 用来对上截图里那一组是谁 */',
    'for (const name of ["ref-bottom-left", "ref-create-bar", "ref-bottom-right"]) {',
    '    const el = document.querySelector(".canvas-page ." + name);',
    '    if (el === null) continue;',
    '    const r = el.getBoundingClientRect();',
    '    out.bars.push({',
    '        name: name,',
    '        rect: Math.round(r.width) + "x" + Math.round(r.height),',
    '        left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),',
    '        buttons: el.querySelectorAll("button").length,',
    '        shadow: getComputedStyle(el).boxShadow,',
    '    });',
    '}',
    'for (const el of page.querySelectorAll("*")) {',
    '    const cs = getComputedStyle(el);',
    '    if (cs.boxShadow === "none") continue;',
    '    const rect = el.getBoundingClientRect();',
    '    if (rect.width < 2 || rect.height < 2) continue;',
    '    const matched = [];',
    '    for (const r of rules) {',
    '        try { if (el.matches(r.sel)) matched.push(r); } catch (e) { /* 非法选择器，忽略 */ }',
    '    }',
    '    out.hits.push({',
    '        sel: el.tagName.toLowerCase() + "|" + String(el.className || "(无类名)").slice(0, 60),',
    '        shadow: cs.boxShadow,',
    '        rect: Math.round(rect.width) + "x" + Math.round(rect.height),',
    '        matched: matched.map((m) => (m.important === "important" ? "!" : "") + m.sel + " { " + m.shadow + " }"),',
    '    });',
    '}',
    'return JSON.stringify(out, null, 1);',
].join('\n');

const { child, port } = await cdp();
const s = await session(port);
try {
    for (const theme of ['light', 'dark']) {
        await s.send('Emulation.setDeviceMetricsOverride', {
            width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
        });
        await s.send('Page.navigate', { url: `${BASE}?theme=${theme}` });
        await new Promise((r) => setTimeout(r, 2500));
        const payload = JSON.stringify({ source: 'dsh-canvas-host', type: 'theme', payload: { theme, tokens: DSH_TOKENS[theme] } });
        await s.send('Runtime.evaluate', { expression: `window.postMessage(${payload}, '*')` });
        await new Promise((r) => setTimeout(r, 400));

        const res = await s.send('Runtime.evaluate', { expression: `(() => {\n${PROBE}\n})()`, returnByValue: true });
        if (res.result?.exceptionDetails !== undefined) {
            const ex = res.result.exceptionDetails;
            throw new Error('页面内抛异常：\n' + String(ex.exception?.description ?? ex.text).split('\n').slice(0, 6).join('\n'));
        }
        console.log(`\n══════ ${theme} （视口 ${VIEWPORT.width}px）══════`);
        const data = JSON.parse(res.result.result.value);
        console.log(`样式表 ${data.sheets} 张，带 box-shadow 的规则 ${data.rulesWithShadow} 条，命中元素 ${data.hits.length} 个\n`);
        console.log('── 三组工具条几何 ──');
        for (const b of data.bars) {
            console.log(`  ${b.name.padEnd(17)} ${b.rect.padEnd(9)} left=${String(b.left).padStart(4)} right=${String(b.right).padStart(4)} top=${String(b.top).padStart(4)} 按钮 ${b.buttons} 个`);
            console.log(`  ${''.padEnd(17)} shadow: ${b.shadow}`);
        }
        console.log('\n── 带阴影的元素 ──');
        for (const h of data.hits) {
            console.log(`● ${h.sel}  [${h.rect}]`);
            console.log(`  生效: ${h.shadow}`);
            for (const m of h.matched) console.log(`  来自: ${m}`);
            console.log('');
        }
    }
} finally {
    s.close();
    child.kill();
}
