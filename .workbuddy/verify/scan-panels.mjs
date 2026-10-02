/**
 * 逐个打开 8 个浮层面板，扫描每一处的底色/文字色/对比度。
 *
 * ⚠️ 为什么必须这么做（这是上一轮漏掉 `.generate-panel` 的原因）：
 * 面板都是 `v-if` 渲染的，**默认一个都没打开**。
 * 之前那轮"对比度扫描 8 个文字元素全绿"扫的是空态引导 + 三组工具条 ——
 * 8 个面板里的每一个都不在 DOM 里，扫描天然扫不到。
 * 结论：「扫描全绿」不等于「面板没问题」，只等于「打开着的东西没问题」。
 *
 * 修法：先 `click()` 对应的工具条按钮把面板打开，再扫。
 * 打开方式按 `CanvasView.vue` 里 activePanel 的取值反查，
 * 不写死坐标（坐标会随视口和布局变）。
 *
 * 用法：node .workbuddy/verify/scan-panels.mjs [--narrow] [--theme light|dark]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDshTokens } from './dsh-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/Microsoft Edge.exe';
const BASE = 'http://127.0.0.1:8791/api/dsh-canvas/embed/index.html';
const PROFILE = resolve(ROOT, '.workbuddy/verify/.edge-theme-profile');

const NARROW = process.argv.includes('--narrow');
const VIEWPORT = NARROW ? { width: 460, height: 860 } : { width: 1000, height: 860 };
const themeArg = process.argv.find((a) => a.startsWith('--theme='));
const THEME = themeArg === undefined ? 'light' : themeArg.slice('--theme='.length);

/**
 * DSH 官方深/浅 token（与 theme-bridge.mjs 同一份，两处要一起改）。
 * 刻意保持 DSH 的两层结构：alias 层的值是 var() 引用，static 层才是字面量。
 */
/**
 * DSH 官方 token 夹具 —— **从 app.asar 真身实抽，不手抄**。
 *
 * ⚠️ 这个夹具曾经两次漏 token，两次都是同一类静默故障：
 *   ① 漏整个 static 层 → alias 层的 var() 断链 → 声明被丢弃；
 *   ② 漏 button-contrast-fill / switch-thumb / state-error-primary
 *      → 「完成」按钮底色变透明，扫描器报了一个查了三轮的假「对比度 1.13」。
 * 详见 `dsh-tokens.mjs` 的文件头注释。
 */
const DSH_TOKENS = loadDshTokens();

/**
 * 面板清单：`[title="…"]` 定位打开按钮，class 名是扫描范围。
 *
 * ⚠️ **必须用 title 而不是 nth-child**：第一版用 `button:nth-child(2)` 定位，
 * 结果 6 个面板「没打开」—— 而脚本只报「面板没打开」、不报「按钮点错了」，
 * 差点被我读成「这些面板没问题」。用 `title` 之后上游改按钮顺序也不会失效。
 * （`assets` 已从清单里去掉：`CanvasView.vue` 里 `togglePanel('assets')`
 *  落不到任何 `v-if` 上，`activePanel === 'assets'` 也没有对应 section ——
 *  那是上游自己的悬空入口，不是本插件的问题。）
 */
const PANELS = [
    { key: 'library', cls: '.library-panel', open: '[title="资产库"]' },
    { key: 'materials', cls: '.materials-panel', open: '[title="素材"]' },
    { key: 'credits', cls: '.credits-panel', open: '.credits-trigger' },
    { key: 'generate', cls: '.generate-panel', open: '[title="生成图片或视频"]' },
    { key: 'doodle', cls: '.doodle-panel', open: '[title="涂鸦"]' },
    { key: 'shortcuts', cls: '.shortcuts-panel', open: '[title="键盘快捷键"]' },
    { key: 'settings', cls: '.settings-panel', open: '[title="设置"]' },
];

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

