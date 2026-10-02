/**
 * 画布独立预览 —— 把宿主半挂在一个普通 `http.Server` 上，不依赖 DSH。
 *
 * 两个用途：
 *
 *  1. **视觉验证**：无头浏览器打开它截图，确认画布真的画出来了
 *     （语法检查证明不了 `getElementById` 拿到了东西）。
 *  2. **手工试玩**：`node tools/preview-server.mjs` 之后在浏览器里直接操作画布，
 *     再用 `/dispatch` 从命令行发一条命令，看它实时变化 —— 这就是
 *     "对话操控画布"那条链路，只是把模型换成了 curl。
 *
 * 用法：
 *   node tools/preview-server.mjs [端口]
 *   curl -s -X POST http://127.0.0.1:8791/api/dsh-canvas/dispatch \
 *        -H 'content-type: application/json' \
 *        -d '{"action":"add_card","params":{"kind":"scene","title":"雨夜街口"}}'
 */
import { createServer } from 'node:http';

import { createBridge } from '../lib/bridge.js';
import { registerInfiniteCanvasRoutes, ROUTE_PREFIX } from '../lib/routes.js';

const port = Number(process.argv[2] ?? '8791');
const bridge = createBridge({ commandTimeoutMs: 10_000, pollHoldMs: 20_000, maxQueued: 32 });
// 预览里不自动开面板（只有一块屏，没什么可开的）。
bridge.autoOpenPanel = false;

/** 最小可用的 `webServer` 替身：只收一条 prefix 路由。 */
let handler = null;
const webServer = {
    register(options) {
        if (handler !== null) throw new Error(`重复注册路由：${options.path}`);
        handler = options.handler;
        return () => { handler = null; };
    },
};

// 预览不过信任栅栏：它就是本机的一块调试屏，没有第二个来源。
registerInfiniteCanvasRoutes(webServer, () => undefined, bridge);

const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '') {
        res.writeHead(302, { location: `${ROUTE_PREFIX}/embed/index.html` });
        res.end();
        return;
    }
    if (handler === null) {
        res.writeHead(503).end('routes not mounted');
        return;
    }
    void handler(req, res);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`画布：    http://127.0.0.1:${port}${ROUTE_PREFIX}/embed/index.html`);
    console.log(`项目页：  http://127.0.0.1:${port}${ROUTE_PREFIX}/embed/index.html#/app/projects`);
    console.log(`状态：    http://127.0.0.1:${port}${ROUTE_PREFIX}/status`);
    console.log(`派发：    curl -s -X POST http://127.0.0.1:${port}${ROUTE_PREFIX}/dispatch \\`);
    console.log(`             -H 'content-type: application/json' \\`);
    console.log(`             -d '{"action":"add_card","params":{"kind":"scene","title":"雨夜街口"}}'`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        bridge.dispose();
        server.close(() => process.exit(0));
    });
}
