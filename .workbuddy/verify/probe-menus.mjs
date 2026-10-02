/**
 * 定位「截图里仍是深色的两个面板」——用户 2026-10-02 反馈，附 DSH 真实窗口截图。
 *
 * ── 现象 ────────────────────────────────────────────────────────────────────
 * 浅色 DSH 窗口里，画布主体已经浅色化、底部工具条已按 P2.8 改对，
 * 但仍有两块**深底白字**：
 *   ① 顶栏「我的画布」点开后弹出的下拉卡片（`.canvas-menu-card`）
 *   ② 中间那个「分镜」生成面板（`.generate-panel`）
 *
 * ── 为什么 ① 不用猜 ─────────────────────────────────────────────────────────
 * grep 覆盖层源码就能看出来：`.canvas-menu-card` 在 `dsh-shell.css` 里
 * **一次都没出现** —— 它压根没被覆盖过。不是「规则没赢」，是「没有规则」。
 *
 * ── 为什么 ② 要实测 ─────────────────────────────────────────────────────────
 * `.generate-panel` 的覆盖规则**确实存在**（第 478 / 490 行等），
 * 却没生效。可能是：① 选择器写错（`:is()` 组合的展开形式对不上）；
 * ② 上游有更高特异性的规则（可能带 `!important`）；
 * ③ 面板不在 `.canvas-page` 里面（挂在 body 上）。
 *
 * 所以这个脚本对每个目标做三件事：
 *   1. 报告它在 DOM 里的真实父链（确认在不在 `.canvas-page` 内）；
 *   2. 用 **CSSOM 枚举命中规则**报出生效值 + 命中哪几条 + 各自有没有 `!important`
 *      （和 `probe-shadow.mjs` 同一套方法，见技能 §3.15）；
 *   3. 把**它的祖先**链上每个元素的底色打一遍 ——
 *      因为「面板看起来深」可能不是它自己深，而是**祖先的深底透上来**
 *      （面板背景是半透明 / transparent 时尤其容易漏）。
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PORT = 9500 + (process.pid % 150);
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-menu-profile');
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'light';
const TOKENS = loadDshTokens();

/** 打开两个面板（画布菜单 + 生成），逐个取证。 */
const TARGETS = [
    { key: 'canvas-menu', 打开: '.ref-title',               面板: '.canvas-menu-card' },
    { key: 'generate',    打开: '[title="生成图片或视频"]',  面板: '.generate-panel' },
];

const PROBE = (targets) => `(async () => {
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 枚举所有命中该元素、且声明了某个属性的 CSS 规则。 */
  const hits = (el, prop) => {
    const found = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules) { walk(r.cssRules); continue; }
          if (!r.selectorText || !r.style) continue;
          if (!r.style.getPropertyValue(prop)) continue;
          try { if (!el.matches(r.selectorText)) continue; } catch { continue; }
          found.push({
            sel: r.selectorText.slice(0, 110),
            val: r.style.getPropertyValue(prop).trim(),
            important: r.style.getPropertyPriority(prop) === 'important',
          });
        }
      };
      walk(rules);
    }
    return found;
  };

  const chain = (el) => {
    const out = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      out.push({
        tag: n.tagName.toLowerCase(),
        cls: (n.className || '').toString().slice(0, 60),
        bg: cs.backgroundColor,
        color: cs.color,
        // 只看自身底色是不是「实的」——半透明 / 透明说明底色来自祖先
        实底: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && !/rgba\\(.*,\\s*0\\.[0-9]+\\)/.test(cs.backgroundColor),
      });
    }
    return out;
  };

  for (const t of ${JSON.stringify(TARGETS)}) {
    const btn = document.querySelector(t.打开);
    if (btn) btn.click();
    else { out.push({ key: t.key, err: '没找到打开按钮 ' + t.打开 }); continue; }

    // ⚠️ 必须等一拍：面板是 \`v-if\`，点击后要等 Vue 下一个 tick 才会插进 DOM。
    // 在同一次同步 \`evaluate\` 里紧接着 querySelector，读到的必然是 null ——
    // 第一版探针就是这么把「面板已打开」误报成「没出现」的。
    await sleep(300);

    const panel = document.querySelector(t.面板);
    if (!panel) {
      out.push({
        key: t.key,
        err: '点了 ' + t.打开 + ' 但面板 ' + t.面板 + ' 没出现',
        // 顺手记下当时 DOM 里有哪些同前缀的类 —— 用来发现「面板其实换了类名」
        近似类名: [...document.querySelectorAll('[class*="' + t.面板.slice(1, 8) + '"]')].map((e) => e.className).slice(0, 6),
        画布页在: !!document.querySelector('.canvas-page'),
      });
      continue;
    }

    const cs = getComputedStyle(panel);
    out.push({
      key: t.key,
      面板类名: panel.className,
      在CanvasPage内: !!panel.closest('.canvas-page'),
      在Body内: panel.parentElement === document.body,
      尺寸: (() => { const r = panel.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
      生效底色: cs.backgroundColor,
      生效文字: cs.color,
      背景命中: hits(panel, 'background'),
      颜色命中: hits(panel, 'color'),
      祖先链: chain(panel),
      // 面板内所有子元素的底色分布，看有没有漏覆盖的
      子元素底色: [...panel.querySelectorAll('*')].slice(0, 400).map((el) => {
        const c = getComputedStyle(el);
        return { cls: (el.className || '').toString().slice(0, 40), bg: c.backgroundColor, color: c.color };
      }),
    });
  }
  return out;
})()`;

