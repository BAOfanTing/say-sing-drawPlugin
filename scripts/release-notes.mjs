#!/usr/bin/env node
// 生成 GitHub Release 正文：该版本的变更内容 + 安装说明 + compare 链接。
//
// 用法：
//   node scripts/release-notes.mjs 1.0.6 --sha256 <hex> --file sing-1.0.6.tar.gz > body.md
//
// 正文来源（按优先级）：
//   1. `CHANGELOG.md` 里 `## [x.y.z] - 日期` 那一节 —— 正常发版都走这条；
//   2. 没有对应小节时，回落到「上一版 tag 到本 tag 的提交列表」（按 feat / fix / 其它分组）。
// 标题格式别改：`## [x.y.z]`（发布工作流按它抽取）。
import { execFileSync } from 'node:child_process';
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

const git = (...argv) => {
  try {
    return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

/** 从 CHANGELOG.md 抽 `## [x.y.z]` 到下一个 `## [` 之间的内容。 */
function changelogSection(ver) {
  let text = '';
  try {
    text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[${ver.replace(/\./g, '\\.')}\\]`).test(l));
  if (start < 0) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').replace(/^-{3,}\s*$/gm, '').trim();
}

const fromChangelog = changelogSection(version);

// 上一个 tag（排除当前版本），用于 compare 链接 / 提交列表回落
const tags = git('tag', '--sort=-v:refname').split('\n').filter(Boolean);
const previous = tags.find((t) => t.replace(/^v/, '') !== version) || '';

let body = fromChangelog;
if (!body) {
  const range = previous ? `${previous}..v${version}` : `v${version}`;
  const raw = git('log', '--no-merges', '--pretty=format:%h%x09%s', range);
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  const groups = { feat: [], fix: [], other: [] };
  for (const line of lines) {
    const [hash, ...rest] = line.split('\t');
    const subject = rest.join('\t').trim();
    if (!subject) continue;
    const item = `- ${subject}（\`${hash}\`）`;
    if (/^feat(\(|:)/i.test(subject)) groups.feat.push(item);
    else if (/^fix(\(|:)/i.test(subject)) groups.fix.push(item);
    else groups.other.push(item);
  }
  const parts = [];
  if (groups.feat.length) parts.push('### 新增', ...groups.feat, '');
  if (groups.fix.length) parts.push('### 修复', ...groups.fix, '');
  if (groups.other.length) parts.push('### 其它', ...groups.other, '');
  body = parts.length ? parts.join('\n').trim() : '（这个版本没有可列出的变更）';
  console.error(`⚠ CHANGELOG.md 里没有 ${version} 一节，正文改用提交列表`);
}

const parts = [`## v${version}`, '', body, ''];

parts.push(
  '## 安装',
  '',
  `控制台 → 插件 → 从本地安装，选附件里的 \`${file}\`。`,
  '',
  '```',
  sha256 ? `sha256: ${sha256}` : 'sha256: 见附件',
  '```',
  '',
  '> 本插件需要在你自己的电脑上跑说话 / 唱歌 / 画图的后端（`gateway/` + 各模型权重），',
  '> 服务器只做转发。详见仓库 README 与 docs/QUICKSTART.md。'
);

if (previous) {
  const repo = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}`
    + `/${process.env.GITHUB_REPOSITORY || 'BAOfanTing/say-sing-drawPlugin'}`;
  parts.push('', `**Full Changelog**: [${previous}...v${version}](${repo}/compare/${previous}...v${version})`);
}

process.stdout.write(parts.join('\n') + '\n');
