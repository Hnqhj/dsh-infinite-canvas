/**
 * 把上游 Poiesis / NexusVault 的 `apps/web` 里**画布用到的那一部分**镜像到 `build/src/`。
 *
 * ── 为什么要镜像 ────────────────────────────────────────────────────────────
 * 上游是「整个应用」的源码（发现广场、技能库、登录、桌面壳…），而我们只要画布
 * 这一块。镜像出最小闭包有两个好处：
 *   ① 构建只处理真正用到的文件，`vite build` 从分钟级降到秒级；
 *   ② pixi / spine / vtable / motion / react / pinia / element-plus 这些
 *      只在别的页面用到的重依赖**整棵树都不会进闭包**，产物能小一个数量级。
 *
 * 闭包边界（实测，见 `docs/接入方案.md` §P1）：
 *   · `src/canvas/**`            47 个文件（去掉 *.test.ts）
 *   · `src/views/CanvasView.vue` + `CanvasProjectsView.vue`
 *   · `src/components/PageHeader.vue`（CanvasProjectsView 的页头）
 *   · `src/data/library-assets.ts`（资产库清单）
 *   · `src/components/hover-icons/**`（main.ts 引入的图标动效 CSS）
 *   · `main.ts` 里 import 的那批全局 CSS（顺序必须原样保留，见下）
 *
 * 闭包**只逃出 canvas/ 四次**：`canvas/window.ts → ../router`、
 * `views/CanvasProjectsView.vue → ../components/PageHeader.vue`、
 * `views/CanvasView.vue → ../data/library-assets`。前两个由 overlay 补齐，
 * 第三个是纯数据文件，原样镜像为 `library-assets.data.ts`。
 *
 * ── 镜像目录是可再生的 ──────────────────────────────────────────────────────
 * `build/src/**` 每次运行都会被清空重建。**不要直接改它** —— 改 `build/overlay/`
 * 或这个脚本。overlay 在镜像之后覆盖上去，是唯一的「我们写的代码」所在。
 *
 * ⚠️ 改完 `build/overlay/` 之后必须重跑这个脚本（或直接 `npm run build`）。
 * 构建器只编 `build/src/`；那里还是上一轮的旧文件时，产物会**照常构建成功、
 * 照常装进 embed、一处都不报错**，只是你的改动根本没进去。
 * 实测踩过两次：
 *   ① overlay 加了个函数，`build/src/` 里命中数 0，产物里也没有；
 *   ② 改了 `dsh-shell.css` 后跑 `npm run build:only`，产物 CSS 哈希**没变**
 *      （`style-DBFXSH2g.css` 原地不动），grep 新规则命中 0。
 *
 * 📌 **`build:only` 到底什么时候能用**（这句之前写反了，实测踩过）：
 * `build:only` = `vite build && install-embed`，**不含本脚本**。
 * 而 `build/src/**` 每次都会被本脚本**清空重建**，overlay 是覆盖上去的。
 * 所以：
 *   · 改了 `build/overlay/**` → **必须** `npm run build`（或先 `npm run sync`）。
 *   · `build:only` 只在「**没改任何源文件**，只想重新打包」时用，
 *     比如手工改过 `build/dist/` 里的东西、或只想重跑 install-embed。
 *   · 「只改了 `build/src/` 之外的东西」这句话是错的 —— 改了 overlay
 *     就是改了 `build/src/` 之外的东西，而那恰恰是**最需要 sync** 的情形。
 *
 * 🔍 **怎么确认改动真的进了产物**：先看 `dist/assets/` 里的 CSS/JS 哈希有没有变。
 * `vite build` 永远成功，它不知道你改的是不是它编的那份文件；
 * 哈希没变 = 你的改动没进去。`tools/smoke-test.mjs` 的 B10 会断言产物里
 * 必须出现关键代码，把这件事变成可测事实而不是靠记。
 *
 * ── 三处必须改写的资源路径 ──────────────────────────────────────────────────
 * 上游用**站点根**当资源前缀（`/fonts/…`、`/library-assets/…`），因为它的页面
 * 就挂在根上。我们的页面挂在 `/api/dsh-canvas/embed/index.html`，根路径会 404。
 * 所以：
 *   ① CSS 里 `url('/fonts/geist-*.woff2')` → `url('../fonts/…')`，顺便让 Vite
 *      把这些字体当资源处理（带 hash 输出到 `assets/` 并自动改写 URL）；
 *   ② `'/library-assets/xxx'` → `'library-assets/xxx'`（相对当前页面），
 *      命中 `CanvasCardNode.vue` 里三个节点的预览图种子；
 *   ③ 文源圆体那两个 `@font-face` 换成空 data URI —— 该字体在上游**已经退役
 *      且零引用**（全仓只有 @font-face 声明，没有任何 `font-family` 用它），
 *      而两个 woff2 各 6.5MB。换成空源后 CSS 仍可解析，只是这个家族永远不可用，
 *      与「没人用它」等价。**若哪天上游重新启用它，这里必须改成真搬字体。**
 *
 * 用法：
 *   node tools/sync-upstream.mjs
 *   node tools/sync-upstream.mjs --from=D:/somewhere/nexusvault-post/apps/web
 *   CANVAS_UPSTREAM=... node tools/sync-upstream.mjs
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIRROR = join(BUILD_DIR, 'src')
const OVERLAY = join(BUILD_DIR, 'overlay')
const FONT_DIR = join(BUILD_DIR, 'fonts')

/** 上游 `apps/web` 的默认位置（侦察时克隆的那份，见 `docs/接入方案.md` §P1）。 */
const DEFAULT_UPSTREAM = resolve(BUILD_DIR, '../_recon/cnb-repo/apps/web')

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => /^--([^=]+)=(.*)$/.exec(arg))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
)
const UPSTREAM = resolve(args.from ?? process.env.CANVAS_UPSTREAM ?? DEFAULT_UPSTREAM)

