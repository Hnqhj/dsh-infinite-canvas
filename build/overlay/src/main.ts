/**
 * DSH 内嵌画布的唯一入口 —— **覆盖上游 `apps/web/src/main.ts`**。
 *
 * 与上游 main.ts 的差别只有三处，其余（尤其是 **CSS 引入顺序**）逐行照抄：
 *   ① 不 `createApp(App)` —— 上游的根组件是 `App.vue` → `AppLayout`（整个应用
 *      外壳：侧栏、顶栏、命令面板）。我们只要路由出口，所以根组件换成
 *      「一个 `<RouterView/>`」。
 *   ② 不 `app.use(createPinia())` —— 画布闭包里没有任何 store（实测：画布
 *      45 个文件对 pinia 零引用），装它只是白背一个包。
 *   ③ 不接 `subscribeDesktopNavigate` —— 那是 Electron 主进程推路由的链路，
 *      DSH 里由 tab 的 `src` 直接决定落点。
 *
 * ── 为什么要照抄全部 33 份全局 CSS ─────────────────────────────────────────
 * 因为这份页面跑在 **iframe** 里，全局样式**不会外泄**到 DSH —— 隔离是免费的。
 * 而画布的观感有一半来自这些「外壳层」：
 *   · `style.css` 定义了 165 个 CSS 变量和基础重置；
 *   · `blaze-parity.css` / `editorial-redesign.css` 定义 `Geist` 的 @font-face
 *     和 `--rd-font-ui`（画布页全程用它，见 canvas-flow.css 的说明）；
 *   · `design-unify.css` 把 `--font-ui` 铺满子树，而 `canvas-flow.css` 靠
 *     「同为 !important 时后来者胜」把它压回 Geist —— **这条压制关系依赖
 *     引入顺序**，少一份或换顺序都会让画布里的文字悄悄变成另一个字体。
 * 只挑几份带进来是在赌「哪几份有用」，赌错的代价是「看起来像另一个应用」，
 * 而这一点正好是用户这次要解决的问题。
 *
 * 顺序与上游 `apps/web/src/main.ts` 逐行对应，`tools/sync-upstream.mjs` 里的
 * `GLOBAL_CSS` 数组是同一份列表 —— 两边要对齐着看。
 */

import { createApp, h } from 'vue'
import { RouterView } from 'vue-router'

/* ── 上游全局样式，顺序不可重排（见文件头）──────────────────────────────── */

import './style.css'
import './kimi-responsive.css'
import './page-layouts.css'
import './layout-refinement.css'
import './soluna-theme.css'
import './auth-polish.css'
import './utility-polish.css'
import './heading-polish.css'
import './brand-polish.css'
import './scale-adaptive.css'
import './profile-card.css'
import './top-navigation.css'
import './account-menu.css'
import './showcase-detail.css'
import './assistant-chat.css'
import './workspace-canvas.css'
import './project-management-polish.css'
import './neutral-accent.css'
import './empty-states.css'
import './auth-dialog-final.css'
import './palette-unify.css'
import './tapnow-visual.css'
import './universe-editorial.css'
import './editorial-redesign.css'
import './blaze-parity.css'
// 统一设计层压轴：把前面各「polish/对齐」沉积收敛成唯一规范。
import './design-unify.css'
import './sidebar-redesign.css'
import './app-auth.css'
import './auth-prompt.css'
import './update-notice.css'
import './explore-surface.css'
import './auth-surface.css'
import './explore-editorial.css'
import './components/hover-icons/hover-icons.css'

/* ── 第三方样式：Vue Flow 基线必须排在画布对齐层之前 ─────────────────────── */

import '@vue-flow/core/dist/style.css'

// MiSans：中文标题 + 正文的正主。按 unicode-range 分包，浏览器只拉实际用到的
// 子集（本地构建时 4 档共约 9.5MB 落在 lib/embed/assets/，运行时按需取）。
// 四档覆盖全站用到的 400/500/600/700。与上游 main.ts 同样的四行。
import 'misans/lib/Normal/MiSans-Regular.min.css'
import 'misans/lib/Normal/MiSans-Medium.min.css'
import 'misans/lib/Normal/MiSans-Demibold.min.css'
import 'misans/lib/Normal/MiSans-Bold.min.css'

import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

/* ── 画布样式：顺序即优先级，见 canvas-flow.css 的注释 ───────────────────── */

import './canvas/canvas-fold.css'
import './canvas/canvas-flow.css'
import './canvas/canvas-chrome.css'
import './canvas/canvas-editorial.css'

/* ── 我们的壳层补丁（最后引入，只碰 html/body/#app 的高度链）───────────── */

import './dsh-shell.css'

import router from './router'
import { installDshBridge } from './dsh-bridge'

/**
 * 根组件：只有一个路由出口。
 *
 * 不写成 `.vue` 文件，是因为它确实只有一行 —— 多一个 SFC 就多一个需要跟上游
 * 无关的构建产物。上游用 `App.vue` + `AppLayout.vue` 是因为它需要整套应用外壳，
 * 我们的「外壳」就是 `dsh-shell.css` 那几行高度声明。
 */
const Root = {
  name: 'CanvasEmbedRoot',
  render: () => h(RouterView),
}

installDshBridge()

createApp(Root).use(router).mount('#app')
