/**
 * DSH 传输适配器 —— 把「DSH 的命令长轮询」接到「画布认识的 `window.nexusvaultMcp`」上。
 *
 * ## 为什么单独一个文件
 *
 * 画布（NexusVault 的 `CanvasView.vue`）已经实现了完整的命令面，
 * 它只认一个接口（见 `views/CanvasView.vue` 的 `declare global`）：
 *
 *     window.nexusvaultMcp = {
 *       onCommand(cb): () => void,                       // 注册处理器，返回注销函数
 *       reply(requestId, result?, error?): void,         // 回执
 *     }
 *
 * 这个文件**只做这一件事**：把这一个接口架在 DSH 的 HTTP 面上。它不认识 Vue、
 * 不认识 React、不认识画布的任何内部结构。
 *
 * ## P1 之后：这份「一行都不用改」的承诺已经兑现
 *
 * P0-A 时的说法是「把占位画布换成真画布时，这个文件一行都不用改」。**兑现了** ——
 * 上游真画布（`CanvasView.vue`）挂载时自己会调 `window.nexusvaultMcp?.onCommand(...)`
 *（它在文件顶部 `declare global` 声明了这个接口），所以本文件只要抢在它之前
 * 占住这个名字，之后纯粹搬运即可。真画布已实测接上（`canvasReady: true`）。
 *
 * 但「不用改」只对**接口**成立，有两处例外，都是踩过的：
 *
 *   ① **必须自启。** P0-A 时本文件只 `install()` 不 `start()`，等占位画布的
 *      `board.js` 调一次。占位画布删掉后那一行随之消失 —— 画布照常渲染、
 *      按钮照常能点，但**对话命令全部静默失效，页面上看不出任何异常**。
 *      见文件末尾的 IIFE。
 *   ② `start()` 收的是 **options 对象**。传字符串会被静默忽略
 *      （`typeof opts.sessionId === 'string'` 不成立），会话标识就这么丢过一次。
 *
 * ## `ping` 为什么在这里答
 *
 * `ping` **不属于**画布契约（`CANVAS_COMMAND_ACTIONS` 只有 8 个动作）。它是
 * 「这条管子还活着吗」的探针，所以由管子自己回答 —— 而且答得更有用：它顺带
 * 报出「画布本体到底注册处理器了没有」。这样 `canvas_ping` 一句话就能区分
 * 「插件没挂上」「面板没开」「面板开了但画布没起来」三种故障。
 */
