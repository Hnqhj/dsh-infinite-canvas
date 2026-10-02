/**
 * 主题桥端到端验证：模拟父页面按 DSH 官方 token 注入，量壳层实际生效值。
 *
 * 为什么不能只看截图：截图只能告诉我"变白了"，但**说不出是哪条声明起的作用**。
 * 这里直接量 getComputedStyle 的最终值 —— 如果 token 没注入，量到的会是
 * dsh-shell.css 里的兜底色（#151517），一眼就能分辨。
 *
 * 用法：node .workbuddy/verify/theme-bridge.mjs
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

/**
 * 视口按 **DSH 实际给的宽度** 设，不设手机宽度。
 *
 * 1080px 窗口下 DSH 右栏实测约 620px —— 关键是要**大于 760px 断点吗？不**：
 * 620 < 760，所以窄容器断点仍会命中。为了能同时覆盖两种情况，
 * 这里默认取一个**大于断点**的宽度，专门验证「配色不依赖断点」这件事；
 * 需要验窄容器时用 `--narrow`。
 */
const NARROW = process.argv.includes('--narrow');
const VIEWPORT = NARROW
    ? { width: 460, height: 860 }
    : { width: 1000, height: 860 };
console.log(`视口: ${VIEWPORT.width}×${VIEWPORT.height}${NARROW ? '（窄容器档）' : '（宽容器档，默认）'}`);

/**
 * DSH 官方深/浅两套 token（实测自 app.asar 的 dsh-client-ui-theme）。
 *
 * ⚠️ 这里**刻意做成 DSH 的两层结构**：alias 层的值是 `var(--dsw-static-*)`
 * 引用，static 层才是字面量。之前这个测试用的是「alias 直接给字面量」，
 * 于是它测的是一个 DSH 里根本不存在的场景 —— 真实情况下一旦只送 alias 层，
 * `var()` 断链、声明失效，而这个测试照样全绿。
 * 教训记在 `.workbuddy/verify/probe-var-chain.mjs` 里。
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
            const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
            if (match !== null) {
                clearTimeout(timer);
                resolvePort({ child, port: Number(match[1]) });
            }
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
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined && waiters.has(msg.id)) {
            waiters.get(msg.id)(msg);
            waiters.delete(msg.id);
        }
    };
    const send = (method, params = {}) => new Promise((r) => {
        id += 1;
        waiters.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    return { send, close: () => ws.close() };
}

/**
 * 在页面里模拟父页面 postMessage 注入 token，然后量生效值。
 *
 * ⚠️ **视口必须是「DSH 实际给的宽度」，不是手机宽度。**
 * 上一轮这里用 460px（比窄容器断点 760 还小），于是 760px 断点里的规则
 * 全部生效、截图看着一切正常；而 DSH 右栏在 1080px 窗口下有 600+px 宽，
 * **那条断点根本不匹配** → 真实环境里工具条一直是上游原样。
 * 这类 bug 只会因为「验证视口 ≠ 使用视口」而漏。
 */
