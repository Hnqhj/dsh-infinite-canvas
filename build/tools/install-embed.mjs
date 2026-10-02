/**
 * 把 `build/dist/` 的构建产物装进插件运行时的静态目录 `lib/embed/`。
 *
 * ── 为什么要有这一步，而不是让 Vite 直接输出到 lib/embed ────────────────────
 * 因为 `lib/embed/` 里**不是只有构建产物**：
 *   · `canvas-transport.js` —— 手写的 DSH 传输层（构建时被内联进 index.html，
 *     但磁盘上这份仍是真源，`lib/embed.js` 的静态托管也按原路径提供它）；
 *   · `canvas-commands.js` —— 命令契约的纯 JS 镜像，`tools/smoke-test.mjs`
 *     靠它做「宿主半 ↔ 画布半」的闭环测试。
 * 让 Vite 直接写这个目录，就得 `emptyOutDir: false`，代价是**旧版本的 hash
 * 资源永远清不掉**（每次改一行代码就多出一份 index-<hash>.js / .css）。
 * 所以让 Vite 输出到干净的 `dist/`，再由这里做一次有选择的覆盖。
 *
 * ── 只覆盖「产物」，不动手写文件 ────────────────────────────────────────────
 * 清理清单写死成下面三个，而不是「把 lib/embed 清空再拷」—— 后者会在有人
 * 手滑改了目录结构时静默删掉传输层。
 *
 * 用法：node tools/install-embed.mjs
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(BUILD_DIR, 'dist')
const EMBED = resolve(BUILD_DIR, '../lib/embed')

/**
 * 构建产物在 `lib/embed/` 里的落点。
 *
 * ⚠️ 这里**只有 `assets` 能整目录删**。`library-assets` 曾经也在这份清单里，
 * 结果它同时是「dist 的构建副本」和「用户放进来的素材」（实测 6MB 预览图）——
 * 整目录删会把用户的素材一起清掉。实测：素材被占时 `rmSync` 直接抛错，
 * 整个安装中断，`index.html` 没更新，而 **vite 已经构建成功了**，
 * 于是产物停在「dist 是新的、embed 是旧的」这种最难查的状态。
 *
 * 所以改成：只删 dist 里有、且本次构建还在的文件（`assets` 走整目录，
 * 因为它 100% 是构建产物），`library-assets` 改成**按文件名覆盖**。
 */
const REPLACE_DIR = ['assets']

/** 必须原地保留的手写文件 —— 清理时绝不能被碰到。 */
const HANDWRITTEN = ['canvas-transport.js', 'canvas-commands.js']

if (!existsSync(DIST)) {
    console.error(`✗ 没有构建产物：${DIST}\n  先跑 npm run build。`)
    process.exit(1)
}

mkdirSync(EMBED, { recursive: true })

for (const name of REPLACE_DIR) {
  const dir = join(EMBED, name)
  /**
   * 删不掉就**跳过、不中断**。
   *
   * 为什么不能中断：vite 已经构建成功了，`rmSync` 一抛错整个脚本就停，
   * 于是 `dist/` 是新的、`lib/embed/` 是旧的 —— 而 Vite 那边**没有任何报错**。
   * 这是最难查的状态：所有命令都"成功"了，跑起来却是旧版本。
   * 跳过删除的代价只是残留几个旧 hash 文件（`index.html` 不引用它们），
   * 比"装了个旧版本"划算得多。
   */
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn(`! ${name} 删不掉（可能被文件锁占用），改为直接覆盖：${e.code ?? e.message}`)
  }
}

let files = 0
let bytes = 0
/**
 * 覆盖已存在的文件时先比大小与 mtime，一致就跳过。
 *
 * 为什么：`cpSync` 覆盖同名文件会先 `unlink`，而 `library-assets` 里是
 * **用户的素材**（预览图常被图片查看器 / 索引服务占着）→ unlink 抛 EBUSY →
 * 整个安装中断。可这两份文件本来就该一模一样（`copy-static.mjs` 从同一个
 * 源拷的），覆盖是**纯多余的操作**。跳过它既省了 6MB 写入，也避开了锁。
 */
const same = (a, b) => {
  try {
    const x = statSync(a)
    const y = statSync(b)
    return x.size === y.size && x.mtimeMs === y.mtimeMs
  } catch {
    return false
  }
}
let skipped = 0
const walk = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) {
      walk(src, dest)
      continue
    }
    if (existsSync(dest) && same(src, dest)) {
      skipped += 1
      continue
    }
    try {
      cpSync(src, dest)
    } catch (e) {
      // 单个文件失败不中断：它多半是被占用，而我们要的是「其余都装上」。
      console.warn(`! 跳过装不下的 ${entry.name}：${e.code ?? e.message}`)
      continue
    }
    files += 1
    bytes += statSync(dest).size
  }
}
walk(DIST, EMBED)

// 传输层必须还在 —— 它被内联进了 index.html，但磁盘上那份仍是真源
// （`lib/embed.js` 的静态托管按原路径提供；将来如果改成 <script src> 也靠它）。
const missing = HANDWRITTEN.filter((name) => !existsSync(join(EMBED, name)))
if (missing.length > 0) {
  console.error(`✗ lib/embed 里缺少手写文件：${missing.join(', ')}`)
  process.exit(1)
}

const top = readdirSync(EMBED, { withFileTypes: true })
  .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  .sort()

console.log(
  `✓ 已装入 ${files} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）→ ` +
    `${relative(process.cwd(), EMBED).replace(/\\/g, '/')}`,
)
if (skipped > 0) console.log(`  跳过 ${skipped} 个未变化的文件（避免覆盖被占用的素材）`)
console.log(`  lib/embed 现在有：${top.join('  ')}`)
