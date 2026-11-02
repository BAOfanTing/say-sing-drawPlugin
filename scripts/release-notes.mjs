#!/usr/bin/env node
// 生成 GitHub Release 正文：安装说明 + 该版本相对上一版的提交列表 + compare 链接。
//
// 用法：
//   node scripts/release-notes.mjs 1.0.5 --sha256 <hex> --file sing-1.0.5.tar.gz > body.md
//
// 说明：正文来自 **git 提交历史**（不再维护 CHANGELOG.md）：
//   从上一个 tag 到当前 tag 之间的 commit，按 feat / fix / 其它分组列出。
import { execFileSync } from 'node:child_process';
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

// 找上一个 tag（排除当前版本）
const tags = git('tag', '--sort=-v:refname').split('\n').filter(Boolean);
const previous = tags.find((tag) => tag.replace(/^v/, '') !== version) || '';
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

const parts = [`## v${version}`, ''];
if (groups.feat.length) parts.push('### 新增', ...groups.feat, '');
if (groups.fix.length) parts.push('### 修复', ...groups.fix, '');
if (groups.other.length) parts.push('### 其它', ...groups.other, '');
if (!lines.length) parts.push('（这个版本没有可列出的提交）', '');

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
