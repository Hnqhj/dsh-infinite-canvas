/**
 * 画布专属路由表 —— **覆盖上游 `apps/web/src/router.ts`**。
 *
 * ── 为什么不是直接用上游那份 ────────────────────────────────────────────────
 * 上游路由表里画布只占两条，但其余二十来条（发现广场、技能库、资产库、登录、
 * 403/404、设备授权回程…）会把整棵视图树拖进构建，连带 pixi / spine / vtable /
 * motion / react / pinia 一起。这里只留画布闭包真正需要的两条。
 *
 * 上游的路由表还带一个全局守卫（`auth.restore()` + 登录卡片 + 管理员判定）。
 * 那些依赖 `stores/auth` 与 `auth/browser-login`，都是 DSH 里不存在的东西，
 * 一并去掉 —— 画布的**完全不需要身份**：它的全部数据在 `localStorage`，
 * 一次网络请求都不发（实测：`canvas/` 下 `fetch(` 命中数为 0）。
 *
 * ── `APP_BASE` 必须与上游逐字相同 ──────────────────────────────────────────
 * `canvas/window.ts` 用它拼 `canvasRoute()`，而三处调用点都靠那条 URL 找回来：
 *   · CanvasView 的「切换画布」菜单 → `router.push(canvasRoute(target.id))`
 *   · CanvasView 的「返回项目页面」 → `router.push('/app/projects')`
 *   · CanvasProjectsView 的「打开画布」 → `openCanvas(id, to => router.push(to))`
 * 所以 `/app` 这个前缀和 `/app/canvas`、`/app/projects` 两条路径都不能改。
 *
 * ── 为什么是 hash 路由 ─────────────────────────────────────────────────────
 * 这份页面由 DSH 的静态托管挂在 `/api/dsh-canvas/embed/index.html`。用
 * `createWebHistory()` 的话，路由跳转会去请求 `/app/projects` 这个**服务器上的
 * 路径** —— 而它当然不存在（托管方只认 `/embed/` 下面）。hash 模式只读 `#`
 * 之后那一段，画布 ⇄ 项目页的切换完全在客户端完成，服务器零参与。
 *
 * 上游在桌面端（`file://`）也是同样的理由切到 hash —— 见它 router.ts 里
 * 「桌面端打包态必须用 hash 路由」那一段。
 */

import { createRouter, createWebHashHistory } from 'vue-router'

/** 与上游 `apps/web/src/router.ts` 的 `APP_BASE` 逐字相同，别改。 */
export const APP_BASE = '/app'

/** 画布页。懒加载：首屏只加载 CanvasView 这一块。 */
const CanvasView = () => import('./views/CanvasView.vue')
/** 画布项目管理页（新建 / 重命名 / 删除 / 打开画布）。 */
const CanvasProjectsView = () => import('./views/CanvasProjectsView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 空 hash 落第 1 条 → 直接进画布。DSH 里点开这个 tab 就是要看画布，
    // 不该先落一屏项目列表。项目页仍然可达：画布顶栏的「返回项目页面」。
    { path: '/', redirect: `${APP_BASE}/canvas` },
    { path: `${APP_BASE}`, redirect: `${APP_BASE}/canvas` },
    { path: `${APP_BASE}/canvas`, name: '画布', component: CanvasView },
    { path: `${APP_BASE}/projects`, name: '项目', component: CanvasProjectsView },
    // 上游的兜底是 404 页；这里没有那一页，一律回画布 —— 在右栏里
    // 显示一屏「页面不存在」不如给一张能用的画布。
    { path: '/:pathMatch(.*)*', redirect: `${APP_BASE}/canvas` },
  ],
})

export default router
