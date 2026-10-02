/**
 * 无限画布 —— DeepSeek Harness host 半。
 *
 * 这个插件把「NexusVault 的无限画布」接进 DSH 的右侧栏，并让对话能直接操控它。
 * 它由两半组成：
 *
 *  1. 一个 HTTP 面（`/api/dsh-canvas/*`）：托管画布静态包、承载命令长轮询与回执；
 *  2. 一组 Agent 工具（`canvas_*`）：模型能读画布、加卡、移卡、删卡、调视口。
 *
 * 两者共用同一条命令桥（`lib/bridge.js`），所以"人看到的画布"和"模型动过的画布"
 * 永远是同一个东西 —— 命令不是写进一份旁路的存档，而是**交给活着的那块画布执行**。
 *
 * 设计取向（与 dsh-asset-library 保持一致，那是本机已经验证过的写法）：
 *  - `inject` 故意留空：没有任何服务是"必须存在才能加载"的。Web 服务器与工具
 *    注册表都用 `ctx.get` 懒绑定，并在 `internal/service` 事件里重试 —— 这样
 *    headless profile 里插件是静默的，而不是永久 pending 在一个 Composition
 *    根本不提供的 key 上。
 *  - 浏览器信任栅栏按请求解析，绝不快照：Connection 行可能在本插件之后激活。
 *  - 所有注册都挂在 `ctx.effect` 上，卸载即回收。
 *  - 自检状态（web / tools 是否挂上）通过 `/status` 暴露，省得靠猜。
 */
import { Config, resolveConfig } from './lib/config.js';
import { createBridge } from './lib/bridge.js';
import { registerInfiniteCanvasRoutes } from './lib/routes.js';
import { buildToolDefinitions } from './lib/tools.js';

/** 插件名（loader 行的 id 与它一致）。 */
export const name = 'infinite-canvas';

/** 见文件头：没有必需服务。 */
export const inject = [];

export { Config };

/** Web 服务器服务的两种拼写，新的在前（老组合叫 `httpServer`）。 */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];

/**
 * 激活插件。
 *
 * @param ctx - host 插件上下文。
 * @param config - 已由 schema 补全的配置（缺失时这里再补一次）。
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const bridge = createBridge({
        commandTimeoutMs: resolved.commandTimeoutMs,
        pollHoldMs: resolved.pollHoldMs,
        maxQueued: resolved.maxQueued,
    });

    ctx.logger.info(`infinite-canvas: ready (timeout=${resolved.commandTimeoutMs}ms, poll=${resolved.pollHoldMs}ms, autoOpen=${resolved.autoOpenPanel})`);

    let disposed = false;
    ctx.effect(() => () => {
        disposed = true;
        bridge.dispose();
    }, 'infinite-canvas: activation state');

    /** 自检状态：`/status` 会把它带出来。 */
    const state = { web: false, tools: { registered: false, names: [], reason: 'not attempted' } };

    // `autoOpenPanel` 是给浏览器半读的：命令到达时画布没开，要不要自动打开。
    // 放在桥上而不是各存一份，是为了让两边读到同一个值。
    bridge.autoOpenPanel = resolved.autoOpenPanel;

    // ---- HTTP 面：懒绑定，服务出现即注册
    const registerWebSurface = () => {
        if (state.web || disposed) return;
        const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
        if (webServer === undefined) return;
        // 栅栏是"每次请求解析"的函数：Connection 行可能后于本行激活，快照会留下
        // 一个永久空洞（等于把接口开放给任意网页）。
        const gate = () => ctx.get('connection');
        // `ctx.effect` 立即执行工厂；对重复路径 webServer 会抛错，所以只有注册
        // 真的成功后才能把标志位置真 —— 否则一次失败会变成永久激活失败。
        ctx.effect(() => registerInfiniteCanvasRoutes(webServer, gate, bridge), 'infinite-canvas: HTTP API');
        state.web = true;
        ctx.logger.info('infinite-canvas: HTTP API mounted at /api/dsh-canvas');
    };
    registerWebSurface();

    // ---- Agent 工具：懒绑定 + 懒加载 defineTool
    const registerTools = async () => {
        if (state.tools.registered || disposed) return;
        const tools = ctx.get('tools');
        if (tools === undefined || typeof tools.register !== 'function') {
            state.tools.reason = 'tools service not present';
            return;
        }
        let defineTool;
        try {
            // 动态 import：`@deepseek-ai/dsh-tools` 由 dsh 安装本体提供。万一某个
            // 部署解析不到，代价是"没有 Agent 工具"，而不是整个插件加载失败
            // （画布面板与 HTTP 面仍然可用）。
            ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
        } catch (error) {
            state.tools.reason = `@deepseek-ai/dsh-tools unavailable: ${String(error)}`;
            state.tools.registered = true;
            ctx.logger.warn(`infinite-canvas: agent tools unavailable (${String(error)})`);
            return;
        }
        if (typeof defineTool !== 'function' || disposed) return;
        const definitions = buildToolDefinitions(defineTool, bridge);
        ctx.effect(() => {
            const disposers = definitions.map((definition) => tools.register(definition));
            return () => {
                for (const dispose of disposers) {
                    if (typeof dispose === 'function') dispose();
                }
            };
        }, 'infinite-canvas: agent tools');
        state.tools.registered = true;
        state.tools.names = definitions.map((definition) => definition.name);
        state.tools.reason = 'ok';
        ctx.logger.info(`infinite-canvas: registered ${definitions.length} agent tool(s)`);
    };
    void registerTools();

    ctx.on('internal/service', (serviceName) => {
        if (serviceName === WEB_SERVER_KEYS[0] || serviceName === WEB_SERVER_KEYS[1]) registerWebSurface();
        if (serviceName === 'tools') void registerTools();
    });

    // 自检状态也从桥那儿一起带出去，`/api/dsh-canvas/status` 已经回桥的快照，
    // 这里只补宿主半自己的注册情况，方便出问题时一眼看出是哪一半没挂上。
    ctx.effect(() => {
        const timer = setInterval(() => {
            if (disposed) return;
            if (state.web && state.tools.registered) clearInterval(timer);
        }, 2_000);
        timer.unref?.();
        return () => clearInterval(timer);
    }, 'infinite-canvas: readiness probe');
}
