/**
 * 冒烟测试 —— 在真实 `http.Server` 上把「工具 → 桥 → HTTP 面 → 画布」整条链路跑一遍。
 *
 * 不需要 DSH、不需要浏览器、不需要模型：宿主半是纯 Node，画布的命令层
 * （`lib/embed/canvas-commands.js`）也是纯逻辑。所以这条链路的每一段都能在
 * 进程里验完，剩下真正不可测的只有"iframe 能不能加载"和"信任栅栏放不放行"。
 *
 * 覆盖四层：
 *
 *   A 契约层   命令语义、参数收敛、错误文案、7 值 kind 与节点类型的投影
 *   B 挂载面   端点清单、静态托管、路径逃逸、方法/体积/JSON 的拒绝
 *   C 命令闭环 长轮询、只交付一次、回执结算、超时、队列上限、会话限定
 *   D 工具层   Agent 工具的端到端往返与文本输出
 *
 * 跑法：`node tools/smoke-test.mjs`（或 `npm test`）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridge } from '../lib/bridge.js';
import { registerInfiniteCanvasRoutes, ROUTE_PREFIX } from '../lib/routes.js';
import { resolveEmbedPath, EMBED_ROOT } from '../lib/embed.js';
import { buildToolDefinitions, resolveSessionId } from '../lib/tools.js';
import { CANVAS_COMMAND_ACTIONS, CANVAS_EXTENDED_ACTIONS, NODE_TYPES } from '../lib/protocol.js';
import {
    CARD_KINDS,
    NODE_TYPE_FOR_KIND,
    MIN_ZOOM,
    MAX_ZOOM,
    createModel,
    runCanvasCommand,
} from '../lib/embed/canvas-commands.js';

/** 仓库根：读源码做静态断言时用（B10 要查 client.js 与 dsh-shell.css）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── 测试脚手架 ─────────────────────────────────────────────────────────── */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 取 JSON 响应；顺便把状态码与原始文本带出来，断言里都要用。 */
async function request(url, init) {
    const response = await fetch(url, init);
    const body = await response.text();
    let json = null;
    try {
        json = JSON.parse(body);
    } catch {
        /* 非 JSON 是预期内的情况（embed 文件、纯文本错误） */
    }
    return { status: response.status, headers: response.headers, body, json };
}

const postJson = (url, payload) => request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

/** DSH 的 `webServer.register` 在我们这里的替身：只允许一条路由。 */
function createFakeWebServer() {
    let handler = null;
    return {
        register(options) {
            if (handler !== null) throw new Error(`duplicate route: ${options.path}`);
            handler = options.handler;
            return () => { handler = null; };
        },
        get handler() { return handler; },
    };
}

/**
 * 起一套完整的宿主半。
 *
 * @param options - `bridge` 传给 `createBridge`；`gate` 是信任栅栏（默认不拦）。
 */
