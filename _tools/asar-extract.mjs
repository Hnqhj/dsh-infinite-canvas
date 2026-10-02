/**
 * 极简 asar 解析器（只读，用于侦察 DSH 客户端包结构）。
 * 用法: node asar-extract.mjs <app.asar> list [前缀过滤]
 *       node asar-extract.mjs <app.asar> extract <内部路径> <输出目录>
 */
import fs from 'node:fs';
import path from 'node:path';

function readHeader(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const headerPickleSize = head.readUInt32LE(4);
    const hb = Buffer.alloc(headerPickleSize);
    fs.readSync(fd, hb, 0, headerPickleSize, 8);
    const strLen = hb.readUInt32LE(4);
    const json = hb.toString('utf8', 8, 8 + strLen);
    fs.closeSync(fd);
    return { header: JSON.parse(json), base: 8 + headerPickleSize };
}

const [asarPath, mode, ...rest] = process.argv.slice(2);
const { header, base } = readHeader(asarPath);

function walk(node, prefix, out) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = prefix === '' ? name : `${prefix}/${name}`;
        if (entry.files) walk(entry, p, out);
        else out.push({ path: p, offset: entry.offset, size: entry.size });
    }
}

const all = [];
walk(header, '', all);

if (mode === 'list') {
    const filter = rest[0] ?? '';
    const hits = all.filter((e) => e.path.includes(filter));
    console.log(`总文件数 ${all.length}，匹配 ${filter} 的 ${hits.length} 项：`);
    for (const e of hits.slice(0, 400)) console.log(String(e.size).padStart(9), e.path);
} else if (mode === 'extract') {
    const [innerPrefix, outDir] = rest;
    const fd = fs.openSync(asarPath, 'r');
    let n = 0;
    for (const e of all) {
        if (!e.path.startsWith(innerPrefix)) continue;
        const dest = path.join(outDir, e.path.replace(/^dsh\/node_modules\//, '').replace(/^\/+/, ''));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const buf = Buffer.alloc(e.size);
        fs.readSync(fd, buf, 0, e.size, base + Number(e.offset));
        fs.writeFileSync(dest, buf);
        n++;
    }
    fs.closeSync(fd);
    console.log(`已提取 ${n} 个文件到 ${outDir}`);
}
