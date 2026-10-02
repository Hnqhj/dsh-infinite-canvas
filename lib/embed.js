/**
 * embed 静态托管 —— 把画布那一包文件从插件目录里发出去。
 *
 * ## 为什么画布要经宿主半发，而不是直接 file:// 打开
 *
 * iframe 必须与 DSH 应用**同源**，这样：① 相对路径能命中插件自己的 HTTP 面；
 * ② localStorage 有稳定的 origin，画布的项目存档不会每次重开就丢；③ 没有 CORS。
 * 实测确认桌面端唯一的 HTTP 端就是 `127.0.0.1:19387`（见 docs/接入方案.md 第六节），
 * 所以"经宿主半发"等于"同源"。
 *
 * ## 路径安全
 *
 * 只允许 `embed` 目录下的相对路径。`..` 段、绝对路径、以及解码后仍含分隔符的
 * 段一律拒绝 —— 这条接口是给同源页面用的，但它仍然是网络可达的。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** embed 目录的绝对路径（随包走）。 */
export const EMBED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'embed');

/** 够用即可的 MIME 表；查不到时回落 `application/octet-stream`。 */
const MIME = new Map(Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
}));

/** 取小写扩展名；没有扩展名时返回空串。 */
export function extOf(relPath) {
    const cut = relPath.lastIndexOf('.');
    return cut === -1 ? '' : relPath.slice(cut).toLowerCase();
}

/**
 * 把一个 URL 相对路径解析成 embed 目录下的绝对路径。
 *
 * @param relative - 已经去掉路由前缀的相对路径（可能为空串，表示目录）。
 * @returns 绝对路径；越界或非法时返回 `undefined`。
 */
export function resolveEmbedPath(relative) {
    let decoded;
    try {
        decoded = decodeURIComponent(relative);
    } catch {
        return undefined;
    }
    // 反斜杠在 Windows 上也是分隔符，先统一掉再判断。
    const unified = decoded.replace(/\\/gu, '/');
    if (unified.includes('\0')) return undefined;
    const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
    for (const segment of segments) {
        if (segment === '..') return undefined;
        // 解码后仍带分隔符的段说明是二次编码的逃逸尝试。
        if (segment.includes('/') || segment.includes('\\')) return undefined;
    }
    const target = normalize(join(EMBED_ROOT, ...segments));
    if (target !== EMBED_ROOT && !target.startsWith(EMBED_ROOT + sep)) return undefined;
    return target;
}

/** 目录请求补 `index.html`；顺便挡掉"想读目录本身"的情况。 */
function withIndex(absolute, relative) {
    const last = relative.split('/').filter((segment) => segment !== '').pop();
    if (last !== undefined && extOf(last) !== '') return absolute;
    return join(absolute, 'index.html');
}

/**
 * 发送一个 embed 文件。
 *
 * 用原生 `req`/`res` 流式发送，并实现 `HEAD` 与基本的 `Content-Length`。
 * 一律 `no-store`：开发期改完 embed 刷新就该看到新版本，别被缓存骗。
 *
 * @returns 找到并发出返回 `true`；文件不存在返回 `false`（调用方回 404）。
 */
export async function sendEmbedFile(req, res, relative) {
    const candidate = resolveEmbedPath(relative);
    if (candidate === undefined) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('invalid embed path');
        return true;
    }
    const absolute = withIndex(candidate, relative);
    let info;
    try {
        info = await stat(absolute);
    } catch {
        return false;
    }
    if (!info.isFile()) return false;

    const headers = {
        'content-type': MIME.get(extOf(absolute)) ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    await new Promise((done) => {
        const stream = createReadStream(absolute);
        stream.on('error', () => { res.destroy(); done(); });
        stream.on('end', done);
        stream.pipe(res);
    });
    return true;
}
