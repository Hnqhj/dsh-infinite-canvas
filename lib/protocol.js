/**
 * 画布协议常量 —— 与 NexusVault 侧契约一一对应的**副本**。
 *
 * ## 为什么是副本而不是共享依赖
 *
 * 契约的真源在 `apps/web/src/canvas/types/card.ts`，但那是 Vue 工程里的模块，
 * 宿主半（Node）引不动，也不该为了几个常量把整个前端工程拖进插件依赖。
 * 所以这里手抄一份，并在每个常量旁标出真源位置 —— 上游改了要同步改这里。
 *
 * 抄的是**边界契约**（枚举值、id 集合、缩放范围），不是实现。这类值极少变，
 * 而且一变就必须两边同时改，否则模型会拿到一个画布不认的 kind。
 *
 * 真源：
 *   - `apps/web/src/canvas/types/card.ts`      → CardKind / PanelId / MIN_ZOOM / MAX_ZOOM
 *   - `apps/web/src/canvas/mcp/canvas-commands.ts` → CANVAS_COMMAND_ACTIONS
 *   - `apps/web/src/canvas/nodes/registry.ts`  → 节点类型表
 */

/* ── 卡片种类（给模型的 7 值公开枚举） ──────────────────────────────────── */

export const CARD_KINDS = [
    'scene',
    'character',
    'note',
    'text',
    'board',
    'video',
    'audio',
];

export function isCardKind(value) {
    return typeof value === 'string' && CARD_KINDS.includes(value);
}

/**
 * `kind` → 节点 schema 类型（画布侧的真实建卡逻辑）。
 *
 * `text` 映射到 `gen_text` 而不是 `note` —— 上游的用意是：模型说「加一个文本卡片」
 * 时，给它一个能真的生成文字的节点比给一张便签有用。
 */
export const NODE_TYPE_FOR_KIND = {
    scene: 'entity_scene',
    character: 'entity_character',
    note: 'note',
    text: 'gen_text',
    board: 'storyboard_shot',
    video: 'gen_video',
    audio: 'asset_input',
};

/* ── 画布上的面板 ───────────────────────────────────────────────────────── */

export const PANEL_IDS = [
    'assets',
    'credits',
    'generate',
    'library',
    'materials',
    'doodle',
    'shortcuts',
    'settings',
];

export function isPanelId(value) {
    return typeof value === 'string' && PANEL_IDS.includes(value);
}

/* ── 命令面 ─────────────────────────────────────────────────────────────── */

/** 画布能执行的全部动作。`ping` 是本插件加的诊断动作，画布侧原生没有。 */
export const CANVAS_COMMAND_ACTIONS = [
    'get_canvas',
    'add_card',
    'move_card',
    'delete_card',
    'select_card',
    'set_view',
    'open_panel',
    'run_agent',
];

/** 除 ping 之外，画布**必然**能执行的动作集合。 */
export const CANVAS_NATIVE_ACTIONS = new Set(CANVAS_COMMAND_ACTIONS);

/* ── 视口 ───────────────────────────────────────────────────────────────── */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.4;

/** 把缩放夹到画布允许的范围内 —— 越界的值画布会自己夹，这里提前夹掉更省一次往返。 */
export function clampZoom(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parsed));
}