if (!existsSync(join(UPSTREAM, 'src/views/CanvasView.vue'))) {
  console.error(`✗ 找不到上游画布源码：${UPSTREAM}`)
  console.error('  期望存在 src/views/CanvasView.vue。')
  console.error('  用 --from=<apps/web 的绝对路径> 或环境变量 CANVAS_UPSTREAM 指定。')
  process.exit(1)
}

/* ── 状态与工具 ──────────────────────────────────────────────────────────── */

let copied = 0
let rewriteHits = 0
const skipped = []

const rel = (p) => relative(process.cwd(), p).replace(/\\/g, '/')

/** 复制一个文件到镜像，并按需做路径改写。`destRel` 相对 `src/`。 */
function mirror(srcRel, destRel = srcRel, transforms = []) {
  const from = join(UPSTREAM, 'src', srcRel)
  if (!existsSync(from)) {
    skipped.push(`src/${srcRel}`)
    return
  }
  const to = join(MIRROR, destRel)
  mkdirSync(dirname(to), { recursive: true })

  if (transforms.length === 0) {
    copyFileSync(from, to)
    copied += 1
    return
  }

  let content = readFileSync(from, 'utf8')
  for (const [pattern, replacement, label] of transforms) {
    const hits = content.match(pattern)?.length ?? 0
    if (hits === 0) continue
    content = content.replace(pattern, replacement)
    rewriteHits += hits
    if (label) console.log(`      ~ ${destRel}: ${label} ×${hits}`)
  }
  writeFileSync(to, content, 'utf8')
  copied += 1
}

/** 递归镜像目录，跳过 `*.test.ts`（它们 import vitest，我们没装）。 */
function mirrorDir(srcRel, transforms = []) {
  const from = join(UPSTREAM, 'src', srcRel)
  if (!existsSync(from)) {
    skipped.push(`src/${srcRel}/**`)
    return
  }
  const walk = (dir, sub) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), sub ? `${sub}/${entry.name}` : entry.name)
        continue
      }
      if (/\.test\.[cm]?ts$/.test(entry.name)) continue
      const target = `${srcRel}/${sub ? `${sub}/` : ''}${entry.name}`
      mirror(target, target, transforms)
    }
  }
  walk(from, '')
}

/* ── 路径改写规则 ────────────────────────────────────────────────────────── */

