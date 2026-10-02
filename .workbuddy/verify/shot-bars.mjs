/**
 * 拍底部三组工具条在**浅色 / 深色**两档下的样子。
 *
 * ── 为什么单独写一个，而不用 shot.mjs ──────────────────────────────────────
 * `shot.mjs` 只负责导航 + 截图，**不注入 DSH 的主题桥**（它没有 `--theme`）。
 * 而画布的浅色是靠宿主 postMessage 写 `data-dsh-theme` + 一整套 `--dsw-*`
 * token 实现的（见 `index.js` 的 `type: 'theme'` 消息）——
 * 不走这一步，画布会一直停在**上游锁死的深色**。
 * `scan-panels.mjs` 有注入逻辑，但它的产出是扫描报告，截图是顺带的。
 *
 * 这个脚本只做一件事：注入两档主题，各拍一张**聚焦底部区域**的图。
 * 聚焦而不是全页，是因为要看的东西就在画面最下面 60px。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const OUT = resolve(ROOT, 'docs');
const PORT = 9333 + Math.floor(process.pid % 200);
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-bars-profile');
const TOKENS = loadDshTokens();

mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

/** 用 Edge 的 CDP 打开页面、注入主题、截底部一条。 */
function shoot(theme) {
  return new Promise((done, fail) => {
    const edge = spawn(
      'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe',
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--headless=new',
        '--hide-scrollbars',
        '--window-size=1000,880',
        'about:blank',
      ],
      { stdio: 'ignore', detached: false },
    );

    const cdp = async (path) => {
      for (let i = 0; i < 60; i += 1) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
          if (r.ok) return r.json();
        } catch {
          /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('CDP 端口没起来');
    };

    (async () => {
      const list = await cdp('/json/list');
      const page = list.find((t) => t.type === 'page');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      let seq = 0;
      const pending = new Map();

      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolve: r, reject: j } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result);
        }
      });
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));

      const send = (method, params = {}) =>
        new Promise((r, j) => {
          const id = ++seq;
          pending.set(id, { resolve: r, reject: j });
          ws.send(JSON.stringify({ id, method, params }));
        });

      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面抛异常');
        return r.result?.value;
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url: `${BASE}?theme=${theme}` });
      await new Promise((r) => setTimeout(r, 2600));

      // 走宿主那条路注入主题 —— 与真实 DSH 里 client.js 发的是同一条消息。
      await evaluate(`(() => {
        window.postMessage(
          { source: 'dsh-canvas-host', type: 'theme', payload: { theme: ${JSON.stringify(theme)}, tokens: ${JSON.stringify(TOKENS[theme])} } },
          '*',
        );
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 700));

      // 复现用户截图的场景：顶栏画布菜单 + 右键菜单都展开。
      // 不点开就拍不到 —— 这正是 P2.9 的教训（浮层是 v-if 的）。
      await evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('.ref-title')?.click();
        await sleep(300);
        document.querySelector('.canvas-stage')?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 560, clientY: 430 }),
        );
        await sleep(300);
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));

      // 顺手报一次三组的实际生效值，截图是「看」，这里是「量」。
      // 也把两个菜单的量打出来 —— 它们是 P2.9 的新增验收项。
      const bars = await evaluate(`(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow,
            color: cs.color,
          };
        };
        return {
          left: pick('.ref-bottom-left'),
          middle: pick('.ref-create-bar'),
          right: pick('.ref-bottom-right'),
          画布菜单: pick('.canvas-menu-card'),
          右键菜单: pick('.canvas-context-menu'),
          菜单按钮: pick('.ref-title'),
        };
      })()`);

      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      const file = resolve(OUT, `底部与菜单-${theme}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      ws.close();
      edge.kill();
      done({ file, bars });
    })().catch((e) => {
      edge.kill();
      fail(e);
    });
  });
}

for (const theme of ['light', 'dark']) {
  const { file, bars } = await shoot(theme);
  console.log(`\n── ${theme} ──`);
  for (const [k, v] of Object.entries(bars)) {
    if (!v) { console.log(`  ${k.padEnd(7)} （不在 DOM 里）`); continue; }
    console.log(`  ${k.padEnd(7)} ${String(v.w + 'x' + v.h).padEnd(9)} bg=${v.bg}  shadow=${v.shadow === 'none' ? 'none' : v.shadow.slice(0, 40)}`);
  }
  console.log(`  → ${file}`);
}
console.log('\n完成');
