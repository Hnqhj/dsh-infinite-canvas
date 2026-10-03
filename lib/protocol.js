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

/**
 * 我们在内嵌页里自己补出来的动作 —— 上游契约里没有。
 *
 * 真源是 `build/overlay/src/dsh-commands.ts`（它包住了 `window.nexusvaultMcp
 * .onCommand`，认得的动作自己办、其余转交画布）。**它不在上游仓库里**，
 * 所以上游那份 `CANVAS_COMMAND_ACTIONS` 不会包含这三条 —— 别把两边混着读。
 *
 * 只有内嵌页（`/api/dsh-canvas/embed/`）认得它们；上游桌面端的 MCP 服务不认。
 */
export const CANVAS_EXTENDED_ACTIONS = [
    'update_card',
    'set_card_data',
    'set_card_type',
];

/** 内嵌页认得的全部动作 = 上游 8 条 + 我们补的这几条。 */
export const CANVAS_ALL_ACTIONS = [...CANVAS_COMMAND_ACTIONS, ...CANVAS_EXTENDED_ACTIONS];

/* ── 节点类型（`set_card_type` 的可选值）───────────────────────────────── */

/**
 * 注册表里**模型能转到**的节点类型。
 *
 * 真源 `apps/web/src/canvas/nodes/registry.ts` 的 `NODE_SCHEMAS`，这里排除了
 * `hiddenFromPalette` 的那三个（真机核对过，不是猜的）：
 *   · `group` / `region` —— 不是内容节点，尺寸存在实例 data 上，转过去会得到
 *     一个 0×0 的框；
 *   · `canvas_text` —— **它是内容节点，但只由文本工具创建**（`canvas-text/schema.ts`
 *     写着"这个类型只由文本工具创建"，因为它要顺带进编辑态）。硬转过去能渲染，
 *     但拿不到那条属性工具条，等于建了一张改不动的字。
 *
 * 注意与 `kind` 不是一回事：`kind` 是给模型的 7 值公开枚举，`type` 是真源。
 * `set_card_type` 收 `type`，因为它要能表达 `kind` 覆盖不到的那几个类型。
 */
export const NODE_TYPES = [
    'asset_input',
    'script_input',
    'gen_text',
    'gen_image',
    'gen_video',
    'entity_character',
    'entity_scene',
    'entity_prop',
    'storyboard_shot',
    'note',
];

export function isNodeType(value) {
    return typeof value === 'string' && NODE_TYPES.includes(value);
}

/* ── 视口 ───────────────────────────────────────────────────────────────── */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.4;

/** 把缩放夹到画布允许的范围内 —— 越界的值画布会自己夹，这里提前夹掉更省一次往返。 */
export function clampZoom(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parsed));
}
