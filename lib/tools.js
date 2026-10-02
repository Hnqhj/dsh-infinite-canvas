/**
 * Agent 工具定义。
 *
 * 单独成模块是为了可测：`execute()` 是纯逻辑 + 桥调用，用 `defineTool` 的替身
 * （恒等函数）就能在 Node 里直接驱动，不需要起 GUI、不需要模型。
 *
 * ## 这些工具做什么、不做什么
 *
 * 它们把「对话」和「画布」连起来：模型能读画布现状、加卡、移卡、删卡、选卡、
 * 调视口、开面板。**画布侧不需要任何改动** —— `apps/web/src/canvas/mcp/canvas-commands.ts`
 * 的 `CanvasCommandContext` 已经把这一整套实现好了，NexusVault 桌面端就是用它
 * 接 MCP 的。这里只是换了一根传输线。
 *
 * ## `kind` 与 `type` 的关系（模型最容易搞错的一点）
 *
 * `kind` 是给模型的**7 值公开枚举**（`scene` / `character` / `note` / `text` /
 * `board` / `video` / `audio`），由画布反投影成节点类型：
 *
 *   scene → entity_scene     character → entity_character   note → note
 *   text  → gen_text         board     → storyboard_shot    video → gen_video
 *   audio → asset_input（并写入 data.media_type = 'audio'）
 *
 * `get_canvas` 回传的每条卡片同时带 `kind`（投影）和 `type`（真源）。
 * **`type` 更精确** —— 7 值枚举里没有「物品」和「图片生成」，它们都被压成了
 * `scene`。读的时候以 `type` 为准，写的时候只能用 `kind`。
 */
import { isCardKind, isPanelId } from './protocol.js';

/** 统一的输出形态：一串给模型读的文本。 */
function asText() {
    return { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };
}

/**
 * 解析这次工具调用该作用到哪个会话的画布。
 *
 * `exec.agent.session.header` 是"我正在这个会话里干活"最可靠的信号。
 * 拿不到就返回 `null` —— 桥那边会把 `null` 当成"不限定会话"，宁可送达也不
 * 要因为标识缺失把命令锁死。
 *
 * @param exec - 工具执行上下文（`{ agent?, signal? }`）。
 */
export function resolveSessionId(exec) {
    const header = exec?.agent?.session?.header;
    const candidate = header?.id ?? header?.sessionId ?? exec?.agent?.session?.id;
    return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null;
}

/** 参数里的空值统一收敛成"没给"。 */
function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** 必填数字；缺失或非数字时抛错，错误文案直接给模型。 */
function requiredNumber(value, field) {
    const parsed = optionalNumber(value);
    if (parsed === undefined) throw new Error(`参数 ${field} 必须是数字`);
    return parsed;
}

/** 把画布现状排成一段可读文本。 */
function formatCanvas(state) {
    const cards = Array.isArray(state?.nodes) ? state.nodes : [];
    const strokes = Array.isArray(state?.strokes) ? state.strokes : [];
    const viewport = state?.viewport ?? {};
    const offset = viewport.offset ?? {};
    const selected = Array.isArray(state?.selectedIds) ? state.selectedIds : [];

    const lines = [
        `卡片 ${cards.length} 张，涂鸦 ${strokes.length} 笔。`,
        `视口：缩放 ${Number(viewport.zoom ?? 1).toFixed(2)}，位移 (${Math.round(Number(offset.x ?? 0))}, ${Math.round(Number(offset.y ?? 0))})。`,
        `选中：${selected.length === 0 ? '（无）' : selected.join(', ')}。`,
        `当前打开的面板：${state?.activePanel ?? '（无）'}。`,
    ];
    if (cards.length > 0) {
        lines.push('id\tkind\ttype\t标题\t位置');
        for (const card of cards) {
            const position = `(${Math.round(Number(card.x ?? 0))}, ${Math.round(Number(card.y ?? 0))})`;
            const title = typeof card.title === 'string' && card.title !== '' ? card.title : '（无标题）';
            const group = card.parentId === undefined ? '' : `\t分组 ${card.parentId}`;
            lines.push(`${card.id}\t${card.kind}\t${card.type}\t${title}\t${position}${group}`);
        }
    }
    return lines.join('\n');
}