function run() {
    return new Promise((done, fail) => {
        const edge = spawn(
            'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe',
            [
                `--remote-debugging-port=${PORT}`,
                `--user-data-dir=${PROFILE}`,
                '--headless=new',
                '--hide-scrollbars',
                '--window-size=1200,900',
                'about:blank',
            ],
            { stdio: 'ignore' },
        );

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
            const page = list.find((t) => t.type === 'page');
            const ws = new WebSocket(page.webSocketDebuggerUrl);
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
            // 必须先设视口 —— 画布走的是 `max-width: 760px` 那档窄容器分支，
            // 视口不对时底栏布局会变，开关按钮的可见性也不同。
            // 这一点是从 `scan-panels.mjs` 抄来的（它也设了），不是想当然。
            await send('Emulation.setDeviceMetricsOverride', {
                width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
            });
            await send('Page.navigate', { url: `${BASE}?theme=${THEME}` });
            await new Promise((r) => setTimeout(r, 3000));

            // 先自检：确认页面真的渲染出了画布底座，再去点按钮。
            const ready = await send('Runtime.evaluate', {
                expression: `(() => ({
                    画布页: !!document.querySelector('.canvas-page'),
                    底栏按钮: document.querySelectorAll('.ref-bottom-left button, .ref-bottom-right button, .ref-create-bar button').length,
                    顶栏: !!document.querySelector('.ref-topbar'),
                    refTitle: !!document.querySelector('.ref-title'),
                }))()`,
                returnByValue: true,
            });
            console.log('\n预检：', JSON.stringify(ready.result.value));

            // 注入主题桥（与 client.js 同一条消息）
            await send('Runtime.evaluate', {
                expression: `window.postMessage({source:'dsh-canvas-host',type:'theme',payload:{theme:${JSON.stringify(THEME)},tokens:${JSON.stringify(TOKENS[THEME])}}},'*'); true`,
                awaitPromise: true,
            });
            await new Promise((r) => setTimeout(r, 800));

            // ⚠️ PROBE 现在是 `async`（要 await sleep 等 Vue 的 tick），
            // 所以**必须** `awaitPromise: true`，否则 CDP 立刻返回
            // 一个还没 resolve 的 Promise，`returnByValue` 拿到的会是 undefined。
            const r = await send('Runtime.evaluate', { expression: PROBE(TARGETS), returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面抛异常');
            ws.close();
            edge.kill();
            done(r.result.value);
        })().catch((e) => { edge.kill(); fail(e); });
    });
}

const data = await run();
console.log(`\n══════ 主题 ${THEME} ══════\n`);
for (const t of data) {
    if (t.err) { console.log(`✗ ${t.key}：${t.err}\n`); continue; }
    console.log(`━━ ${t.key} ━━`);
    console.log(`  面板类名      ${t.面板类名}`);
    console.log(`  在 .canvas-page 内  ${t.在CanvasPage内}    直接挂 body  ${t.在Body内}`);
    console.log(`  尺寸          ${t.尺寸}`);
    console.log(`  生效底色      ${t.生效底色}`);
    console.log(`  生效文字      ${t.生效文字}`);
    console.log('  ── background 命中规则 ──');
    for (const h of t.背景命中) console.log(`     ${h.important ? '!important ' : ''}${h.val}   ← ${h.sel}`);
    if (!t.背景命中.length) console.log('     （无 —— 底色可能来自祖先或默认值）');
    console.log('  ── 祖先链（底色来源）──');
    for (const c of t.祖先链) {
        console.log(`     ${c.实底 ? '■' : '□'} ${c.tag}.${c.cls}  bg=${c.bg}  color=${c.color}`);
    }
    console.log('  ── 子元素底色分布 ──');
    const tally = new Map();
    for (const s of t.子元素底色) {
        if (s.bg === 'rgba(0, 0, 0, 0)') continue;
        const k = `${s.bg}`;
        if (!tally.has(k)) tally.set(k, []);
        if (tally.get(k).length < 4) tally.get(k).push(s.cls || s.cls);
    }
    for (const [bg, cls] of tally) console.log(`     ${bg}  ← ${cls.length} 个：${cls.join(', ')}`);
    console.log();
}
