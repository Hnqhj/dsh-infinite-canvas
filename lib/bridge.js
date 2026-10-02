/**
 * 画布命令桥 —— 把「宿主半的 Agent 工具」和「浏览器半的无限画布」连成一次请求/应答。
 *
 * ## 为什么是长轮询而不是 SSE
 *
 * `webServer` 交给我们的 handler 是**裸 `req`/`res`**（资产库插件就是靠这个实现
 * HTTP Range 的），长轮询在它上面零假设就能工作。SSE 要求响应不被任何中间层缓冲
 * ——D SH 的响应链里带了 `Vary: Accept-Encoding`，不确定中间有没有压缩层，所以
 * 等到外壳验完之后再决定要不要升级。**命令闭环不依赖传输方式**，这里换掉不影响
 * 上层任何代码。
 *
 * ## 一次往返的形状
 *
 *   浏览器         长轮询 GET /next?cursor=N   ─┐
 *                                               │  有命令就立刻返回，没有就挂住 25 秒
 *   工具 dispatch(action, params)  ──► queue ────┘
 *   浏览器执行完     POST /result {requestId}  ──► settle() ──► 工具 resolve
 *
 * ## 两条硬规则
 *
 * 1. **命令只交付一次**（取走即 `splice`）。交付后浏览器崩了就是超时，不做重投
 *    ——画布命令不是幂等的（`add_card` 重投会多出一张卡）。
 * 2. **排队中的命令不会喂给错的会话**。`targetSessionId` 与轮询方 `sessionId`
 *    都能拿到时才算匹配；任一侧拿不到就放行（单会话是绝大多数情况，宁可送达
 *    也不要死锁）。
 */