async function harness(options = {}) {
    const bridge = createBridge({
        commandTimeoutMs: 1_500,
        pollHoldMs: 400,
        maxQueued: 6,
        ...(options.bridge ?? {}),
    });
    const webServer = createFakeWebServer();
    const gate = options.gate ?? (() => undefined);
    const disposeRoutes = registerInfiniteCanvasRoutes(webServer, gate, bridge);
    const server = createServer((req, res) => { void webServer.handler(req, res); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`;
    return {
        bridge,
        base,
        async close() {
            bridge.dispose();
            disposeRoute(disposeRoutes);
            await new Promise((done) => server.close(done));
        },
    };
}

function disposeRoute(disposer) {
    if (typeof disposer === 'function') disposer();
}

/**
 * 假浏览器：用真实的长轮询循环扮演右侧栏里的画布面板。
 *
 * 命令处理走真画布命令层（`runCanvasCommand`），所以这一层不是"另写一套假的"，
 * 而是把同一份契约换个地方执行。
 */
class FakeBrowser {
    constructor(base, options = {}) {
        this.base = base;
        this.sessionId = options.sessionId ?? 's1';
        this.handlers = options.handlers ?? {};
        this.cursor = 0;
        this.running = false;
        this.seen = [];
        this.replies = [];
    }

    start() {
        if (this.running) return this;
        this.running = true;
        this.controller = new AbortController();
        this.loopPromise = this.run();
        return this;
    }

    async run() {
        while (this.running) {
            let payload;
            try {
                const response = await fetch(
                    `${this.base}/next?cursor=${this.cursor}&sessionId=${encodeURIComponent(this.sessionId)}`,
                    { signal: this.controller.signal },
                );
                payload = await response.json();
            } catch {
                break;
            }
            const seq = Number(payload?.seq);
            if (Number.isFinite(seq) && seq > this.cursor) this.cursor = seq;
            for (const command of payload?.commands ?? []) {
                this.seen.push(command);
                await this.handle(command);
            }
        }
    }

    async handle(command) {
        const handler = this.handlers[command.action];
        if (typeof handler !== 'function') {
            await this.reply(command.requestId, undefined, `未实现：${command.action}`);
            return;
        }
        try {
            await this.reply(command.requestId, await handler(command.params ?? {}));
        } catch (error) {
            await this.reply(command.requestId, undefined,
                error instanceof Error ? error.message : String(error));
        }
    }

    async reply(requestId, result, error) {
        const body = { requestId };
        if (error !== undefined) body.error = error;
        else body.result = result === undefined ? null : result;
        // 先登记再发请求：命令的结果一结算，`dispatch()` 就 resolve 了，
        // 那时测试已经在读这个数组 —— 后 push 会稳定地读不到（这不是产品 bug，
        // 是测试自己的竞态）。状态码发完再回填。
        const entry = { requestId, result, error, status: null };
        this.replies.push(entry);
        const response = await postJson(`${this.base}/result`, body);
        entry.status = response.status;
        return response;
    }

    stop() {
        this.running = false;
        this.controller?.abort();
    }
}

/** 用真画布命令层造一套命令处理器。 */
function modelHandlers(model) {
    const handlers = {};
    for (const action of [
        'get_canvas', 'add_card', 'move_card', 'delete_card',
        'select_card', 'set_view', 'open_panel', 'run_agent',
    ]) {
        handlers[action] = (params) => runCanvasCommand(model.commandContext, {
            requestId: `local-${action}`,
            action,
            params,
        });
    }
    return handlers;
}

/** 睡一小会儿：超时类的断言要用它制造"还没到点"的时刻。 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 等到条件成立（带上限），用于等异步的命令交付。 */
async function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((done) => setTimeout(done, 15));
    }
    throw new Error(`等待超时（${timeoutMs} ms）：条件始终不成立`);
}

/* ══ A 契约层 ═══════════════════════════════════════════════════════════ */

test('A1 每条 kind 都映射到真画布的节点类型', () => {
    assert.deepEqual([...CARD_KINDS], [
        'scene', 'character', 'note', 'text', 'board', 'video', 'audio',
    ]);
    for (const kind of CARD_KINDS) {
        assert.equal(typeof NODE_TYPE_FOR_KIND[kind], 'string', `${kind} 缺少节点类型`);
    }
    assert.equal(NODE_TYPE_FOR_KIND.board, 'storyboard_shot');
    assert.equal(NODE_TYPE_FOR_KIND.audio, 'asset_input');
});

test('A2 get_canvas 的字段名与真画布一致（改它就是改契约）', () => {
    const model = createModel();
    model.create({ kind: 'scene', title: '甲' }, { x: 10, y: 20 });
    const state = runCanvasCommand(model.commandContext, { requestId: 'r1', action: 'get_canvas' });

    assert.deepEqual(Object.keys(state).sort(), [
        'activePanel', 'nodes', 'selectedId', 'selectedIds', 'strokes', 'viewport',
    ]);
    assert.deepEqual(Object.keys(state.nodes[0]).sort(), ['id', 'kind', 'title', 'type', 'x', 'y']);
    assert.deepEqual(Object.keys(state.viewport).sort(), ['offset', 'zoom']);
    assert.deepEqual(Object.keys(state.viewport.offset).sort(), ['x', 'y']);
});

test('A3 add_card 的默认值、投影与 audio 的 media_type', () => {
    const model = createModel();

    const fallback = runCanvasCommand(model.commandContext, { requestId: 'r', action: 'add_card', params: {} });
    assert.equal(fallback.kind, 'note', 'kind 省略时按 note 处理');

    const illegal = runCanvasCommand(model.commandContext, {
        requestId: 'r', action: 'add_card', params: { kind: '不存在的种类' },
    });
    assert.equal(illegal.kind, 'note', '非法 kind 回落成 note 而不是抛错');

    const audio = runCanvasCommand(model.commandContext, {
        requestId: 'r', action: 'add_card', params: { kind: 'audio', title: '环境声' },
    });
    assert.equal(audio.type, 'asset_input');
    assert.equal(audio.media_type, 'audio', 'audio 必须带 media_type');

    const placed = runCanvasCommand(model.commandContext, {
        requestId: 'r', action: 'add_card', params: { kind: 'scene', x: 700, y: '800' },
    });
    assert.equal(placed.x, 700);
    assert.equal(placed.y, 800, '字符串数字要被收敛成数字');
});

test('A4 卡片 id 是数字，且每次新建都递增', () => {
    const model = createModel();
    const first = model.create({ kind: 'note' });
    const second = model.create({ kind: 'note' });
    assert.equal(typeof first.id, 'number');
    assert.equal(second.id, first.id + 1);
});

test('A5 move / delete / select 对未知 id 抛真画布同款错误', () => {
    const model = createModel();
    const ctx = model.commandContext;
    for (const action of ['move_card', 'delete_card', 'select_card']) {
        assert.throws(
            () => runCanvasCommand(ctx, { requestId: 'r', action, params: { id: 999 } }),
            /找不到指定卡片/,
            `${action} 应当抛"找不到指定卡片"`,
        );
    }
    assert.throws(
        () => runCanvasCommand(ctx, { requestId: 'r', action: 'move_card', params: {} }),
        /参数 id 必须是数字/,
    );
});

test('A6 set_view 夹紧缩放、支持局部更新与 fit', () => {
    const model = createModel();
    const ctx = model.commandContext;
    model.create({ kind: 'note' }, { x: 0, y: 0 });

    const tooBig = runCanvasCommand(ctx, { requestId: 'r', action: 'set_view', params: { zoom: 99 } });
    assert.equal(tooBig.zoom, MAX_ZOOM);

    const tooSmall = runCanvasCommand(ctx, { requestId: 'r', action: 'set_view', params: { zoom: 0.001 } });
    assert.equal(tooSmall.zoom, MIN_ZOOM);

    runCanvasCommand(ctx, { requestId: 'r', action: 'set_view', params: { zoom: 1, x: 30, y: 40 } });
    const partial = runCanvasCommand(ctx, { requestId: 'r', action: 'set_view', params: { zoom: 1.5 } });
    assert.deepEqual(partial.offset, { x: 30, y: 40 }, '只给 zoom 时位移必须保留');
    assert.equal(partial.zoom, 1.5);

    const fitted = runCanvasCommand(ctx, { requestId: 'r', action: 'set_view', params: { fit: true } });
    assert.ok(Number.isFinite(fitted.zoom));
});

test('A7 open_panel 只认 8 个面板 id', () => {
    const model = createModel();
    const ok = runCanvasCommand(model.commandContext, {
        requestId: 'r', action: 'open_panel', params: { panel: 'assets' },
    });
    assert.deepEqual(ok, { panel: 'assets' });
    assert.equal(model.panel, 'assets');
    assert.throws(
        () => runCanvasCommand(model.commandContext, {
            requestId: 'r', action: 'open_panel', params: { panel: 'nothing' },
        }),
        /不支持的面板/,
    );
});

test('A8 run_agent 是关键词占位（与真画布当前行为一致）', () => {
    const model = createModel();
    const ctx = model.commandContext;

    runCanvasCommand(ctx, { requestId: 'r', action: 'run_agent', params: { prompt: '生成3个变体' } });
    assert.equal(model.cards.length, 3, '含"变体"应建 3 张场景卡');
    assert.ok(model.cards.every((card) => card.kind === 'scene'));

    assert.throws(
        () => runCanvasCommand(ctx, { requestId: 'r', action: 'run_agent', params: { prompt: '   ' } }),
        /参数 prompt 不能为空/,
    );

    const before = model.cards.length;
    runCanvasCommand(ctx, { requestId: 'r', action: 'run_agent', params: { prompt: '把这段拆成分镜' } });
    assert.equal(model.cards.length, before + 1, '其它指令建 1 张场景卡');
});

test('A9 未知动作抛错而不是静默成功', () => {
    const model = createModel();
    assert.throws(
        () => runCanvasCommand(model.commandContext, { requestId: 'r', action: 'nope' }),
        /不支持的画布命令：nope/,
    );
});

test('A10 状态变更会通知外壳（渲染不能靠轮询）', () => {
    let calls = 0;
    const model = createModel({ onChange: () => { calls += 1; } });
    runCanvasCommand(model.commandContext, { requestId: 'r', action: 'add_card', params: {} });
    runCanvasCommand(model.commandContext, { requestId: 'r', action: 'select_card', params: { id: 1 } });
    assert.equal(calls, 2);
});

test('A11 外壳抛错不会让数据变更回滚', () => {
    const model = createModel({ onChange: () => { throw new Error('渲染炸了'); } });
    assert.doesNotThrow(() => {
        runCanvasCommand(model.commandContext, { requestId: 'r', action: 'add_card', params: {} });
    });
    assert.equal(model.cards.length, 1);
});

/* ══ B 挂载面 ═══════════════════════════════════════════════════════════ */

test('B1 端点清单与状态快照', async () => {
    const h = await harness();
    try {
        const index = await request(`${h.base}/`);
        assert.equal(index.status, 200);
        assert.deepEqual(index.json.endpoints, ['status', 'next', 'result', 'dispatch', 'embed']);

        const status = await request(`${h.base}/status`);
        assert.equal(status.status, 200);
        assert.equal(status.json.autoOpenPanel, false, '缺省不开自动打开');
        assert.equal(status.json.browser.connected, false);
        assert.deepEqual(status.json.queued, []);
    } finally {
        await h.close();
    }
});

test('B2 静态托管：真画布入口 / 传输层 / 命令层都在，且是 no-store', async () => {
    const h = await harness();
    try {
        for (const [path, type] of [
            ['/embed/index.html', 'text/html'],
            ['/embed/canvas-transport.js', 'text/javascript'],
            ['/embed/canvas-commands.js', 'text/javascript'],
        ]) {
            const res = await request(`${h.base}${path}`);
            assert.equal(res.status, 200, `${path} 应当存在`);
            assert.ok(res.headers.get('content-type').startsWith(type), `${path} 的内容类型`);
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.ok(Number(res.headers.get('content-length')) > 0);
        }
    } finally {
        await h.close();
    }
});

/**
 * 真画布的关键不变量：**传输层必须在入口模块之前执行**。
 *
 * `canvas-transport.js` 要抢先占住 `window.nexusvaultMcp`，画布挂载时才调
 * `window.nexusvaultMcp?.onCommand(...)` 把处理器交进来（上游 `CanvasView.vue`
 * 顶部 `declare global` 声明的那个接口）。顺序反了画布看到的就是 undefined，
 * 命令一条也进不来 —— 而且**页面上完全看不出异常**：画布照常渲染，
 * 只是所有对话操控都静默失效。所以这条必须由测试钉住。
 */
test('B8 真画布入口：传输层内联在入口模块之前，且产物齐备', async () => {
    const h = await harness();
    try {
        const res = await request(`${h.base}/embed/index.html`);
        assert.equal(res.status, 200);
        const html = res.body;

        const transportAt = html.indexOf('nexusvaultMcp');
        const moduleAt = html.search(/<script[^>]*type="module"/);
        assert.ok(transportAt >= 0, 'index.html 里应当内联了传输层（构建时的 inline 插件负责）');
        assert.ok(moduleAt >= 0, 'index.html 里应当有入口模块');
        assert.ok(
            transportAt < moduleAt,
            `传输层必须在入口模块之前（实际位置：传输层 ${transportAt} / 模块 ${moduleAt}）`,
        );

        // 入口模块引用的那份产物真的在，而且类型正确。
        const src = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
        assert.ok(src, '入口模块应当有 src');
        assert.ok(src.startsWith('./assets/'), `入口应当指向 assets/，实际 ${src}`);
        const entry = await request(`${h.base}/embed/${src.slice(2)}`);
        assert.equal(entry.status, 200, `入口模块 ${src} 应当存在`);
        assert.ok(entry.headers.get('content-type').startsWith('text/javascript'));

        // 样式表同理 —— 画布的观感全在那 952KB 的 CSS 里，缺了就是白页。
        const href = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
        assert.ok(href, '应当有样式表');
        const css = await request(`${h.base}/embed/${href.slice(2)}`);
        assert.equal(css.status, 200, `样式表 ${href} 应当存在`);
        assert.ok(css.headers.get('content-type').startsWith('text/css'));
        assert.ok(Number(css.headers.get('content-length')) > 200_000, '样式表不该是空壳');

        // 资产库清单里的中文文件名必须能被托管层解析出来（会 percent-encode 后到达）。
        const asset = resolveEmbedPath('library-assets/01_%E5%8C%BB%E9%99%A2%E5%A4%A7%E5%8E%85_%E6%AD%A3%E5%BC%8F.png');
        assert.ok(asset, '中文资产文件名应当能解析');
        assert.ok(asset.endsWith('01_医院大厅_正式.png'), `解析结果应当是真实文件名，实际 ${asset}`);
    } finally {
        await h.close();
    }
});

/**
 * 内联副本必须与 `lib/embed/canvas-transport.js` 那份**逐字一致**。
 *
 * 传输层现在有两个落点：磁盘上的独立文件（真源，构建插件读它）和
 * `index.html` 里内联的那份（实际执行的就是它）。它们是同一份内容的两种投放方式，
 * 所以**改了一边忘了重建，另一边就是过期的**—— 而症状极隐蔽：
 * 页面照常渲染、按钮照常能点，只有某条命令行为仍是旧的。
 * P1 实施时改传输层注释就踩过一次。
 *
 * 转义规则与 `build/vite.config.mjs` 的 inline 插件一致：HTML 里没有转义 `</script`
 * 的说法，所以 `</script` 被打断成 `<\/script`。
 */
test('B9 传输层的内联副本与磁盘那份逐字一致', async () => {
    const h = await harness();
    try {
        const html = (await request(`${h.base}/embed/index.html`)).body;
        const disk = (await request(`${h.base}/embed/canvas-transport.js`)).body;
        const escaped = disk.replace(/<\/script/gi, '<\\/script');
        assert.ok(
            html.includes(escaped),
            'index.html 里的内联传输层与 canvas-transport.js 不一致 —— 多半是改了传输层忘了重建（npm run build）',
        );
    } finally {
        await h.close();
    }
});

/**
 * 主题三态的契约。
 *
 * 这里钉的是**三处必须同时成立**的事实，缺一整条链路就静默失效：
 *   ① 首帧内联脚本按 `?theme=` 写 `data-dsh-theme`（否则先闪一下错色）；
 *   ② 桥接受 `tokens` 字段并按 `--dsw-` 前缀放行（否则外壳退回兜底色）；
 *   ③ 画布本体的 `data-theme="dark"` 锁**不能被顺手改掉** ——
 *      那是上游的产品决策（图像工作区深底），改了会掉进只给别的页面写的
 *      浅色分支，观感立刻和用户的开源项目不一致。
 */
test('B10 主题三态：首帧落 data-dsh-theme、桥接 --dsw-* token、画布本体仍锁深色', async () => {
    const h = await harness();
    try {
        const html = (await request(`${h.base}/embed/index.html`)).body;

        // ① 首帧内联脚本。
        assert.ok(
            html.includes("dataset.dshTheme"),
            'index.html 的首帧脚本没有写 data-dsh-theme —— DSH 深色下会先闪一条浅色滚动条',
        );
        assert.ok(
            html.includes("get('theme')"),
            '首帧脚本没有读 URL 上的 ?theme= 参数',
        );
        assert.ok(
            html.includes('meta[name="theme-color"]') || html.includes('name="theme-color"'),
            '没有 theme-color 元信息，DSH 的窗口配色不会跟着走',
        );

        // ② 桥：token 前缀放行 + 只接受 --dsw- 前缀。
        assert.ok(
            html.includes('nexusvaultMcp') || html.includes('installDshBridge'),
            '入口或传输层都没找到（产物不完整）',
        );

        // ③ 画布本体的深色锁仍在 —— 但**理由**不是"上游产品决策"。
        //
        // ⚠️ 这条断言的注释上一版写的是「那是上游产品决策」。**读完整段注释
        // 才发现结论正好相反**：上游 `canvas-flow.css` 原文说那个
        // `background: #101114` 的无条件覆盖「确实是历史遗留而非刻意设计，
        // 若要跟随主题只需删掉那一段」。所以 `data-theme="dark"` 这个锁
        // 只是**上游自己的实现方式**（它没有浅色变体），我们保留它是为了
        // 不去改 4 份画布 CSS 里 480 处硬编码色；浅色化由 dsh-shell.css
        // 的覆盖层完成，而不是靠切这个锁。
        assert.ok(
            html.includes('data-theme="dark"'),
            '画布本体的 data-theme="dark" 锁被去掉了 —— 覆盖层方案依赖它（去掉会同时打乱上游 4 份画布 CSS 的深底假设）',
        );
        assert.ok(
            html.includes("dataset.theme = 'dark'"),
            '首帧脚本没有把画布本体锁成深色',
        );

        // ② 之二：桥的源码在 bundle 里，钉住两条安全属性 ——
        //    只放行 `--dsw-` 前缀（别的变量名一律不写），且拦掉能截断声明的字符。
        //
        // 注意断言只能匹配**语义片段**：打包器会把 `'...'` 换成 `` `...` ``、
        // 把局部变量压成一个字母，所以不能断言具体字面量，只能断言那几个
        // 危险字符和 setProperty 同时出现。
        const bundle = html.match(/src="[^"]*index-[^"]*\.js"/)?.[0];
        assert.ok(bundle !== undefined, '找不到入口 bundle');
        const entry = (await request(`${h.base}/embed/${bundle.replace(/^src="/, '').replace(/"$/, '')}`)).body;
        assert.ok(
            entry.includes('--dsw-'),
            '桥没有按 --dsw- 前缀放行 token',
        );
        for (const char of [';', '}', '<']) {
            assert.ok(
                entry.includes(`includes(\`${char}\`)`) || entry.includes(`includes('${char}')`) || entry.includes(`includes("${char}")`),
                `桥没有拦掉能截断 CSS 声明的字符 ${char} —— 父页面送来的值可能截断后续样式`,
            );
        }
        assert.ok(
            entry.includes('setProperty'),
            '桥没有把 token 写进 CSS 自定义属性',
        );

        // ③ 之二：父页面**必须连 static 层一起送**。
        //
        // DSH 的 token 是两层：alias 层的值是 `var(--dsw-static-*)` 引用，
        // static 层才是字面量。只送 alias 层 → iframe 里 var() 断链 →
        // 整条声明失效 → 工具条吃 dsh-shell.css 的兜底色 → 表现为
        //「DSH 已经切浅色了但画布还是深色」，且没有任何报错。
        // 实测证据见 .workbuddy/verify/probe-var-chain.mjs。
        const client = readFileSync(resolve(ROOT, 'client.js'), 'utf8');
        assert.ok(
            /const STATIC_TOKEN_NAMES = \[/.test(client),
            'client.js 里没有 STATIC_TOKEN_NAMES —— 主题桥只送 alias 层会让 var() 断链',
        );
        const staticBlock = /const STATIC_TOKEN_NAMES = \[([\s\S]*?)\];/.exec(client);
        const staticNames = staticBlock === null
            ? []
            : [...staticBlock[1].matchAll(/--dsw-static-[a-z0-9-]+/g)].map((m) => m[0]);
        assert.ok(
            staticNames.length >= 70,
            `STATIC_TOKEN_NAMES 只有 ${staticNames.length} 条 —— 实测 DSH 的 body 上有 77 个 static token，少了会让部分 alias 断链`,
        );
        assert.ok(
            /for \(let i = 0; i < STATIC_TOKEN_COUNT/.test(client),
            'readDswTokens 没有遍历 STATIC_TOKEN_NAMES —— 定义了名单但没送出，等于没修',
        );

        // ④ 兜底层同样必须是两层（dsh-shell.css 的 :root）。
        const shellCss = readFileSync(resolve(ROOT, 'build/overlay/src/dsh-shell.css'), 'utf8');
        const rootBlock = /:root \{([\s\S]*?)\n\}/.exec(shellCss);
        assert.ok(rootBlock !== null, 'dsh-shell.css 里找不到 :root 兜底块');
        const rootBody = rootBlock?.[1] ?? '';
        assert.ok(
            /--dsw-static-[a-z0-9-]+:/.test(rootBody),
            'dsh-shell.css 的 :root 兜底只给了 alias 层 —— 桥没生效时 var() 会断链',
        );

        // ⑤ 画布浅色化已实现（用户 2026-10-02 拍板：不再保持恒深色）。
        // 上游注释承认锁深色是「历史遗留而非刻意设计」。
        assert.ok(
            /html\[data-dsh-theme='light'\] \.canvas-page/.test(shellCss),
            'dsh-shell.css 里没有浅色画布覆盖层 —— DSH 切浅色时画布还是深色',
        );
        assert.ok(
            /html\[data-dsh-theme='light'\][^{]*\{[^}]*--dsw-alias-bg-layer-3/s.test(shellCss),
            '浅色兜底只给了两层 bg —— layer-1 与 layer-3 同为白色会让悬停/按下反馈消失',
        );

        // ⑥ ⚠️ 断点里不许放配色。
        // 上一版把工具条的底色/描边写在 `@media (max-width: 760px)` 里，
        // 而 DSH 右栏在 1080px 窗口下有 600+px 宽 → 那条断点根本不匹配 →
        // 工具条一直是上游原样。**断点只管布局。**
        //
        // 切块的两个坑（都实测踩过）：
        //  a) 不能用 `@media…{ … \n}` 这种正则 —— 短媒体查询会在遇到文件后面
        //     第一个 `}` 时提前收口，把断点**之外**的内容算进来 → 断言误报。
        //     必须按字符级花括号配对。
        //  b) 正则会**匹配到注释里**的 `@media (max-width: 760px)` 字样
        //     （那段注释正好在讲这个坑），于是从注释里"切"出一个假规则块。
        //     所以必须要求 `@media` 出现在**行首**（前面只有空白）。
        const mediaBlocks = [];
        const mediaRe = /^@media[^{]*\{/gm;
        let mm;
        while ((mm = mediaRe.exec(shellCss)) !== null) {
            let depth = 1;
            let j = mm.index + mm[0].length;
            for (; j < shellCss.length; j += 1) {
                const ch = shellCss[j];
                if (ch === '{') depth += 1;
                else if (ch === '}') { depth -= 1; if (depth === 0) break; }
            }
            mediaBlocks.push(shellCss.slice(mm.index + mm[0].length, j));
        }
        assert.ok(mediaBlocks.length > 0, '窄容器适配的媒体查询不见了');
        for (const block of mediaBlocks) {
            assert.ok(
                !/background:\s*var\(--dsw-/.test(block),
                '媒体查询里出现了 DSH 配色 —— 断点只该管布局，配色放在断点外（全宽度生效）',
            );
        }
        // 配色必须存在于断点之外。删掉块**内容**（连同起始的 `{`），
        // 剩下的就是"断点之外"的部分。
        let outsideMedia = shellCss;
        for (const block of mediaBlocks) {
            outsideMedia = outsideMedia.replace(block, '');
        }
        assert.ok(
            /\.ref-create-bar\s*\{[^}]*background:\s*var\(--dsw-/.test(outsideMedia),
            '工具条的 DSH 底色不在媒体查询之外 —— 宽容器下永远不生效',
        );

        // ⑦ 浅色下「白底白字」的两处漏网（实测对比度 1.12 / 1.13）。
        // 它们是深底假设的硬编码，靠给父元素上色管不到：
        //   · `.canvas-empty-title` 写死 `rgba(240,243,241,.9)`
        //   · `.credits-trigger b` 写死 `#f0f1f4`（颜色不从父 button 继承）
        assert.ok(
            /\.canvas-empty-title\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/.test(shellCss),
            '浅色下没覆盖 .canvas-empty-title —— 标题会白底白字（实测对比度 1.12）',
        );
        assert.ok(
            /\.credits-trigger b\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/.test(shellCss),
            '浅色下没覆盖 .credits-trigger b —— 积分数字会白底白字（实测对比度 1.13）',
        );

        // ⑧ 浮起容器的阴影必须**分主题**；且浮岛**只给中条**。
        //
        // 实测（`.workbuddy/verify/probe-shadow.mjs`，用 CSSOM 枚举命中规则）：
        // 上游**只给中条** `.ref-create-bar` 写了 `box-shadow: 0 8px 30px #0007`
        // （47% 黑，为深底设计），左右两条**一个阴影都没有** ——
        // 中间那条在浅底上既是一团墨，又比两侧高一档。
        // 用户说的"阴影太重"一半是阴影本身，一半是三组不同权重。
        //
        // 阴影值本身按 P2.6 收成 `--canvas-shadow-float`（浅色峰值 47% → 6%）。
        //
        // ⚠️ 但「三组同权重」这个做法后来被用户推翻了（2026-10-02 三次反馈：
        // 「左下角和右下角的图标按钮功能不要浮岛样式，底部中间的保持不变」）。
        // 查上游 `canvas-chrome.css` 947 / 964 行原文才看清：
        // 左右两组本来就是 `background: transparent` 的**裸按钮簇**，
        // 注释写着「按钮簇直接坐画布上」，只有中条是浮岛。
        // P2.5 把三组统一成同权重，等于给裸按钮簇套了三个白盒子：
        // 既多一层没必要的框，又把「主入口 / 次级工具」的层级差抹平了。
        // 所以现在断言的是**层级差存在**，而不是「三组一致」。
        assert.ok(
            (shellCss.match(/--canvas-shadow-float:/g) ?? []).length >= 2,
            '--canvas-shadow-float 只定义了一次 —— 阴影必须分深浅两套，单值一定有一边错',
        );
        assert.ok(
            /\.canvas-page \.ref-create-bar\s*\{[^}]*box-shadow:\s*var\(--canvas-shadow-float\)/.test(outsideMedia),
            '中条创建栏没有收阴影 —— 上游那套 0 8px 30px #0007（47% 黑）在浅色下是一团墨',
        );
        // 左/右必须**显式**打回透明，不能只是「上游恰好是 transparent」。
        // 覆盖层里写出来是为了：① 不依赖上游；② 意图显式，读代码的人看得见。
        assert.ok(
            /\.canvas-page \.ref-bottom-left,\s*\.canvas-page \.ref-bottom-right\s*\{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/.test(outsideMedia),
            '左下 / 右下的工具条没有显式打回透明 —— 用户要求这两组不要浮岛样式',
        );
        // 容器透明了，按钮的 hover 底色必须换成**半透明**的交互色。
        // 实心 `bg-layer-2`（浅 #f5f6f7）压在纯白 `bg-base` 上等于看不见 ——
        // 这条是「去掉浮岛」连带的必改项，不改就是把功能一起去掉。
        assert.ok(
            /\.canvas-page \.ref-bottom-left button:hover,\s*\.canvas-page \.ref-bottom-right button:hover\s*\{[^}]*interactive-bg-hover/.test(outsideMedia),
            '透明容器上的按钮 hover 用了实心底色 —— 压在纯白画布上等于没有 hover 反馈',
        );
        // 变量前缀不能是 --dsw-*：那个前缀在本仓库是 DSH 官方颜色 token，
        // 而 DSH 官方 190 个 token 里**没有任何 shadow/elevation**，
        // 冒用官方前缀会让人以为这是官方规范。
        const shadowDefs = [...shellCss.matchAll(/(--[a-z-]+)-shadow-float:/g)].map((m) => m[1]);
        assert.ok(
            shadowDefs.every((p) => p === '--canvas'),
            `--canvas-shadow-float 的前缀是 ${shadowDefs.join('/')} —— 官方 token 表里没有阴影项，别冒用 --dsw-* 前缀`,
        );

        // ⑨ 浮层面板与空态引导共用同一套阴影。
        // 它们和工具条是同一层「浮在画布上」的容器，阴影一深一浅会让面板
        // 看着比工具条更重。上游给的是 0 14px 45px #0009（60% 黑）。
        assert.ok(
            /\.canvas-page \.floating-panel,\s*\.canvas-page \.canvas-empty-guide\s*\{[^}]*box-shadow:\s*var\(--canvas-shadow-float\)/.test(outsideMedia),
            '浮层面板 / 空态引导没有收阴影 —— 上游那套 60% 的大模糊在两个主题下都过重',
        );

        /**
         * ⑩ ⚠️ 7 个浮层面板的**内部构件**也必须被覆盖（用户 2026-10-02 二次反馈）。
         *
         * 这一条是本项目最贵的一个教训：
         * 上一轮只覆盖了「面板外壳」，扫描也报了「8 个文字元素全绿」——
         * 但那个结论**是真的**却**没有意义**：7 个面板全是 `v-if` 渲染，
         * 默认一个都不在 DOM 里，扫到的只有空态引导 + 三组工具条。
         * 「扫描全绿」被误读成「浅色化做完了」，用户看到截图里的深色面板才发现。
         *
         * **验收扫描必须先把目标「打开」再扫**（见 verify/scan-panels.mjs）。
         *
         * ⚠️⚠️ 判据必须**同时锚定选择器与它声明的属性**，不能只查选择器出现过：
         * 实测（`verify/verify-assertions.mjs` 逐条删规则验证）发现
         * 只查选择器的话 **18 条里有 14 条是虚的** —— 因为同一个选择器
         * 在文件里出现多次（`.library-item` 有 `{}` / `:hover` / `:disabled` 三条，
         * `.generate-pill` 有合并规则与 `:hover` 两条），
         * 删掉其中一条，另一条仍然让断言通过。
         * 「全绿但拦不住」比没有断言更危险，因为它给人虚假的安全感。
         */
        const PANEL_COVERAGE = [
            // [说明, 选择器片段, 该规则必须声明的属性]
            ['生成面板的提示词区（唯一不带 .floating-panel 类的面板）', '.generate-panel textarea', 'color:'],
            ['生成面板的图标瓦片', '.generate-icon', 'background:'],
            ['生成面板的媒体胶囊', '.generate-pill', 'button-floating-fill'],
            ['生成面板的模型名（颜色不从父胶囊继承，必须单独点名）', '.generate-pill b', 'color:'],
            ['生成面板的积分胶囊', '.generate-cost', 'color:'],
            ['生成面板的提交按钮', '.generate-submit', 'state-business-primary'],
            ['生成面板的模型下拉', '.generate-model-menu', 'background:'],
            ['生成面板的分段控件', '.generate-model-tabs', 'background:'],
            ['资产库 / 素材的网格卡', '.library-item {', 'bg-layer-1'],
            ['资产库的缩略图占位', '.library-preview', 'bg-layer-2'],
            ['资产库的标题', '.library-name', 'label-primary'],
            ['涂鸦面板的按钮', '.doodle-panel button {', 'bg-layer-2'],
            ['涂鸦面板的笔刷选中圈（浅色下白圈等于看不见）', '.doodle-panel i.selected', 'state-business-primary'],
            ['涂鸦面板的完成按钮', 'button:last-of-type', 'state-business-primary'],
            ['快捷键面板正文', '.shortcuts-panel p', 'color:'],
            ['设置面板正文', '.settings-panel p {', 'color:'],
            ['设置面板的快照输入框', '.snapshot-save input', 'bg-layer-2'],
            ['设置面板的快照条目', '.snapshot-name', 'bg-layer-1'],
            ['设置面板的快照删除键', '.snapshot-del', 'border'],
            ['设置面板的开关轨道', '.switch {', 'bg-layer-3'],
            ['设置面板的破坏性按钮（上游对比度只有 1.24）', '.settings-panel p .danger', 'state-error-primary'],
            ['面板 header 的关闭按钮（深色下上游那个灰字几乎看不见）', '.panel-close', 'label-secondary'],
            ['加节点面板的条目', '.palette-item', 'bg-layer-1'],
        ];
        for (const [what, sel, prop] of PANEL_COVERAGE) {
            const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            /**
             * 切出「以某选择器行开头、到配对 `}` 为止」的规则块，再看块里有没有那个属性。
             * 一步式大正则做不到这件事 —— 必须先定位块。
             */
            const blocks = [];
            const re = new RegExp(`^html\\[data-dsh-theme[^\\]]*\\][^{]*${esc(sel)}`, 'gm');
            let m;
            while ((m = re.exec(shellCss)) !== null) {
                const from = m.index;
                const braceAt = shellCss.indexOf('{', from);
                if (braceAt < 0) continue;
                let depth = 1;
                let j = braceAt + 1;
                for (; j < shellCss.length; j += 1) {
                    const ch = shellCss[j];
                    if (ch === '{') depth += 1;
                    else if (ch === '}') { depth -= 1; if (depth === 0) break; }
                }
                blocks.push(shellCss.slice(from, j));
            }
            const hit = blocks.some((b) => b.includes(prop));
            assert.ok(
                hit,
                `主题覆盖层里「${what}」没有声明 ${prop}（选择器片段 ${sel}）`,
            );
        }
        assert.ok(
            /state-error-primary/.test(shellCss),
            '破坏性按钮没有用官方的 state-error-primary —— 上游那个 12% 灰底 + 灰字对比度只有 1.24',
        );
        // ⚠️ 官方**没有** state-danger 这个 token；写错不报错，只静默退兜底。
        assert.ok(
            !/var\(--dsw-alias-state-danger/.test(shellCss),
            '用了不存在的 --dsw-alias-state-danger —— 官方危险/错误态叫 state-error-primary / state-error-secondary',
        );
        // 官方**没有任何 radius token**，本插件的圆角必须用 --canvas-* 前缀。
        assert.ok(
            !/var\(--dsw-radius-/.test(shellCss),
            '圆角用了 --dsw-radius-* —— 官方 token 表里没有任何 radius 项，别冒用官方前缀',
        );

        /**
         * ⑪ ⚠️ 覆盖层的改动必须**真的进了产物**。
         *
         * 前面 ①~⑩ 全部只读 `build/overlay/src/dsh-shell.css`（编辑源）。
         * 但构建器编的是 `build/src/`（镜像产物）—— 两份文件不是同一份。
         * `build:only` 不含 `sync-upstream`，所以改完 overlay 跑它会：
         *   **构建成功 → 装进 embed → 一处不报 → 改动根本没进去**。
         * 实测踩过一次：产物 CSS 哈希原地不动（`style-DBFXSH2g.css`），
         * grep 新规则命中 0，而 `npm test` 那时是 38/38 全绿。
         *
         * 所以这里读**产物**（`lib/embed/assets/` 里那个最新的 style-*.css）
         * 做一次抽查。挑的样本是「左右工具条打回透明」这条 ——
         * 它是最近一次改动，且在 overlay 源里是精确的 `background: transparent`
         * + `box-shadow: none`，minify 后仍能按特征串匹配到。
         */
        const embedAssets = resolve(ROOT, 'lib/embed/assets');
        const styleFiles = existsSync(embedAssets)
            ? readdirSync(embedAssets).filter((f) => /^style-.*\.css$/.test(f))
            : [];
        assert.ok(
            styleFiles.length > 0,
            'lib/embed/assets 里没有 style-*.css —— 产物没装进去，B10 ①~⑩ 验的全是没被编进去的源码',
        );
        const latestStyle = readFileSync(resolve(embedAssets, styleFiles.sort().at(-1)), 'utf8');
        // minify 后是 `background:0 0`（`transparent` 被规范化成 0 0），
        // 所以这里只查「没有 box-shadow」这一半 —— 它才是用户可见的那个效果。
        assert.ok(
            /\.canvas-page \.ref-bottom-left,\.canvas-page \.ref-bottom-right\{[^}]*box-shadow:none/.test(latestStyle),
            '产物 CSS 里找不到「左右工具条 box-shadow:none」—— 改动没进产物（多半是只跑了 build:only，没跑 sync）',
        );
        assert.ok(
            /ref-bottom-left button:hover,\.canvas-page \.ref-bottom-right button:hover\{[^}]*interactive-bg-hover/.test(latestStyle),
            '产物 CSS 里找不到「透明容器 hover 用 interactive-bg-hover」—— 改动没进产物',
        );

        /**
         * ⑫ ⚠️ 画布菜单（顶栏下拉 + 右键菜单）必须有覆盖。
         *
         * 这一条也是「**没写**」而不是「写错了」—— 用户 2026-10-02 三次反馈
         * 附真实窗口截图，浅色下顶栏「我的画布」点开的卡片是一块 `#22242b` 深斑。
         * 查下来是覆盖层里 `.canvas-menu-card` **一次都没出现过**。
         *
         * 为什么之前的 7 面板扫描没抓到：它们不在那 7 个 `v-if` 面板清单里
         * （`CanvasView.vue` 里 `projectMenuOpen` 是**另一个**状态），
         * 而且它们是「顶栏 / 画布容器」的一部分，不在 `.canvas-stage` 内。
         *
         * `.canvas-context-menu` 必须一起断言 —— 上游注释自己写了
         * 「与 .canvas-menu-card 同一套：#22242b 平涂 + #383b45 发丝边 + 12px 圆角」，
         * 改一处漏一处，还是一块黑斑。
         */
        assert.ok(
            /:is\(\.canvas-menu-card,\s*\.canvas-context-menu\)/.test(shellCss),
            '画布菜单 / 右键菜单没有被覆盖 —— 它们是顶栏与画布容器的一部分，不在 7 个 v-if 面板清单里',
        );
        // 展开态是**独立的一条**：`[aria-expanded="true"]` 的特异性 (0,4,0)
        // 高于上游那条泛化规则，只写 `:hover` 压不住（实测 why-loses.mjs
        // 把它排到第 8 位，根本没参与竞争）。
        assert.ok(
            /\.canvas-page \.ref-title\[aria-expanded='true'\]\s*\{[^}]*background:\s*var\(--dsw-alias-/.test(shellCss),
            '顶栏画布菜单按钮的展开态没被覆盖 —— 上游给它写死了 #252830 实心深底',
        );
        // 假阳性防护：这两个类名不得被改回具体色值（说明覆盖被上游同款覆盖掉了）
        assert.ok(
            !/\.canvas-menu-card\s*\{[^}]*background:\s*#/.test(shellCss),
            '覆盖层里给 .canvas-menu-card 写了具体色值 —— 应该用 token，否则跟随不了主题',
        );

        /**
         * ⑬ ⚠️ 节点卡（含创作板）必须有浅色覆盖（用户 2026-10-02 四次反馈）。
         *
         * scan-all-nodes.mjs（种 localStorage 落全部 13 种节点）实测：
         * 11 张卡全部深底 —— 通用卡底 #262626（editorial 51 行，10 种共用）+
         * 创作板 #1f1f1f（flow 860 行）。之前三轮没碰它，因为节点卡是
         * localStorage 驱动的，空画布上一张都不在 DOM 里。
         *
         * 断言锚四个最关键的位置：卡基本体 / 创作板本体 / 卡内缩略图 /
         * 浮动工具条（选中态才渲染，最容易漏）。
         * 选中态必须换品牌蓝 —— 上游近白描边（#f1f1f1）浅色下看不见。
         */
        assert.ok(
            /html\[data-dsh-theme='light'\] \.canvas-page \.canvas-stage \.canvas-card\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-1\)/.test(shellCss),
            '节点卡没有浅色覆盖 —— 11 种卡全部还是 #262626 深底',
        );
        assert.ok(
            /html\[data-dsh-theme='light'\] \.canvas-page \.canvas-card\.is-board\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-1\)/.test(shellCss),
            '创作板没有浅色覆盖 —— 它有自己的 #1f1f1f 底，只盖通用卡基压不住它',
        );
        assert.ok(
            /html\[data-dsh-theme='light'\][^{]*\.card-thumb\s*\{[^}]*bg-layer-2/.test(shellCss),
            '节点卡缩略图没有浅色覆盖 —— #222222 压在白卡上是深色补丁',
        );
        assert.ok(
            /html\[data-dsh-theme='light'\][^{]*\.card-toolbar\s*\{[^}]*bg-layer-1/.test(shellCss),
            '节点浮动工具条没有浅色覆盖 —— 选中节点后浮出的 #1e1e1e 胶囊是又一块黑斑',
        );
        assert.ok(
            /html\[data-dsh-theme='light'\][^{]*\.canvas-card\.is-selected\s*\{[^}]*state-business-primary/.test(shellCss),
            '节点选中态没有换品牌蓝 —— 上游近白描边 #f1f1f1 浅色下等于看不见',
        );

        /**
         * ⑭ 覆盖层卫生：重复选择器 / 冒用官方前缀 / token 位混写 hex。
         *
         * 覆盖层 1300+ 行，靠人眼查重复不现实。
         * ⚠️ 用**模块导入**而不是 spawnSync —— Windows 下 spawnSync 子进程
         * 报 EBUSY（本项目第二次踩：P2.6 的 spawnSync cmd.exe 同款），
         * 模块导入在同一进程内跑，毫秒级且无平台问题。
         */
        const { checkOverlayHygiene } = await import(
            // ⚠️ Windows 下动态 import 的绝对路径必须转成 file:// URL（`D:` 会被当协议）
            pathToFileURL(resolve(ROOT, 'tools/verify/check-overlay-hygiene.mjs')).href
        );
        const raw = readFileSync(resolve(ROOT, 'build/overlay/src/dsh-shell.css'), 'utf8');
        const { problems } = checkOverlayHygiene(raw);
        assert.deepEqual(
            problems,
            [],
            `覆盖层卫生检查未通过：\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`,
        );

        /**
         * ⑮ 覆盖层覆盖率：先把上游 4 份画布 CSS 全量过一遍，再对着覆盖层比。
         *
         * 前四条、`⑪`~`⑭` 都是**正向**断言 —— 它们只能证明"改过的那几处是
         * 对的"，对"还有几百处压根没碰过"是全盲的。这也就是为什么这个项目
         * 连着三轮都是用户截图打回来：我没有一条断言会告诉我还剩多少。
         *
         * 这一条是唯一**反向**的：它不检查某个具体选择器，而是问"还有没有漏的"。
         *   维度一 深底色（不透明、亮度 < 0.30）→ 浅色下会是一坨深色
         *   维度二 浅色文字（不透明、亮度 > 0.75）→ 白底上直接隐形
         */
        const { scanGap } = await import(
            pathToFileURL(resolve(ROOT, 'tools/verify/scan-dark-gap.mjs')).href
        );
        const gap = scanGap();
        const fmt = (list) => list.slice(0, 8).map((r) => `  ✗ ${r.file}  ${r.prop}: ${r.lit}  ${r.sel}`).join('\n');
        assert.deepEqual(
            gap.bgGaps,
            [],
            `还有 ${gap.bgGaps.length} 处深底色没被覆盖层碰到（浅色下会是一坨深色）：\n${fmt(gap.bgGaps)}`,
        );
        assert.deepEqual(
            gap.textGaps,
            [],
            `还有 ${gap.textGaps.length} 处浅色文字没被覆盖层碰到（底色一白就隐形）：\n${fmt(gap.textGaps)}`,
        );
    } finally {
        await h.close();
    }
});

test('B3 HEAD 返回长度但没有正文', async () => {    const h = await harness();
    try {
        const res = await request(`${h.base}/embed/index.html`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.ok(Number(res.headers.get('content-length')) > 0);
        assert.equal(res.body, '');
    } finally {
        await h.close();
    }
});

test('B4 路径逃逸被挡住（含二次编码与反斜杠）', async () => {
    assert.equal(resolveEmbedPath('../index.js'), undefined);
    assert.equal(resolveEmbedPath('..%2Findex.js'), undefined);
    assert.equal(resolveEmbedPath('a/../../secret'), undefined);
    assert.equal(resolveEmbedPath('..\\index.js'), undefined);
    assert.equal(resolveEmbedPath('a%00b.js'), undefined);
    assert.ok(resolveEmbedPath('index.html')?.startsWith(EMBED_ROOT));

    const h = await harness();
    try {
        for (const path of ['/embed/../index.js', '/embed/%2e%2e%2findex.js', '/embed/..%5Cindex.js']) {
            const res = await request(`${h.base}${path}`);
            assert.ok(res.status === 400 || res.status === 404, `${path} 被拒绝了（实际 ${res.status}）`);
            assert.ok(!res.body.includes('infinite-canvas:'), `${path} 泄漏了宿主半源码`);
        }
    } finally {
        await h.close();
    }
});

test('B5 不存在的 embed 文件、未知路由、错方法、坏 JSON、超大 body', async () => {
    const h = await harness();
    try {
        const missing = await request(`${h.base}/embed/nope.html`);
        assert.equal(missing.status, 404);
        assert.equal(missing.json.error.code, 'NOT_FOUND');

        const unknown = await request(`${h.base}/whatever`);
        assert.equal(unknown.status, 404);

        const wrongMethod = await request(`${h.base}/status`, { method: 'POST' });
        assert.equal(wrongMethod.status, 405);
        assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');

        const badJson = await postJson(`${h.base}/dispatch`, '{ 不是 json');
        assert.equal(badJson.status, 400);
        assert.equal(badJson.json.error.code, 'BAD_JSON');

        const arrayBody = await postJson(`${h.base}/dispatch`, [1, 2, 3]);
        assert.equal(arrayBody.status, 400, '数组不是合法的请求体');

        const huge = await postJson(`${h.base}/dispatch`, { action: 'ping', pad: 'x'.repeat(80 * 1024) });
        assert.equal(huge.status, 413);
        assert.equal(huge.json.error.code, 'PAYLOAD_TOO_LARGE');

        const noAction = await postJson(`${h.base}/dispatch`, {});
        assert.equal(noAction.status, 400);
    } finally {
        await h.close();
    }
});

test('B6 信任栅栏拒绝时，接口一个字都不做就返回 403', async () => {
    const h = await harness({ gate: () => ({ requestRejection: () => 403 }) });
    try {
        const res = await request(`${h.base}/status`);
        assert.equal(res.status, 403);
        assert.equal(res.json.error.code, 'FORBIDDEN');
        const embed = await request(`${h.base}/embed/index.html`);
        assert.equal(embed.status, 403, 'embed 也不能绕过栅栏');
    } finally {
        await h.close();
    }
});

test('B7 栅栏按请求解析：后出现的 Connection 服务立刻生效', async () => {
    let gateService;
    const h = await harness({ gate: () => gateService });
    try {
        assert.equal((await request(`${h.base}/status`)).status, 200, '没有栅栏时放行');
        gateService = { requestRejection: () => 401 };
        assert.equal((await request(`${h.base}/status`)).status, 401, '栅栏出现后立刻生效');
        gateService = undefined;
        assert.equal((await request(`${h.base}/status`)).status, 200, '栅栏消失后恢复');
    } finally {
        await h.close();
    }
});

/* ══ C 命令闭环 ═════════════════════════════════════════════════════════ */

test('C1 一次完整往返：工具派发 → 长轮询取走 → 回执结算', async () => {
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: { ping: () => ({ echo: 'pong' }) } }).start();
    try {
        await waitFor(() => browser.running);
        const result = await h.bridge.dispatch('ping', {});
        assert.deepEqual(result, { echo: 'pong' });
        assert.equal(browser.seen.length, 1);
        await waitFor(() => browser.replies[0]?.status === 200);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C2 命令只交付一次，取走即从队列消失', async () => {
    const model = createModel();
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(model) }).start();
    try {
        await h.bridge.dispatch('add_card', { kind: 'scene', title: '甲' });
        assert.equal(model.cards.length, 1, '画布应当收到并执行');

        // 再等一个长轮询周期，确认没有第二条重复投递。
        await new Promise((done) => setTimeout(done, 500));
        assert.equal(model.cards.length, 1, 'add_card 绝不能重投 —— 它不是幂等的');
        assert.equal(h.bridge.status().queued.length, 0);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C3 重复或者过期的回执回 404，而不是假装成功', async () => {
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: { ping: () => ({ echo: 'pong' }) } }).start();
    try {
        await h.bridge.dispatch('ping', {});
        const requestId = browser.replies[0].requestId;
        const again = await postJson(`${h.base}/result`, { requestId, result: {} });
        assert.equal(again.status, 404);
        assert.equal(again.json.error.code, 'UNKNOWN_REQUEST');

        const noId = await postJson(`${h.base}/result`, { result: {} });
        assert.equal(noId.status, 400);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C4 画布没开时，超时文案要说清"从未连接过"', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 250 } });
    try {
        await assert.rejects(
            () => h.bridge.dispatch('get_canvas', {}),
            (error) => {
                assert.match(error.message, /超时/);
                assert.match(error.message, /从未连接过/, '要直接指出面板没开过，而不是让人猜');
                assert.match(error.message, /get_canvas/);
                return true;
            },
        );
        // 超时后队列必须清空 —— 否则它会在一段时间后突然被执行。
        assert.equal(h.bridge.status().queued.length, 0);
        assert.equal(h.bridge.status().expired, 1);
    } finally {
        await h.close();
    }
});

test('C5 画布曾经连过但已断开时，文案报出"最后一次连接在几秒前"', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 250, pollHoldMs: 200 } });
    const browser = new FakeBrowser(h.base, { handlers: {} }).start();
    try {
        await waitFor(() => h.bridge.status().browser.polls > 0);
        browser.stop();
        await new Promise((done) => setTimeout(done, 260));
        await assert.rejects(
            () => h.bridge.dispatch('get_canvas', {}),
            (error) => {
                assert.match(error.message, /秒前/);
                return true;
            },
        );
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C6 长轮询在没有命令时挂起到 pollHoldMs 再回空', async () => {
    const h = await harness({ bridge: { pollHoldMs: 300 } });
    try {
        const started = Date.now();
        const res = await request(`${h.base}/next?cursor=0&sessionId=s1`);
        const cost = Date.now() - started;
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.commands, []);
        assert.ok(cost >= 250, `应当挂住约 300ms，实际 ${cost}ms`);
        assert.equal(res.json.browserConnected, true);
    } finally {
        await h.close();
    }
});

test('C7 队列有上限，满了立刻拒绝而不是无限堆积', async () => {
    const h = await harness({ bridge: { maxQueued: 2, commandTimeoutMs: 5_000 } });
    try {
        const swallowed = [];
        swallowed.push(h.bridge.dispatch('ping', {}).catch(() => {}));
        swallowed.push(h.bridge.dispatch('ping', {}).catch(() => {}));
        await assert.rejects(
            () => h.bridge.dispatch('ping', {}),
            /队列已满/,
        );
        assert.equal(h.bridge.status().queued.length, 2);
        await Promise.all(swallowed);
    } finally {
        await h.close();
    }
});

test('C8 画布回错误时，工具侧拿到的是那句错误', async () => {
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: {} }).start();
    try {
        await assert.rejects(
            () => h.bridge.dispatch('move_card', { id: 3 }),
            /未实现：move_card/,
        );
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C9 命令按会话限定：两边都有会话标识时必须相等', async () => {
    const h = await harness();
    const browserA = new FakeBrowser(h.base, { sessionId: 'A', handlers: { ping: () => ({ who: 'A' }) } }).start();
    const browserB = new FakeBrowser(h.base, { sessionId: 'B', handlers: { ping: () => ({ who: 'B' }) } }).start();
    try {
        await new Promise((done) => setTimeout(done, 60));
        const result = await h.bridge.dispatch('ping', {}, { sessionId: 'B' });
        assert.deepEqual(result, { who: 'B' }, '命令不能被 A 抢走');
        assert.equal(browserA.seen.length, 0);
    } finally {
        browserA.stop();
        browserB.stop();
        await h.close();
    }
});

test('C10 会话标识缺失时放行（宁可送达也不要死锁）', async () => {
    const h = await harness();
    const browser = new FakeBrowser(h.base, { sessionId: '', handlers: { ping: () => 'ok' } }).start();
    try {
        assert.equal(await h.bridge.dispatch('ping', {}, { sessionId: 'A' }), 'ok');
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C11 /dispatch 端点：不经过模型也能手工跑通一条命令', async () => {
    const model = createModel();
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(model) }).start();
    try {
        const res = await postJson(`${h.base}/dispatch`, {
            action: 'add_card',
            params: { kind: 'character', title: '林昭' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.equal(res.json.result.title, '林昭');
        assert.equal(model.cards.length, 1);

        const badAction = await postJson(`${h.base}/dispatch`, { action: '' });
        assert.equal(badAction.status, 400);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('C12 卸载时等待中的命令立刻失败，不会挂到超时', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 30_000 } });
    const pending = h.bridge.dispatch('get_canvas', {});
    h.bridge.dispose();
    await assert.rejects(() => pending, /已卸载/);
    await h.close();
});

/* ══ D 工具层 ═══════════════════════════════════════════════════════════ */

const identity = (definition) => definition;
const execInSession = (id) => ({ agent: { session: { header: { id } } } });

test('D1 注册 12 个工具，名字与画布动作对得上', async () => {
    const h = await harness();
    try {
        const tools = buildToolDefinitions(identity, h.bridge);
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            'canvas_add_card', 'canvas_batch', 'canvas_delete_card', 'canvas_get',
            'canvas_move_card', 'canvas_open_panel', 'canvas_ping', 'canvas_run_agent',
            'canvas_select_card', 'canvas_set_card_type', 'canvas_set_view',
            'canvas_update_card',
        ]);
        for (const tool of tools) {
            assert.equal(typeof tool.description, 'string');
            assert.ok(tool.description.length > 10, `${tool.name} 的说明太短，模型会猜`);
            assert.equal(typeof tool.execute, 'function');
            assert.equal(tool.output.schema.type, 'string');
        }
    } finally {
        await h.close();
    }
});

test('D2 canvas_ping 端到端：模型调用 → 画布应答 → 可读文本', async () => {
    const h = await harness();
    const browser = new FakeBrowser(h.base, {
        handlers: { ping: () => ({ echo: 'pong', canvasReady: true }) },
    }).start();
    try {
        const tools = Object.fromEntries(buildToolDefinitions(identity, h.bridge).map((t) => [t.name, t]));
        const text = await tools.canvas_ping.execute({}, execInSession('s1'));
        assert.match(text, /画布已连通/);
        assert.match(text, /往返耗时：\d+ ms/);
        assert.match(text, /pong/);
        assert.match(text, /"connected":true/);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('D3 canvas_get 把画布排成模型能读的表', async () => {
    const model = createModel({ fit: () => {} });
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(model) }).start();
    try {
        runCanvasCommand(model.commandContext, {
            requestId: 'seed', action: 'add_card',
            params: { kind: 'board', title: '镜 01 · 26 秒', x: 560, y: 64 },
        });
        const tools = Object.fromEntries(buildToolDefinitions(identity, h.bridge).map((t) => [t.name, t]));
        const text = await tools.canvas_get.execute({}, execInSession('s1'));
        assert.match(text, /卡片 1 张/);
        assert.match(text, /id\tkind\ttype\t标题\t位置/);
        assert.match(text, /board\tstoryboard_shot\t镜 01 · 26 秒\t\(560, 64\)/);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('D4 工具层的参数收敛与错误文案', async () => {
    const model = createModel({ fit: () => {} });
    const h = await harness();
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(model) }).start();
    try {
        const tools = Object.fromEntries(buildToolDefinitions(identity, h.bridge).map((t) => [t.name, t]));

        // 非法 kind 回落成 note，而不是让整次调用失败。
        const added = await tools.canvas_add_card.execute({ kind: '不存在' }, execInSession('s1'));
        assert.match(added, /（note \/ note）/);

        await assert.rejects(
            () => tools.canvas_move_card.execute({}, execInSession('s1')),
            /参数 id 必须是数字/,
        );
        await assert.rejects(
            () => tools.canvas_open_panel.execute({ panel: '不存在' }, execInSession('s1')),
            /不支持的面板/,
        );
        await assert.rejects(
            () => tools.canvas_run_agent.execute({ prompt: '  ' }, execInSession('s1')),
            /prompt 不能为空/,
        );

        const moved = await tools.canvas_move_card.execute({ id: model.cards[0].id, x: 12, y: 34 }, execInSession('s1'));
        assert.match(moved, /已移动卡片 #1 到 \(12, 34\)/);

        const fitted = await tools.canvas_set_view.execute({ fit: true }, execInSession('s1'));
        assert.match(fitted, /视口已更新/);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('D5 会话标识从 exec.agent.session.header 解析；拿不到就当没有', () => {
    assert.equal(resolveSessionId(execInSession('s1')), 's1');
    assert.equal(resolveSessionId({ agent: { session: { id: 's2' } } }), 's2');
    assert.equal(resolveSessionId({}), null);
    assert.equal(resolveSessionId(undefined), null);
    assert.equal(resolveSessionId(execInSession('   ')), null);
});

/**
 * 写内容那两个工具的参数校验。
 *
 * 为什么单独一条：`canvas_update_card` 有**两种用法**（只改标题 / 只写内容 /
 * 一起改），是最容易出偏的一个工具。三条要卡住：
 *   ① `data` 传数组要被当成"没给"而不是塞进画布；
 *   ② title 和 data 都不给要报错 —— 跑完了什么都没变，不如现在说清楚；
 *   ③ `canvas_set_card_type` 必须拒掉 `canvas_text` 这类不开放转换的类型，
 *      否则模型会拿到一张改不动的字。
 *
 * 假浏览器这里补了三条**我们自己**的动作（镜像契约里没有，所以
 * `modelHandlers()` 不带它们），把"参数对不对"和"动作能不能跑"分开验。
 */
test('D6 写内容工具的参数校验：数组 data、空调用、不开放的类型都要被挡住', async () => {
    const model = createModel({ fit: () => {} });
    const h = await harness();
    const browser = new FakeBrowser(h.base, {
        handlers: {
            ...modelHandlers(model),
            update_card: (params) => ({
                id: params.id,
                title: params.title ?? '原标题',
                kind: 'note',
                type: 'note',
            }),
            set_card_type: (params) => ({
                id: params.id,
                type: params.type,
                kind: 'text',
                title: '原标题',
            }),
        },
    }).start();
    try {
        const tools = Object.fromEntries(buildToolDefinitions(identity, h.bridge).map((t) => [t.name, t]));
        const exec = execInSession('s1');

        await assert.rejects(
            () => tools.canvas_update_card.execute({}, exec),
            /参数 id 必须是数字/,
        );
        await assert.rejects(
            () => tools.canvas_update_card.execute({ id: 1 }, exec),
            /至少要给 title 或 data/,
        );
        // 数组不是"业务字段"，塞进去会把卡片的 data 换成数组 —— 必须挡掉。
        await assert.rejects(
            () => tools.canvas_update_card.execute({ id: 1, data: [1, 2] }, exec),
            /至少要给 title 或 data/,
        );
        await assert.rejects(
            () => tools.canvas_set_card_type.execute({ id: 1, type: 'canvas_text' }, exec),
            /不支持的节点类型/,
        );
        await assert.rejects(
            () => tools.canvas_set_card_type.execute({ id: 1, type: 'group' }, exec),
            /不支持的节点类型/,
        );

        const written = await tools.canvas_update_card.execute({ id: 1, title: '新标题' }, exec);
        assert.match(written, /已更新卡片 #1「新标题」/);

        const converted = await tools.canvas_set_card_type.execute({ id: 1, type: 'entity_prop' }, exec);
        assert.match(converted, /已换成 entity_prop/);
    } finally {
        browser.stop();
        await h.close();
    }
});

/* ══ E 产物契约 ═════════════════════════════════════════════════════════
 *
 * A 组测的是 `lib/embed/canvas-commands.js` —— 那是我们自己抄的**契约镜像**，
 * 构建产物一次都不引用它（`index.html` 里出现 0 次）。后果是：上游把动作改名、
 * 把 `kind` 的投影换掉之后，A 组照样全绿，而真画布的行为早就变了 ——
 * 等到有人在对话里发现「模型说的东西画布不认」，已经晚了半年。
 *
 * 这一组把方向掉过来：**直接读 `lib/embed/` 的构建产物**。契约漂移会被这里挡住，
 * 而不是被重试三次的人工排查发现。
 */

/**
 * 读**命令面所在的那个 chunk**。
 *
 * 为什么不是把 `assets/*.js` 拼成一整段来断言 —— 那样做会被救回来：同一个类型名
 * 常常出现在别的文件里（比如 `_plugin-vue_export-helper` 也带 `--dsw-static-*`
 * 全套类型），只要还有一处，这条断言就是绿的，而真正的契约早搬家了。
 * 契约在哪，就查哪。
 *
 * 判定办法不看文件名（带 hash，会变），看特征：同时定义了全部 8 个动作的那个
 * 文件。压缩器爱怎么写 `case` 不重要 —— 名字对得上就够了。
 */
function readCommandSurface() {
    const dir = resolve(ROOT, 'lib/embed/assets');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
    for (const name of files) {
        const text = readFileSync(resolve(dir, name), 'utf8');
        const hits = CANVAS_COMMAND_ACTIONS.filter((action) => text.includes(action)).length;
        if (hits === CANVAS_COMMAND_ACTIONS.length) return { name, text };
    }
    return null;
}

/**
 * 入口 chunk —— `index.html` 里那个 `assets/index-<hash>.js`。
 *
 * 它和「命令面 chunk」**不是同一个**，而查产物常量时两边都得看：
 * Vite 会把被多处共用的模块提到入口里。实测过一次 —— 我们的 overlay 静态
 * `import` 了 `canvas/types/card`（为了拿 `kindForNode`）之后，`MIN_ZOOM` 就从
 * CanvasView chunk 挪进了入口 chunk，E5 于是假失败了一次。
 * 那次入口 chunk 只涨了 113 字节，不是回归，是查找位置写窄了。
 */
function readEntryChunk() {
    const html = readBuiltIndex();
    const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/u.exec(html);
    if (match === null) return { name: '(入口 chunk 未找到)', text: '' };
    const file = resolve(ROOT, 'lib/embed/assets', match[1]);
    return existsSync(file)
        ? { name: match[1], text: readFileSync(file, 'utf8') }
        : { name: match[1], text: '' };
}

/** 入口页。`index.html` 里内联着传输层，所以它也是产物的一部分。 */
function readBuiltIndex() {
    const file = resolve(ROOT, 'lib/embed/index.html');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** 取命令面，顺手把"压根没构建"这个最常见的前提说清楚。 */
function requireCommandSurface() {
    const surface = readCommandSurface();
    assert.notEqual(surface, null, 'lib/embed 里找不到命令面 —— 先跑一次 `cd build && npm run build`');
    return surface;
}

test('E1 产物的命令面：8 个动作一个都不能少', () => {
    const { name, text } = requireCommandSurface();
    for (const action of CANVAS_COMMAND_ACTIONS) {
        assert.ok(text.includes(action), `${name} 里找不到动作 \`${action}\` —— 上游的命令面变了`);
    }
});

test('E2 产物的 get_canvas：模型要读的字段名都还在', () => {
    // 这几个字段是 `lib/tools.js` 里 formatCanvas 直接读的，改一个就少一列。
    const { name, text } = requireCommandSurface();
    const head = /return\{nodes:[^}]{0,400}/u.exec(text);
    assert.notEqual(head, null, `${name} 里没找到 get_canvas 的返回语句 —— 契约搬了家`);
    for (const field of ['nodes:', 'strokes:', 'viewport:', 'selectedIds:', 'activePanel:']) {
        assert.ok(head[0].includes(field), `get_canvas 的返回里少了 \`${field}\``);
    }
});

test('E3 产物的节点类型表：7 个 kind 的落点都对得上', () => {
    const { name, text } = requireCommandSurface();
    for (const type of [
        'entity_scene', 'entity_character', 'note',
        'gen_text', 'storyboard_shot', 'gen_video', 'asset_input',
    ]) {
        assert.ok(text.includes(type), `${name} 里找不到节点类型 \`${type}\``);
    }
});

test('E4 传输层与画布在产物里真的握上了手', () => {
    // 两端都提到同一个名字，这段握手才算成立：只有一边说话是接不上的。
    assert.ok(readBuiltIndex().includes('nexusvaultMcp'), '入口页没有内联传输层（nexusvaultMcp 不见了）');
    const { name, text } = requireCommandSurface();
    assert.ok(text.includes('nexusvaultMcp'), `${name} 不再使用 nexusvaultMcp —— 换传输线要先改这一组`);
});

test('E5 产物的缩放上下限与协议写的一致', () => {
    const surface = requireCommandSurface();
    const entry = readEntryChunk();
    // 两个 chunk 一起看：共用模块会被 Vite 提到入口里，只查一个会假失败。
    const text = `${surface.text}\n${entry.text}`;
    const where = `${surface.name} + ${entry.name}`;
    // 压缩后 `0.25` 会被写成 `.25`，所以两种写法都认。
    const lower = `${MIN_ZOOM}`.replace(/^0/u, '');
    assert.ok(text.includes(lower), `${where} 里找不到缩放下限 ${MIN_ZOOM}（写作 \`${lower}\`）`);
    assert.ok(text.includes(`${MAX_ZOOM}`), `${where} 里找不到缩放上限 ${MAX_ZOOM}`);
});

/**
 * 我们补的那三条动作**必须真的进了产物**。
 *
 * 这不是废话：它们住在 `build/overlay/src/dsh-commands.ts` 里，而 overlay 要
 * **`npm run build` 之后**才会被铺进 `build/src/` 参与构建。改了 overlay 忘了
 * 重建，源码里看得到、产物里没有，而页面照常能开 —— 症状是模型说"我改不动
 * 卡片"，得查半天。E1 验的是上游那 8 条，这一条验的是我们自己这几条。
 */
test('E6 产物的扩展命令面：我们补的三条动作都进了产物', () => {
    const entry = readEntryChunk();
    for (const action of CANVAS_EXTENDED_ACTIONS) {
        assert.ok(
            entry.text.includes(action),
            `${entry.name} 里找不到扩展动作 ${action} —— 多半是改了 build/overlay/ 忘了 npm run build`,
        );
    }
    // 排障把手也在：真机上量「store 是不是画布那份」全靠它。
    assert.ok(entry.text.includes('__dshExtended'), `${entry.name} 里找不到 __dshExtended 排障把手`);
});

/**
 * 节点注册表里一共有几个 schema 类型。
 *
 * 真源 `build/overlay` 镜像过来的 `apps/web/src/canvas/nodes/registry.ts` 的
 * `NODE_SCHEMAS`（2026-10-03 数是 13）。上游加一个节点类型时这里会红 ——
 * 那是**故意的**：新增类型意味着 `set_card_type` 要重新决定开不开放它。
 */
const EXPECTED_NODE_SCHEMA_COUNT = 13;

/**
 * 宿主侧的 `NODE_TYPES` 必须和产物里的节点注册表对得上。
 *
 * `canvas_set_card_type` 的参数枚举来自 `lib/protocol.js`（手抄的副本），
 * 真源在产物里。两边一旦分叉，模型会拿到一个画布不认的类型，而报错要等它
 * 真的调一次才看得见 —— 所以在这里钉死：协议里列的每一个类型，产物里都得有。
 */
test('E7 宿主侧 NODE_TYPES 与产物注册表对得上', () => {
    const surface = requireCommandSurface();
    const entry = readEntryChunk();
    const text = `${surface.text}\n${entry.text}`;
    const where = `${surface.name} + ${entry.name}`;
    for (const type of NODE_TYPES) {
        assert.ok(text.includes(type), `${where} 里找不到节点类型 ${type}`);
    }
    // 注册表里的类型总数（13）= 能转的（NODE_TYPES）+ 三个不进面板的。
    // 少了说明注册表变了我们没跟上，多了说明混进了不该出现的别名。
    const excluded = ['canvas_text', 'group', 'region'];
    for (const type of excluded) {
        assert.ok(text.includes(type), `${where} 里找不到被排除的类型 ${type}（它应在注册表里，只是不开放转换）`);
    }
    assert.equal(
        NODE_TYPES.length + excluded.length,
        EXPECTED_NODE_SCHEMA_COUNT,
        `注册表类型数对不上：协议 ${NODE_TYPES.length} + 排除 ${excluded.length} ≠ ${EXPECTED_NODE_SCHEMA_COUNT}`,
    );
});

/* ══ F 挂起式等待与冷路径 ═════════════════════════════════════════════════
 *
 * 这两件事都是为了同一件更大的事：**模型发出的第一条命令不该失败**。
 *
 * 挂起式等待把「命令到达 → 面板打开」之间的平均 1.25 秒空耗降到一次往返；
 * 冷路径预算则承认「得先把面板唤醒、再把 iframe 拉起来」比「画布已经在那儿等着」
 * 慢一个量级。两者叠起来，"画布没开时的第一次操作"才有了活路。
 */

test('F1 挂起式 /status：来了命令立刻回，没来就挂在服务端', async () => {
    const h = await harness({ bridge: { sentinelHoldMs: 500, commandTimeoutMs: 3_000 } });
    try {
        // ① 没有更新的命令：请求必须被留在服务端，而不是立刻退回。
        let started = Date.now();
        let res = await request(`${h.base}/status?hold=1&since=5`);
        assert.ok(Date.now() - started >= 400, `应当挂住约 500ms，实际 ${Date.now() - started}ms`);
        assert.equal(res.status, 200);

        // ② 派一条命令：请求要立刻回来，而且命令还得在队列里。
        void h.bridge.dispatch('ping', {}).catch(() => {});
        started = Date.now();
        res = await request(`${h.base}/status?hold=1&since=0`);
        assert.ok(Date.now() - started < 400, '命令一产生就该立刻回答');
        assert.equal(res.json.queued.length, 1, '看一眼不等于取走');

        // ③ 游标已经追上、队列里那条还是旧的：必须继续挂住。
        //    这条挡的是热循环 —— 服务端若「队列非空就回答」，两边会互相追着打。
        started = Date.now();
        await request(`${h.base}/status?hold=1&since=${res.json.seq}`);
        assert.ok(Date.now() - started >= 400, '没有新命令时不该立刻回答');
    } finally {
        await h.close();
    }
});

test('F2 冷路径：画布从未连上时，命令拿到更长的超时', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 200, coldCommandTimeoutMs: 700 } });
    // 开了自动打开才值得等：面板会被唤醒，命令还有机会被取走。
    h.bridge.autoOpenPanel = true;
    try {
        const waiting = h.bridge.dispatch('get_canvas', {});
        await sleep(350);
        assert.equal(h.bridge.status().pending.length, 1, '命令还在等 —— 冷路径不该按常速超时');
        assert.equal(h.bridge.status().queued.length, 1);
        await assert.rejects(() => waiting, /从未连接过/);
    } finally {
        await h.close();
    }
});

test('F3 关掉自动开面板时冷路径不生效 —— 等下去没有意义', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 200, coldCommandTimeoutMs: 5_000 } });
    try {
        assert.equal(h.bridge.autoOpenPanel, false, 'harness 的缺省');
        await assert.rejects(() => h.bridge.dispatch('get_canvas', {}), /超时（200 ms）/);
    } finally {
        await h.close();
    }
});

test('F4 /status 带出宿主半的挂载情况，且必须是引用', async () => {
    const h = await harness();
    try {
        // 宿主半还没交过来时是 `null`：不是 undefined，也不是替它猜一个对象。
        assert.equal((await request(`${h.base}/status`)).json.host, null);

        const state = { web: false, webAttempts: 0, tools: { registered: false, names: [], reason: 'not attempted' } };
        h.bridge.setHostState(state);
        assert.equal((await request(`${h.base}/status`)).json.host.web, false);

        // 引用语义是这里的重点：两半都是懒绑定的，同一份对象后面还会改。
        // 存快照的话 /status 会永远停在注册之前的样子，那还不如不查。
        state.web = true;
        state.tools.names.push('canvas_get');
        const host = (await request(`${h.base}/status`)).json.host;
        assert.equal(host.web, true, '引用丢了的话这里还停在 false');
        assert.deepEqual(host.tools.names, ['canvas_get']);
    } finally {
        await h.close();
    }
});

test('F5 挂起的请求被中断后，服务端照常服务下一个', async () => {
    const h = await harness({ bridge: { sentinelHoldMs: 400 } });
    try {
        const controller = new AbortController();
        const abandoned = request(`${h.base}/status?hold=1&since=99`, { signal: controller.signal });
        await sleep(60);
        controller.abort();
        await Promise.allSettled([abandoned]);

        const res = await request(`${h.base}/status`);
        assert.equal(res.status, 200, '客户端断开不能把这条路由弄坏');
    } finally {
        await h.close();
    }
});

/* ══ G 幂等与批量 ═══════════════════════════════════════════════════════════
 *
 * 这两个能力对应的是同一句实话：**命令走的是网络，超时不等于没执行。**
 *
 * 幂等键让"重投一次"变成安全动作；批量让"改一处要往返一趟"变成一次往返。
 * 少了前一件事，模型不敢在拿不到回执时重试；少了后一件事，铺一批卡片要十几次
 * 往返，中途断一次就留下半截状态。
 */

/** 造一套工具，测试里按名字取用。 */
function toolMap(bridge) {
    return Object.fromEntries(buildToolDefinitions(identity, bridge).map((tool) => [tool.name, tool]));
}

test('G1 幂等键：重投拿回上一次的结果，画布不会被要求执行第二次', async () => {
    const h = await harness();
    const model = createModel();
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(model) }).start();
    try {
        await waitFor(() => h.bridge.status().browser.polls > 0);
        const tools = toolMap(h.bridge);

        const first = await tools.canvas_add_card.execute(
            { kind: 'scene', title: '雨夜街口', clientToken: 'tok-1' }, execInSession('s1'));
        const second = await tools.canvas_add_card.execute(
            { kind: 'scene', title: '雨夜街口', clientToken: 'tok-1' }, execInSession('s1'));

        assert.equal(second, first, '同一把钥匙必须拿回同一份结果');
        assert.equal(browser.seen.length, 1, `画布只该收到 1 条 add_card，实际 ${browser.seen.length} 条`);
        assert.equal(model.cards.length, 1);

        // 换一把钥匙就是一次真正的新建 —— 幂等不是"以后都不许建了"。
        await tools.canvas_add_card.execute(
            { kind: 'scene', title: '雨夜街口', clientToken: 'tok-2' }, execInSession('s1'));
        assert.equal(browser.seen.length, 2);
        assert.equal(model.cards.length, 2);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('G2 幂等键不记住失败 —— 失败之后重投要能真的重来', async () => {
    // 没有浏览器接命令，所以必然超时。
    const h = await harness({ bridge: { commandTimeoutMs: 250 } });
    try {
        const tools = toolMap(h.bridge);
        await assert.rejects(
            () => tools.canvas_add_card.execute({ clientToken: 'tok-x' }, execInSession('s1')),
            /超时/,
        );
        // 第二次必须真的再入队一次，而不是立刻拿回上一次的失败。
        const again = tools.canvas_add_card.execute({ clientToken: 'tok-x' }, execInSession('s1'));
        await waitFor(() => h.bridge.status().queued.length === 1, 1_000);
        await assert.rejects(() => again, /超时/);
    } finally {
        await h.close();
    }
});

test('G3 add_card 的坐标必须成对 —— 真画布会把缺的那个轴置 0', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 3_000 } });
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(createModel()) }).start();
    try {
        await waitFor(() => h.bridge.status().browser.polls > 0);
        const tools = toolMap(h.bridge);
        for (const args of [{ x: 900 }, { y: 200 }]) {
            await assert.rejects(
                () => tools.canvas_add_card.execute(args, execInSession('s1')),
                /x 和 y 必须成对提供/,
                `只给 ${Object.keys(args)[0]} 必须被挡下`,
            );
        }
        // 两个都给、两个都不给，都该放行。
        await tools.canvas_add_card.execute({ x: 900, y: 200 }, execInSession('s1'));
        await tools.canvas_add_card.execute({}, execInSession('s1'));
    } finally {
        browser.stop();
        await h.close();
    }
});

