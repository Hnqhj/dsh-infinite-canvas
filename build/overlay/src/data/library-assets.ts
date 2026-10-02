/**
 * 本地资产库清单 —— **覆盖上游 `apps/web/src/data/library-assets.ts`**。
 *
 * ── 为什么只改一个函数 ──────────────────────────────────────────────────────
 * 上游把 `LIBRARY_ASSETS` 这份清单**同时**喂给两个页面：资产库页
 * （`AssetsLibraryView`）和画布左下角的「资产库」面板。清单是纯数据，
 * 我们这边完全照用 —— 所以它从镜像出来的 `library-assets.data.ts` 重导出，
 * **不复制一份**：上游加一张图，我们下次构建就自动有，不会出现
 * 「一边加图另一边看不见」。
 *
 * 唯一必须改的是 `libraryAssetUrl()`。上游写死站点根：
 *
 *     return `/library-assets/${file}`
 *
 * 这在它的页面里成立，因为页面就挂在 `/` 上。我们的页面挂在
 * `/api/dsh-canvas/embed/index.html`，`/library-assets/x.png` 会被解析到
 * **DSH 服务的根路径** → 404 → 资产库面板整片空白、拖出来的节点也没有预览图。
 *
 * 去掉开头的 `/` 变成相对路径后，它相对**当前文档**解析，正好落在
 * `/api/dsh-canvas/embed/library-assets/x.png` —— 与 `index.html` 同级的
 * 那个目录（由 `tools/copy-static.mjs` 放进去）。
 *
 * 同样的改写也发生在 `canvas/components/CanvasCardNode.vue` 里三个节点的
 * 预览图种子上（`entity_scene` / `entity_character` / `storyboard_shot`），
 * 由 `tools/sync-upstream.mjs` 的 `REWRITE_ASSETS` 规则统一处理。
 *
 * ⚠️ hash 路由让这个相对路径**不会**随导航漂移：hash 变化不影响文档的基准
 * URL，所以画布 ⇄ 项目页来回切，图片路径始终是那一串。
 */

import { LIBRARY_ASSETS, type LibraryAsset } from './library-assets.data'

export { LIBRARY_ASSETS }
export type { LibraryAsset }

/**
 * 资产文件的访问路径。
 *
 * 相对当前文档，不带前导 `/` —— 理由见文件头。
 * （上游注释说的是「开发与桌面端都走这个公共前缀」，那是根路径的世界观。）
 */
export function libraryAssetUrl(file: string): string {
  return `library-assets/${file}`
}