async function measure(s, theme, tokens) {
    await s.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    });
    await s.send('Page.navigate', { url: `${BASE}?theme=${theme}` });
    await new Promise((r) => setTimeout(r, 2500));

    // 走真实的 postMessage 通道，和 client.js 发的是同一种消息。
    const payload = JSON.stringify({ source: 'dsh-canvas-host', type: 'theme', payload: { theme, tokens } });
    const expr = `(() => {
        window.postMessage(${payload}, '*');
        return 'sent';
    })()`;
    await s.send('Runtime.evaluate', { expression: expr });
    await new Promise((r) => setTimeout(r, 400));

    /** 探针要读的 token 名：两态的并集。 */
    const NAMES0 = Object.keys(DSH_TOKENS.dark).concat(Object.keys(DSH_TOKENS.light));
    /**
     * 探针正文用「字符串数组 + join」而不是嵌套模板字符串 ——
     * 它自己含 `/rgba?\(([^)]+)\)/` 这种正则，多一层转义就错一层。
     * 拼好后整段塞进 `Runtime.evaluate`。
     */
    const probeBody = [
        "const cs0 = getComputedStyle(document.documentElement);",
        "const root0 = document.documentElement;",
        "const out = { attr: root0.dataset.dshTheme, colorScheme: cs0.colorScheme, tokens: {} };",
        'for (const name of __NAMES__) { out.tokens[name] = cs0.getPropertyValue(name).trim(); }',
        '',
        "const parse = (c) => {",
        "    const m = c.match(/rgba?\\(([^)]+)\\)/);",
        "    if (m === null) return null;",
        "    const p = m[1].split(\",\").map((x) => parseFloat(x));",
        "    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };",
        "};",
        "const lum = (c) => {",
        "    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };",
        "    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);",
        "};",
        "const bgOf = (el) => {",
        "    let n = el;",
        "    while (n !== null && n !== document.documentElement) {",
        "        const bg = parse(getComputedStyle(n).backgroundColor);",
        "        if (bg !== null && bg.a > 0.6) return bg;",
        "        n = n.parentElement;",
        "    }",
        "    return { r: 255, g: 255, b: 255, a: 1 };",
        "};",
        '',
        "const bar = document.querySelector(\".ref-create-bar\");",
        "if (bar !== null) {",
        "    const bs = getComputedStyle(bar);",
        "    out.barBg = bs.backgroundColor;",
        "    out.barBorder = bs.borderTopColor;",
        "    out.barRadius = bs.borderTopLeftRadius;",
        "}",
        "const leftBar = document.querySelector(\".ref-bottom-left\");",
        "if (leftBar !== null) out.leftBarBg = getComputedStyle(leftBar).backgroundColor;",
        "const page = document.querySelector(\".canvas-page\");",
        "out.canvasBg = page === null ? null : getComputedStyle(page).backgroundColor;",
        '',
        "/* 对比度扫描：画布内所有「有直接文字且可见」的元素，算前景与上溯背景的亮度差 */",
        "const items = [];",
        "if (page !== null) {",
        "    for (const el of page.querySelectorAll(\"*\")) {",
        "        let hasText = false;",
        "        for (const n of el.childNodes) {",
        "            if (n.nodeType === 3 && n.textContent.trim() !== \"\") { hasText = true; break; }",
        "        }",
        "        if (!hasText) continue;",
        "        const cs = getComputedStyle(el);",
        "        if (cs.visibility === \"hidden\" || cs.display === \"none\") continue;",
        "        if (Number(cs.opacity) < 0.3) continue;",
        "        const rect = el.getBoundingClientRect();",
        "        if (rect.width < 2 || rect.height < 2) continue;",
        "        const fg = parse(cs.color);",
        "        if (fg === null || fg.a < 0.3) continue;",
        "        const bg = bgOf(el);",
        "        const l1 = lum(fg), l2 = lum(bg);",
        "        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);",
        "        items.push({",
        "            sel: el.tagName.toLowerCase() + \".\" + String(el.className || \"\").split(\" \").slice(0, 2).join(\".\"),",
        "            fg: cs.color,",
        "            bg: \"rgb(\" + Math.round(bg.r) + \", \" + Math.round(bg.g) + \", \" + Math.round(bg.b) + \")\",",
        "            ratio: Math.round(ratio * 100) / 100,",
        "        });",
        "    }",
        "}",
        "out.lowContrast = items;",
        "out.textCount = items.length;",
        "return JSON.stringify(out);",
    ];
    // 拼成完整探针：__NAMES__ 是占位符，替换成 token 名的 JSON 字面量。
    // 不用「当参数传进去」的形式 —— 箭头函数的形参在 CDP 的求值上下文里
    // 行为不稳（实测报 `NAMES0 is not defined`），直接内联最省事。
    const probe = `(() => {
${probeBody.join('\n').replace('__NAMES__', JSON.stringify(NAMES0))}
})()`;
    const res = await s.send('Runtime.evaluate', { expression: probe, returnByValue: true });

    // CDP 不会因为页面里抛异常而 reject：异常会**塞进 result**。
    // 直接 `JSON.parse(res.result.result.value)` 的话，
    // 报错是 `undefined is not valid JSON` —— 完全指不到真正原因。
    // 所以先看有没有异常，把它原样打出来。
    if (res.result?.exceptionDetails !== undefined) {
        const ex = res.result.exceptionDetails;
        const text = ex.exception?.description ?? ex.text ?? '(无描述)';
        throw new Error(`页面内抛异常：\n${String(text).split('\n').slice(0, 6).join('\n')}`);
    }
    if (res.result?.result?.value === undefined) {
        throw new Error(`求值没返回字符串。原始返回：${JSON.stringify(res).slice(0, 500)}`);
    }
    return JSON.parse(res.result.result.value);
}