/** 把可能为空的会话标识收敛成 `null` 或去空白的字符串。 */
function normaliseSession(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** 交给浏览器的命令形状（刻意不含内部字段）。 */
function publicCommand(command) {
    return {
        seq: command.seq,
        requestId: command.requestId,
        action: command.action,
        params: command.params,
    };
}

/**
 * 创建命令桥。
 *
 * @param options - `commandTimeoutMs` 工具侧等待上限；`pollHoldMs` 长轮询挂起时长；
 *   `maxQueued` 排队上限（防某次浏览器卡死把内存吃光）。
 */
export function createBridge(options = {}) {
    const commandTimeoutMs = options.commandTimeoutMs ?? 12_000;
    const pollHoldMs = options.pollHoldMs ?? 25_000;
    const maxQueued = options.maxQueued ?? 64;

    /** 单调递增，同时用作命令序号与 requestId 的一部分。 */
    let seq = 0;
    /** 尚未被取走的命令。 */
    const queue = [];
    /** requestId → 等待中的工具调用。 */
    const pending = new Map();
    /** 长轮询的唤醒句柄。 */
    const waiters = new Set();
    /** 浏览器侧的活跃度（`/status` 会把它带出来）。 */
    const browser = { lastSeenAt: 0, sessionId: null, polls: 0 };
    /** 命令到达且画布没开时，要不要自动把面板打开。由宿主半按配置写入。 */
    let autoOpenPanel = false;
    let delivered = 0;
    let expired = 0;
    let disposed = false;

    /**
     * 这条命令能不能交给这个轮询方。
     *
     * 两侧都有会话标识时必须相等；任一侧缺就放行 —— 见文件头第 2 条。
     */
    function takeable(command, sessionId) {
        if (command.targetSessionId === null) return true;
        if (sessionId === null) return true;
        return command.targetSessionId === sessionId;
    }

    /** 取走所有可交付且晚于游标的命令。 */
    function drain(cursor, sessionId) {
        const taken = [];
        for (let index = 0; index < queue.length;) {
            const command = queue[index];
            if (command.seq > cursor && takeable(command, sessionId)) {
                taken.push(command);
                queue.splice(index, 1);
            } else {
                index += 1;
            }
        }
        return taken;
    }

    /** 有新命令时唤醒所有挂起的长轮询（各自再自行判断可交付性）。 */
    function flush() {
        for (const waiter of [...waiters]) {
            waiters.delete(waiter);
            waiter();
        }
    }

    /** 超时文案里带上浏览器侧的事实，省得靠猜。 */
    function timeoutMessage(action) {
        if (browser.lastSeenAt === 0) {
            return `画布命令超时（${commandTimeoutMs} ms）：${action}。画布面板从未连接过 —— 先在右侧栏打开一次「画布」。`;
        }
        const seconds = Math.round((Date.now() - browser.lastSeenAt) / 1000);
        return `画布命令超时（${commandTimeoutMs} ms）：${action}。画布面板最后一次连接在 ${seconds} 秒前，可能已经关掉或卡住。`;
    }

    return {
        /** 浏览器半据此决定"命令到了要不要自动开面板"。两边读同一个值。 */
        get autoOpenPanel() { return autoOpenPanel; },
        set autoOpenPanel(value) { autoOpenPanel = value === true; },

        /**
         * 发一条命令给画布，等它的结果。
         *
         * @param action - 画布动作名（`get_canvas` / `add_card` / …）。
         * @param params - 动作参数。
         * @param meta - `sessionId` 用于把命令限定到某个会话的画布。
         * @returns 画布侧回执的结果对象；超时或队列满时 reject。
         */
        dispatch(action, params, meta = {}) {
            if (disposed) return Promise.reject(new Error('画布桥已卸载'));
            if (queue.length >= maxQueued) {
                return Promise.reject(new Error(`画布命令队列已满（${maxQueued} 条），上一条命令可能还没被画布取走。`));
            }
            const requestId = `r${++seq}`;
            const command = {
                seq,
                requestId,
                action,
                params: params ?? {},
                targetSessionId: normaliseSession(meta.sessionId),
                at: Date.now(),
            };
            queue.push(command);

            const promise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    // 命令可能还躺在队列里（浏览器一直没连上），一并清掉 ——
                    // 否则它会在几小时后突然被取走并执行，那是最难查的一类 bug。
                    const index = queue.findIndex((item) => item.requestId === requestId);
                    if (index !== -1) queue.splice(index, 1);
                    expired += 1;
                    reject(new Error(timeoutMessage(action)));
                }, commandTimeoutMs);
                pending.set(requestId, { resolve, reject, timer });
            });

            flush();
            return promise;
        },

        /**
         * 长轮询：有命令立刻返回，没有就挂到 `pollHoldMs` 再返回空。
         *
         * 游标归**调用方**管：返回的 `commands` 里最大 `seq` 就是下一次的游标。
         * 服务端不回游标，因为"没交付"的两种情况（会话不匹配、还没产生）用同一个
         * 数字表达不了，交给调用方做单调递增最不容易错。
         */
        poll(cursor, sessionId) {
            const self = normaliseSession(sessionId);
            browser.lastSeenAt = Date.now();
            browser.polls += 1;
            if (self !== null) browser.sessionId = self;

            const safeCursor = Number.isFinite(cursor) ? cursor : 0;
            const immediate = drain(safeCursor, self);
            if (immediate.length > 0) {
                delivered += immediate.length;
                return Promise.resolve({ seq, commands: immediate.map(publicCommand), browserConnected: true });
            }

            return new Promise((resolve) => {
                let settled = false;
                let timer = null;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    waiters.delete(finish);
                    const taken = drain(safeCursor, self);
                    delivered += taken.length;
                    resolve({ seq, commands: taken.map(publicCommand), browserConnected: true });
                };
                timer = setTimeout(finish, pollHoldMs);
                waiters.add(finish);
            });
        },

        /**
         * 回填一条命令的结果。
         *
         * 返回 `false` 表示这条 requestId 已经不在等待了（工具已超时，或重复回执）
         * —— 调用方据此回 404 而不是假装成功。
         */
        settle(requestId, result, error) {
            const entry = pending.get(requestId);
            if (entry === undefined) return false;
            pending.delete(requestId);
            clearTimeout(entry.timer);
            if (typeof error === 'string' && error.trim() !== '') entry.reject(new Error(error.trim()));
            else entry.resolve(result);
            return true;
        },

        /** 诊断快照。`/status` 直接回它。 */
        status() {
            return {
                seq,
                queued: queue.map(publicCommand),
                pending: [...pending.keys()],
                delivered,
                expired,
                /** 浏览器半据此决定"命令到了要不要自动开面板"。两边读同一个值。 */
                autoOpenPanel,
                browser: {
                    connected: browser.lastSeenAt !== 0 && Date.now() - browser.lastSeenAt < pollHoldMs + 5_000,
                    lastSeenAgoMs: browser.lastSeenAt === 0 ? null : Date.now() - browser.lastSeenAt,
                    polls: browser.polls,
                    sessionId: browser.sessionId,
                },
            };
        },

        /** 卸载时把所有等待中的工具调用直接失败掉，别让它们挂到超时。 */
        dispose() {
            disposed = true;
            for (const [requestId, entry] of [...pending.entries()]) {
                pending.delete(requestId);
                clearTimeout(entry.timer);
                entry.reject(new Error('画布插件已卸载'));
            }
            queue.length = 0;
            flush();
        },
    };
}
