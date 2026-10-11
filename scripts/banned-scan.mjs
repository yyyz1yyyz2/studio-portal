#!/usr/bin/env node
/**
 * banned-scan —— 整仓敏感模式扫描(门户发布前脱敏预检门工具)
 *
 * 扫描集:整个仓工作区文本文件,含本脚本自身——零自豁免。
 * 跳过目录:.git、node_modules。
 * 命中即:逐条列出 文件:行号 + 模式名 + 行片段,退出码 1;全绿退出码 0。
 *
 * 设计说明(公开仓自脱敏):
 * 1) 硬编码模式在源码中以片段拼装而成,使本脚本源码自身不被任何模式字面命中——
 *    因此"扫描器扫自己"也能全绿,扫描器源码可随仓公开而不泄任何内部信息。
 * 2) 「标识词」类(永不对外的内部标识:个人称谓、人设名、内部要地名)不硬编码进本公开脚本,
 *    而是读本地不入库清单 scripts/banned-words.local.json(格式 {"words":["…"],…});
 *    文件不存在则该类为空(类目机制在,词表由风控班维护)。该清单文件本身
 *    排除出扫描集——它按定义就是敏感词列表,扫它必然自我命中。
 *
 * 用法:node scripts/banned-scan.mjs [可选:仓根目录,默认取本脚本上级目录]
 * 退出码:0=全绿;1=命中;2=扫描器自身故障(如词表 JSON 损坏,故障关门不静默放行)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.argv[2] ? String(process.argv[2]) : join(SCRIPT_DIR, '..');
const WORDLIST_NAME = 'banned-words.local.json';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEXT_EXT = new Set([
  '.md', '.markdown', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.json', '.txt', '.xml', '.yml', '.yaml', '.csv', '.svg',
]);

// ---- 硬编码模式集(片段拼装,防源码自匹配;模式名全部中文,杜绝拉丁字面巧合) ----

/** 转义正则元字符 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS = [
  {
    name: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  },
  {
    // 个人即时通/手机号形态的裸数字串(5 到 11 位;日期"年-月-日"带分隔符不命中)
    name: '连续数字串五到十一位',
    re: /\d{5,11}/,
  },
  {
    // 电商平台令牌前缀(片段拼装)
    name: '商店平台令牌前缀',
    re: new RegExp('shp' + 'at_', 'i'),
  },
  {
    // 部署平台令牌前缀(片段拼装)
    name: '部署平台令牌前缀',
    re: new RegExp('vc' + 'p_', 'i'),
  },
  {
    // 模型服务密钥前缀:词边界加两字母连字符(片段拼装,避免英文单词内部误报)
    name: '模型密钥前缀',
    re: new RegExp('\\bs' + 'k-[A-Za-z0-9]', 'i'),
  },
  {
    // 通用密钥写法:三字母接口前缀直连可选连字符加尾词(片段拼装)
    name: '通用接口密钥写法',
    re: new RegExp('api' + '[_-]?key', 'i'),
  },
  {
    // 地址栏携带凭据写法:凭据词紧跟等号(片段拼装)
    name: '地址栏凭据赋值',
    re: new RegExp('toke' + 'n=', 'i'),
  },
  {
    // 机器内部用户目录路径(正反斜杠两种写法;片段拼装)
    name: '机器内部路径',
    re: new RegExp('C:' + '[\\\\/]Us' + 'ers', 'i'),
  },
  {
    // 机器默认账户名(片段拼装)
    name: '机器默认账户名',
    re: new RegExp('Admini' + 'strator', 'i'),
  },
];

// ---- 本地标识词表(永不对外的内部标识词;不入库,由风控班维护) ----

function loadLocalWords() {
  const p = join(SCRIPT_DIR, WORDLIST_NAME);
  if (!existsSync(p)) return { words: [], present: false, path: p };
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[banned-scan][故障] 本地词表解析失败: ${WORDLIST_NAME} :: ${e.message}`);
    process.exit(2);
  }
  const words = Array.isArray(raw.words) ? raw.words.map(String).filter(Boolean) : [];
  return { words, present: true, path: p };
}

const local = loadLocalWords();
if (local.present && local.words.length > 0) {
  PATTERNS.push({
    name: '本地标识词表',
    re: new RegExp('(' + local.words.map(esc).join('|') + ')', 'i'),
  });
}

// ---- 文件收集 ----

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, acc);
    } else if (ent.isFile()) {
      acc.push(p);
    }
  }
  return acc;
}

const relOf = (p) => relative(ROOT, p).split('\\').join('/');

const allFiles = walk(ROOT);
const skippedBinary = [];
const files = allFiles.filter((p) => {
  if (basename(p) === WORDLIST_NAME) return false; // 词表文件本身排除出扫描集
  const ext = extname(p).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (!ext) return true; // 无扩展名的点文件(如忽略清单)按文本处理
  skippedBinary.push(relOf(p));
  return false;
});

// ---- 扫描 ----

const hits = [];
let scanned = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    skippedBinary.push(relOf(file));
    continue;
  }
  scanned += 1;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        hits.push({ file: relOf(file), line: i + 1, name, snippet: line.trim().slice(0, 160) });
      }
    }
  }
}

// ---- 报告 ----

const scope = [
  `扫描根: ${relOf(ROOT) === '' ? '(仓根)' : relOf(ROOT)}`,
  `文本文件: ${scanned} 个(含本脚本,零自豁免)`,
  `跳过目录: ${[...SKIP_DIRS].join('、')}`,
  `非文本跳过: ${skippedBinary.length} 个`,
  `本地标识词表: ${local.present ? `已载入 ${local.words.length} 词` : '未配置(类目为空)'}; 本地模式类共 ${PATTERNS.length} 类`,
];

if (hits.length > 0) {
  for (const scopeLine of scope) console.log(`[banned-scan] ${scopeLine}`);
  console.error(`[banned-scan] 命中 ${hits.length} 处:`);
  for (const h of hits) {
    console.error(`[banned-scan] 命中〔${h.name}〕 ${h.file}:${h.line}`);
    console.error(`    ${h.snippet}`);
  }
  process.exit(1);
}

for (const scopeLine of scope) console.log(`[banned-scan] ${scopeLine}`);
console.log(`[banned-scan] 全绿: 0 命中(模式类 ${PATTERNS.length} 类,扫描 ${scanned} 个文本文件)`);
process.exit(0);
