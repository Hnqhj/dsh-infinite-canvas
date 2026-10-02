/**
 * 画布命令层 —— **纯逻辑，不碰 DOM，不碰 Vue/React**。
 *
 * 这一层的存在理由和 NexusVault 把 `canvas-commands.ts` 抽出来是同一条：
 * 契约要能在单测里逐条钉死，而不是靠"起个浏览器点一遍"。
 *
 * 所以它被切成两块：
 *
 *   `createModel()`      —— 状态（卡片 / 视口 / 选中 / 面板）+ 变更方法
 *   `runCanvasCommand()` —— `{requestId, action, params}` → 结果 的纯分发
 *
 * ## 与真画布的对应关系（改这个文件前先读）
 *
 *   本文件                          NexusVault
 *   ─────────────────────────────   ─────────────────────────────────────
 *   CARD_KINDS                      canvas/types/card.ts
 *   NODE_TYPE_FOR_KIND              canvas/types/card.ts
 *   PANEL_IDS                       canvas/types/card.ts
 *   MIN_ZOOM / MAX_ZOOM             canvas/types/card.ts
 *   createModel().commandContext    views/CanvasView.vue 的 commandContext
 *   runCanvasCommand()              canvas/mcp/canvas-commands.ts
 *
 * 三条硬约束（真画布那边同样成立，改这里等于改契约）：
 *
 *  1. **卡片 id 必须是数字**（真画布对应 `z.number()`）。
 *  2. **`get_canvas` 的字段名不能改**。返回结构直接喂给模型，加字段可以，
 *     改名会让它按旧名去读（`viewport.offset` 这类嵌套字段尤其致命）。
 *  3. **`kind` 是 7 值公开枚举，`type` 是节点类型真源**。写只能用 `kind`
 *     （7 值里没有"物品"和"图片生成"，它们被压进 `scene`）；读以 `type` 为准。
 */

/* ── 契约常量 ───────────────────────────────────────────────────────────── */

/** 7 值公开枚举：模型能写的全部卡片种类。 */
export const CARD_KINDS = ['scene', 'character', 'note', 'text', 'board', 'video', 'audio'];

/** `kind` → 节点类型真源。`audio` 另需写入 `data.media_type = 'audio'`。 */
export const NODE_TYPE_FOR_KIND = {
    scene: 'entity_scene',
    character: 'entity_character',
    note: 'note',
    text: 'gen_text',
    board: 'storyboard_shot',
    video: 'gen_video',
    audio: 'asset_input',
};

/** 画布上可打开的面板。 */
export const PANEL_IDS = ['assets', 'credits', 'generate', 'library', 'materials', 'doodle', 'shortcuts', 'settings'];

/** 缩放上下限。 */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.4;

/** 界面用的中文名。不属于契约，只影响文案。 */
export const KIND_LABEL = {
    scene: '场景',
    character: '角色',
    note: '便签',
    text: '文本',
    board: '分镜',
    video: '视频',
    audio: '音频',
};

export const PANEL_LABEL = {
    assets: '资产库',
    credits: '积分',
    generate: '生成',
    library: '库',
    materials: '素材',
    doodle: '涂鸦',
    shortcuts: '快捷键',
    settings: '设置',
};

/** 卡片尺寸与自适应留白（纯展示参数，真画布那边由节点模板决定）。 */
export const CARD_W = 208;
export const CARD_H = 136;
export const FIT_PADDING = 72;

/** 新卡片的落位走法：横三竖无限，免得叠在一起。 */
const NEW_CARD_STEP_X = 248;
const NEW_CARD_STEP_Y = 176;
const NEW_CARD_PER_ROW = 3;

/* ── 校验与收敛 ─────────────────────────────────────────────────────────── */

export const isCardKind = (value) => typeof value === 'string' && CARD_KINDS.includes(value);
export const isPanelId = (value) => typeof value === 'string' && PANEL_IDS.includes(value);
export const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** 空值统一收敛成"没给"。文案与真画布一字不差。 */
export function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** 必填数字；缺失或非数字时抛错，错误文案直接给模型。 */
export function requiredNumber(value, field) {
    const parsed = optionalNumber(value);
    if (parsed === undefined) throw new Error(`参数 ${field} 必须是数字`);
    return parsed;
}

/* ── 模型 ───────────────────────────────────────────────────────────────── */

