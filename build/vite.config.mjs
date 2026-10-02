/**
 * 画布内嵌页的构建配置 —— 只产出一个页面：`lib/embed/index.html`。
 *
 * 与上游 `apps/web/vite.config.ts` 的差别，逐条都是「因为我们在 iframe 里、
 * 而且只要画布这一块」：
 *
 *   · `base: './'` —— 页面由 DSH 的静态托管挂在 `/api/dsh-canvas/embed/`。
 *     上游默认的 `base: '/'` 会让产物引用 `/assets/xxx.js`，那是**服务器的
 *     根路径**，托管方不认 → 整页空白。上游在桌面端（`file://`）踩过同一个坑，
 *     它 vite.config.ts 里那段注释就是为它写的。
 *   · 砍掉 `skillsPlugin()` —— 上游的自定义插件，负责把 `public/skill-library.json`
 *     （1.3MB）之类的东西注入技能库页。画布不用。
 *   · 砍掉 `manualChunks` —— 上游的分包规则是给 echarts / pixi / element-plus
 *     准备的，那些包根本不在画布闭包里，规则留着只会误导。
 *   · 砍掉 dev/preview 的 `/api` 代理 —— 画布一次网络请求都不发。
 *   · 加上 `inline-canvas-transport` 插件（见下）。
 */

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

/** 传输层真源：插件运行时的静态托管目录，也是这里被内联进 HTML 的那一份。 */
const TRANSPORT_SOURCE = here('../lib/embed/canvas-transport.js')

const TRANSPORT_PLACEHOLDER = '<!--@canvas-transport-->'

/**
 * 把 `lib/embed/canvas-transport.js` 内联进 `index.html` 的 `<head>`。
 *
 * 为什么不用 `<script src="./canvas-transport.js">`：那个文件不在 Vite 的
 * 模块图里（它要作为**普通脚本**、在模块之前同步执行），所以要么放进 `public/`
 * 让它被原样拷贝，要么内联。内联更好，两个理由：
 *   ① 少一次请求，且彻底没有「`base: './'` 下这个相对路径怎么解析」的变数；
 *   ② **只有一份真源** —— 插件运行时（`lib/embed.js` 的静态托管）和构建产物
 *      读的是同一个文件。放 `public/` 就得每次构建复制一次，两份迟早分叉。
 *
 * `<script>` 里出现 `</script` 会把标签提前闭合（HTML 里没有转义这一说），
 * 所以替换时按惯例把 `</` 打断成 `<\/`。传输层现在没有这种字符串，
 * 但加一条保险只有一行成本。
 */
function inlineCanvasTransport() {
  return {
    name: 'dsh-inline-canvas-transport',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const source = readFileSync(TRANSPORT_SOURCE, 'utf8')
        if (!html.includes(TRANSPORT_PLACEHOLDER)) {
          this.error(`index.html 里找不到 ${TRANSPORT_PLACEHOLDER}，传输层不会被注入。`)
        }
        const safe = source.replace(/<\/script/gi, '<\\/script')
        return html.replace(TRANSPORT_PLACEHOLDER, `<script>\n${safe}\n    </script>`)
      },
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), inlineCanvasTransport()],

  define: {
    // 上游 vite.config.ts 会注入它（取自根 package.json 的 version）。
    // 画布闭包里目前没有任何地方读（只在 env.d.ts 里声明过），
    // 留着是为了「镜像一份上游代码却缺一个宏」时不至于在运行时炸掉。
    __APP_VERSION__: JSON.stringify('1.4.0'),
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /**
     * 目标是 **Chromium 100**，不是「DSH 的 Electron 36 / Chromium 132」。
     *
     * 故意定低，理由是**验证环境**：本机的无头 Edge 就是 Chromium 100
     * （实测 UA：`HeadlessChrome/100.0.4896.75 Edg/100.0.1185.36`）。
     * 一开始写的是 `chrome122`，压缩器据此把 `@media (max-width: 680px)`
     * 「现代化」成范围语法 `@media (width<=680px)` —— 而范围语法要 Chromium 104+。
     * 于是同一份产物在DSH（132）里是好的，在本机验证时整条媒体查询被解析成
     * `not all`、**永不匹配**：布局覆盖全部失效，而页面看起来「只是有点挤」。
     *
     * 定到 100 的效果：压缩器不再改写语法（保留 `max-width:` 原形），
     * 于是**验证时看到的与DSH 里看到的一致**，DSH 因为更新而只会更宽松。
     * `:has()`（上游 CSS 用到，105+）压缩器无法降级，仍按原样输出 ——
     * 它在 DSH 里生效，在本机验证时失效，那部分差异是上游自己的依赖，
     * 不影响底部工具条与空态引导这两处我们要验的布局。
     *
     * 未来若 DSH 换了更老的 Electron，往下调；调高之前先确认本机验证浏览器
     * 不比它更老，否则会重演这次「验证通过、实际不生效」。
     */
    target: 'chrome100',
    /** 只有一个页面，拆 CSS 没有意义，合成一份还省一次请求。 */
    cssCodeSplit: false,
    /** 不需要 modulepreload 的 polyfill（同上，目标环境原生支持）。 */
    modulePreload: { polyfill: false },
    /** 单 chunk 会超过默认的 500KB 警告线，那不是问题，别刷屏。 */
    chunkSizeWarningLimit: 3000,
  },
})
