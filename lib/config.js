/**
 * 无限画布配置。
 *
 * 每个字段都带默认值：profile 里那行插件写成 `{}`、或者测试里直接调用 `apply()`，
 * 都不该因为缺 key 而启动失败。
 *
 * 字段刻意少：P0 阶段要验证的是「右侧栏 tab + 命令闭环」，不是配置能力。等外壳
 * 稳了再按需加（例如 embed 目录、是否允许模型改画布）。
 */
import z from '@deepseek-ai/schemastery';

/** 出厂默认值；`apply()` 用它补齐未经 schema 的配置。 */
export const INFINITE_CANVAS_DEFAULTS = {
    // 工具侧等待画布回执的上限。与 NexusVault 桌面端 mcp-server.mjs 的 12 秒对齐。
    commandTimeoutMs: 12_000,
    // 长轮询挂起时长。必须小于常见的反向代理空闲超时；桌面端是直连本机，够用。
    pollHoldMs: 25_000,
    // 排队上限：防某次浏览器卡死把内存吃光。
    maxQueued: 64,
    // 命令到达时若画布面板没开，是否自动把它打开。关掉就变成"必须手动先开面板"。
    autoOpenPanel: true,
};

export const Config = z.object({
    commandTimeoutMs: z.natural().min(1_000).max(120_000).default(INFINITE_CANVAS_DEFAULTS.commandTimeoutMs),
    pollHoldMs: z.natural().min(1_000).max(120_000).default(INFINITE_CANVAS_DEFAULTS.pollHoldMs),
    maxQueued: z.natural().min(1).max(10_000).default(INFINITE_CANVAS_DEFAULTS.maxQueued),
    autoOpenPanel: z.boolean().default(INFINITE_CANVAS_DEFAULTS.autoOpenPanel),
});

/**
 * 把可能不完整的配置补成完整配置。
 *
 * 只要"调用方绕过了 schema"这一条存在（直接组合、单元测试），就需要这层归一化。
 *
 * @param config - `apply()` 收到的原始配置。
 * @returns 每个字段都存在的配置对象。
 */
export function resolveConfig(config) {
    const merged = { ...INFINITE_CANVAS_DEFAULTS, ...(config ?? {}) };
    const number = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback);
    return {
        commandTimeoutMs: number(merged.commandTimeoutMs, INFINITE_CANVAS_DEFAULTS.commandTimeoutMs),
        pollHoldMs: number(merged.pollHoldMs, INFINITE_CANVAS_DEFAULTS.pollHoldMs),
        maxQueued: number(merged.maxQueued, INFINITE_CANVAS_DEFAULTS.maxQueued),
        autoOpenPanel: merged.autoOpenPanel !== false,
    };
}
