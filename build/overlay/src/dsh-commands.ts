/**
 * 扩展命令面 —— **画布本来不会的那些动作**，由我们这一层补上。
 *
 * ## 为什么会有这个文件
 *
 * 上游 `canvas/mcp/canvas-commands.ts` 只有 8 个动作，而且 `add_card` 只认
 * `kind` / `title` / `x` / `y`。结果是模型能摆卡片，却**写不进任何内容**：
 * 场景卡没有描述、分镜卡没有摘要和台词、便签里没有字。而画布其实**有**这些
 * 字段 —— 每种节点类型都有一份 `defaultData`（`entity_*` 是 `name`/`description`，
 * `storyboard_shot` 是 `shot_no`/`summary`/`dialogue`/`prompt`，`note` 是 `text`），
 * 只是命令面没把它们开出来。
 *
 * 改上游契约要去上游仓库。这里是另一条路：**抢在画布注册处理器之前把接口包一层**。
 * 传输层（`lib/embed/canvas-transport.js`）已经占住 `window.nexusvaultMcp`，画布挂载时
 * 会调 `onCommand(handler)` 注册它自己的处理器 —— 我们把那个 `onCommand` 换掉，
 * 让它注册的 handler 先进我们这一层：认得的动作自己办，不认得的原样转交。
 * 于是**上游一行都不用改**，命令面却多了几条。
 *
 * ## `flow` 从哪来（这是全文件最要紧的一点）
 *
 * 状态只能从 Vue Flow 的 store 拿到，而 `useVueFlow()` **在组件外调用会新建一个空
 * store**（`@vue-flow/core` 的实现：`inject` 拿不到就走 `storage.create()`），
 * 拿不到画布正在用的那个。
 *
 * 所以它由调用方（`main.ts` 的根组件）在 `setup()` 里调好再传进来 —— 根组件 `provide`
 * 的 store 会被路由子组件 `CanvasView` 的 `useVueFlow()` `inject` 到，于是我们手里这份
 * **就是画布用的那一份**。顺序不能反：`installExtendedCommands` 必须在 `createApp`
 * 之前装好（画布一挂载就会来注册）。
 *
 * ## 为什么没有 `connect`
 *
 * 上一版计划里列过它。**做不了，也不该做**：上游 2026-09-29 已把端口体系整体下线
 * （`canvas/persistence.ts` 的存档格式里 `edges` 字段直接丢弃，`CanvasView.vue`
 * 全篇零 `addEdges`）。画布不再是节点图，卡片之间的关系改由「拖进创作板」和
 * 「提示词里 @ 提及」表达，两者都落在 `card.data.refs`。往一个不存在的图结构上
 * 加连线，只会写出没人读的数据。
 *
 * ## 为什么是 `set_card_type` 而不是「建卡时指定类型」
 *
 * `add_card` 拿不到 `type`：命令层只透传 `kind`，而 `CanvasView` 的
 * `commandContext.addCard` 又把 `input` 重建成 `{kind,title,x,y}` —— **两道都掐掉了**。
 * 要开就得改上游那个 3200 行的视图组件，不划算。
 *
 * 好在改类型这条路是通的：`CanvasCardNode.vue` 里写着「节点类型恒为 `canvasCard`，
 * `card.type` 保持**唯一真源**」，壳是按 `data.card.type` 查 schema 渲染的。
 * 所以「先 `add_card` 建一张，再 `set_card_type` 转过去」等价于直接建 —— 而
 * `kind: 'board'` 本来就映射到 `storyboard_shot`，分镜卡甚至不用转。
 */

import { getNodeSchema, NODE_SCHEMAS } from './canvas/nodes/registry'
import { kindForNode } from './canvas/types/card'

/**
 * 只声明我们真用到的那几个方法。
 *
 * `useVueFlow()` 返回的东西很大（几十个 getter 与 action），全量标注类型会把它
 * 整个拖进这一层的编译面；而这里只需要"找到节点""改节点数据""改节点本身"。
 */
export interface FlowStore {
  findNode: (id: string) => unknown | undefined
  updateNodeData: (id: string, data: Record<string, unknown>, options?: { replace?: boolean }) => void
  /** 改 `data` 之外的节点字段（`style`）必须走它：`updateNodeData` 只碰 `data`。 */
  updateNode: (id: string, update: Record<string, unknown>, options?: { replace?: boolean }) => void
}

/** 我们这一层新增的动作。上游没有，别写进上游契约的镜像里当真源。 */
export const EXTENDED_ACTIONS = ['update_card', 'set_card_data', 'set_card_type'] as const

/** 节点业务数据的落点：`node.data.card`。上游 `flowNodeToCard` 就是这么读的。 */
type CardData = Record<string, unknown>

interface CanvasCard {
  id: number
  title?: string
  type?: string
  kind?: string
  data?: CardData
  [key: string]: unknown
}

interface ExtendedCommand {
  requestId?: string
  action?: string
  params?: Record<string, unknown>
}