/**
 * 注入之后截一张图。
 *
 * 必须**注入完再截**，不能只截 `?theme=light` 那个 URL ——
 * 独立打开 embed 页时父页面不在，工具条吃的是 dsh-shell.css 里的兜底深色
 * token，于是深浅两张图会**逐字节相同**（实测过，120758 B = 120758 B）。
 * 截图要看的是"注入 DSH 浅色 token 之后壳层变成什么样"。
 */
async function shoot(s, theme, tokens, out) {
    await measure(s, theme, tokens);   // 复用：导航 + 注入
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`  → 已存 ${out}`);
}

function check(label, actual, expected) {
    const ok = actual === expected;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${actual}${ok ? '' : `  (期望 ${expected})`}`);
    return ok;
}

/**
 * 把注入的 token 值折成 `getComputedStyle` 会给出的 rgb() 形式。
 *
 * 必须比**折算后**的值而不是原字符串：注入的是 `#151517`，而浏览器算出来的
 * 是 `rgb(21, 21, 23)`，直接比字符串会永远不相等 —— 那不是桥坏了，
 * 是两种表示法。
 */
function toRgb(value) {
    if (value.startsWith('#')) {
        const n = Number.parseInt(value.slice(1), 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    }
    return normalizeRgb(value);
}

/**
 * 归一化 CSS 颜色表示法的差异。
 *
 * 只做两件安全的事：压空白、去掉小数尾零（`0.10` → `0.1`）。
 * **不做 hex→rgb 折算** —— 自定义属性用 `getPropertyValue` 读回来的是
 * **原样字符串**（浏览器不会把 `--x: #fff` 算成 `rgb(255,255,255)`），
 * 只有 `backgroundColor` 这类真正参与颜色计算的属性才会被折算。
 * 所以 token 比 token、原样比原样；折算只发生在下面量元素颜色那一步。
 */
function normalizeRgb(value) {
    return String(value)
        .replace(/\s+/g, ' ')
        .replace(/,\s*/g, ',')
        .replace(/(\.\d*?)0+(?=[,)\s]|$)/g, '$1')  // 0.10 → 0.1
        .replace(/\.(?=[,)\s]|$)/, '')            // 0. → 0
        .replace(/,\s*\)/g, ')')
        .trim();
}

const { child, port } = await cdp();
const s = await session(port);
let failures = 0;

