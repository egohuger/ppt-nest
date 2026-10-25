#!/usr/bin/env node
/**
 * 图标体检：把前端代码里用到的图标名与 icons.js 注册表逐一对齐。
 * 未注册的名字会让 icon() 返回空串（一个圆按钮里没有图标 = 只有底色），
 * 而 console.warn 在常规验收里很容易被漏掉，所以做成可重复跑的脚本。
 *
 * 用法：node scripts/check-icons.mjs
 *   退出码 0 = 全部已注册；1 = 有缺失或有多余的注册项（多余只提示，不算失败）
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');

const iconsSrc = readFileSync(join(frontend, 'js', 'icons.js'), 'utf8');
const registered = new Set([...iconsSrc.matchAll(/^\s{4}'([a-z0-9-]+)':/gm)].map(m => m[1]));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(name) && !/icons\.js$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(frontend, 'js')), join(frontend, 'index.html')];
const used = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const re of [/icon\(\s*['"]([a-z0-9-]+)['"]/g, /data-icon=['"]([a-z0-9-]+)['"]/g]) {
    for (const m of src.matchAll(re)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(f.replace(root + '/', ''));
    }
  }
}

const missing = [...used.keys()].filter(n => !registered.has(n)).sort();
const unused = [...registered].filter(n => !used.has(n)).sort();

console.log(`注册表 ${registered.size} 个 / 代码使用 ${used.size} 个`);
if (unused.length) console.log(`未使用（不算错）: ${unused.join(', ')}`);
if (missing.length) {
  console.error('\n缺失的图标（会渲染成空白）:');
  for (const n of missing) console.error(`  - ${n}  ← ${[...used.get(n)].join(', ')}`);
  console.error('\n把官方路径补进 frontend/js/icons.js 的 ICON_PATHS 即可。');
  process.exit(1);
}
console.log('全部图标均已注册 ✓');
