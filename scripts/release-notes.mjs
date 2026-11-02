#!/usr/bin/env node
// 生成 GitHub Release 正文：安装说明 + 该版本在 CHANGELOG.md 里的整节内容。
//
// 用法：
//   node scripts/release-notes.mjs 1.0.5 --sha256 <hex> --file sing-1.0.5.tar.gz > body.md
//
// 为什么要有它：release.yml 之前把 body 写死成"安装"一段，`generate_release_notes`
// 又被 body 覆盖，于是 Release 页只剩安装说明 —— 用户看不到这个版本做了什么。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const version = String(args[0] || '').replace(/^v/, '');
if (!version) {
  console.error('用法: node scripts/release-notes.mjs <version> [--sha256 <hex>] [--file <name>]');
  process.exit(2);
}
const pick = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const sha256 = pick('--sha256');
const file = pick('--file') || `sing-${version}.tar.gz`;

/** 从 CHANGELOG.md 里抽 `## [x.y.z]` 到下一个 `## [` 之间的内容。 */
function section(text, ver) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s*\\[${ver.replace(/\./g, '\\.')}\\]`).test(line));
  if (start < 0) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s*\[/.test(lines[i]) || /^---\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const body = section(changelog, version);
// "上一版" = 当前版本之后出现的那一节（CHANGELOG 是倒序，第一条就是当前版本）
const allVersions = [...changelog.matchAll(/^##\s*\[([0-9.]+)\]/gm)].map((m) => m[1]);
const at = allVersions.indexOf(version);
const previous = at >= 0 ? allVersions[at + 1] : allVersions[0];

const install = [
  '## 安装',
  '',
  `控制台 → 插件 → 从本地安装，选附件里的 \`${file}\`。`,
  '',
  '```',
  sha256 ? `sha256: ${sha256}` : 'sha256: 见下方附件说明',
  '```',
  '',
  '> 本插件需要在你自己的电脑上跑说话/唱歌后端（`gateway/` + 说话模型），服务器只做转发。',
  '> 详见仓库 README 与 docs/QUICKSTART.md。'
].join('\n');

const parts = [body || `## v${version}\n\n（CHANGELOG.md 里没有 ${version} 这一节，请补上）`, '', install];
if (previous && previous !== version) {
  const repo = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}`
    + `/${process.env.GITHUB_REPOSITORY || 'BAOfanTing/say-sing-drawPlugin'}`;
  parts.push('', `**Full Changelog**: [v${previous}...v${version}](${repo}/compare/v${previous}...v${version})`);
}
process.stdout.write(parts.join('\n') + '\n');

if (!body) {
  console.error(`⚠ CHANGELOG.md 里没找到 ${version} 一节，正文只有安装说明`);
  process.exitCode = 0;
}