try {
    for (const theme of ['dark', 'light']) {
        console.log(`\n【${theme}】父页面注入官方 token 后：`);
        const out = await measure(s, theme, DSH_TOKENS[theme]);
        const T = DSH_TOKENS[theme];

        if (!check('data-dsh-theme', out.attr, theme)) failures += 1;
        if (!check('color-scheme', out.colorScheme, theme)) failures += 1;

        // token 桥：注入的值必须原样出现在 :root 上。
        // 自定义属性读回来是原样字符串，所以直接比（只归一空白与小数尾零）。
        for (const [name, value] of Object.entries(T)) {
            const actual = normalizeRgb(out.tokens[name]);
            const expected = normalizeRgb(value);
            if (actual === expected) {
                check(name, actual, expected);
            } else if (expected.startsWith('var(')) {
                // alias 层是**引用**：读回来必然是解引用后的最终值，不该等于 `var(...)`。
                // 所以要比的是"解引用结果 == 被引用的那个 static 的值"。
                const ref = /var\((--[a-z0-9-]+)\)/.exec(expected);
                if (ref === null) {
                    check(name, actual, expected);
                    continue;
                }
                const refName = ref[1];
                const refExpected = normalizeRgb(T[refName] ?? '');
                if (actual === refExpected) {
                    // 解引用成功 —— 这才是真正要验的。
                    console.log(`  ✓ ${name} 解引用 → ${actual}`);
                } else {
                    console.log(`  ✗ ${name} 解引用失败: ${actual}  (${refName} 应为 ${refExpected})`);
                    failures += 1;
                }
            } else {
                check(name, actual, expected);
            }
        }

        // 画布本体：浅色下**必须跟着变白**（用户要的就是这个）。
        // 上一轮这里断言"恒为深色"，是按旧方案写的；
        // 现在浅色化已实现，浅色下量到深色就是 bug。
        const expectLightCanvas = theme === 'light';
        const canvasIsLight = out.canvasBg === 'rgb(255, 255, 255)';
        if (expectLightCanvas) {
            if (!check('画布本体（浅色下应变白）', out.canvasBg, 'rgb(255, 255, 255)')) failures += 1;
        } else {
            if (!check('画布本体（深色下应保持深）', out.canvasBg, 'rgb(18, 18, 18)')) failures += 1;
        }

        // 壳层元素：底色应等于注入的 bg-layer-1（解引用后）。
        // 元素颜色**会**被浏览器折算成 rgb()，所以两边都过一遍 normalizeRgb。
        // ⚠️ P2.8 后**只有中条**是实底浮岛（bg-layer-1），左右两条按用户要求
        // 打回透明（裸按钮簇）—— 断言跟着改：查 `.ref-create-bar`，
        // 同时断言左条**仍是透明的**（防止有人把浮岛样式加回来）。
        const expectedLayer1 = toRgb(T['--dsw-static-neutral-bluish-875']);
        if (out.barBg !== null) {
            if (!check('创建条（中条）底色取到注入值', normalizeRgb(out.barBg), normalizeRgb(expectedLayer1))) failures += 1;
            console.log(`    圆角: ${out.barRadius}  描边: ${out.barBorder}`);
        } else {
            console.log('  · 工具条不在（正常，跳过）');
        }
        if (out.leftBarBg !== undefined) {
            if (!check('左条保持透明（P2.8 用户决策：不要浮岛）', normalizeRgb(out.leftBarBg), normalizeRgb('rgba(0, 0, 0, 0)'))) failures += 1;
        }

        // ⚠️ 浅色化最容易漏的一类问题：**前景与背景几乎同色 → 文字看不见**。
        // 逐个量「有可见文字的元素」的前景色与它上溯到的背景色，算相对亮度差。
        // 阈值 1.5 偏松（只抓明显不可读），宁可多报也不漏。
        if (theme === 'light' && out.lowContrast !== undefined) {
            const bad = out.lowContrast.filter((x) => x.ratio < 1.5);
            if (bad.length === 0) {
                console.log(`    对比度扫描: ${out.lowContrast.length} 个文字元素，无低于 1.5 的`);
            } else {
                console.log(`    ⚠️ 对比度不足（<1.5）${bad.length} 个：`);
                for (const item of bad.slice(0, 8)) {
                    console.log(`        ${item.sel} 前景 ${item.fg} / 背景 ${item.bg} = ${item.ratio.toFixed(2)}`);
                    failures += 1;
                }
            }
        }

        await shoot(s, theme, DSH_TOKENS[theme], resolve(ROOT, `docs/验证-主题-${theme === 'dark' ? '深色' : '浅色'}.png`));
    }
} finally {
    s.close();
    child.kill();
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项不符`}`);
process.exit(failures === 0 ? 0 : 1);
