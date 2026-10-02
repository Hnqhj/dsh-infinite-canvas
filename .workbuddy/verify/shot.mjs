/**
 * 无头浏览器截图 / 求值工具（CDP）。
 *
 * 不用 `--screenshot` 那条路，因为它用**窗口**尺寸而不是视口尺寸（含浏览器 chrome，
 * 本机实测约 126px），截出来底部会多一条底色，看起来像"背景穿帮"。
 * 这里走 `Emulation.setDeviceMetricsOverride` 精确设定视口，并把页面里的求值结果
 * 直接打回终端 —— 几何问题用 `--eval` 量，比看截图猜快得多。
 *
 * 用法：
 *   node .workbuddy/verify/shot.mjs --url http://127.0.0.1:8791/api/dsh-canvas/embed/index.html \
 *     --out _shot.png --w 900 --h 700 --dpr 2 --clip 0,0,900,120 \
 *     --wait 1500 --eval "document.querySelectorAll('.vue-flow__node').length"
 *
 * 参数：`--w --h` 视口；`--dpr` 像素倍率；`--clip x,y,w,h` 真实裁切；`--full` 整页；
 *      `--wait ms` 等 JS；`--eval <js>` 可重复；`--print` 用打印媒体查询。
 *
 * 四个已知坑都已经在实现里绕开：
 *  1. `clip.scale` 固定为 1（再乘 DPR 会得到 dpr² 倍图，采样坐标全错一倍）；
 *  2. 禁用缓存（profile 是复用的，改了文件不刷新会看到旧版本 → 误判"参数没用"）；
 *  3. 求值表达式先摊平成字符串再序列化（直接 JSON.stringify 一个 Promise 会得到 `{}`）；
 *  4. profile 放数据盘（无头浏览器缓存写满 C 盘会让整条工具链 ENOSPC）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── 参数 ───────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
function value(name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}
function values(name) {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
}

const targetUrl = value('url');
if (targetUrl === null) {
    console.error('缺少 --url');
    process.exit(2);
}
const outPath = resolve(value('out', '_shot.png'));
const width = Number(value('w', '1440'));
const height = Number(value('h', '900'));
const dpr = Number(value('dpr', '1'));
const waitMs = Number(value('wait', '1500'));
const fullPage = flag('full');
const printMode = flag('print');
const clipRaw = value('clip');
const clip = clipRaw === null ? null : (() => {
    const [x, y, w, h] = clipRaw.split(',').map(Number);
    return { x, y, width: w, height: h, scale: 1 };   // scale 恒为 1，见文件头第 1 条
})();
const evals = values('eval');

/* ── 找浏览器 ───────────────────────────────────────────────────────────── */

/**
 * 不写死路径 —— 本机的 Edge 装在 `Application\<版本号>\Microsoft Edge.exe`
 * （而且没有 `msedge.exe`），写死一个绝对路径会直接找不到。所以按"候选目录 +
 * 候选文件名"扫，版本号目录按名字倒序取最新的。
 */
const CANDIDATE_ROOTS = [
    'C:/Program Files (x86)/Microsoft/Edge/Application',
    'C:/Program Files/Microsoft/Edge/Application',
    'C:/Program Files/Google/Chrome/Application',
    'C:/Program Files (x86)/Google/Chrome/Application',
    'C:/Program Files (x86)/Microsoft/EdgeWebView/Application',
    'C:/Users/Administrator/AppData/Local/Google/Chrome/Application',
    '/usr/bin',
];
const EXE_NAMES = ['msedge.exe', 'Microsoft Edge.exe', 'chrome.exe', 'google-chrome'];

