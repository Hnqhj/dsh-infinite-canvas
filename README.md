# 无限画布 · DSH 插件

把 [NexusVault](https://cnb.cool/hjqn/ai-tansuobianjibu) 的无限画布接进 **DeepSeek Harness 的右侧栏**，
并让**对话直接操控它**。

画布落在右栏的**原生架构**里 —— 一个真正的右侧栏 tab 类型，连同引导页入口与 chip 图标。
不是浮层，也不是外挂窗口：拖宽、切全屏、切会话保留、每会话独立布局，这些行为都跟
「工作区文件 / 新建终端 / 浏览器」完全一致。

![画布全貌（浅色）](docs/全节点-light.png)

---

## 目录

- [它是什么](#它是什么)
- [已经做到什么](#已经做到什么)
- [怎么用对话操控](#怎么用对话操控)
- [安装](#安装)
- [命令面](#命令面)
- [架构](#架构)
- [主题与外观](#主题与外观)
- [真画布是怎么搬进来的](#真画布是怎么搬进来的)
- [仓库结构](#仓库结构)
- [开发](#开发)
- [已验证 / 未验证](#已验证--未验证)

---

## 它是什么

DSH 的对话里多出 9 个 `canvas_*` 工具。你用人话下指令，模型调工具，命令经长轮询
送到**活着的那块画布**上执行，结果再回执给模型 —— 画布是真画布，不是仿制品。

关键在于**画布侧零改动**：上游 `CanvasView.vue` 挂载时会自己调
`window.nexusvaultMcp?.onCommand(...)`（它在文件顶部 `declare global` 里声明了这个接口），
我们只是抢先把那个名字占住。8 条命令、`kind` 枚举、面板 id、缩放上下限全部沿用上游
常量，所以命令面、传输层、HTTP 面、工具层在换真画布时**一行都没改**。

## 已经做到什么

| 部分 | 状态 |
|---|---|
| 宿主半：HTTP 面 + 命令桥 + 9 个 Agent 工具 | ✅ 完成，**38 项冒烟测试全绿** |
| 浏览器半：tab 注册、iframe 承载、主题跟随、自动开面板 | ✅ 完成 |
| 画布本体 | ✅ **真画布**：节点卡、8 个面板、右键菜单、涂鸦层、色块、小地图、项目管理页全部可用 |
| 命令闭环 | ✅ 实测：`add_card` / `select_card` / `open_panel` / `get_canvas` 返回的都是真画布自己的结构 |
| 主题三态 | ✅ 跟随 DSH 的 `light` / `dark` / `system`，控件外观按 DSH 官方设计 token 重置 |
| 存档 | ✅ 实测：localStorage 跨浏览器重启存活 |
| 窄容器排版 | ✅ 实测：380~900px 六档零重叠 |

## 怎么用对话操控

直接说人话：

> - 看看画布上有什么
> - 在雨夜街口那张卡右边加一张分镜卡
> - 把 3 号卡挪到 (900, 200)
> - 把画布上的卡片都框进视野
> - 打开生成面板

**命令到达时画布没开？** 会自动把右栏画布 tab 打开（`autoOpenPanel: true`，默认开）。
这条靠一个哨兵实现：画布没开时每 2.5 秒读一次 `/status`（纯读端点，不会把命令消费掉），
发现队列里有新命令就去开面板。

## 安装

> [!IMPORTANT]
> 画布本体（以及它的构建产物）**不在本仓库里**。上游源码是 NexusVault，本仓库只含
> 适配层与构建脚本，所以 clone 之后**必须先构建一次**，否则 `lib/embed/index.html`
> 不存在，画布打不开。

**前置：** 已安装 DSH，Node 22+。

```bash
# 1. 克隆本仓库
git clone https://github.com/Hnqhj/dsh-infinite-canvas.git
cd dsh-infinite-canvas

# 2. 取上游源码到脚本默认找的位置（构建从这里读画布本体）
#    上游仓库：https://cnb.cool/hjqn/ai-tansuobianjibu
git clone https://cnb.cool/hjqn/ai-tansuobianjibu.git _recon/cnb-repo

# 3. 构建画布（约 25 秒，产出 lib/embed/）
cd build && npm install && npm run build && cd ..
```

```powershell
# 4. 同步进 DSH 的某个 profile
powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev-install.ps1 `
  -DshHome "$env:USERPROFILE\.dsh" -Profile desktop -SkipProjection

# 5. 重启 DSH
```

上游位置不在默认路径时，用 `--from=` 参数或 `CANVAS_UPSTREAM=` 环境变量覆盖。

> **改完源码要重新同步**：pnpm 对 `file:` 目录依赖按**路径**而非内容哈希判定，
> 不会发现工作区里的改动。改了就再跑一次第 4 步。
>
> - **宿主半**（`index.js`、`lib/*.js`）改了 → **重启 DSH**
> - **浏览器半**（`client.js`、`lib/embed/*`）改了 → **刷新窗口**即可

**第一次打开看三件事：**

1. 右栏引导页上有没有「画布」入口 —— 没有就是浏览器半没挂上（看 DSH 日志里有无 `infinite-canvas`）
2. 点开后 iframe 里有没有画布 —— 若出现「画布脚本没有回应」的诊断条，它会把 iframe 文档原文摊开给你看，最常见是 403（信任栅栏拦下了 iframe 导航）
3. 颜色跟不跟 DSH —— 主题初值走 URL 参数 `?theme=`，之后靠 postMessage 跟随

**手工排查（不经过模型）：**

```bash
node tools/preview-server.mjs 8791     # 独立跑一块画布 → http://127.0.0.1:8791/

# 从命令行发一条命令，看画布实时变化
curl -s -X POST http://127.0.0.1:8791/api/dsh-canvas/dispatch \
  -H 'content-type: application/json' \
  -d '{"action":"add_card","params":{"kind":"scene","title":"雨夜街口"}}'

curl -s http://127.0.0.1:8791/api/dsh-canvas/status   # 桥与浏览器的诊断快照
```

在 DSH 里对应 `http://127.0.0.1:19387/api/dsh-canvas/status`。

## 命令面

9 个 Agent 工具，全部带 `canvas_` 前缀。`kind` 是给模型的 **7 值公开枚举**，
`type` 是节点类型真源 —— **读以 `type` 为准，写只能用 `kind`**。

| 工具 | 画布动作 | 说明 |
|---|---|---|
| `canvas_ping` | `ping` | 连通性探针，由传输层自己回答（画布契约里没有这条） |
| `canvas_get` | `get_canvas` | 读全部卡片、涂鸦、视口、选中、面板。**改之前先调它** |
| `canvas_add_card` | `add_card` | 建卡，返回 id |
| `canvas_move_card` | `move_card` | 移动到世界坐标 |
| `canvas_delete_card` | `delete_card` | 删除（破坏性，先 `get` 确认） |
| `canvas_select_card` | `select_card` | 选中，用户能看到选中框 |
| `canvas_set_view` | `set_view` | 缩放 / 平移 / `fit` |
| `canvas_open_panel` | `open_panel` | 打开 8 个面板之一 |
| `canvas_run_agent` | `run_agent` | 交给画布自己的助手（**目前是关键词占位**） |

`kind` → `type` 的投影：

```
scene → entity_scene      character → entity_character   note → note
text  → gen_text          board     → storyboard_shot     video → gen_video
audio → asset_input（并写入 data.media_type = 'audio'）
```

## 架构

```
对话（模型）
   │  canvas_* 工具
   ▼
宿主半  index.js + lib/{routes,embed,bridge,tools,protocol,config}.js
   │      · /api/dsh-canvas/*   ← 同源 HTTP 面，先过浏览器信任栅栏
   │      · 命令长轮询 GET /next?cursor=N&sessionId=S
   │      · 回执        POST /result
   ▼
传输层  lib/embed/canvas-transport.js   ← 唯一认识 DSH 的前端代码
   │      把 window.nexusvaultMcp 架在长轮询上，自启并从 ?sessionId= 取会话
   ▼
真画布    lib/embed/index.html            ← NexusVault 的画布页（构建产物）
         lib/embed/assets/               Vue Flow + MiSans 分包 + 样式表
         上游 apps/web/src/views/CanvasView.vue 及其 45 个文件的闭包
```

几个刻意的选择：

- **正文是 iframe。** 画布是 Vue 3 + Vue Flow，插件侧无构建；塞进同一文档树要处理样式
  污染和两套响应式共存，而没有一条收益。iframe 换来样式隔离、同源（由宿主半发出来，
  localStorage 有稳定 origin）、尺寸自适应免费。DSH 自带的浏览器 tab 也是 iframe，
  所以这不是绕开框架。**正因为在 iframe 里，那 33 份全局 CSS 不会外泄** —— 于是可以
  整条照搬上游级联，观感才与开源项目逐字一致。
- **长轮询而不是 SSE。** `webServer` 交给我们的是裸 `req`/`res`，长轮询零假设就能跑；
  SSE 要求响应不被任何中间层缓冲，没验过。命令闭环不依赖传输方式，以后要换不影响上层。
- **命令只交付一次。** 取走即 `splice`。画布命令不幂等（`add_card` 重投会多出一张卡），
  交付后浏览器崩了就走超时，不重投。
- **纯逻辑与 DOM 分离。** `canvas-commands.js` 不碰 DOM，所以那 8 条命令能在单测里
  逐条钉死 —— 这也是上游把 `canvas-commands.ts` 抽出来的同一个理由。它现在**不参与运行**，
  只作为契约镜像给 `smoke-test.mjs` 用；真画布跑的是上游自己那份。

## 主题与外观

画布跟随 DSH 的 `light` / `dark` / `system` 三态，外观按 DSH 官方设计 token 重置，
而不是自己配一套颜色。

![浅色](docs/全节点-light.png) ![深色](docs/全节点-dark.png)

做法是**一层覆盖**，不碰上游源码：`build/overlay/src/dsh-shell.css` 挂
`html[data-dsh-theme]` 选择器，把 DSH 的 token 整层搬进来后逐处改写。

几个必须知道的约束：

- **DSH 的 token 是两层的。** `--dsw-static-*` 是字面量，`--dsw-alias-*` 是
  `var(--dsw-static-*)` 的引用。跨界传递**只送 alias 会让 `var()` 断链**，声明被丢弃且
  **静默失效** —— 所以必须整层搬。
- **官方 token 表里没有 radius，也没有 shadow**，也没有 `state-danger`
  （危险态真身是 `state-error-primary`）。缺的自己定，不要去猜官方名字。
- **hover 底色用实心层还是 alpha，取决于它下面有没有实底。** 实底上用 `bg-layer-2`，
  透明容器上只能叠 `interactive-bg-hover` 这类 alpha 色。

### 一条容易漏的连带规则

**每换一处底色，必须连带换掉它的文字色。** 容器一变白，写死的浅色字就直接隐形 ——
它不是一块突兀的深色，是一片「什么都没有」，比深底色更难自查：

- `.panel-search input { color: #fff }` —— 打字才看得到字
- `.generate-model-option.selected { color: #fff }` **且它没有自己的 background** ——
  透出的是后面那张已变白的菜单，选中当前模型时整行消失，只剩一个蓝勾浮着
- `.canvas-text-size { color: #e6e8ee; background: transparent }` —— 自身透明，
  透出的是已变白的工具条底

> 一个元素自己没有底色，不等于它安全 —— 要看它**实际透出的是谁的底**。

### 穷举而不是逐个补

这项工作一度靠截图驱动：打到哪改到哪，改完不知道还剩多少。现在反过来 —— 写脚本把上游
画布 CSS **全量**过一遍再对着覆盖层比（`.workbuddy/verify/scan-dark-gap.mjs`）：

| 维度 | 扫哪些属性 | 阈值（相对亮度） | 为什么是这个方向 |
|---|---|---|---|
| 深底色 | `background` / `border*` / `box-shadow` | 不透明且 **< 0.30** | 浅色主题下一坨深色 |
| 浅色文字 | `color` | 不透明且 **> 0.75** | **方向故意相反** —— 白底上直接隐形 |

两条都挂进了 `npm test`：深底色 119 处、浅色文字 63 处，**缺口必须为 0**。

## 真画布是怎么搬进来的

`build/` 是一个独立的构建工程，把上游 `apps/web` 里画布的最小闭包单独打成
一个可静态托管的页面。

```
build/
  tools/sync-upstream.mjs   从上游镜像 116 个文件到 build/src/（含 11 处路径改写）
  tools/copy-static.mjs     搬 5.9MB 演示图（同名同大小则跳过）
  tools/install-embed.mjs   dist/ → lib/embed/，只覆盖产物，手写文件原地保留
  overlay/src/              ← 唯一「我们写的代码」：router / main / library-assets / 壳层
  src/                      上游镜像，每次 sync 清空重建，不要直接改
```

`npm run build` = sync → copy-static → vite build → install-embed。

三个必须改写的地方（都由 `sync-upstream.mjs` 自动做）：

| 上游写法 | 为什么不行 | 改成 |
|---|---|---|
| `url('/fonts/geist-*.woff2')` | 页面挂在 `/api/dsh-canvas/embed/`，站点根 404 | `url('../fonts/…')`，交给 Vite 当资源处理 |
| `'/library-assets/01_医院大厅_正式.png'` | 同上 | `'library-assets/…'`（相对当前文档） |
| `url('/fonts/wenyuan-rounded-*.woff2')` | 两个各 6.5MB，而该字体上游已退役**且零引用** | 空 data URI |

闭包边界是实测出来的：`canvas/` 45 个文件，外部包只有 6 个真依赖
（`vue` `vue-router` `@vue-flow/{core,background,minimap}` `@lucide/vue`），**零次网络请求**
（全部状态在 localStorage）。所以 pixi / spine / vtable / motion / react / pinia /
element-plus 整棵树都不在产物里。

### 两处必须知道的坑

1. **构建目标要定到能实测的浏览器版本。** 产物里 `@media (max-width: 680px)` 被压缩器按
   `target: 'chrome122'` 改写成范围语法 `@media (width<=680px)`，而范围语法要 Chromium 104+。
   本机无头 Edge 是 **Chromium 100**，整条媒体查询被解析成 `not all` 永不匹配 —— 布局覆盖
   全部失效，而页面看起来「只是有点挤」。所以 `build.target` 定 `chrome100`
   （DSH 是 Chromium 132，只会更新不会更旧）。
2. **窄容器要把三组工具条折成两行。** 上游把 `.ref-bottom-left` / `.ref-create-bar` /
   `.ref-bottom-right` 排在同一 `bottom: 14px`，内容净宽 116+190+275=581px，
   **视口窄于约 738px 必然重叠**；空态引导的 `.canvas-empty-guide` 是
   `position:absolute; left:50%` 且没给 right 的 shrink-to-fit 陷阱，可用宽度被算成视口的
   一半，按钮被压到 65px、中文逐字换行。两处都由 `overlay/src/dsh-shell.css` 在 ≤760px 时
   改布局（不改视觉），实测 380 / 440 / 520 / 700 / 760 / 900 六档零重叠。

![右栏宽度六档](docs/验证-右栏宽度.png)

## 仓库结构

```
index.js                     宿主半入口
client.js                    浏览器半：右侧栏 tab 注册
cordis.patch.yml             只插入本插件自己的 loader 行
icon.svg / locale/           图标与词典
build/                       真画布的构建工程（见上）
lib/
  config.js                  配置模式（超时、轮询挂起、队列上限、自动开面板）
  bridge.js                  命令桥：排队、只交付一次、结算、超时、会话限定
  routes.js                  /api/dsh-canvas/* HTTP 面
  embed.js                   embed 静态托管（同源 + 路径逃逸防护）
  tools.js                   9 个 Agent 工具
  protocol.js                与真画布对齐的契约常量（附真源指针）
  embed/
    canvas-transport.js      DSH 长轮询 ⇄ window.nexusvaultMcp（构建时被内联进 index.html）
    canvas-commands.js       契约镜像：状态模型 + 8 条命令分发（只给单测用）
    index.html               真画布页（构建产物，不入库）
    assets/                  JS / CSS / 字体分包（构建产物，不入库）
    library-assets/          资产库演示图（构建时 copy-static 搬入）
tools/
  smoke-test.mjs             38 项冒烟测试（Node 里跑完整链路）
  preview-server.mjs         独立预览（不依赖 DSH）
  dev-install.ps1            同步进某个 profile
  sync-all.ps1               同步进所有相关 profile
.workbuddy/verify/           验证脚本（含覆盖率与卫生两条穷举扫描，随测试一起跑）
docs/接入方案.md              完整的接入方案与决策依据
docs/验证-*.png              实测截图
```

## 开发

```bash
npm test                          # 38 项冒烟测试
cd build && npm run build         # 构建画布（sync → copy-static → vite → install-embed）
node tools/preview-server.mjs 8791    # 独立预览，不依赖 DSH
```

改样式请改 `build/overlay/src/`，**不要改 `build/src/`**（上游镜像，每次 sync 清空重建）。

## 已验证 / 未验证

已实测（无头 Chromium + 独立预览服务，细节见 `docs/接入方案.md`）：

- 真画布完整渲染：顶栏项目菜单、点阵舞台、节点卡、8 个面板、右键菜单、底部工具条
- 命令闭环：`add_card` ×3 / `select_card` / `open_panel` / `get_canvas`
  全部返回真画布自己的结构
- 传输层自启、`canvasReady: true`、`delivered/answered` 计数一致
- localStorage 存档跨浏览器重启存活
- 六档视口宽度零重叠
- 主题三态：浅色 / 深色两档全量扫描无残留
- 38/38 冒烟测试通过

**尚未做的：**

- `canvas_run_agent` 仍是关键词占位，未接真正的「读画布 → 生成 Patch → 应用」
- 画布项目管理页**能用**（真画布自带，顶栏「我的画布」进入），但没有从 DSH 侧直达的入口
- 跨会话隔离：现在所有会话共用一份 localStorage 存档
- 项目管理页（`#/app/projects`）的卡片未做主题适配

![命令闭环](docs/验证-真画布命令闭环.png)
![画布项目管理页](docs/验证-项目页.png)

## 许可

MIT
