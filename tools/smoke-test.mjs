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
            pathToFileURL(resolve(ROOT, '.workbuddy/verify/check-overlay-hygiene.mjs')).href
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
            pathToFileURL(resolve(ROOT, '.workbuddy/verify/scan-dark-gap.mjs')).href
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

test('D1 注册 9 个工具，名字与画布动作对得上', async () => {
    const h = await harness();
    try {
        const tools = buildToolDefinitions(identity, h.bridge);
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            'canvas_add_card', 'canvas_delete_card', 'canvas_get', 'canvas_move_card',
            'canvas_open_panel', 'canvas_ping', 'canvas_run_agent', 'canvas_select_card',
            'canvas_set_view',
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