/**
 * 建一个画布模型。
 *
 * @param options - `onChange()` 每次状态变更后调用（外壳用它重画）；
 *   `fit()` 由外壳提供"框住全部卡片"的实现（需要 DOM 尺寸，模型自己算不了）。
 */
export function createModel(options = {}) {
    const cards = [];
    const strokes = [];
    const viewport = { zoom: 1, offset: { x: 0, y: 0 } };
    let selection = null;
    let panel = null;
    let nextId = 1;

    /** 状态变了就喊一声。外壳没接也不该让业务逻辑崩。 */
    const notify = () => {
        try {
            options.onChange?.();
        } catch {
            /* 渲染出错不该回滚数据变更 */
        }
    };

    const find = (id) => cards.find((card) => card.id === id) ?? null;

    /** 下一个空位：从已有卡片的右下角继续排。 */
    function nextSlot() {
        const index = cards.length;
        return {
            x: 64 + (index % NEW_CARD_PER_ROW) * NEW_CARD_STEP_X,
            y: 64 + Math.floor(index / NEW_CARD_PER_ROW) * NEW_CARD_STEP_Y,
        };
    }

    /**
     * 建一张卡并放进画布。**不通知外壳** —— 调用方（命令面或外壳）自己决定
     * 什么时候重画，批量操作时就不会重画三次。
     *
     * 坐标的优先顺序：显式传入的 `position` > `input.x` / `input.y` > 自动排位。
     * 真画布的 `addCard(input)` 就是从 `input` 里读 x/y 的（`createCard({ x, y })`），
     * 所以 MCP 传 `x: 560` 时**必须**落在 560 —— 只给一个轴时另一个轴才走自动排位。
     */
    function create(input, position) {
        const kind = isCardKind(input.kind) ? input.kind : 'note';
        const auto = nextSlot();
        const x = position?.x ?? optionalNumber(input.x) ?? auto.x;
        const y = position?.y ?? optionalNumber(input.y) ?? auto.y;
        const card = {
            id: nextId,
            kind,
            type: NODE_TYPE_FOR_KIND[kind],
            title: typeof input.title === 'string' && input.title !== ''
                ? input.title
                : `${KIND_LABEL[kind]} ${nextId}`,
            x,
            y,
        };
        nextId += 1;
        // 真画布会给 audio 写 media_type，照做 —— 这是契约的一部分。
        if (kind === 'audio') card.media_type = 'audio';
        cards.push(card);
        return card;
    }

    /**
     * 命令面。与 `views/CanvasView.vue` 的 `commandContext` 逐方法对应。
     *
     * 每个方法都返回**结构化拷贝**：直接回传内部对象会让后来的改动倒灌进已经
     * 发出去的结果里（真画布那边是为了过 IPC 序列化，这里是为了同一个原因）。
     */
    const commandContext = {
        cards: () => cards.map((card) => ({ ...card })),
        strokes: () => strokes.map((stroke) => ({ ...stroke })),
        viewport: () => ({ zoom: viewport.zoom, offset: { ...viewport.offset } }),
        selectedId: () => selection,
        activePanel: () => panel,

        addCard(input) {
            const card = create(input);
            notify();
            return { ...card };
        },

        moveCard(id, position) {
            const card = find(id);
            if (card === null) throw new Error('找不到指定卡片');
            card.x = position.x ?? card.x;
            card.y = position.y ?? card.y;
            notify();
            return { ...card };
        },

        deleteCard(id) {
            const index = cards.findIndex((card) => card.id === id);
            if (index === -1) throw new Error('找不到指定卡片');
            cards.splice(index, 1);
            if (selection === id) selection = null;
            notify();
        },

        selectCard(id) {
            const card = find(id);
            if (card === null) throw new Error('找不到指定卡片');
            selection = card.id;
            notify();
        },

        setPanel(next) {
            panel = next;
            notify();
        },

        setViewport(patch) {
            if (patch.fit) {
                // 模型算不了尺寸，交给外壳；算完再把结果读回来返回给调用方。
                options.fit?.();
                notify();
                return commandContext.viewport();
            }
            if (patch.zoom !== undefined) viewport.zoom = clampZoom(patch.zoom);
            if (patch.x !== undefined) viewport.offset.x = patch.x;
            if (patch.y !== undefined) viewport.offset.y = patch.y;
            notify();
            return commandContext.viewport();
        },

        /**
         * 画布助手。
         *
         * **仍是关键词占位**，行为与真画布当前的 `runAgent()` 一致（那边第三期
         * 才会换成"读上下文 → 生成结构化 Patch → 应用"）。
         *
         * P1 起本文件**不参与运行** —— 它是上游 `canvas/mcp/canvas-commands.ts`
         * 的纯 JS 镜像，唯一用途是让 `tools/smoke-test.mjs` 能在 Node 里
         * 逐条钉死这 8 条命令的契约。改契约时对着上游那份改，别只改这里。
         */
        runAgent(prompt) {
            const value = String(prompt).trim();
            if (value === '') return;
            if (value.includes('变体')) {
                const base = value.replace(/生成?\s*3个?变体/, '').trim() || '场景';
                for (let i = 1; i <= 3; i += 1) create({ kind: 'scene', title: `${base} ${i}` });
            } else if (value.includes('移除') && selection !== null) {
                const card = find(selection);
                if (card !== null) card.title = `${card.title} · 已去背`;
            } else {
                create({ kind: 'scene', title: value.slice(0, 34) });
            }
            notify();
        },
    };

    return {
        cards,
        strokes,
        viewport,
        commandContext,
        notify,
        find,
        create,
        get selection() { return selection; },
        set selection(value) { selection = value; },
        get panel() { return panel; },
        set panel(value) { panel = value; },
        get nextId() { return nextId; },
        /** 清空回初始态（"重置"按钮用）。 */
        reset() {
            cards.length = 0;
            strokes.length = 0;
            selection = null;
            panel = null;
            nextId = 1;
            viewport.zoom = 1;
            viewport.offset.x = 0;
            viewport.offset.y = 0;
        },
    };
}

