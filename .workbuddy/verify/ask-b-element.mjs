/**
 * 揪出「浅色下白底白字」的那个元素到底是哪个。
 *
 * 上一轮的对比度扫描只报 `b. 前景 rgb(240,241,244)` —— 一个没有类名的 `<b>`，
 * 在 CSS 里 grep 不到（说明是内联样式或继承来的）。
 * 靠翻代码猜不出来，直接在页面里问它：父链、文本内容、内联样式、命中规则。
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe';
const BASE = 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-ask-profile');

const TOKENS = {
    '--dsw-static-neutral-bluish-00': '#ffffff',
    '--dsw-static-neutral-bluish-1000': '#0f1115',
    '--dsw-static-neutral-bluish-600': '#81858c',
    '--dsw-static-neutral-bluish-700': '#61666b',
    '--dsw-static-neutral-bluish-200': '#e1e5ee',
    '--dsw-static-neutral-bluish-60': '#f5f6f7',
    '--dsw-static-neutral-bluish-100': '#ebeef2',
    '--dsw-static-neutral-bluish-300': '#cfd3d6',
    '--dsw-static-neutral-bluish-950': '#ffffff',
    '--dsw-static-neutral-bluish-875': '#ffffff',
    '--dsw-static-neutral-bluish-850': '#f5f6f7',
    '--dsw-static-deepseek-500': '#4176e6',
    '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-950)',
    '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-875)',
    '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-850)',
    '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-100)',
    '--dsw-alias-label-primary': 'var(--dsw-static-neutral-bluish-1000)',
    '--dsw-alias-label-secondary': 'var(--dsw-static-neutral-bluish-700)',
    '--dsw-alias-label-tertiary': 'var(--dsw-static-neutral-bluish-600)',
    '--dsw-alias-border-l1': 'rgba(0, 0, 0, 0.04)',
    '--dsw-alias-border-l2': 'rgba(0, 0, 0, 0.10)',
    '--dsw-alias-border-l3': 'rgba(0, 0, 0, 0.12)',
    '--dsw-alias-state-business-primary': 'var(--dsw-static-deepseek-500)',
};

const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const port = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('无 CDP 端口')), 30_000);
    child.stderr.on('data', (c) => {
        buf += String(c);
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
        if (m !== null) { clearTimeout(t); res(Number(m[1])); }
    });
});

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const waiters = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => {
    id += 1; waiters.set(id, r); ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 860, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}?theme=light` });
await new Promise((r) => setTimeout(r, 2500));

const payload = JSON.stringify({ source: 'dsh-canvas-host', type: 'theme', payload: { theme: 'light', tokens: TOKENS } });
await send('Runtime.evaluate', { expression: `window.postMessage(${payload}, '*')` });
await new Promise((r) => setTimeout(r, 500));

/** 用 CSSOM 找出「命中了哪几条规则」——这比翻源码准。 */
const script = `
(() => {
    const page = document.querySelector('.canvas-page');
    if (page === null) return JSON.stringify({ error: 'no .canvas-page' });
    const bad = [];
    for (const el of page.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.color !== 'rgb(240, 241, 244)') continue;
        // 找命中它的规则
        const hits = [];
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch { continue; }
            for (const rule of rules) {
                if (rule.selectorText === undefined) continue;
                try {
                    if (el.matches(rule.selectorText)) {
                        hits.push({
                            sheet: (sheet.href || 'inline').split('/').pop(),
                            sel: rule.selectorText.slice(0, 120),
                            color: rule.style.color || null,
                        });
                    }
                } catch { /* 选择器语法问题，忽略 */ }
            }
        }
        const chain = [];
        for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
            chain.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ').join('.') : ''));
        }
        bad.push({
            tag: el.tagName,
            text: (el.textContent || '').trim().slice(0, 40),
            inline: el.getAttribute('style') || '(无内联)',
            chain: chain.slice(0, 5),
            hits: hits.filter((h) => h.color !== '').slice(0, 5),
        });
    }
    return JSON.stringify(bad, null, 2);
})()
`;

const res = await send('Runtime.evaluate', { expression: script, returnByValue: true });
if (res.result?.exceptionDetails) {
    console.error('页面异常：', res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
} else {
    console.log(res.result.result.value);
}
ws.close();
child.kill();
process.exit(0);
