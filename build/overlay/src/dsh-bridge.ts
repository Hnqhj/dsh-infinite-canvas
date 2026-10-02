/**
 * 画布 ⇄ DSH 父页面的小桥。
 *
 * ── 它**不**负责命令传输 ────────────────────────────────────────────────────
 * 命令走 `lib/embed/canvas-transport.js`（由 `index.html` 在入口模块**之前**
 * 内联执行）。那个文件抢先把 `window.nexusvaultMcp` 占住，
 * 画布自己挂载时会调 `window.nexusvaultMcp?.onCommand(...)` 注册处理器 ——
 * 这是上游 `CanvasView.vue` 里 `declare global` 声明的那个接口，一个字都不用改。
 *
 * 这里只处理「父页面想让画布知道、但和命令无关」的事：
 *   · 主题 —— 父页面把 DSH 解析后的结果与 `--dsw-*` token 值发过来。
 *   · 就绪 —— 画布挂载完了，告诉父页面一声（父页面拿它做诊断文案）。
 *
 * ── 主题：为什么"半跟随" ──────────────────────────────────────────────────
 * 上游的画布**没有浅色版本**，这是产品决策而非遗漏：`index.html` 首帧就把
 * `data-theme` 锁成 `dark`，`canvas-flow.css` 里专门有一段解释
 * 「画布页为什么始终是深色」（图像工作区，深底更利于判断画面）。
 *
 * 所以这里**不**去改 `data-theme` —— 改了会让画布掉进一批只给别的页面写的
 * 浅色分支里，观感立刻和用户的开源项目不一致。
 *
 * 真正跟随 DSH 的是**壳层**：`--dsw-*` 变量被父页面送进来后写进
 * `document.documentElement`，画布页自己那些壳层元素（滚动条、占位、选区色）
 * 读 `var(--dsw-*, 自己的兜底)`，于是在深浅之间自然切换；而画布本体的
 * 配色（节点卡、点阵舞台、面板）仍由上游那 33 份样式表决定，不受影响。
 *
 * 换句话说：**外壳跟 DSH 走，画布跟产品决策走。**
 */

const MESSAGE_SOURCE = 'dsh-canvas-host'

interface HostThemeMessage {
  source?: string
  type?: string
  payload?: { theme?: string; tokens?: Record<string, string> }
}

/** 只有这几个前缀的变量才允许被父页面写进来。 */
const TOKEN_ALLOW_PREFIX = '--dsw-'

/**
 * 把 token 写成根元素上的自定义属性。
 *
 * `style.setProperty` 对无法解析的值会**静默丢弃**，所以这里先做一次形状校验：
 * 父页面那边读到的是 `getComputedStyle` 的计算值，正常一定是合法色值或
 * `var(...)`；万一不是（比如 DSH 换了实现），宁可不写，也不要写进去一个
 * 坏值让整条声明失效。
 */
function applyTokens(tokens: Record<string, string> | undefined): void {
  if (tokens === null || typeof tokens !== 'object') return
  const root = document.documentElement
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof name !== 'string' || !name.startsWith(TOKEN_ALLOW_PREFIX)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    // 逗号 / 分号会截断或串掉后面的声明；`color-mix()`/`var()` 里都有逗号，
    // 所以只挡最危险的两个字符而不是做完整 CSS 值解析。
    if (value.includes(';') || value.includes('}') || value.includes('<')) continue
    try {
      root.style.setProperty(name, value)
    } catch {
      /* 属性名不合法就放弃这一条 */
    }
  }
}

/** 官方 bg-base 的浅/深两值，用来同步 `<meta name="theme-color">`。 */
const THEME_COLOR = { light: '#ffffff', dark: '#151517' } as const

function applyTheme(theme: string): void {
  const root = document.documentElement
  // 记成 `data-dsh-theme` 而不是 `data-theme`：后者是上游自己的锁，
  // 碰它等于把画布推进浅色分支。属性名区分大小写，别写成 data-dsh-Theme。
  root.dataset.dshTheme = theme === 'light' ? 'light' : 'dark'
  // 同步 theme-color，让 DSH 的窗口/任务栏配色跟着走。首帧那一版由
  // index.html 的内联脚本按 URL 参数写好，这里保证后续切换不脱节。
  const resolved = theme === 'light' ? 'light' : 'dark'
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[resolved])
}

function readThemeParam(): void {
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme')
  if (theme) applyTheme(theme)
}

function listenTheme(): void {
  window.addEventListener('message', (event: MessageEvent<HostThemeMessage>) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.source !== MESSAGE_SOURCE || data.type !== 'theme') return
    const theme = data.payload?.theme
    if (typeof theme === 'string') applyTheme(theme)
    applyTokens(data.payload?.tokens)
  })
}

/** 告诉父页面「画布这一侧已经接管」。父页面靠这条消息消掉诊断条，
 *  所以必须真的发出去 —— 收不到就意味着 4 秒后弹一条"脚本没有回应"。 */
function announceReady(): void {
  window.parent?.postMessage(
    { source: 'dsh-canvas', type: 'ready', payload: { href: window.location.href } },
    '*',
  )
}

export function installDshBridge(): void {
  readThemeParam()
  listenTheme()
  // 挂到下一个宏任务：此时 Vue 已经把首批 DOM 提交完，父页面读文档能看到东西。
  window.setTimeout(announceReady, 0)
}