/** `/library-assets/xxx` → `library-assets/xxx`（相对当前 iframe 页面）。 */
const REWRITE_ASSETS = [
  [/'\/library-assets\//g, "'library-assets/", '资产库路径改相对'],
  [/`\/library-assets\//g, '`library-assets/', '资产库路径改相对'],
]

/**
 * 字体 URL 改写 + 文源圆体去重。见文件头 ① ③。
 *
 * `url('/fonts/geist-X.woff2')` → `url('../fonts/geist-X.woff2')`：
 * 镜像里 CSS 都在 `src/`（`src/components/hover-icons/` 里没有字体引用），
 * 而字体放在 `build/fonts/`，所以从 `src/x.css` 看是 `../fonts/x`。
 *
 * 两条规则都会把引号**归一成单引号** —— 所以替换串里不能再把捕获到的引号
 * 写回去（否则会得到 `url(''../fonts/x'` 这种双开引号，CSS 直接解析失败）。
 */
const REWRITE_FONTS = [
  [
    /url\((['"]?)\/fonts\/wenyuan-rounded-(?:medium|bold)\.woff2\1\)/g,
    'url("data:font/woff2;base64,")',
    '文源圆体（已退役、零引用）置空',
  ],
  [/url\((['"]?)\/fonts\//g, "url('../fonts/", '字体路径改相对'],
]

/* ── 1. 画布本体 ─────────────────────────────────────────────────────────── */

rmSync(MIRROR, { recursive: true, force: true })
mkdirSync(MIRROR, { recursive: true })

console.log(`上游：${UPSTREAM}`)
console.log('复制画布闭包 …')

mirrorDir('canvas', REWRITE_ASSETS)
mirrorDir('components/hover-icons')
mirror('views/CanvasView.vue', 'views/CanvasView.vue', REWRITE_ASSETS)
mirror('views/CanvasProjectsView.vue', 'views/CanvasProjectsView.vue')
mirror('components/PageHeader.vue', 'components/PageHeader.vue')
// 资产清单镜像成 `.data.ts`：overlay 里的 `library-assets.ts` 只重写 URL 函数，
// 数据本身继续吃上游这份，避免「上游加了图我们看不到」。
mirror('data/library-assets.ts', 'data/library-assets.data.ts')

/* ── 2. 全局 CSS ─────────────────────────────────────────────────────────── */

/**
 * 上游 `main.ts` 里 CSS 的引入顺序。
 *
 * **顺序是视觉的一部分，不能重排。** 这份仓库的设计系统是「层层覆盖」的：
 * `design-unify` 收敛前面十几个 polish，`explore-surface` / `auth-surface` 再压
 * 一层，`canvas-flow` 最后靠「同为 !important 时后者胜」压住 `design-unify`
 * 的字体规则。重排会**静默**改变观感 —— 上游在 `canvas-flow.css` 的注释里
 * 专门为这个坑写过一段（还留着一条 `verify/probe-menu-font.mjs` 去钉它）。
 *
 * 这里与上游 main.ts 逐行对应，`overlay/src/main.ts` 以同样顺序 import。
 */
const GLOBAL_CSS = [
  'style.css',
  'kimi-responsive.css',
  'page-layouts.css',
  'layout-refinement.css',
  'soluna-theme.css',
  'auth-polish.css',
  'utility-polish.css',
  'heading-polish.css',
  'brand-polish.css',
  'scale-adaptive.css',
  'profile-card.css',
  'top-navigation.css',
  'account-menu.css',
  'showcase-detail.css',
  'assistant-chat.css',
  'workspace-canvas.css',
  'project-management-polish.css',
  'neutral-accent.css',
  'empty-states.css',
  'auth-dialog-final.css',
  'palette-unify.css',
  'tapnow-visual.css',
  'universe-editorial.css',
  'editorial-redesign.css',
  'blaze-parity.css',
  'design-unify.css',
  'sidebar-redesign.css',
  'app-auth.css',
  'auth-prompt.css',
  'update-notice.css',
  'explore-surface.css',
  'auth-surface.css',
  'explore-editorial.css',
]

console.log(`复制全局样式 ×${GLOBAL_CSS.length} …`)
for (const file of GLOBAL_CSS) mirror(file, file, REWRITE_FONTS)

/* ── 3. Geist 字体 ───────────────────────────────────────────────────────── */

console.log('复制 Geist 字体 …')
mkdirSync(FONT_DIR, { recursive: true })
for (const file of [
  'geist-Regular.woff2',
  'geist-Medium.woff2',
  'geist-SemiBold.woff2',
  'geist-Bold.woff2',
  'geist-mono-SemiBold.woff2',
]) {
  const from = join(UPSTREAM, 'public/fonts', file)
  if (!existsSync(from)) {
    skipped.push(`public/fonts/${file}`)
    continue
  }
  copyFileSync(from, join(FONT_DIR, file))
}

/* ── 4. overlay 覆盖 ─────────────────────────────────────────────────────── */

console.log('覆盖 overlay …')
let overlaid = 0
const overlayWalk = (dir, sub) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      overlayWalk(join(dir, entry.name), sub ? `${sub}/${entry.name}` : entry.name)
      continue
    }
    const target = sub ? `${sub}/${entry.name}` : entry.name
    const to = join(MIRROR, target)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(dir, entry.name), to)
    console.log(`      + src/${target}`)
    overlaid += 1
  }
}
overlayWalk(join(OVERLAY, 'src'), '')

/* ── 5. 汇总 ─────────────────────────────────────────────────────────────── */

const mirrorBytes = (() => {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else total += statSync(p).size
    }
  }
  walk(MIRROR)
  return total
})()

console.log('')
console.log(`✓ 镜像完成：${copied} 个上游文件 + ${overlaid} 个 overlay 覆盖，${rewriteHits} 处路径改写`)
console.log(`  镜像：${rel(MIRROR)}  （${(mirrorBytes / 1024).toFixed(0)} KB 源码）`)
if (skipped.length > 0) {
  console.log(`  ⚠ 上游缺 ${skipped.length} 项：`)
  for (const item of skipped) console.log(`      ${item}`)
}
