/**
 * 全页扫描：**不看类名，只看哪里还是深色的**。
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────────────
 * 前面 `probe-menus.mjs` 已经证明：`.generate-panel` 的覆盖是**生效**的
 * （实测 `rgb(255,255,255)`），可用户截图里画布中央那块明明还是深底白字。
 * 说明**我认错了目标** —— 深色的那块是另一个元素。
 *
 * 认错目标的原因很具体：我按「哪个面板没被覆盖」去查，而实际上
 * 「面板」这个假设本身可能就是错的。所以这个脚本**不预设任何类名**：
 * 遍历整页所有元素，按「实底且亮度低」筛出来，再按「面积」排序，
 * 让人能一眼看出哪块最大 —— 那就是截图里最显眼的那块。
 *
 * 配套输出「点击链路」：报告这些深色元素能不能被关掉/切走，
 * 因为面板类元素常常有第二个状态（展开/收起）导致扫不到。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PORT = 9700 + (process.pid % 150);
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-scanall-profile');
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'light';
/** 画布空白处点击会把选中态清掉，可能关掉面板；默认不点。 */
const NUDGE = process.argv.includes('--nudge');
/**
 * 复现用户截图里的**展开态**：画布菜单 + 生成面板同时打开。
 * 实测教训：默认状态下全页只有 html/body 是深底（那是 DSH 外壳色，
 * 被 iframe 里的画布盖住，正常）—— 所有深色浮层都是**按需渲染**的，
 * 不点开就一个都扫不到。这正是技能 §3.18 说的那个坑的又一次复现。
 */
const SCENE = process.argv.includes('--scene');
const TOKENS = loadDshTokens();