/**
 * 构造 Agent 工具定义。
 *
 * @param defineTool - `@deepseek-ai/dsh-tools` 的构造器（测试里传恒等函数）。
 * @param bridge - 命令桥（`lib/bridge.js`）。
 * @returns 工具定义数组，交给 `ctx.tools.register()`。
 */
export function buildToolDefinitions(defineTool, bridge) {
    /**
     * 把一条画布命令发给画布并等结果。
     *
     * 三次重试都没有 —— 画布命令不幂等（`add_card` 重发会多出一张卡），
     * 失败就让模型自己决定要不要再来一次。
     */
    const send = (exec, action, params) => bridge.dispatch(action, params, { sessionId: resolveSessionId(exec) });

    return [
        defineTool({
            name: 'canvas_ping',
            description: '检查画布是否连通：发一条空命令给右侧栏的画布面板，返回画布侧的应答与耗时。画布命令超时、或不确定画布面板是否打开时先用它排查。',
            parameters: {},
            output: asText(),
            async execute(_args, exec) {
                const started = Date.now();
                const echo = await send(exec, 'ping', {});
                const cost = Date.now() - started;
                return [
                    '画布已连通。',
                    `往返耗时：${cost} ms`,
                    `画布应答：${JSON.stringify(echo)}`,
                    `桥状态：${JSON.stringify(bridge.status().browser)}`,
                ].join('\n');
            },
        }),
        defineTool({
            name: 'canvas_get',
            description: '读取当前画布的全部内容：每张卡片的 id、种类、节点类型、标题、世界坐标与所属分组，以及涂鸦笔数、视口缩放位移、当前选中项和打开的面板。**改动画布之前先调用它**，否则会凭猜测操作卡片的 id 和位置。',
            parameters: {},
            output: asText(),
            async execute(_args, exec) {
                const state = await send(exec, 'get_canvas', {});
                return formatCanvas(state);
            },
        }),
        defineTool({
            name: 'canvas_add_card',
            description: '在画布上新建一张卡片，返回它的 id。不指定坐标时会放在画布的空位。',
            parameters: {
                kind: {
                    type: 'string',
                    enum: ['scene', 'character', 'note', 'text', 'board', 'video', 'audio'],
                    description: '卡片种类。scene 场景、character 角色、note 便签、text 文本生成、board 分镜、video 视频生成、audio 音频素材。省略按 note 处理。',
                },
                title: { type: 'string', description: '卡片标题。' },
                x: { type: 'number', description: '画布世界坐标 X；省略时由画布决定。' },
                y: { type: 'number', description: '画布世界坐标 Y；省略时由画布决定。' },
            },
            output: asText(),
            async execute(args, exec) {
                const kind = isCardKind(args.kind) ? args.kind : 'note';
                const card = await send(exec, 'add_card', {
                    kind,
                    title: typeof args.title === 'string' ? args.title : undefined,
                    x: optionalNumber(args.x),
                    y: optionalNumber(args.y),
                });
                return `已新建卡片：#${card.id}「${card.title}」（${card.kind} / ${card.type}），位置 (${Math.round(card.x)}, ${Math.round(card.y)})。`;
            },
        }),
        defineTool({
            name: 'canvas_move_card',
            description: '把一张卡片移动到指定的世界坐标。坐标是画布世界坐标（不是屏幕像素），可以从 canvas_get 的结果里读到别的卡片作参照。',
            parameters: {
                id: { type: 'number', required: true, description: '卡片 id，来自 canvas_get。' },
                x: { type: 'number', description: '目标世界坐标 X；省略表示不改 X。' },
                y: { type: 'number', description: '目标世界坐标 Y；省略表示不改 Y。' },
            },
            output: asText(),
            async execute(args, exec) {
                const id = requiredNumber(args.id, 'id');
                const card = await send(exec, 'move_card', { id, x: optionalNumber(args.x), y: optionalNumber(args.y) });
                return `已移动卡片 #${id} 到 (${Math.round(card.x)}, ${Math.round(card.y)})。`;
            },
        }),
        defineTool({
            name: 'canvas_delete_card',
            description: '删除一张卡片。这是破坏性操作，删之前先用 canvas_get 确认 id 与标题，并把要删的卡片报给用户。注意：删分组卡片走的是「解组」语义，组里的子卡片会被释放出来而不是一起删掉。',
            parameters: {
                id: { type: 'number', required: true, description: '要删除的卡片 id，来自 canvas_get。' },
            },
            output: asText(),
            async execute(args, exec) {
                const id = requiredNumber(args.id, 'id');
                await send(exec, 'delete_card', { id });
                return `已删除卡片 #${id}。`;
            },
        }),
        defineTool({
            name: 'canvas_select_card',
            description: '在画布上选中一张卡片（用户能直接看到选中框）。用于把用户的注意力引到某张卡片上，或为后续操作指定目标。',
            parameters: {
                id: { type: 'number', required: true, description: '要选中的卡片 id，来自 canvas_get。' },
            },
            output: asText(),
            async execute(args, exec) {
                const id = requiredNumber(args.id, 'id');
                await send(exec, 'select_card', { id });
                return `已选中卡片 #${id}。`;
            },
        }),
        defineTool({
            name: 'canvas_set_view',
            description: '调整画布视口：缩放、平移，或让画布自动适应全部卡片。用户说「看不到」「放大一点」「整体看一下」时用它。',
            parameters: {
                fit: { type: 'boolean', description: 'true 时让画布自动缩放到框住全部卡片，此时忽略 zoom / x / y。' },
                zoom: { type: 'number', description: '缩放倍数，画布限制在 0.25～2.4 之间。' },
                x: { type: 'number', description: '视口位移 X（世界坐标）。' },
                y: { type: 'number', description: '视口位移 Y（世界坐标）。' },
            },
            output: asText(),
            async execute(args, exec) {
                const viewport = await send(exec, 'set_view', {
                    fit: args.fit === true,
                    zoom: optionalNumber(args.zoom),
                    x: optionalNumber(args.x),
                    y: optionalNumber(args.y),
                });
                const offset = viewport?.offset ?? {};
                return `视口已更新：缩放 ${Number(viewport?.zoom ?? 1).toFixed(2)}，位移 (${Math.round(Number(offset.x ?? 0))}, ${Math.round(Number(offset.y ?? 0))})。`;
            },
        }),
        defineTool({
            name: 'canvas_open_panel',
            description: '打开画布上的一个侧边面板：资产库、积分、生成、素材、涂鸦、快捷键或设置。',
            parameters: {
                panel: {
                    type: 'string',
                    enum: ['assets', 'credits', 'generate', 'library', 'materials', 'doodle', 'shortcuts', 'settings'],
                    required: true,
                    description: '要打开的面板。assets 资产、credits 积分、generate 生成、library 库、materials 素材、doodle 涂鸦、shortcuts 快捷键、settings 设置。',
                },
            },
            output: asText(),
            async execute(args, exec) {
                if (!isPanelId(args.panel)) throw new Error('不支持的面板，可选：assets / credits / generate / library / materials / doodle / shortcuts / settings');
                await send(exec, 'open_panel', { panel: args.panel });
                return `已打开面板：${args.panel}。`;
            },
        }),
        defineTool({
            name: 'canvas_run_agent',
            description: '把一条自然语言指令交给画布自己的画布助手处理。注意：该助手目前仍是占位实现（只会按关键词建场景卡片），只有在用户明确要求「让画布助手做」时才用它；常规操作请直接用 canvas_add_card 这类工具。',
            parameters: {
                prompt: { type: 'string', required: true, description: '要交给画布助手的指令。' },
            },
            output: asText(),
            async execute(args, exec) {
                const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
                if (prompt === '') throw new Error('参数 prompt 不能为空');
                await send(exec, 'run_agent', { prompt });
                return `已把指令交给画布助手：「${prompt}」。`;
            },
        }),
    ];
}
