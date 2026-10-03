/**
 * 无限画布的 HTTP 面。
 *
 * 一条 `prefix` 路由（`/api/dsh-canvas`）承载全部端点，**先过浏览器信任栅栏再做
 * 任何工作**：裸 Web 路由不继承 Connection 服务的 Host/Origin 栅栏，不查这一步
 * 就等于把这个接口开放给任意网页。栅栏按请求解析（`gate()` 每次调用），因为
 * Connection 行可能在本路由注册之后才激活 —— 快照式捕获会永久留一个空洞。
 *
 * 端点：
 *
 *   GET  /                 → 端点清单（人看的）
 *   GET  /status           → 桥与浏览器的诊断快照（?hold=1 时挂起等新命令）
 *   GET  /next?cursor=&sessionId=  → 长轮询，取画布要执行的命令
 *   POST /result           → 画布回填命令结果
 *   POST /dispatch         → 直接派发一条命令并等结果（手工排查与冒烟测试用）
 *   GET  /embed/<path>     → 画布静态包（同源，relative 路径可引用）
 */
import { sendEmbedFile } from './embed.js';

/** 整条 API 的路径前缀。 */
export const ROUTE_PREFIX = '/api/dsh-canvas';

/** 请求体上限：端点只收小 JSON，超过就是攻击。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 一个 HTTP 语义错误：状态码 + 信封里的 code。 */
class RouteError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'RouteError';
        this.status = status;
        this.code = code;
    }
}

/** 唯一的 JSON 出口；带 `no-store`，因为面板轮询的都是实时状态。 */
function sendJson(res, status, payload) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

/** 错误信封；与面板客户端的约定。 */
function errorPayload(code, message) {
    return { error: { code, message } };
}

/** 栅栏判定：`requestRejection` 返回数字表示拒绝状态码。 */
function evaluateGate(gate, req, res) {
    const outcome = gate.requestRejection(req, res);
    if (outcome === undefined || outcome === false || outcome === null) return undefined;
    return typeof outcome === 'number' ? outcome : 403;
}

/** 方法校验。 */
function requireMethod(method, expected) {
    if (method !== expected) throw new RouteError(405, 'METHOD_NOT_ALLOWED', `Use ${expected}`);
}

/** 读请求体并解析成对象；超限、非 JSON、非对象一律拒绝。 */
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new RouteError(413, 'PAYLOAD_TOO_LARGE', 'Body too large');
        chunks.push(chunk);
    }
    if (size === 0) return {};
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new RouteError(400, 'BAD_JSON', 'Body is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new RouteError(400, 'BAD_JSON', 'Body must be a JSON object');
    }
    return parsed;
}

/** 所有拒绝都收敛成约定的信封，传输层才能继续服务下一个请求。 */
function sendFailure(res, error) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    if (error instanceof RouteError) {
        sendJson(res, error.status, errorPayload(error.code, error.message));
        return;
    }
    sendJson(res, 500, errorPayload('INTERNAL', error instanceof Error ? error.message : String(error)));
}

/**
 * `/status` 支持**挂起式等待**（`?hold=1`）。
 *
 * 浏览器半的哨兵用它取代原来那个「每 2.5 秒问一次」的定时器：命令一到这里就
 * 立刻返回，浏览器马上把面板打开，不用再白白平均等待 1.25 秒 —— 那是冷路径里
 * 最贵的一块，而命令总共只有 12 秒。**请求量反而更少**（每分钟 24 次降到 3 次）。
 *
 * `since` 是必须的：没有它，服务端不知道浏览器「已经见过哪些命令」，只要队列
 * 还剩东西就立刻返回，两边会互相追着打成热循环。语义与长轮询的 `cursor` 一致。
 * 挂起时长由桥自己定（`sentinelHoldMs`），这里不重复��一份。
 */
