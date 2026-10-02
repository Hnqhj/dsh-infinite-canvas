/**
 * 最小复现：只送 alias 层 token 时，iframe 里的 `var()` 链会不会断。
 *
 * 背景：DSH 的 token 是两层 —— `--dsw-alias-*` 的值是 `var(--dsw-static-*)`
 * **引用**，而 static 层才是字面量。插件最初只把 alias 层送进 iframe，
 * 于是 iframe 里 `--dsw-static-*` 不存在，`var()` 解析失败，
 * **整条声明失效**（不是"回退到兜底值"，而是这条 background 直接不算）。
 *
 * 这个探针就是用来确认这件事，而不是靠推断。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe';
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-probe');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
/* a：alias 与 static 都在（= 送两层，正确） */
#a{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);--dsw-static-neutral-bluish-00:#fff;background:var(--dsw-alias-bg-base)}
/* b：只送 alias，static 缺失（= 只送 alias 层，错误） */
#b{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);background:var(--dsw-alias-bg-base)}
/* c：带 var() 兜底，模拟 dsh-shell.css 的写法 */
#c{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);background:var(--dsw-alias-bg-base,#151517)}
div{width:40px;height:20px}
</style></head><body><div id="a"></div><div id="b"></div><div id="c"></div></body></html>`;

const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
});

const port = 8799;
await new Promise((r) => server.listen(port, r));

const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const devtoolsPort = await new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('CDP 端口没出现')), 30_000);
    child.stderr.on('data', (chunk) => {
        buf += String(chunk);
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
        if (m !== null) { clearTimeout(timer); res(Number(m[1])); }
    });
});

const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let id = 0;
const waiters = new Map();
ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((r) => {
    id += 1;
    waiters.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
await new Promise((r) => setTimeout(r, 900));

const expr = 'JSON.stringify({'
    + 'a:getComputedStyle(document.getElementById("a")).backgroundColor,'
    + 'b:getComputedStyle(document.getElementById("b")).backgroundColor,'
    + 'c:getComputedStyle(document.getElementById("c")).backgroundColor})';
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const out = JSON.parse(res.result.result.value);

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
console.log('a 两层都在        →', out.a);
console.log('b 只送 alias      →', out.b, out.b === TRANSPARENT ? '  ← 透明！var() 链断了' : '');
console.log('c 只送 alias+兜底 →', out.c, out.c === '#151517' ? '  ← 走了兜底值（不是断链，是 var() 失败吃 fallback）' : '');

console.log('\n结论：');
if (out.b === TRANSPARENT) {
    console.log('  ✓ 证实：只送 alias 层时 var() 断链，该条声明**完全失效**。');
    console.log('    必须连 static 层一起送（static 层全是字面量，0 个引用）。');
} else {
    console.log('  ✗ 推断不成立，var() 未定义时会用兜底值而非断链 —— 需另查原因。');
}

ws.close();
child.kill();
server.close();
process.exit(0);