(function () {
    'use strict';

    /** 与父页面（DSH 右栏 tab 正文）的 postMessage 约定。 */
    const MESSAGE_SOURCE = 'dsh-canvas';
    /** 缺省端点：宿主半 `lib/routes.js` 的 `ROUTE_PREFIX`。 */
    const DEFAULT_ENDPOINT = '/api/dsh-canvas';
    /** 断线重连的退避阶梯（毫秒），撞到底就停在最后一个。 */
    const RETRY_STEPS = [400, 900, 1_800, 3_500, 5_000];
    /** 服务端立刻返回空结果时的最小间隔，防热循环。 */
    const MIN_IDLE_GAP = 180;
    /** 命令到达后等画布注册处理器的宽限时长。 */
    const HANDLER_GRACE_MS = 4_000;

    /**
     * 从地址栏取会话标识。
     *
     * 父页面（`client.js` 的 tab 正文）把当前会话拼在 iframe 的 `?sessionId=` 上，
     * 那是它唯一能把「这一条画布属于哪个会话」告诉进来的通道 —— iframe 与父页面
     * 同源但**不共享 JS 状态**，postMessage 要等页面自己接线，而传输层要赶在
     * 画布挂载前就位。
     *
     * 取不到就交空串：宿主半的规则是「两边都有会话标识时才要求相等」，
     * 空串意味着「不限定会话」，比猜一个值安全。
     */
    function readSessionFromLocation() {
        try {
            const value = new URLSearchParams(window.location.search).get('sessionId');
            return typeof value === 'string' ? value : '';
        } catch {
            return '';
        }
    }

    /** 运行状态。没有任何一项是画布契约的一部分，纯诊断。 */
    const state = {
        running: false,
        endpoint: DEFAULT_ENDPOINT,
        sessionId: '',
        cursor: 0,
        polls: 0,
        delivered: 0,
        answered: 0,
        errors: 0,
        consecutiveErrors: 0,
        lastError: null,
        lastSeenAt: 0,
        handler: null,
        inFlight: new Set(),
        startedAt: 0,
    };

    /** 长轮询的中止句柄，`stop()` 与重启用它。 */
    let abort = null;
    /** 是否还有一轮轮询在跑（防重入）。 */
    let looping = false;

    /** 当前连接是否算「活」：最近一次轮询成功且在挂起周期内。 */
    function connected() {
        return state.running && state.lastSeenAt !== 0 && Date.now() - state.lastSeenAt < 35_000;
    }

    /** 给父页面 / 画布用的状态快照。 */
    function status() {
        return {
            running: state.running,
            connected: connected(),
            endpoint: state.endpoint,
            sessionId: state.sessionId === '' ? null : state.sessionId,
            cursor: state.cursor,
            polls: state.polls,
            delivered: state.delivered,
            answered: state.answered,
            errors: state.errors,
            lastError: state.lastError,
            lastSeenAgoMs: state.lastSeenAt === 0 ? null : Date.now() - state.lastSeenAt,
            uptimeMs: state.startedAt === 0 ? 0 : Date.now() - state.startedAt,
            /** 画布本体是否已经注册处理器 —— 区分「管子通」和「画布在」。 */
            canvasReady: state.handler !== null,
            /** 已交给画布但还没回执的命令数。 */
            inFlight: [...state.inFlight],
        };
    }

    /** 把状态推给父页面；父页面不在或没挂监听时静默。 */
    function emit() {
        try {
            window.parent?.postMessage({ source: MESSAGE_SOURCE, type: 'status', payload: status() }, '*');
        } catch {
            /* 跨源或父页面已走，无关紧要 */
        }
    }

    /** 统一的告警出口。控制台是这块面板唯一能被开发者看到的日志面。 */
    function warn(message) {
        // eslint-disable-next-line no-console
        console.warn(`[dsh-canvas] ${message}`);
    }

    /** 回一条结果给宿主半。404 表示工具已经超时，不是错误。 */
    async function reply(requestId, result, error) {
        if (typeof requestId !== 'string' || requestId === '') return;
        state.inFlight.delete(requestId);
        state.answered += 1;
        const body = { requestId };
        if (error !== undefined) body.error = String(error);
        else body.result = result === undefined ? null : result;
        try {
            const response = await fetch(`${state.endpoint}/result`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                cache: 'no-store',
            });
            if (response.status === 404) {
                warn(`命令 ${requestId} 的等待方已经超时，回执被丢弃（画布侧操作本身已生效）`);
            }
        } catch (cause) {
            warn(`回执失败：${String(cause)}`);
        }
        emit();
    }

    /**
     * `ping` 的本地应答。
     *
     * 顺带把 `status()` 塞进去 —— 模型读一次 `canvas_ping` 就能看到管子、画布、
     * 会话三件事的全貌，不用去翻 `/status`。
     */
    function answerPing(command) {
        return {
            echo: 'pong',
            at: new Date().toISOString(),
            command: { seq: command.seq, requestId: command.requestId },
            transport: status(),
        };
    }

    /**
     * 处理一条命令。
     *
     * `ping` 自己答；其余交给画布。画布还没就绪时**不立刻失败**，而是等一小段
     * 宽限 —— 首次打开 tab 时命令常常比画布脚本先到（iframe 冷启动），
     * 直接回错误会让「第一次操作总是失败」变成一个假故障。
     */
    async function handle(command) {
        if (command.action === 'ping') {
            await reply(command.requestId, answerPing(command));
            return;
        }
        const handler = await waitForHandler(HANDLER_GRACE_MS);
        if (handler === null) {
            await reply(command.requestId, undefined,
                `画布本体尚未就绪（等待 ${HANDLER_GRACE_MS} ms 仍没有注册命令处理器）。面板可能刚打开、脚本加载失败，或画布崩溃了。`);
            return;
        }
        state.inFlight.add(command.requestId);
        try {
            handler(command);
        } catch (cause) {
            await reply(command.requestId, undefined,
                cause instanceof Error ? cause.message : String(cause));
        }
        emit();
    }

    /** 等处理器出现；已存在则立即返回。 */
    function waitForHandler(timeoutMs) {
        if (state.handler !== null) return Promise.resolve(state.handler);
        return new Promise((resolve) => {
            const started = Date.now();
            const tick = () => {
                if (state.handler !== null) return resolve(state.handler);
                if (Date.now() - started >= timeoutMs) return resolve(null);
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    /** 当前该等多久再发下一次轮询。 */
    function backoffMs() {
        if (state.consecutiveErrors === 0) return MIN_IDLE_GAP;
        return RETRY_STEPS[Math.min(state.consecutiveErrors - 1, RETRY_STEPS.length - 1)];
    }

    /** 一趟轮询：取命令、逐个处理、推进游标。返回服务端耗时。 */
    async function pollOnce() {
        const url = `${state.endpoint}/next?cursor=${state.cursor}&sessionId=${encodeURIComponent(state.sessionId)}`;
        const controller = new AbortController();
        abort = controller;
        const started = Date.now();
        let response;
        try {
            response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        } finally {
            if (abort === controller) abort = null;
        }
        if (!response.ok) {
            throw new Error(`长轮询 HTTP ${response.status}`);
        }
        const payload = await response.json();
        state.polls += 1;
        state.lastSeenAt = Date.now();
        state.consecutiveErrors = 0;

        // 服务端回的是它自己的单调计数器 —— 比「取到命令的最大 seq」更稳：
        // 队列里可能有属于别的会话、这次没被取走、但 seq 更小的命令。
        const serverSeq = Number(payload?.seq);
        if (Number.isFinite(serverSeq) && serverSeq > state.cursor) state.cursor = serverSeq;

        const commands = Array.isArray(payload?.commands) ? payload.commands : [];
        state.delivered += commands.length;
        for (const command of commands) {
            if (command === null || typeof command !== 'object') continue;
            await handle(command);
        }
        emit();
        return Date.now() - started;
    }

    /** 主循环：只要还在运行就一直轮询下去。 */
    async function loop() {
        if (looping) return;
        looping = true;
        while (state.running) {
            let cost = 0;
            try {
                cost = await pollOnce();
            } catch (cause) {
                if (!state.running) break;
                // `stop()` 用 AbortController 打断，这里不该算错误。
                if (cause instanceof DOMException && cause.name === 'AbortError') break;
                state.errors += 1;
                state.consecutiveErrors += 1;
                state.lastError = cause instanceof Error ? cause.message : String(cause);
                emit();
            }
            if (!state.running) break;
            // 服务端立刻就回了（说明上一轮是空转或出错），稍等一下再问，
            // 否则一个坏掉的服务端会被我们打成每秒几百次的请求。
            if (cost < MIN_IDLE_GAP) {
                await sleep(Math.max(backoffMs(), MIN_IDLE_GAP - cost));
            }
        }
        looping = false;
        emit();
    }

    /** 可被打断的等待。 */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 启动。
     *
     * @param options - `endpoint` 端点前缀；`sessionId` 会话标识（用于把命令
     *   限定到本会话的画布）；`onStatus` 状态订阅（父页面之外的第二条观察通道）。
     */
    function start(options) {
        const opts = options ?? {};
        if (state.running) return status();
        state.endpoint = typeof opts.endpoint === 'string' && opts.endpoint !== '' ? opts.endpoint : DEFAULT_ENDPOINT;
        state.sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : '';
        state.startedAt = Date.now();
        state.running = true;
        emit();
        void loop();
        return status();
    }

    /** 停机：打断在途轮询，不注销 `nexusvaultMcp`（画布可能还在，回执仍要能发）。 */
    function stop() {
        state.running = false;
        abort?.abort();
        abort = null;
        emit();
    }

    /**
     * 安装 `window.nexusvaultMcp`。
     *
     * 这里**不覆盖已有实现**：桌面端 NexusVault 自带一份由 preload 注入的实现，
     * 如果检测到它，本文件退让（返回 `false`），由调用方决定怎么处理。
     * 在 DSH 里这个名字是空的，所以正常情况下总是我们赢。
     */
    function install() {
        const existing = window.nexusvaultMcp;
        if (existing !== undefined && existing !== null && existing.__dshTransport !== true) {
            warn('window.nexusvaultMcp 已被别的实现占用（可能是 NexusVault 桌面端的 preload），本适配器退让。');
            return false;
        }
        window.nexusvaultMcp = {
            __dshTransport: true,
            /**
             * 注册处理器。
             *
             * 语义与 preload 版一致：**只保留最后一个**（真画布只会注册一次），
             * 返回注销函数。多条命令可以并发交给同一个处理器 —— 处理器用
             * `requestId` 区分回执，这也是原实现的用法。
             */
            onCommand(callback) {
                if (typeof callback !== 'function') return () => {};
                state.handler = callback;
                emit();
                return () => {
                    if (state.handler === callback) {
                        state.handler = null;
                        emit();
                    }
                };
            },
            reply,
            /** 扩展面：DSH 专有，画布契约不需要它，但父页面与调试用得上。 */
            __dsh: { start, stop, status, MESSAGE_SOURCE },
        };
        return true;
    }

    window.DshCanvasTransport = { install, start, stop, status, reply, DEFAULT_ENDPOINT, MESSAGE_SOURCE };

    // 尽早装上：画布脚本通常在 DOMContentLoaded 之后才跑，先占名字才不会漏掉
    // 第一批命令。
    install();

    /**
     * **自启。**
     *
     * 为什么不留成「等画布来调 start()」：这个页面里除了本文件，没有任何人知道
     * DSH 的存在。真画布（`CanvasView.vue`）只会调它自己那一半接口
     * —— `nexusvaultMcp.onCommand(...)` / `.reply(...)`，它绝不会去碰
     * `window.DshCanvasTransport`。P0-A 时占位画布的 `board.js` 顺手调过一次，
     * 占位页删掉后那一行也消失了 —— 于是画布照常渲染、按钮照常能点，
     * **但对话一条命令都进不来**，而且页面上看不出任何异常。
     * 传输层是这个页面里唯一为 DSH 存在的东西，自启是它自己的事。
     */
    start({ sessionId: readSessionFromLocation() });
})();
