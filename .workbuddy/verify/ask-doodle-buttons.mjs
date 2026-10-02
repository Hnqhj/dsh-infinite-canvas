/**
 * 打开涂鸦面板，逐个按钮报出「底色 / 文字色 / 类名 / 是否 last-child」。
 *
 * 为什么单独写：`.doodle-panel button:last-child` 这条规则我以为覆盖了
 * 「完成」按钮，但扫描器一直报它 `rgba(0,0,0,0)`（无底色）+ 深色文字 = 1.13。
 * 与其读 CSS 猜 `:last-child` 落在哪个元素上（面板里有注释掉的节点、
 * `v-if` 的 SVG 层、笔刷色板），不如直接把每个按钮量出来。
 *
 * 用法：node .workbuddy/verify/ask-doodle-buttons.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe';
const BASE = 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-theme-profile');

/**
 * DSH 官方 token 夹具 —— **从 app.asar 真身实抽，不手抄**。
 *
 * ⚠️ 这个夹具曾经两次漏 token，两次都是同一类静默故障：
 *   ① 漏整个 static 层 → alias 层的 var() 断链 → 声明被丢弃；
 *   ② 漏 button-contrast-fill / switch-thumb / state-error-primary
 *      → 「完成」按钮底色变透明，扫描器报了一个查了三轮的假「对比度 1.13」。
 * 详见 `dsh-tokens.mjs` 的文件头注释。
 */
const TOKENS = loadDshTokens();

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
        child.stderr.on('data', (c) => {
            buf += String(c);
            const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
            if (m !== null) { clearTimeout(timer); resolvePort({ child, port: Number(m[1]) }); }
        });
        child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`浏览器退出 ${c}`)); });
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
    'const panel = document.querySelector(".doodle-panel");',
    'if (panel === null) return JSON.stringify({ missing: true });',
    'const out = { panelBg: getComputedStyle(panel).backgroundColor, buttons: [] };',
    'const all = [...panel.children];',
    'out.childTags = all.map((e) => e.tagName.toLowerCase() + "." + String(e.className || "-"));',
    'const btns = [...panel.querySelectorAll("button")];',
    'btns.forEach((b, i) => {',
    '    const cs = getComputedStyle(b);',
    '    out.buttons.push({',
    '        i: i,',
    '        text: b.textContent.trim().slice(0, 8),',
    '        cls: String(b.className || "(无类名)"),',
    '        isLast: b === btns[btns.length - 1],',
    '        isLastChild: b === panel.lastElementChild,',
    '        bg: cs.backgroundColor,',
    '        color: cs.color,',
    '    });',
    '});',
    'return JSON.stringify(out, null, 1);',
].join('\n');

const { child, port } = await cdp();
const s = await session(port);
try {
    for (const theme of ['light', 'dark']) {
        await s.send('Emulation.setDeviceMetricsOverride', {
            width: 1000, height: 860, deviceScaleFactor: 1, mobile: false,
        });
        await s.send('Page.navigate', { url: `${BASE}?theme=${theme}` });
        await new Promise((r) => setTimeout(r, 2500));
        const payload = JSON.stringify({ source: 'dsh-canvas-host', type: 'theme', payload: { theme, tokens: TOKENS[theme] } });
        await s.send('Runtime.evaluate', { expression: `window.postMessage(${payload}, '*')` });
        await new Promise((r) => setTimeout(r, 400));
        await s.send('Runtime.evaluate', { expression: `document.querySelector('[title="涂鸦"]').click()` });
        await new Promise((r) => setTimeout(r, 400));

        const res = await s.send('Runtime.evaluate', { expression: `(() => {\n${PROBE}\n})()`, returnByValue: true });
        if (res.result?.exceptionDetails !== undefined) {
            const ex = res.result.exceptionDetails;
            throw new Error('页面内抛异常：\n' + String(ex.exception?.description ?? ex.text).split('\n').slice(0, 5).join('\n'));
        }
        const d = JSON.parse(res.result.result.value);
        console.log(`\n══════ ${theme} ══════`);
        if (d.missing === true) { console.log('面板没打开'); continue; }
        console.log('面板底色:', d.panelBg);
        console.log('直接子节点:', d.childTags.join('  '));
        console.log('');
        for (const b of d.buttons) {
            console.log(`  [${b.i}] "${b.text}"  class="${b.cls}"  last=${b.isLast} lastChild=${b.isLastChild}`);
            console.log(`      底 ${b.bg}   字 ${b.color}`);
        }
    }
} finally {
    s.close();
    child.kill();
}