test('G4 批量：顺序执行，中途失败就停，并说清做到了第几步', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 3_000 } });
    const model = createModel();
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(model) }).start();
    try {
        await waitFor(() => h.bridge.status().browser.polls > 0);
        const tools = toolMap(h.bridge);

        await assert.rejects(
            () => tools.canvas_batch.execute({ steps: [] }, execInSession('s1')),
            /steps 不能为空/,
        );

        const report = await tools.canvas_batch.execute({
            steps: [
                { action: 'add_card', params: { title: 'a' } },
                { action: 'add_card', params: { title: 'b' } },
                { action: 'delete_card', params: { id: 999 } },
                { action: 'add_card', params: { title: 'c' } },
            ],
        }, execInSession('s1'));

        assert.match(report, /失败 1/);
        assert.match(report, /找不到指定卡片/);
        assert.ok(!report.includes('「c」'), '失败之后不该继续往下做');
        assert.equal(model.cards.length, 2, '前两步已经落盘，第三步失败 —— 画布没有撤销这一步');

        // 开了 continueOnError 就把剩下的做完，失败原因照样列出来。
        const lenient = await tools.canvas_batch.execute({
            continueOnError: true,
            steps: [
                { action: 'delete_card', params: { id: 999 } },
                { action: 'add_card', params: { title: 'd' } },
            ],
        }, execInSession('s1'));
        assert.match(lenient, /失败 1/);
        assert.ok(lenient.includes('「d」'), 'continueOnError 时后面的步骤仍要执行');
        assert.equal(model.cards.length, 3);
    } finally {
        browser.stop();
        await h.close();
    }
});

test('G5 批量不收 get_canvas：中途要读就用 canvas_get', async () => {
    const h = await harness({ bridge: { commandTimeoutMs: 3_000 } });
    const browser = new FakeBrowser(h.base, { handlers: modelHandlers(createModel()) }).start();
    try {
        await waitFor(() => h.bridge.status().browser.polls > 0);
        const tools = toolMap(h.bridge);
        const report = await tools.canvas_batch.execute({
            steps: [{ action: 'get_canvas', params: {} }],
        }, execInSession('s1'));
        assert.match(report, /不支持的动作/);
    } finally {
        browser.stop();
        await h.close();
    }
});

/* ── 跑 ─────────────────────────────────────────────────────────────────── */

let passed = 0;
const failures = [];

console.log('\n无限画布 · 冒烟测试\n');

for (const { name, fn } of tests) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  ✗ ${name}`);
        console.log(`      ${(error?.message ?? String(error)).split('\n').join('\n      ')}`);
    }
}

console.log(`\n${passed} 通过 / ${failures.length} 失败 / 共 ${tests.length} 项\n`);
process.exit(failures.length === 0 ? 0 : 1);