/* ── 分发 ───────────────────────────────────────────────────────────────── */

/**
 * 执行一条命令：成功返回结果对象，失败抛 `Error`（调用方负责回 error）。
 *
 * 与 `canvas/mcp/canvas-commands.ts` 的 `runCanvasCommand` 等价 ——
 * 分支顺序、默认值、错误文案都对齐。
 *
 * @param ctx - 命令面（`createModel().commandContext`）。
 * @param command - `{requestId, action, params?}`。
 */
export function runCanvasCommand(ctx, command) {
    const params = command.params ?? {};

    switch (command.action) {
        case 'get_canvas': {
            const selectedId = ctx.selectedId();
            return {
                nodes: ctx.cards(),
                strokes: ctx.strokes(),
                viewport: ctx.viewport(),
                // 旧字段：单选中项，保留不动（外部已有消费方）。
                selectedId,
                // 新字段：为多选预留。现在长度只会是 0 或 1。
                selectedIds: selectedId === null ? [] : [selectedId],
                activePanel: ctx.activePanel(),
            };
        }

        case 'add_card': {
            const kind = isCardKind(params.kind) ? params.kind : 'note';
            return ctx.addCard({
                kind,
                title: typeof params.title === 'string' ? params.title : undefined,
                x: optionalNumber(params.x),
                y: optionalNumber(params.y),
            });
        }

        case 'move_card': {
            const id = requiredNumber(params.id, 'id');
            return ctx.moveCard(id, { x: optionalNumber(params.x), y: optionalNumber(params.y) });
        }

        case 'delete_card': {
            const id = requiredNumber(params.id, 'id');
            ctx.deleteCard(id);
            return { deleted: true, id };
        }

        case 'select_card': {
            const id = requiredNumber(params.id, 'id');
            ctx.selectCard(id);
            return { selectedId: id };
        }

        case 'set_view': {
            const next = ctx.setViewport({
                fit: params.fit === true,
                zoom: optionalNumber(params.zoom),
                x: optionalNumber(params.x),
                y: optionalNumber(params.y),
            });
            return { zoom: next.zoom, offset: next.offset };
        }

        case 'open_panel': {
            if (!isPanelId(params.panel)) throw new Error('不支持的面板');
            ctx.setPanel(params.panel);
            return { panel: params.panel };
        }

        case 'run_agent': {
            const prompt = typeof params.prompt === 'string' ? params.prompt : '';
            if (!prompt.trim()) throw new Error('参数 prompt 不能为空');
            ctx.runAgent(prompt);
            return { accepted: true };
        }

        default:
            throw new Error(`不支持的画布命令：${command.action}`);
    }
}