/**
 * 把更新后的节点排成模型能读的形状，与上游 `flowNodeToCard` 对齐。
 *
 * 位置用 `computedPosition`（含父节点偏移的绝对坐标）而不是 `position`：
 * 分组里的子节点 `position` 是相对坐标，直接给模型会把它算错地方。
 */
function cardOf(node: unknown): Record<string, unknown> {
  const anyNode = node as {
    data?: { card?: CanvasCard }
    position?: { x?: number; y?: number }
    computedPosition?: { x?: number; y?: number }
  }
  const card = anyNode?.data?.card ?? ({} as CanvasCard)
  const at = anyNode?.computedPosition ?? anyNode?.position ?? {}
  return { ...card, x: Number(at?.x ?? 0), y: Number(at?.y ?? 0) }
}

/** 取节点上那张卡，取不到就抛 —— 后面三个动作的第一步都一样。 */
function cardOn(node: unknown, id: number): CanvasCard {
  const card = (node as { data?: { card?: CanvasCard } } | undefined)?.data?.card
  if (!card) throw new Error(`卡片 #${id} 上没有业务数据（不是画布自己建的节点？）`)
  return card
}

/**
 * 补齐画布不会、但模型最需要的那几条命令。
 *
 * @param flow - 与画布共用的 Vue Flow store（见文件头）。
 * @returns 装上了返回 `true`；传输层不在（或已被别的实现占用）返回 `false`。
 */