/** 面板扫描探针：传面板选择器进去，返回该面板内每一处「底色 + 文字色 + 对比度」。 */
const PROBE = [
    'const SEL = __SEL__;',
    'const panel = document.querySelector(SEL);',
    'if (panel === null) return JSON.stringify({ missing: true });',
    'const parse = (c) => {',
    '    const m = c.match(/rgba?\\(([^)]+)\\)/);',
    '    if (m === null) return null;',
    '    const p = m[1].split(",").map((x) => parseFloat(x));',
    '    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };',
    '};',
    'const lum = (c) => {',
    '    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };',
    '    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);',
    '};',
    'const bgOf = (el) => {',
    '    let n = el;',
    '    while (n !== null) {',
    '        const bg = parse(getComputedStyle(n).backgroundColor);',
    '        if (bg !== null && bg.a > 0.6) return bg;',
    '        n = n.parentElement;',
    '    }',
    '    return { r: 255, g: 255, b: 255, a: 1 };',
    '};',
    /**
     * 面板自身的底色 —— 当作"兜底背景"。
     *
     * 为什么需要它：`.doodle-panel button` 上游是 `background: transparent`，
     * `bgOf` 一路透明上溯到 `documentElement` 只能返回**纯白**兜底。
     * 可它实际坐在**深色面板**上 → 拿纯白去比，算出 `rgb(21,21,23)` vs 白 = 1.13，
     * 报出一条根本不存在的"看不清"。
     *
     * 教训：对比度必须以**元素真实所处的那一层**为基准，
     * 而不是"往上找不到就假定白色"。深色主题下这个假定必错。
     */
    'const panelBg = parse(getComputedStyle(panel).backgroundColor);',
    'const base = (panelBg !== null && panelBg.a > 0.6)',
    '    ? panelBg',
    '    : (parse(getComputedStyle(document.querySelector(".canvas-page")).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 });',
    'const rows = [];',
    'const dbg = [];',
    'for (const el of [panel, ...panel.querySelectorAll("*")]) {',
    '    const cs = getComputedStyle(el);',
    '    if (cs.display === "none" || cs.visibility === "hidden") continue;',
    '    if (Number(cs.opacity) < 0.3) continue;',
    '    const r = el.getBoundingClientRect();',
    '    if (r.width < 2 || r.height < 2) continue;',
    '    /* 调试取证：所有 button 的 own 底 + 命中规则，一次问清"谁是这个元素" */',
        '    if (el.tagName === "BUTTON") {',
        '        const hits = [];',
        '        for (const sheet of document.styleSheets) {',
        '            let lst; try { lst = sheet.cssRules; } catch { continue; }',
        '            const walk = (rs, ctx) => { for (const ru of rs) {',
        '                if (ru.cssRules && ru.conditionText !== undefined) { walk(ru.cssRules, ctx + "@" + ru.conditionText + " "); continue; }',
        '                if (ru.cssRules) { walk(ru.cssRules, ctx); continue; }',
        '                if (ru.selectorText === undefined) continue;',
        '                const bgv = ru.style.backgroundColor || ru.style.background || "";',
        '                if (bgv === "") continue;',
        '                let m = false;',
        '                try { m = el.matches(ru.selectorText); } catch {}',
        '                if (!m) continue;',
        '                const imp = ru.style.getPropertyPriority("background-color");',
        '                hits.push(ctx + ru.selectorText + "{" + bgv + (imp === "important" ? " !important" : "") + "}");',
        '            } };',
        '            walk(lst, "");',
        '        }',
        '        const attr = document.documentElement.dataset.dshTheme ?? "(未设置)";',
        '        const mTheme = attr === "dark" && el.matches(".doodle-panel button:last-of-type");',
        '        dbg.push({ tag: "button", text: el.textContent.trim().slice(0,6), own: cs.backgroundColor, hits,',
        '            attr: attr, mTheme: mTheme,',
        '            mLastOfType: el.matches(".doodle-panel button:last-of-type"),',
        '            mLastChild: el.matches(".doodle-panel button:last-child") });',
        '    }',
    '    /* 身份信息：报出父链与自身 class，扫出来的异常才能直接定位到源码那一行 */',
    '    const chain = [];',
    '    for (let p = el; p !== null && p !== document.body; p = p.parentElement) {',
    '        chain.unshift(p.tagName.toLowerCase() + (p.className ? "." + String(p.className).split(" ")[0] : ""));',
    '    }',
    '    /* 自己有实底 → 它是一个「表面」，要单独判 */',
    '    const own = parse(cs.backgroundColor);',
    /**
     * 「算不算它自己的底」阈值必须是 **0.6**，不能是 0.02。
     *
     * 第一版用 `a > 0.02`，于是 `rgba(0,0,0,0.12)` 这种**近乎透明**的底
     * 被当成实底 → 拿它的亮度去比前景，算出一堆假的「看不清」。
     * 实测：深色下 `.doodle-panel button` 报 `rgb(21,21,23) / rgba(0,0,0,0)` = 1.13，
     * 而它其实**没有任何底色**（透明），真实背景是深色面板 —— 不构成问题。
     *
     * 0.6 与 `bgOf` 上溯时用的阈值一致：**半透明的不算底**，
     * 一致比两套阈值更不容易自相矛盾。
     */
    '    const hasOwnBg = own !== null && own.a > 0.6;',
    '    let hasText = false;',
    '    for (const n of el.childNodes) {',
    '        if (n.nodeType === 3 && n.textContent.trim() !== "") { hasText = true; break; }',
    '    }',
    '    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";',
    '    if (!hasOwnBg && !hasText && !isField) continue;',
    '    const fg = parse(cs.color);',
    '    const bg = hasOwnBg ? own : bgOf(el);',
    '    const realBg = hasOwnBg ? own : (bg.a > 0.6 ? bg : base);',
    '    const out = {',
    '        tag: el.tagName.toLowerCase(),',
    '        cls: String(el.className || "").slice(0, 46),',
    '        chain: chain.join(" > ").slice(-90),',
    '        bg: cs.backgroundColor,',
    '        realBg: "rgb(" + Math.round(realBg.r) + "," + Math.round(realBg.g) + "," + Math.round(realBg.b) + ")",',
    '        hasOwn: hasOwnBg,',
    '        color: cs.color,',
    '    };',
    '    if (hasOwnBg) {',
    '        out.lum = Math.round(lum(own) * 1000) / 1000;',
    '    }',
    '    if ((hasText || isField) && fg !== null) {',
    '        const l1 = lum(fg), l2 = lum(realBg);',
    '        out.ratio = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;',
    '    }',
    '    rows.push(out);',
    '}',
    'return JSON.stringify({ missing: false, rows, dbg });',
].join('\n');

