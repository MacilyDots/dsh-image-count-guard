// 会话图片报告：统计一个 DSH 会话里的图片出现位置、字节总量与省略状态。
// 用途：判断某个会话切到视觉模型后会不会撞上上游的图片张数上限。
//
//   node session-image-report.mjs <session.v4.jsonl.zstd>
//   node session-image-report.mjs <sessions 根目录>            # 扫描最近的会话
//   node session-image-report.mjs <sessions 根目录> --limit 30
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** 解多帧 zstd：按 magic 切帧，逐帧解压后拼接。 */
function loadSessionText(file) {
  const buf = readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  let index = 0;
  while ((index = buf.indexOf(magic, index)) !== -1) { offsets.push(index); index += 4; }
  const parts = [];
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame];
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8')); } catch {}
  }
  return parts.join('');
}

/** readdir，失败返回空数组（权限/竞态）。 */
function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function parseEvents(file) {
  return loadSessionText(file)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/** 收集一个事件里所有 image block 的附件事实。 */
function collectImages(node, where, rows) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) collectImages(item, where, rows); return; }
  if (node.type === 'image') rows.push({ where, bytes: node.attachment?.bytes ?? 0, name: node.attachment?.name ?? '', offloaded: node.offloaded === true });
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    if (node[key] && typeof node[key] === 'object') collectImages(node[key], where, rows);
  }
}

function report(file) {
  const events = parseEvents(file);
  const rows = [];
  events.forEach((event, index) => collectImages(event.data, `${index}:${event.type}`, rows));
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const base64 = Math.ceil(bytes / 3) * 4;
  const offloaded = rows.filter((row) => row.offloaded).length;
  return {
    file,
    events: events.length,
    images: rows.length - offloaded,
    imageOccurrences: rows.length,
    offloaded,
    rawMiB: bytes / 1048576,
    base64MiB: base64 / 1048576,
    averageKiB: rows.length === 0 ? 0 : bytes / rows.length / 1024,
    names: rows.map((row) => row.name).filter(Boolean),
  };
}

const target = process.argv[2];
if (!target) {
  console.error('用法：node session-image-report.mjs <session.v4.jsonl.zstd | sessions 根目录> [--limit N]');
  process.exit(2);
}
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex === -1 ? 20 : Number(process.argv[limitIndex + 1]);

const stats = statSync(target);
if (stats.isFile()) {
  const result = report(target);
  console.log(JSON.stringify(result, null, 2));
} else {
  const files = [];
  const addSessionDirs = (parent) => {
    for (const name of readdirSync(parent)) {
      const dir = join(parent, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      // sessions\<workspace>\<session>\session.vX.jsonl.zstd
      for (const sessionName of safeReaddir(dir)) {
        const sessionDir = join(dir, sessionName);
        for (const fileName of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
          const file = join(sessionDir, fileName);
          try { files.push({ file, mtime: statSync(file).mtimeMs }); } catch {}
        }
      }
    }
  };
  addSessionDirs(target);
  files.sort((a, b) => b.mtime - a.mtime);
  const rows = files.slice(0, limit).map((entry) => report(entry.file));
  rows.sort((a, b) => b.images - a.images);
  console.log('会话            图片数  已省略  原始MiB  base64MiB  平均KiB  事件数');
  for (const row of rows) {
    const label = row.file.split(/[\\/]/).slice(-2, -1)[0].slice(0, 20);
    console.log(`${label.padEnd(20)} ${String(row.images).padStart(5)} ${String(row.offloaded).padStart(6)} ${row.rawMiB.toFixed(2).padStart(8)} ${row.base64MiB.toFixed(2).padStart(10)} ${row.averageKiB.toFixed(0).padStart(8)} ${String(row.events).padStart(7)}`);
  }
}