export function installExtendedCommands(flow: FlowStore): boolean {
  const api = (window as unknown as { nexusvaultMcp?: Record<string, unknown> }).nexusvaultMcp
  // 只认我们自己的传输层：桌面端 preload 那一份不是这个形状，别去动它。
  if (!api || api.__dshTransport !== true) return false
  if (typeof api.onCommand !== 'function' || typeof api.reply !== 'function') return false

  const rawOnCommand = api.onCommand as (cb: unknown) => () => void
  const reply = api.reply as (requestId: string, result?: unknown, error?: string) => void

  /** 画布自己的处理器。注册进来之前，命令只能先攒着 —— 见 `pending`。 */
  let native: ((command: ExtendedCommand) => void | Promise<void>) | null = null

  /**
   * 画布还没挂载时收到的命令。
   *
   * 不加这段的话，冷启动期间（画布脚本还在路上）发来的扩展命令会被丢掉，
   * 而那正是现在最常发生的一段时间 —— 与传输层里 `HANDLER_GRACE_MS` 同一个理由。
   */
  const pending: ExtendedCommand[] = []

  async function runExtended(command: ExtendedCommand): Promise<unknown> {
    const params = command.params ?? {}
    switch (command.action) {
      case 'update_card':
      case 'set_card_data':
        return updateCard(flow, command.action, params)
      case 'set_card_type':
        return setCardType(flow, params)
      default:
        return undefined
    }
  }

  api.onCommand = (callback: unknown) => {
    if (typeof callback === 'function') {
      native = callback as (command: ExtendedCommand) => void | Promise<void>
      // 补投那些比画布早到的命令。
      for (const command of pending.splice(0)) void deliver(command)
    }
    // 交给传输层的是我们这一层。
    return rawOnCommand((command: ExtendedCommand) => { void deliver(command); })
  }

  async function deliver(command: ExtendedCommand): Promise<void> {
    const requestId = typeof command?.requestId === 'string' ? command.requestId : ''
    if (requestId === '') return
    // 不是我们认得的动作：原样转交画布（画布没挂载就先欠着，等它注册时补投）。
    if (!EXTENDED_ACTIONS.includes(command.action as (typeof EXTENDED_ACTIONS)[number])) {
      if (native === null) pending.push(command)
      else native(command)
      return
    }
    try {
      reply(requestId, await runExtended(command))
    } catch (error) {
      reply(requestId, undefined, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 排障把手：无头浏览器 / 控制台里能直接问到这一层的状态。
   *
   * 三个字段各有各的用处，缺一个「是不是画布那一份 store」这个问题就答不了：
   *   `installed`  —— 包装装上了没有（传输层不在时会是 false / 不存在）
   *   `actions`    —— 认得哪些动作
   *   `nodeCount`  —— **我们手里这份 store 里有几个节点**。画布上明明有卡、
   *                   这里却是 0，就说明 `useVueFlow()` 拿到的不是画布那份
   *                   （多半是有人在组件外调了它）。这是本文件最容易坏的一处，
   *                   光看代码看不出来，只能这样量。
   *
   * `run` 是给验证用的直驱入口：它绕过传输层跑一次命令并**直接返回结果**，
   * 所以不需要宿主半在场也能验证动作本身对不对。
   */
  ;(window as unknown as { __dshExtended?: unknown }).__dshExtended = {
    installed: true,
    actions: EXTENDED_ACTIONS.slice(),
    nodeCount: () => {
      const nodes = (flow as unknown as { nodes?: { value?: unknown[] } }).nodes
      return Array.isArray(nodes?.value) ? nodes.value.length : -1
    },
    run: (action: string, params: Record<string, unknown>) =>
      runExtended({ action, params }),
  }

  return true
}

/**
 * 改一张卡：标题、业务数据，或两者一起。
 *
 * `data` 是**合并**而不是替换 —— 每种节点类型都有一份 `defaultData`（分镜有
 * `shot_no` / `duration_sec` 这类带默认值的字段），整份换掉会把它们抹平，
 * 画布上的节点反而变空。
 *
 * 两个动作的区别只是"能不能改标题"：
 *   `update_card`  —— 标题与数据都行（模型改卡片走这条）
 *   `set_card_data` —— 只动数据（批量写内容时更省心，不会手滑改掉标题）
 */
function updateCard(flow: FlowStore, action: string, params: Record<string, unknown>) {
  const id = Number(params.id)
  if (!Number.isSafeInteger(id)) throw new Error('参数 id 必须是数字')

  const node = flow.findNode(String(id))
  if (!node) throw new Error('找不到指定卡片')
  const current = cardOn(node, id)

  const next: CanvasCard = { ...current }
  if (action === 'update_card' && typeof params.title === 'string' && params.title !== '') {
    next.title = params.title
  }
  const patch = params.data
  if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
    next.data = { ...(current.data ?? {}), ...(patch as CardData) }
  }

  // 浅合并到 node.data：只换 `card` 这一个键，别把它旁边的东西抹掉。
  flow.updateNodeData(String(id), { card: next })
  return cardOf(flow.findNode(String(id)))
}

/**
 * 换一张卡的节点类型。
 *
 * 上游 `add_card` 只给 7 值 `kind` 枚举，映射到 7 个节点类型；注册表里其实还有
 * `entity_prop` / `gen_image` / `script_input` / `canvas_text` / `gen_text` 这些
 * 拿不到的类型。`add_card` 的 `type` 又被命令层和 `commandContext.addCard` 各掐一道，
 * 所以「把一张已存在的卡转成别的类型」是唯一走得通的路 —— 见文件头。
 *
 * ## 数据怎么过渡
 *
 * 新类型 `defaultData` 打底，再**只**把旧数据里「新 schema 也声明了」的同名键盖上去。
 * 两端都照顾到了：
 *   · 新类型该有的默认值一定在（`shot_no`、`duration_sec` 这类不会缺）；
 *   · 同名字段的旧内容不丢（比如 `refs`，它在新旧 schema 里都叫 `refs`）；
 *   · 旧类型的专属字段（便签的 `text`）不会被带进分镜卡里变成垃圾。
 *
 * ## 为什么拒掉 group / region
 *
 * 它们不是内容节点：尺寸存在实例 `data` 上（`width`/`height`），分组还要写
 * Vue Flow 的 `dimensions`（几何真源，子节点 `extent:'parent'` 的钳制读它）。
 * 这里只改 `card.type` 不会补那些，转过去会得到一个 0×0 的框。要分组就用
 * 画布自己的圈选打组。
 */
function setCardType(flow: FlowStore, params: Record<string, unknown>) {
  const id = Number(params.id)
  if (!Number.isSafeInteger(id)) throw new Error('参数 id 必须是数字')

  const type = params.type
  if (typeof type !== 'string' || type === '') {
    throw new Error(`参数 type 必须是字符串，可选值：${paletteTypes().join(' / ')}`)
  }

  const node = flow.findNode(String(id))
  if (!node) throw new Error('找不到指定卡片')
  const current = cardOn(node, id)

  const schema = getNodeSchema(type)
  if (!schema) {
    throw new Error(`未注册的节点类型：${type}；可选值：${paletteTypes().join(' / ')}`)
  }
  if (schema.hiddenFromPalette) {
    // 三类的理由不同，但结论一样：转过去也用不起来。
    //   group / region —— 不是内容节点，尺寸在实例 data 上，会得到一个 0×0 的框；
    //   canvas_text    —— 是内容，但只能由文本工具创建（它要顺带进编辑态）。
    throw new Error(`「${schema.title}」不能通过 set_card_type 转换 —— 它只能由画布上对应的工具创建`)
  }
  if (current.type === type) return cardOf(node)

  const defaults = schema.defaultData ?? {}
  // 只保留新 schema 认识的键，其余随旧类型一起退休。
  const carried: CardData = {}
  for (const key of Object.keys(defaults)) {
    const old = current.data?.[key]
    if (old !== undefined) carried[key] = old
  }
  const data: CardData = { ...defaults, ...carried }

  const next: CanvasCard = {
    ...current,
    type,
    // kind 是 type 的有损投影，必须跟着重算，否则 get_canvas 会报回旧种类。
    kind: kindForNode(type, data),
    data,
  }

  // 一次写完 data 与 style：buildFlowNode 给的宽高来自 schema.size，
  // 不同类型宽度不同（分镜 272、创作板 394…），不跟着换会留一个错尺寸。
  flow.updateNode(String(id), {
    data: { card: next },
    style: schema.size ? { width: `${schema.size.width}px` } : undefined,
  })

  return cardOf(flow.findNode(String(id)))
}

/** 报错信息里要列出可选类型，取「面板里看得见的那些」（排除 group / region）。 */
function paletteTypes(): string[] {
  return NODE_SCHEMAS.filter((schema) => !schema.hiddenFromPalette).map((schema) => schema.type)
}
