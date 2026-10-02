/**
 * 全节点扫描：往 localStorage 里种一个包含**全部 13 种节点**的项目，
 * 刷新后逐卡扫描颜色。
 *
 * ── 为什么直接种数据而不一个个点 UI ────────────────────────────────────────
 * 加节点面板（`.asset-panel`）没有工具条入口（`activePanel === 'assets'`
 * 在 `CanvasView.vue` 里没有任何按钮触发 —— P2.7 时记过它是「悬空入口」，
 * 现在确认依然如此）。右键菜单 / 工具条只能落创作板与文本两种。
 * 剩下 9 种节点没有任何 UI 路径能一次落全，逐个找入口会把探针写成
 * 一堆特判，而「直接构造持久化数据」是上游文档化的公开格式
 * （`persistence.ts` v2 结构），反而最稳。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────────────────
 * `type` 清单来自 `nodes/registry.ts` 的 `NODE_SCHEMAS`（13 个）。
 * `kind` 是 `type` 的有损投影（`kindForNode()`），但持久化里两者都存；
 * 这里直接给每个 type 配上正确 kind（读 `types/card.ts` 的投影规则）。
 * `data` 给 `{}` —— 画布挂载时会与 schema 的 `defaultData` 合并，
 * 空 data 是合法输入（`migrateCanvas` 的铁律：坏数据丢掉，不抛错）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PORT = 9960 + (process.pid % 40);
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-allnodes-profile');
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'light';
const KEEP = process.argv.includes('--keep');
const TOKENS = loadDshTokens();

/** type → kind 投影（读自 types/card.ts 的 kindForNode 注释与 mcp 枚举）。 */
const NODES = [
    { type: 'asset_input', kind: 'scene', title: '素材输入' },
    { type: 'script_input', kind: 'scene', title: '剧本输入' },
    { type: 'gen_text', kind: 'scene', title: '文本生成' },
    { type: 'gen_image', kind: 'scene', title: '图片生成' },
    { type: 'gen_video', kind: 'video', title: '视频生成' },
    { type: 'character', kind: 'character', title: '角色' },
    { type: 'scene', kind: 'scene', title: '场景' },
    { type: 'prop', kind: 'scene', title: '物品' },
    { type: 'storyboard_shot', kind: 'board', title: '分镜' },
    { type: 'note', kind: 'note', title: '便签' },
    { type: 'canvas_text', kind: 'text', title: '文本' },
    { type: 'group', kind: 'scene', title: '编组' },
    { type: 'region', kind: 'scene', title: '区域' },
];

const SEED = {
    version: 2,
    cards: NODES.map((n, i) => ({
        id: i + 1,
        x: 40 + (i % 4) * 420,
        y: 40 + Math.floor(i / 4) * 340,
        title: n.title,
        type: n.type,
        kind: n.kind,
        data: {},
    })),
    strokes: [],
};

