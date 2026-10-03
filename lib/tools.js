/**
 * Agent 工具定义。
 *
 * 单独成模块是为了可测：`execute()` 是纯逻辑 + 桥调用，用 `defineTool` 的替身
 * （恒等函数）就能在 Node 里直接驱动，不需要起 GUI、不需要模型。
 *
 * ## 这些工具做什么、不做什么
 *
 * 它们把「对话」和「画布」连起来：模型能读画布现状、加卡、移卡、删卡、选卡、
 * 调视口、开面板。上游那一套（`apps/web/src/canvas/mcp/canvas-commands.ts` 的
 * `CanvasCommandContext`）已经实现好了，NexusVault 桌面端就是用它接 MCP 的，
 * 这里只是换了一根传输线。
 *
 * 但**上游契约只让人摆卡片，不让人写内容**：`add_card` 只认 kind/title/x/y，
 * 建出来的卡是空的。所以我们在内嵌页里补了三条动作（`update_card` /
 * `set_card_data` / `set_card_type`），真源在
 * `build/overlay/src/dsh-commands.ts`。它们是**内嵌页专有**的 —— 上游桌面端的
 * MCP 服务不认这三条。
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
import { isCardKind, isNodeType, isPanelId, NODE_TYPES } from './protocol.js';

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

/** 非空字符串；空串一律当成"没给"，免得把卡片标题清成空白。 */
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 纯对象（数组不算）；其余一律当"没给"，由调用方决定是报错还是忽略。 */
function plainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value;
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
     * 三次重试都没有 —— 命令不幂等就是长的那个样子。要重试安全，走 `clientToken`：
     * 见下面各工具的说明。
     */
    const send = (exec, action, params) => bridge.dispatch(action, params, { sessionId: resolveSessionId(exec) });

    /**
     * 带幂等键发一条命令。
     *
     * 为什么值得为它单独留一个参数：**超时不等于没执行**。回执在回来的路上丢了，
     * 画布上的卡其实已经加好了。这时候再发一次 `add_card`，就会多出一张。
     * 给了 `clientToken`，重投拿到的是上一次的结果，而不是被执行第二次。
     *
     * @param token - 调用方给的钥匙；空或不给就退化成普通命令。
     */
    const sendOnce = (exec, action, params, token) => bridge.dispatch(action, params, {
        sessionId: resolveSessionId(exec),
        idempotencyKey: typeof token === 'string' && token.trim() !== '' ? token.trim() : null,
    });

    /* ── 参数收敛 ─────────────────────────────────────────────────────── */

    /** 单次批量最多几步：再多就不叫批量了，而且一次往返占着太久。 */
    const MAX_BATCH_STEPS = 24;

    /**
     * 允许批量执行的动作。`get_canvas` 不在内 —— 中途要读请用 `canvas_get`。
     *
     * 写内容的三条也在内：`add_card` 建出来的卡是空的，能「建一批 + 填一批」
     * 才算完整，否则模型要为每个字段来回一趟。
     */
    const BATCH_ACTIONS = [
        'add_card', 'move_card', 'delete_card', 'select_card', 'set_view', 'open_panel',
        'update_card', 'set_card_data', 'set_card_type',
    ];

    /**
     * 把一个动作的入参收敛成画布认识的形状。
     *
     * **单命令工具和批量工具必须共用这一份。** 各写一份的话，两边对同一个动作的
     * 理解会渐渐不一样（少一层默认值、多一条校验），而模型是照着其中一个工具的
     * 说明在写参数 —— 那是最难查的一类偏。
     *
     * @param action - 动作名。
     * @param args - 模型给的原始参数。
     * @returns 交给画布的 params。
     */
    function normaliseParams(action, args) {
        const input = args ?? {};
        switch (action) {
            case 'add_card': {
                const x = optionalNumber(input.x);
                const y = optionalNumber(input.y);
                // 真画布在只给一个轴时会把另一个设成 0（`Yt()` 里的 `x??0, y??0`）。
                // 与其让它悄悄把卡片扔到画布最上面一行，不如在这里说清楚。
                if ((x === undefined) !== (y === undefined)) {
                    throw new Error('x 和 y 必须成对提供：只给一个时，真画布会把另一个轴设成 0，卡片会跑到画布边缘。先用 canvas_get 取一张参照卡的坐标。');
                }
                return {
                    kind: isCardKind(input.kind) ? input.kind : 'note',
                    title: typeof input.title === 'string' ? input.title : undefined,
                    x,
                    y,
                };
            }
            case 'move_card':
                return {
                    id: requiredNumber(input.id, 'id'),
                    x: optionalNumber(input.x),
                    y: optionalNumber(input.y),
                };
            case 'delete_card':
            case 'select_card':
                return { id: requiredNumber(input.id, 'id') };
            case 'set_view':
                return {
                    fit: input.fit === true,
                    zoom: optionalNumber(input.zoom),
                    x: optionalNumber(input.x),
                    y: optionalNumber(input.y),
                };
            case 'open_panel':
                if (!isPanelId(input.panel)) throw new Error('不支持的面板，可选：assets / credits / generate / library / materials / doodle / shortcuts / settings');
                return { panel: input.panel };
            /* ── 下面三条是我们自己补的动作，上游契约里没有 ────────────── */
            case 'update_card': {
                const id = requiredNumber(input.id, 'id');
                const title = nonEmptyString(input.title);
                const data = plainObject(input.data);
                // 两个都不给，命令跑完了什么都不会变 —— 那还不如现在报错。
                if (title === undefined && data === undefined) {
                    throw new Error('至少要给 title 或 data 其中一个，否则这张卡不会有变化');
                }
                return { id, title, data };
            }
            case 'set_card_data': {
                const id = requiredNumber(input.id, 'id');
                const data = plainObject(input.data);
                if (data === undefined) throw new Error('参数 data 必须是对象，例如 {"summary":"雨夜巷口"}');
                return { id, data };
            }
            case 'set_card_type': {
                const id = requiredNumber(input.id, 'id');
                if (!isNodeType(input.type)) throw new Error(`不支持的节点类型，可选：${NODE_TYPES.join(' / ')}`);
                return { id, type: input.type };
            }
            default:
                throw new Error(`不支持的动作：${action}`);
        }
    }

    /** 把一个动作的结果压成一句短语，给批量报告用。 */
    function summarise(action, result) {
        if (result === null || typeof result !== 'object') return '已完成';
        switch (action) {
            case 'add_card': return `#${result.id}「${result.title}」`;
            case 'move_card': return `#${result.id} → (${Math.round(result.x)}, ${Math.round(result.y)})`;
            case 'delete_card': return `#${result.id} 已删除`;
            case 'select_card': return `#${result.selectedId} 已选中`;
            case 'set_view': {
                const offset = result.offset ?? {};
                return `缩放 ${Number(result.zoom ?? 1).toFixed(2)}，位移 (${Math.round(Number(offset.x ?? 0))}, ${Math.round(Number(offset.y ?? 0))})`;
            }
            case 'open_panel': return `面板 ${result.panel}`;
            case 'update_card': return `#${result.id}「${result.title}」已更新`;
            case 'set_card_data': return `#${result.id} 内容已写入`;
            case 'set_card_type': return `#${result.id} → ${result.type}`;
            default: return '已完成';
        }
    }

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
            description: '在画布上新建一张卡片，返回它的 id。坐标要么两个都给、要么都不给（只给一个时画布会把另一个轴设成 0，卡片会跑到画布最边上）。都不给时由画布排位，但它的空位只有九格，第十张会与第一张重叠 —— 连着建多张时请用 canvas_get 取一张参照卡，自己往下排。',
            parameters: {
                kind: {
                    type: 'string',
                    enum: ['scene', 'character', 'note', 'text', 'board', 'video', 'audio'],
                    description: '卡片种类。scene 场景、character 角色、note 便签、text 文本生成、board 分镜、video 视频生成、audio 音频素材。省略按 note 处理。',
                },
                title: { type: 'string', description: '卡片标题。' },
                x: { type: 'number', description: '画布世界坐标 X。**必须与 y 一起给**，否则画布会把 y 置 0。' },
                y: { type: 'number', description: '画布世界坐标 Y。**必须与 x 一起给**。' },
                clientToken: {
                    type: 'string',
                    description: '这次新建的重复凭证。收不到回执、或不确定有没有建成时，用同一个 clientToken 再发一次不会多出一张卡 —— 第二次会直接拿回第一次的结果。给值就用它，不给则每次都是一次独立的新建。',
                },
            },
            output: asText(),
            async execute(args, exec) {
                const card = await sendOnce(exec, 'add_card', normaliseParams('add_card', args), args.clientToken);
                return `已新建卡片：#${card.id}「${card.title}」（${card.kind} / ${card.type}），位置 (${Math.round(card.x)}, ${Math.round(card.y)})。`;
            },
        }),
        defineTool({
            name: 'canvas_update_card',
            description: '往一张已有的卡片里写内容：改标题、写业务字段，或两者一起。这是把画布真正用起来的那条命令 —— canvas_add_card 建出来的卡是空的，场景卡没有描述、分镜卡没有摘要和台词，都要靠它填。**写入是合并，不是替换**：没提到的字段保持原值，不会把分镜的镜号、时长这类默认值抹掉。',
            parameters: {
                id: { type: 'number', required: true, description: '要修改的卡片 id，来自 canvas_get。' },
                title: { type: 'string', description: '新的卡片标题。不给就保留原标题。' },
                data: {
                    type: 'object',
                    description: '要写入的业务字段，按卡片类型给对应的键。分镜卡（storyboard_shot）：shot_no / summary / dialogue / prompt / duration_sec / target / model_id / output_url / refs；角色与场景卡（entity_character / entity_scene / entity_prop）：name / description / ref_asset_ids / preview_url；便签（note）：text；文本生成卡（gen_text）：prompt / output / model_id。不确定有哪些键时，先用 canvas_get 看一眼同类卡片。',
                },
            },
            output: asText(),
            async execute(args, exec) {
                const card = await send(exec, 'update_card', normaliseParams('update_card', args));
                return `已更新卡片 #${card.id}「${card.title}」（${card.kind} / ${card.type}）。`;
            },
        }),
        defineTool({
            name: 'canvas_set_card_type',
            description: '把一张已有的卡片换成另一种节点类型。用于 canvas_add_card 的 kind 枚举覆盖不到的类型（物体 entity_prop、图片生成 gen_image、剧本输入 script_input 等）。换类型时数据按新类型的默认值重置，只保留新旧类型都有的同名字段。分镜卡不必转 —— canvas_add_card 的 kind 传 board 建出来的就是分镜卡（storyboard_shot）。',
            parameters: {
                id: { type: 'number', required: true, description: '要换类型的卡片 id，来自 canvas_get。' },
                type: {
                    type: 'string',
                    enum: NODE_TYPES,
                    required: true,
                    description: '目标节点类型。asset_input 素材输入、script_input 剧本、gen_text 文本生成、gen_image 图片生成、gen_video 视频生成、entity_character 角色、entity_scene 场景、entity_prop 物品、storyboard_shot 分镜、note 便签。',
                },
            },
            output: asText(),
            async execute(args, exec) {
                const card = await send(exec, 'set_card_type', normaliseParams('set_card_type', args));
                return `卡片 #${card.id} 已换成 ${card.type}（${card.kind}），标题仍为「${card.title}」。`;
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
                const card = await send(exec, 'move_card', normaliseParams('move_card', args));
                return `已移动卡片 #${id} 到 (${Math.round(card.x)}, ${Math.round(card.y)})。`;
            },
        }),
        defineTool({
            name: 'canvas_delete_card',
            description: '删除一张卡片。这是破坏性操作，删之前先用 canvas_get 确认 id 与标题，并把要删的卡片报给用户。注意：删分组卡片走的是「解组」语义，组里的子卡片会被释放出来而不是一起删掉。',
            parameters: {
                id: { type: 'number', required: true, description: '要删除的卡片 id，来自 canvas_get。' },
                clientToken: {
                    type: 'string',
                    description: '这次删除的重复凭证。给了它，同一个凭证重复调用会直接拿回上一次的结果，不会再报一次"找不到卡片" —— 收不到回执又不敢重试的场景用它。',
                },
            },
            output: asText(),
            async execute(args, exec) {
                const id = requiredNumber(args.id, 'id');
                await sendOnce(exec, 'delete_card', normaliseParams('delete_card', args), args.clientToken);
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
                await send(exec, 'select_card', normaliseParams('select_card', args));
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
                const viewport = await send(exec, 'set_view', normaliseParams('set_view', args));
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
                await send(exec, 'open_panel', normaliseParams('open_panel', args));
                return `已打开面板：${args.panel}。`;
            },
        }),
        defineTool({
            name: 'canvas_batch',
            description: '一次调用里按顺序执行多条画布命令（建卡、写内容、换类型、移卡、删卡、选中、调视口、开面板）。照着一个结构铺一批卡片、或要一口气改动多处时用它，省掉来回好多趟。中途某一步失败就停下来，并告诉你已经做到了第几步 —— 画布没有"撤销"这一步，所以前面几步的改动**不会**自动还原，按返回的清单接着处理。',
            parameters: {
                steps: {
                    type: 'array',
                    required: true,
                    description: '要顺序执行的步骤。每步是 {action, params}，action 取 add_card / update_card / set_card_data / set_card_type / move_card / delete_card / select_card / set_view / open_panel 之一；params 与对应的单个工具完全一致（例如 add_card 要 x 和 y 成对）。建一批卡片再逐张填内容，是它最典型的用法。',
                },
                continueOnError: {
                    type: 'boolean',
                    description: 'true 时某一步失败也继续做剩下的，最后把每一步的结果（含失败原因）一起列出来。默认 false：遇到第一个失败就停，免得后面的步骤建立在已经错了的状态上。',
                },
            },
            output: asText(),
            async execute(args, exec) {
                const steps = Array.isArray(args.steps) ? args.steps : [];
                if (steps.length === 0) throw new Error('参数 steps 不能为空');
                if (steps.length > MAX_BATCH_STEPS) throw new Error(`一次最多 ${MAX_BATCH_STEPS} 步，多了请拆成几批`);

                const keepGoing = args.continueOnError === true;
                const report = [];
                for (let index = 0; index < steps.length; index += 1) {
                    const step = steps[index] ?? {};
                    const action = typeof step.action === 'string' ? step.action.trim() : '';
                    if (!BATCH_ACTIONS.includes(action)) {
                        report.push({ index: index + 1, action: action || '（空）', ok: false, error: `不支持的动作，可选：${BATCH_ACTIONS.join(' / ')}` });
                        if (!keepGoing) break;
                        continue;
                    }
                    try {
                        const params = normaliseParams(action, step.params);
                        const result = await send(exec, action, params);
                        report.push({ index: index + 1, action, ok: true, detail: summarise(action, result) });
                    } catch (error) {
                        report.push({
                            index: index + 1,
                            action,
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        if (!keepGoing) break;
                    }
                }

                const failed = report.filter((row) => !row.ok);
                const lines = [`批量执行 ${report.length}/${steps.length} 步：成功 ${report.length - failed.length}，失败 ${failed.length}。`];
                for (const row of report) {
                    lines.push(row.ok
                        ? `  ${row.index}. ${row.action} ✓ ${row.detail}`
                        : `  ${row.index}. ${row.action} ✗ ${row.error}`);
                }
                if (failed.length > 0) {
                    lines.push('画布没有"撤销"这一步 —— 失败之前的改动已经落在画布上了，按这个清单接着处理。');
                }
                return lines.join('\n');
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