async function readStatus(res, bridge, url) {
    const held = url.searchParams.get('hold') === '1';
    if (!held) return bridge.status();
    const since = Number(url.searchParams.get('since') ?? '0');
    const controller = new AbortController();
    const release = () => controller.abort();
    res.once('close', release);
    try {
        // 挂起时长交给桥（`sentinelHoldMs`）：超时策略只有一处该知道它。
        return await bridge.waitForActivity(undefined, Number.isFinite(since) ? since : 0, controller.signal);
    } finally {
        res.removeListener('close', release);
    }
}

/**
 * 注册无限画布的 HTTP 面。
 *
 * @param webServer - 宿主 Web 服务器（提供 `register`）。
 * @param gate - 返回 Connection 服务的函数（**不要**在注册时快照它）。
 * @param bridge - 命令桥。
 * @returns 卸载函数（`webServer.register` 的返回值）。
 */
export function registerInfiniteCanvasRoutes(webServer, gate, bridge) {
    const handle = async (req, res) => {
        const resolvedGate = gate();
        if (resolvedGate !== undefined) {
            const rejection = evaluateGate(resolvedGate, req, res);
            if (rejection !== undefined) {
                sendJson(res, rejection, errorPayload(
                    rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
                    rejection === 401 ? 'unauthorized' : 'forbidden',
                ));
                return;
            }
        }

        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/u, '');
        const [head = '', ...tail] = rest === '' ? [] : rest.split('/');

        // embed 是唯一一条"要发文件而不是 JSON"的分支，放在最前面按尾段判断。
        if (head === 'embed') {
            if (method !== 'GET' && method !== 'HEAD') throw new RouteError(405, 'METHOD_NOT_ALLOWED', 'Use GET');
            const relative = tail.join('/');
            const sent = await sendEmbedFile(req, res, relative);
            if (!sent) throw new RouteError(404, 'NOT_FOUND', `No such embed file: ${relative}`);
            return;
        }

        if (rest === '') {
            requireMethod(method, 'GET');
            sendJson(res, 200, {
                name: 'infinite-canvas',
                endpoints: ['status', 'next', 'result', 'dispatch', 'embed'],
            });
            return;
        }

        if (head === 'status' && tail.length === 0) {
            requireMethod(method, 'GET');
            sendJson(res, 200, await readStatus(res, bridge, url));
            return;
        }

        if (head === 'next' && tail.length === 0) {
            requireMethod(method, 'GET');
            const cursor = Number(url.searchParams.get('cursor') ?? '0');
            const sessionId = url.searchParams.get('sessionId') ?? '';
            sendJson(res, 200, await bridge.poll(Number.isFinite(cursor) ? cursor : 0, sessionId));
            return;
        }

        if (head === 'result' && tail.length === 0) {
            requireMethod(method, 'POST');
            const body = await readJsonBody(req);
            const requestId = typeof body.requestId === 'string' ? body.requestId : '';
            if (requestId === '') throw new RouteError(400, 'BAD_REQUEST', 'requestId is required');
            const known = bridge.settle(
                requestId,
                body.result,
                typeof body.error === 'string' ? body.error : undefined,
            );
            // 未知或已超时的 requestId 明确回 404，别假装成功 —— 面板据此知道
            // 这条命令已经没人等了。
            if (!known) throw new RouteError(404, 'UNKNOWN_REQUEST', `No pending command: ${requestId}`);
            sendJson(res, 200, { ok: true, requestId });
            return;
        }

        if (head === 'dispatch' && tail.length === 0) {
            requireMethod(method, 'POST');
            const body = await readJsonBody(req);
            const action = typeof body.action === 'string' ? body.action.trim() : '';
            if (action === '') throw new RouteError(400, 'BAD_REQUEST', 'action is required');
            const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params)
                ? body.params
                : {};
            const result = await bridge.dispatch(action, params, {
                sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            });
            sendJson(res, 200, { ok: true, result });
            return;
        }

        throw new RouteError(404, 'NOT_FOUND', `Unknown route: ${url.pathname}`);
    };

    return webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
            try {
                await handle(req, res);
            } catch (error) {
                sendFailure(res, error);
            }
        },
    });
}