async function evaluate(s, script) {
    const res = await s.send('Runtime.evaluate', { expression: `(() => {\n${script}\n})()`, returnByValue: true });
    if (res.result?.exceptionDetails !== undefined) {
        const ex = res.result.exceptionDetails;
        throw new Error('页面内抛异常：\n' + String(ex.exception?.description ?? ex.text).split('\n').slice(0, 6).join('\n'));
    }
    if (res.result?.result?.value === undefined) {
        throw new Error('求值没返回字符串：' + JSON.stringify(res).slice(0, 400));
    }
    return JSON.parse(res.result.result.value);
}

const { child, port } = await cdp();
const s = await session(port);
let problems = 0;

try {
    await s.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    });
    await s.send('Page.navigate', { url: `${BASE}?theme=${THEME}` });
    await new Promise((r) => setTimeout(r, 2500));
    const payload = JSON.stringify({ source: 'dsh-canvas-host', type: 'theme', payload: { theme: THEME, tokens: DSH_TOKENS[THEME] } });
    await s.send('Runtime.evaluate', { expression: `window.postMessage(${payload}, '*')` });
    await new Promise((r) => setTimeout(r, 400));

    console.log(`主题 ${THEME} · 视口 ${VIEWPORT.width}px`);
    /**
     * 判据**必须跟着主题反过来**。
     *
     * 第一版只有一条「lum<0.35 = 深色残留」，拿去跑深色主题时
     * 报出 35 处「问题」—— 可深色主题底本来就该深，那 35 处全是正常的。
     * 同理对比度阈值在深色下要放松（深底上的浅字天然高对比，
     * 但 1.24 这种**前景与背景几乎同色**的情况在两个主题下都是真问题）。
     *
     * 所以：
     *   深色残留 = 浅色主题下 lum 偏低的实底 / 深色主题下 lum 偏高的实底
     *   对比度   = 两个主题同一条阈值（1.5），因为它衡量的是「看不看得清」
     */
    if (THEME === 'light') {
        console.log('判据：实底 lum<0.35 = 深色残留（浅色 bg-base 是 #fff，lum≈1.0）');
    } else {
        console.log('判据：实底 lum>0.45 = 浅色残留（深色 bg-base 是 #151517，lum≈0.007）');
    }
    console.log('对比度：两主题同阈值 1.5（它衡量「看不看得清」，与主题无关）');
    console.log('例外（**不是**残留，别当 bug 报）：');
    console.log('  · 品牌蓝 #4176e6 / #7aaaff —— 官方主色，主按钮/开关就该是这个值');
    console.log('  · 涂鸦笔刷的 `i` —— 内联 background 是**笔迹颜色**（内容色），本就不跟随主题');
    console.log('');

    for (const p of PANELS) {
        // 打开：点对应按钮。上面已经点过一轮的按钮在这里会被 toggle 关掉，
        // 所以点完必须以「面板是否在 DOM 里」为判据，而不是以点击是否成功为判据。
        const openScript = [
            'const btn = document.querySelector(' + JSON.stringify(p.open) + ');',
            'if (btn === null) return JSON.stringify("no-button");',
            'btn.click();',
            'return JSON.stringify("clicked");',
        ].join('\n');
        const clicked = await evaluate(s, openScript);
        await new Promise((r) => setTimeout(r, 350));
        const data = await evaluate(s, PROBE.replace('__SEL__', JSON.stringify(p.cls)));

        if (data.missing === true) {
            console.log(`✗ ${p.key.padEnd(10)} 面板没打开（点 ${p.open} → ${clicked}）`);
            problems += 1;
            continue;
        }

        // 「残留」的方向随主题反转：浅色下残留 = 太深，深色下残留 = 太浅。
        const WRONG = THEME === 'light'
            ? (lum) => lum < 0.35
            : (lum) => lum > 0.45;
        const wrongWord = THEME === 'light' ? '深色残留' : '浅色残留';

        /**
         * 三条豁免，**每条都是设计上正确的，不该报**。它们是扫出来的「假阳性」，
         * 而假阳性必须消掉 —— 留着的后果是扫到第 5 个的时候人就懒得看了，
         * 扫描器一旦失去可信度就等于不存在。
         *  ① 品牌蓝 —— DSH 官方主色（浅 #4176e6 / 深 #7aaaff），
         *     主按钮/开关/选中态就该是这个值。它「深」但那是**语义色**，
         *     不是忘了改的硬编码。
         *  ② 涂鸦笔刷 `<i>` —— `CanvasView.vue:3161` 是 `v-for` 的笔迹色板，
         *     `:style="{ background: color }"` 是**用户选的笔迹颜色**（内容色），
         *     本来就不该跟随主题。按类名豁免，不按颜色豁免（它是灰的）。
         *  ③ 滑杆 `input[type=range]` —— `CanvasView.vue` 写的是 `<input
         *     v-model.number 绑定 doodleWidth、type 为 range 的那个 input，**没有 class**，
         *     Vue 给它的 className 是字符串 input（HTML 元素名兜底），
         *     而 tag 本身就是 input。实测它的 computed background 是
         *     rgba(0,0,0,0)（浏览器自绘轨道），拿这个去比前景必然算出
         *     一条假的 1.13。**按 tag + 无 class 判，别按 class 字符串判。**
         */
        const isBrand = (c) => c === 'rgb(65, 118, 230)' || c === 'rgb(122, 170, 255)';
        const exemptRow = (r) => {
            if (r.lum === undefined || !WRONG(r.lum)) return false;
            if (isBrand(r.bg)) return true;                       // 品牌蓝
            if (r.tag === 'i') return true;                       // 笔迹色板（内容色）
            if (r.tag === 'input') return true;                   // range 滑杆，浏览器自绘
            return false;
        };
        const surfaces = (data.rows ?? []).filter(
            (r) => r.lum !== undefined && WRONG(r.lum) && !exemptRow(r),
        );
        const exempt = (data.rows ?? []).filter(exemptRow);
        const lowText = (data.rows ?? []).filter((r) => r.ratio !== undefined && r.ratio < 1.5);

        const bad = surfaces.length + lowText.length;
        problems += bad;
        const mark = bad === 0 ? '✓' : '✗';
        console.log(
            `${mark} ${p.key.padEnd(10)} ${String(data.rows.length).padStart(3)} 个表面/文字元素，` +
            `${wrongWord} ${surfaces.length}，文字看不清 ${lowText.length}` +
            (exempt.length > 0 ? `（${exempt.length} 个按设计豁免）` : ''),
        );
        // 顺手截一张这个面板开着时的图 —— 扫描器证明「数值对」，截图证明「看起来对」
        if (process.env.SHOOT === '1') {
            const shot = await s.send('Page.captureScreenshot', { format: 'png' });
            const out = resolve(ROOT, `docs/面板-${THEME}-${p.key}.png`);
            writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
            console.log(`      → 已存 ${out.split('/').pop()}`);
        }

        for (const r of surfaces) {
            console.log(`      ${wrongWord} ${r.bg}  lum=${r.lum}  .${r.cls || r.tag}`);
        }
        for (const r of lowText) {
            console.log(`      看不清 ${r.color} / ${r.bg} = ${r.ratio}  （判定用的底 = ${r.realBg}）`);
            console.log(`        ${r.chain}`);
            for (const d of (data.dbg ?? [])) {
                console.log(`        [button "${d.text}"] own=${d.own} attr=${d.attr} mTheme=${d.mTheme} lastOfType=${d.mLastOfType} lastChild=${d.mLastChild}`);
                for (const h of d.hits) console.log(`            命中 ${h}`);
            }
        }
    }
} finally {
    s.close();
    child.kill();
}

console.log(`\n${problems === 0 ? '全部通过' : `${problems} 处问题`}`);
process.exit(problems === 0 ? 0 : 1);