function findBrowser() {
    for (const root of CANDIDATE_ROOTS) {
        if (!existsSync(root)) continue;
        // 先看根目录（有些安装把 exe 直接放在 Application 下）。
        for (const name of EXE_NAMES) {
            const direct = `${root}/${name}`;
            if (existsSync(direct)) return direct;
        }
        // 再进版本号子目录，倒序即"最新的优先"。
        let entries = [];
        try {
            entries = readdirSync(root, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort()
                .reverse();
        } catch {
            continue;
        }
        for (const dir of entries) {
            for (const name of EXE_NAMES) {
                const candidate = `${root}/${dir}/${name}`;
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    return undefined;
}

const browser = findBrowser();
if (browser === undefined) {
    console.error('找不到 Edge / Chrome。已扫过：\n  ' + CANDIDATE_ROOTS.join('\n  '));
    process.exit(2);
}
console.log(`browser ${browser}`);

/** profile 放数据盘：无头浏览器会写缓存，塞满 C 盘会让整条工具链报 ENOSPC。 */
const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.edge-profile');
mkdirSync(PROFILE_DIR, { recursive: true });

/* ── CDP 客户端（用 Node 自带的全局 WebSocket，无依赖） ──────────────────── */

class Cdp {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id === undefined) return;
            const entry = this.pending.get(message.id);
            if (entry === undefined) return;
            this.pending.delete(message.id);
            if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
            else entry.resolve(message.result);
        });
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId !== undefined) payload.sessionId = sessionId;
        this.socket.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
            }, 30_000);
        });
    }
}

/* ── 启动 ───────────────────────────────────────────────────────────────── */

const args = [
    '--headless=new',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--enable-unsafe-swiftshader',   // 无 GPU 时软件合成；不要用 --disable-gpu，会让滤镜失效
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    `--user-data-dir=${PROFILE_DIR}`,
    `--disk-cache-dir=${PROFILE_DIR}/cache`,
    '--remote-debugging-port=0',
    'about:blank',
];

const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('等待 DevTools 端点超时')), 25_000);
    child.stderr.on('data', (chunk) => {
        buffer += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
        if (match !== null) {
            clearTimeout(timer);
            resolve(match[1]);
        }
    });
    child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`浏览器提前退出（code ${code}）`));
    });
});

/** 这里 wsUrl 指向 browser 目标；下面再 attach 到页面目标拿会话。 */
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
});
const cdp = new Cdp(socket);

let exitCode = 0;
try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    // profile 是复用的：不关缓存，改了文件后可能仍加载旧版本，"改了没反应"极易误判。
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: dpr, mobile: false,
    }, sessionId);
    if (printMode) await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);

    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
    await new Promise((done) => setTimeout(done, waitMs));

    // 逐条求值并把结果摊平成字符串 —— 直接 JSON.stringify(Promise) 会得到 "{}"。
    for (const expression of evals) {
        const wrapped =
            'Promise.resolve((function(){ try { return (' + expression + '); } ' +
            'catch(e){ return "ERR " + e.message; } })()).then(' +
            'function(v){ return typeof v === "string" ? v : JSON.stringify(v); },' +
            'function(e){ return "ERR " + (e && e.message); })';
        const result = await cdp.send('Runtime.evaluate', {
            expression: wrapped, returnByValue: true, awaitPromise: true,
        }, sessionId);
        console.log(`eval> ${result?.result?.value ?? '(undefined)'}`);
    }

    const shotArgs = { format: 'png', captureBeyondViewport: fullPage };
    // clip 与 full 互斥：给了 clip 就按裁切走。
    if (clip !== null) {
        const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
        const content = metrics.cssContentSize ?? { x: 0, y: 0 };
        shotArgs.clip = {
            ...clip,
            x: clip.x + (content.x ?? 0),
            y: clip.y + (content.y ?? 0),
        };
    }
    const { data } = await cdp.send('Page.captureScreenshot', shotArgs, sessionId);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(data, 'base64'));
    console.log(`saved ${outPath}`);
} catch (error) {
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
} finally {
    try {
        socket.close();
    } catch { /* 已经关了 */ }
    child.kill();
}

process.exit(exitCode);