const SCAN = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);

  const lum = (c) => {
    const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (!m) return null;
    return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
  };
  const solid = (c) => {
    if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return false;
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (m && m[1].includes(',')) {
      const p = m[1].split(',').map((s) => s.trim());
      if (p.length === 4 && parseFloat(p[3]) < 0.6) return false;
    }
    return true;
  };

  const THEME = ${JSON.stringify(THEME)};
  const dark = THEME === 'light' ? 0.35 : 0.45;
  const hitWrong = (l) => (THEME === 'light' ? l < dark : l > dark);
  // 品牌蓝（浅 #4176e6 / 深 #7aaaff）是官方主色，豁免
  const BRAND = /^rgb\\\\(\\\\s*(65, 118, 230|122, 170, 255)\\\\s*\\\\)$/;

  const cards = [...document.querySelectorAll('.vue-flow__node')];
  const out = [];
  for (const node of cards) {
    const card = node.querySelector('.canvas-card');
    if (!card) continue;
    const type = ${JSON.stringify(NODES.map((n) => n.type))}[Number(node.dataset.id) - 1] ?? '?';
    const title = card.querySelector('.board-head strong, .card-title, strong')?.textContent?.trim() ?? '';
    const r = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const entry = {
      type, title,
      cls: [...card.classList].filter((c) => c !== 'canvas-card').join(' '),
      尺寸: Math.round(r.width) + 'x' + Math.round(r.height),
      底色: cs.backgroundColor,
      文字: cs.color,
      描边: cs.borderTopColor,
      阴影: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 40),
      问题: [],
    };
    const cardL = lum(cs.backgroundColor);
    if (solid(cs.backgroundColor) && cardL !== null && hitWrong(cardL) && !BRAND.test(cs.backgroundColor)) {
      entry.问题.push('卡底 ' + cs.backgroundColor);
    }
    for (const el of card.querySelectorAll('*')) {
      const c = getComputedStyle(el);
      const er = el.getBoundingClientRect();
      if (er.width < 8 || er.height < 8) continue;
      if (solid(c.backgroundColor)) {
        const l = lum(c.backgroundColor);
        if (l !== null && hitWrong(l) && !BRAND.test(c.backgroundColor)) {
          entry.问题.push('表面 ' + c.backgroundColor + ' ← .' + (el.className || '').toString().split(' ')[0] + ' (' + Math.round(er.width) + 'x' + Math.round(er.height) + ')');
        }
      }
      // 文字对比度（有文本内容的元素才算）
      const txt = (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        ? el.textContent.trim().slice(0, 24) : '';
      if (txt && solid(c.color)) {
        let ref = null;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const bc = getComputedStyle(n).backgroundColor;
          if (solid(bc)) { ref = bc; break; }
        }
        if (ref) {
          const l1 = lum(c.color), l2 = lum(ref);
          if (l1 !== null && l2 !== null) {
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            if (ratio < 1.5) entry.问题.push('文字 ' + c.color + ' on ' + ref + ' 对比 ' + (Math.round(ratio * 100) / 100) + ' ← ' + txt);
          }
        }
      }
    }
    out.push(entry);
  }
  return out;
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
            await send('Emulation.setDeviceMetricsOverride', { width: 1720, height: 1200, deviceScaleFactor: 1, mobile: false });
            // 先开一次页面拿 origin（localStorage 按 origin 隔离），种数据，再刷新
            await send('Page.navigate', { url: BASE });
            await new Promise((r) => setTimeout(r, 2200));
            const seed = await send('Runtime.evaluate', {
                expression: `(() => {
                  localStorage.setItem('nexusvault-canvas-projects', JSON.stringify([
                    { id: 'verify-all-nodes', name: '全节点验收', createdAt: ${Date.now()}, updatedAt: ${Date.now()}, cardCount: ${NODES.length} },
                  ]));
                  localStorage.setItem('nexusvault-canvas-active-project', 'verify-all-nodes');
                  localStorage.setItem('nexusvault-canvas-project.verify-all-nodes', ${JSON.stringify(JSON.stringify(SEED))});
                  return true;
                })()`,
                returnByValue: true,
            });
            if (!seed.result.value) throw new Error('种数据失败');
            await send('Page.navigate', { url: `${BASE}?theme=${THEME}` });
            await new Promise((r) => setTimeout(r, 3200));
            await send('Runtime.evaluate', {
                expression: `window.postMessage({source:'dsh-canvas-host',type:'theme',payload:{theme:${JSON.stringify(THEME)},tokens:${JSON.stringify(TOKENS[THEME])}}},'*'); true`,
            });
            await new Promise((r) => setTimeout(r, 900));

            const r = await send('Runtime.evaluate', { expression: SCAN, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) {
                const d = r.exceptionDetails;
                throw new Error(['页面侧异常：' + (d.text ?? ''), d.exception?.description ?? '',
                    typeof d.lineNumber === 'number' ? `位置: 第 ${d.lineNumber + 1} 行` : ''].filter(Boolean).join('\n'));
            }
            // 缩到全图再截一张
            await send('Runtime.evaluate', { expression: `true` });
            const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            ws.close();
            if (!KEEP) edge.kill();
            done({ rows: r.result.value, png: shot.data });
        })().catch((e) => { try { edge.kill(); } catch { /* 已退出 */ } fail(e); });
    });
}

const { rows, png } = await run();
let bad = 0;
console.log(`\n══════ 主题 ${THEME} · ${rows.length} 张卡 ══════\n`);
for (const c of rows) {
    if (c.问题.length) bad += 1;
    console.log(`${c.问题.length ? '❌' : '✅'} ${c.type.padEnd(16)} ${String(c.尺寸).padEnd(10)} 底=${c.底色}`);
    if (c.问题.length) for (const p of c.问题.slice(0, 8)) console.log(`     ${p}`);
    if (c.问题.length > 8) console.log(`     … 还有 ${c.问题.length - 8} 处`);
}
console.log(`\n${rows.length - bad}/${rows.length} 张卡通过`);
const f = resolve(ROOT, `docs/全节点-${THEME}.png`);
writeFileSync(f, Buffer.from(png, 'base64'));
console.log('截图 → ' + f);