const SCAN = (theme, nudge, scene) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

  ${nudge ? "document.querySelector('.canvas-stage')?.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); await sleep(200);" : ''}

  const opened = [];
  ${scene ? `
  // 用户截图里是**多个浮层同时可见**：画布菜单（顶栏）+ 生成面板（画布中央）。
  //
  // ⚠️ 下面这些选择器写在被注入的模板字符串里，**属性值一律用单引号** ——
  // 用双引号会提前闭合外层模板字符串，页面侧变成语法错误，
  // 而 CDP 只回一句 "Uncaught"，完全指不到位置（实测踩过）。
  const gen = document.querySelector('[title=\\'生成图片或视频\\']');
  if (gen) { gen.click(); await sleep(300); }
  opened.push('生成面板 → ' + (document.querySelector('.generate-panel') ? '已开' : '没开'));
  const menu = document.querySelector('.ref-title');
  if (menu) { menu.click(); await sleep(300); }
  opened.push('画布菜单 → ' + (document.querySelector('.canvas-menu-card') ? '已开' : '没开'));
  // 右键上下文菜单：跟 .canvas-menu-card 是同一套配色（上游注释自己写的），
  // 所以它必须一起进验收范围 —— 否则改了卡片漏了菜单，还是一块黑斑。
  const stage = document.querySelector('.canvas-stage');
  if (stage) {
    stage.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 520, clientY: 420 }));
    await sleep(320);
  }
  opened.push('右键菜单 → ' + (document.querySelector('.canvas-context-menu') ? '已开' : '没开'));
  opened.push('同时可见 → ' + [
    document.querySelector('.generate-panel') ? 'generate' : null,
    document.querySelector('.canvas-menu-card') ? 'menu' : null,
    document.querySelector('.canvas-context-menu') ? 'context' : null,
  ].filter(Boolean).join('+'));
  ` : ''}

  const THEME = ${JSON.stringify(theme)};
  // 判据随主题反转：浅色下「太深」是残留，深色下「太浅」是残留
  const dark = THEME === 'light' ? 0.35 : 0.45;
  const word = THEME === 'light' ? '深色残留' : '浅色残留';
  const hitWrong = (l) => (THEME === 'light' ? l < dark : l > dark);

  const all = [...document.querySelectorAll('*')];
  const rows = [];
  /**
   * 按设计豁免 —— 扫到第 5 个假阳性人就会懒得看，扫描器一旦失去可信度
   * 就等于不存在（这条方法论在 P2.7 已经踩过一次）。
   *
   * ① 品牌蓝（浅 #4176e6 / 深 #7aaaff）—— DSH 官方主色，
   *    深色主题下 lum 约 0.7，会被判成「浅色残留」，但它就是主色本身。
   * ② 画布自己的点阵背景 —— 浅色下的浅点、深色下的深点，都是内容不是表面。
   *
   * ⚠️ 这段注释在模板字符串里，**反引号和双引号都不能出现** ——
   * 写了就会提前闭合外层模板字符串，Node 侧直接 SyntaxError，
   * 而报错指向的是「注释那一行」，非常误导（同一个坑踩了三次：
   * 第一次双引号、第二次伪类名的单引号、第三次注释里的反引号）。
   */
  const BRAND = /^rgb\\(\\s*(65, 118, 230|122, 170, 255)\\s*\\)$/;
  const 豁免 = [];
  try {
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) continue;          // 太小的不值得报
    if (r.width * r.height < 900) continue;
    const cs = getComputedStyle(el);
    if (!solid(cs.backgroundColor)) continue;             // 只看**实底**
    const l = lum(cs.backgroundColor);
    if (l === null || !hitWrong(l)) continue;
    if (BRAND.test(cs.backgroundColor)) {
      豁免.push({ cls: (el.className || '').toString().slice(0, 40), bg: cs.backgroundColor, 理由: 'DSH 品牌主色' });
      continue;
    }
    // 面积最大的排前面 —— 用户截图里最显眼的就是面积最大的那块
    rows.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 56),
      bg: cs.backgroundColor,
      color: cs.color,
      面积: Math.round(r.width * r.height),
      尺寸: Math.round(r.width) + 'x' + Math.round(r.height),
      位置: [Math.round(r.x), Math.round(r.y)],
      文本: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 44),
      父: (el.parentElement?.className || '').toString().slice(0, 34),
      // ── 状态快照：这一条是本脚本最重要的产出 ──
      // 「为什么这个元素是深色」几乎总是因为它处于某个**状态**，
      // 而状态本身不在扫描器的关注范围里。实测两次栽在这：
      //   ① 面板是 v-if 的，不点开就一个都扫不到（→ --scene）；
      //   ② 按钮写死了 aria-expanded=true 的实心深底，
      //      而扫描只看「当前生效值」，不告诉你「是哪条规则、哪个状态」。
      // ⚠️ 这段注释放在被注入页面的模板字符串里，**不能用英文双引号** ——
      // 它会提前闭合外层模板字符串（实测报 SyntaxError）。
      // 所以状态名一律用中文描述。
      状态: {
        // ⚠️ 伪类名这里用双引号包，不能用单引号 ——
        // 这段代码在模板字符串里，单引号会被外层的引号规则吃掉，
        // 页面侧直接 SyntaxError（实测踩了三次才定位到）。
        hover: (() => { try { return el.matches(":hover"); } catch { return null; } })(),
        focus: (() => { try { return el.matches(":focus"); } catch { return null; } })(),
        active: (() => { try { return el.matches(":active"); } catch { return null; } })(),
        disabled: el.disabled === true,
        checked: el.getAttribute('aria-checked'),
        pressed: el.getAttribute('aria-pressed'),
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        current: el.getAttribute('aria-current'),
        祖先展开态: (() => {
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            if (n.getAttribute?.('aria-expanded') === 'true') return n.className || n.tagName;
          }
          return null;
        })(),
      },
    });
  }
  } catch (e) {
    // 页面里抛了异常要**把原文带回来**，否则只看到一句 Uncaught，
    // 定位不到是哪一行。实测踩过：一个英文双引号提前闭合了模板字符串，
    // 页面侧就变成了一段语法错误的 JS，报错却完全指不到真正的位置。
    return { 主题: THEME, 页面异常: String(e && e.stack || e), 命中: [] };
  }
  // 面积降序 —— 用户截图里最显眼的就是面积最大的那块，
  // 排前面能让人一眼认出「是不是同一块」。
  rows.sort((a, b) => b.面积 - a.面积);
  const kept = [];
  for (const r of rows) {
    if (kept.length >= 14) break;
    kept.push(r);
  }
  return {
    主题: THEME,
    判据: word + '（实底 lum ' + (THEME === 'light' ? '<' : '>') + dark + '）',
    扫描元素数: all.length,
    打开过程: opened,
    豁免,
    命中: kept,
  };
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
            await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
            await send('Page.navigate', { url: `${BASE}?theme=${THEME}` });
            await new Promise((r) => setTimeout(r, 3000));
            await send('Runtime.evaluate', {
                expression: `window.postMessage({source:'dsh-canvas-host',type:'theme',payload:{theme:${JSON.stringify(THEME)},tokens:${JSON.stringify(TOKENS[THEME])}}},'*'); true`,
            });
            await new Promise((r) => setTimeout(r, 800));

            const r = await send('Runtime.evaluate', { expression: SCAN(THEME, NUDGE, SCENE), returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) {
                // ⚠️ 别只把 `text` 抛出去（它就一句 "Uncaught"）——
                // `exception` 里有真实的行列与源码片段，这才是能定位的信息。
                // 技能 §3.12 记的就是这条：Runtime.evaluate 不会因页面抛异常而 reject，
                // 异常**只**出现在 exceptionDetails 里，必须自己取。
                const d = r.exceptionDetails;
                throw new Error([
                    '页面侧异常：' + (d.text ?? ''),
                    d.exception?.description ? '描述: ' + d.exception.description : '',
                    typeof d.lineNumber === 'number' ? `位置: 第 ${d.lineNumber + 1} 行 第 ${(d.columnNumber ?? 0) + 1} 列` : '',
                ].filter(Boolean).join('\n'));
            }
            ws.close();
            edge.kill();
            done(r.result.value);
        })().catch((e) => { edge.kill(); fail(e); });
    });
}

const d = await run();
if (d.页面异常) {
    console.error('\n❌ 页面里抛了异常，原文如下：\n' + d.页面异常 + '\n');
    process.exit(1);
}
console.log(`\n══════ 主题 ${d.主题} · 判据：${d.判据} · 扫了 ${d.扫描元素数} 个 ══════`);
if (d.打开过程?.length) {
    console.log('\n打开过程：');
    for (const s of d.打开过程) console.log(`  ${s}`);
}
if (d.豁免?.length) {
    console.log(`\n按设计豁免 ${d.豁免.length} 个：`);
    for (const x of d.豁免) console.log(`  · .${x.cls}  ${x.bg}  （${x.理由}）`);
}
console.log('');
if (!d.命中.length) {
    console.log('✅ 没有命中（整页没有「实底 + 亮度不对 + 面积够大」的元素）');
} else {
    for (const r of d.命中) {
        console.log(`● ${r.尺寸.padEnd(10)} 面积${String(r.面积).padStart(7)}  @${r.位置.join(',')}`);
        console.log(`   ${r.tag}.${r.cls}`);
        console.log(`   bg=${r.bg}  color=${r.color}`);
        if (r.文本) console.log(`   文本: ${r.文本}`);
        console.log(`   父: .${r.父}`);
        const on = Object.entries(r.状态).filter(([, v]) => v === true || (v && v !== false));
        if (on.length) console.log(`   ⚠ 状态: ${on.map(([k, v]) => `${k}=${v}`).join('  ')}`);
        console.log();
    }
}
