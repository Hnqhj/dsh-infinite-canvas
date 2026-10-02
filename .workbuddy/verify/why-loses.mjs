/**
 * 专查一个选择器的**全部命中规则**（不管声明什么属性），按「谁赢」排。
 *
 * ── 为什么单独写 ────────────────────────────────────────────────────────────
 * `probe-menus.mjs` 只报「声明了 `background` 的命中规则」，
 * 但 `.ref-title` 的问题是：我的 `html[data-dsh-theme] .canvas-page .ref-title:hover`
 * 明明写了 `background`，却**没赢**。只列 background 命中项看不出原因 ——
 * 可能我的规则根本没进 `document.styleSheets`（产物没同步 / 选择器写错被丢弃），
 * 也可能它在但被更强的规则压住。这两者要分开看：
 *   · 不在 sheets 里 → 产物问题（构建 / 同步）
 *   · 在但输了 → 特异性问题（要加 `!important` 或改选择器）
 *
 * 输出里对每条规则标 `✔生效 / ✘被压`，并算出它的特异性和源码顺序，
 * 这样「为什么输了」一眼可见。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PORT = 9800 + (process.pid % 100);
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-why-profile');
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'light';
const SEL = process.argv.find((a) => a.startsWith('--sel='))?.slice(6) ?? '.ref-title';
const TOKENS = loadDshTokens();

const PROBE = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { err: '没找到 ' + ${JSON.stringify(sel)} };

  /** 选择器特异性：按 id / class+attr / tag 计数（够用了，不做完整实现）。 */
  const spec = (s) => {
    const ids = (s.match(/#[\w-]+/g) ?? []).length;
    const cls = (s.match(/\\.[\\w-]+|\\[[^\\]]+\\]/g) ?? []).length;
    const tag = (s.match(/(^|\\s|>)\\s*[a-z][\\w-]*/gi) ?? []).length;
    return ids * 10000 + cls * 100 + tag;
  };

  const rows = [];
  let order = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (list, href) => {
      for (const r of list) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules, href); continue; }
        if (!r.selectorText) continue;
        let m = false;
        try { m = el.matches(r.selectorText); } catch { continue; }
        if (!m) continue;
        order += 1;
        // 该规则里所有有值的属性（不只是 background —— hover 可能是别的属性在起作用）
        const decls = {};
        for (let i = 0; i < r.style.length; i += 1) {
          const p = r.style[i];
          decls[p] = r.style.getPropertyValue(p) + (r.style.getPropertyPriority(p) === 'important' ? ' !important' : '');
        }
        rows.push({
          sel: r.selectorText,
          spec: spec(r.selectorText),
          order,
          decls,
          hover: r.selectorText.includes(':hover'),
        });
      }
    };
    walk(rules, sheet.href);
  }
  // 同一特异性下，后出现的赢（同权重时源码顺序决定）
  rows.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const winner = rows.length ? rows[rows.length - 1] : null;
  return {
    目标: el.className,
    生效背景: getComputedStyle(el).backgroundColor,
    生效文字: getComputedStyle(el).color,
    处于hover: el.matches(':hover'),
    规则数: rows.length,
    赢家: winner ? { sel: winner.sel, spec: winner.spec, decls: winner.decls } : null,
    全部: rows,
  };
})()`;

function run() {
    return new Promise((done, fail) => {
        const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe', [
            `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
            '--headless=new', '--hide-scrollbars', '--window-size=1200,900', 'about:blank',
        ], { stdio: 'ignore' });
        const cdp = async (p) => {
            for (let i = 0; i < 60; i += 1) {
                try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return r.json(); } catch { /* 等 */ }
                await new Promise((r) => setTimeout(r, 250));
            }
            throw new Error('CDP 没起来');
        };
        (async () => {
            mkdirSync(PROFILE, { recursive: true });
            const list = await cdp('/json/list');
            const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
            let seq = 0;
            const pending = new Map();
            ws.addEventListener('message', (ev) => {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) {
                    const { resolve: r, reject: j } = pending.get(m.id);
                    pending.delete(m.id);
                    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
                }
            });
            await new Promise((r) => ws.addEventListener('open', r, { once: true }));
            const send = (method, params = {}) =>
                new Promise((r, j) => { const id = ++seq; pending.set(id, { resolve: r, reject: j }); ws.send(JSON.stringify({ id, method, params })); });

            await send('Page.enable');
            await send('Runtime.enable');
            await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
            await send('Page.navigate', { url: `${BASE}?theme=${THEME}` });
            await new Promise((r) => setTimeout(r, 3000));
            await send('Runtime.evaluate', {
                expression: `window.postMessage({source:'dsh-canvas-host',type:'theme',payload:{theme:${JSON.stringify(THEME)},tokens:${JSON.stringify(TOKENS[THEME])}}},'*'); true`,
            });
            await new Promise((r) => setTimeout(r, 700));
            // 先点开菜单（真实场景里它就是展开的），再取证
            await send('Runtime.evaluate', {
                expression: `(async () => { document.querySelector('.ref-title')?.click(); await new Promise(r => setTimeout(r, 300)); return true; })()`,
                awaitPromise: true, returnByValue: true,
            });

            const r = await send('Runtime.evaluate', { expression: PROBE(SEL), returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面抛异常');
            ws.close(); edge.kill(); done(r.result.value);
        })().catch((e) => { edge.kill(); fail(e); });
    });
}

const d = await run();
if (d.err) { console.log('✗ ' + d.err); process.exit(0); }
console.log(`\n══════ ${SEL} ══════`);
console.log(`元素      .${d.目标}`);
console.log(`处于 hover  ${d.处于hover}`);
console.log(`生效背景    ${d.生效背景}`);
console.log(`生效文字    ${d.生效文字}`);
console.log(`命中规则    ${d.规则数} 条`);
console.log(`\n── 赢家（特异性和顺序都最高的那条）──`);
console.log(`  ${d.赢家?.sel}   [特异 ${d.赢家?.spec}]`);
for (const [k, v] of Object.entries(d.赢家?.decls ?? {})) console.log(`      ${k}: ${v}`);
console.log(`\n── 全部命中规则（按特异性 → 顺序升序，最后一条即赢家）──`);
for (const r of d.全部) {
    const isWinner = r.sel === d.赢家?.sel;
    console.log(`  ${isWinner ? '✔' : '✘'} [特异 ${String(r.spec).padStart(5)}] ${r.sel}`);
    for (const [k, v] of Object.entries(r.decls)) {
        if (['background', 'background-color', 'color', 'border', 'border-color', 'box-shadow'].includes(k)) {
            console.log(`        ${k}: ${v}`);
        }
    }
}
console.log();
