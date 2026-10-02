/**
 * 把体积大的**二进制静态资源**从上游搬到 `build/public/`。
 *
 * 为什么和 `sync-upstream.mjs` 分开：那边搬的是源码（约 1.5MB 文本，每次构建
 * 都必须重做一遍才能保证路径改写生效），这边搬的是 4.6MB 的演示图片 ——
 * 内容不变时**跳过**，不为它们付每次构建的拷贝时间。
 *
 * 搬什么、不搬什么：
 *   ✓ `public/library-assets/**` —— 画布左下「资产库 / 素材」两个面板的图片，
 *     以及 `entity_scene` / `entity_character` / `storyboard_shot` 三类节点的
 *     预览图种子。**这是「看起来像我的项目」的一部分**，少了就是一片灰底框。
 *   ✗ `public/fonts/**` —— Geist 那 5 个（约 200KB）在 `sync-upstream.mjs` 里
 *     搬（体积小、且要和 CSS 改写一起验证）；文源圆体两个各 6.5MB，
 *     上游已退役且零引用，不搬（见 sync-upstream.mjs 文件头 ③）；
 *     `fusion-pixel-12px`（917KB）同样已退役，不搬。
 *   ✗ `public/skill-library.json`（1.3MB）、`agent-office` / `demo-showcase` /
 *     `prototype`（共 6MB+）—— 都属于技能库页 / 广场页，画布不碰。
 *   ✗ `logo2.png` / `logotop.png` / `soluna-mark*.png` —— 品牌图，用在应用顶栏
 *     与登录页；画布的顶栏只有一行项目名文字。
 *
 * 图片保持**原名**落进 `build/public/`，Vite 的 `publicDir` 会原样拷进 `dist/`，
 * 于是 URL 与 `data/library-assets.ts` 里写的那串文件名一一对应。
 * 注意：这一批**不走** Vite 的资源管线（不加 hash）。它们是「内容随上游变」的
 * 演示数据，不是需要长期缓存的构建产物；加 hash 反而会让
 * `LIBRARY_ASSETS` 里的文件名和磁盘上的对不上。
 *
 * 用法：
 *   node tools/copy-static.mjs
 *   node tools/copy-static.mjs --from=D:/somewhere/nexusvault-post/apps/web --force
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = join(BUILD_DIR, 'public')
const DEFAULT_UPSTREAM = resolve(BUILD_DIR, '../_recon/cnb-repo/apps/web')

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => /^--([^=]+)(?:=(.*))?$/.exec(arg))
    .filter(Boolean)
    .map((m) => [m[1], m[2] ?? 'true']),
)
const UPSTREAM = resolve(args.from ?? process.env.CANVAS_UPSTREAM ?? DEFAULT_UPSTREAM)
const FORCE = args.force === 'true'

const SOURCES = ['library-assets']

if (!existsSync(join(UPSTREAM, 'public'))) {
  console.error(`✗ 找不到上游 public 目录：${join(UPSTREAM, 'public')}`)
  process.exit(1)
}

let copied = 0
let skipped = 0
let bytes = 0

for (const name of SOURCES) {
  const from = join(UPSTREAM, 'public', name)
  if (!existsSync(from)) {
    console.warn(`  ! 上游缺目录，跳过：public/${name}`)
    continue
  }
  const to = join(PUBLIC_DIR, name)
  mkdirSync(to, { recursive: true })

  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    const size = statSync(src).size

    // 同名同大小就认为没变。**故意不比 mtime**：克隆 / 检出会重写 mtime，
    // 那会让「内容没变」被判成「变了」，每次构建白拷 4.6MB。
    if (!FORCE && existsSync(dest) && statSync(dest).size === size) {
      skipped += 1
      continue
    }
    copyFileSync(src, dest)
    copied += 1
    bytes += size
  }
}

const dest = relative(process.cwd(), PUBLIC_DIR).replace(/\\/g, '/')
console.log(
  `✓ 静态资源：新拷 ${copied} 个（${(bytes / 1024 / 1024).toFixed(1)} MB），` +
    `跳过 ${skipped} 个未变的 → ${dest}`,
)
