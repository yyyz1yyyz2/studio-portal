#!/usr/bin/env node
/**
 * smoke-html —— index.html 无头冒烟(L1 证据工具)
 *
 * 两层:
 * 1) 结构层(零依赖,必跑):doctype 在位、文档闭合、零外链依赖
 *    (无图片/无脚本/无外链样式/无内嵌框架/无任何 src 属性/无远程资源引用)。
 * 2) 行为层(playwright 可载入时跑):file:// 无头打开,断言
 *    零控制台报错 + 零页面异常 + 零失败请求 + 关键文案在页。
 *
 * playwright 解析顺序:环境变量 PW_MODULE_DIR(指向任一含 playwright 的
 * node_modules 目录)→ 本仓 node_modules。路径经环境变量注入,不写死在本源码里。
 *
 * 用法:PW_MODULE_DIR=<路径> node scripts/smoke-html.mjs
 * 退出码:0=通过;1=任一断言失败
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HTML = join(ROOT, 'index.html');

let failures = 0;
const bad = (msg) => { failures += 1; console.error(`[smoke][失败] ${msg}`); };
const ok = (msg) => console.log(`[smoke][过] ${msg}`);

// ---- 结构层 ----

if (!existsSync(HTML)) {
  bad(`index.html 不存在: ${HTML}`);
} else {
  ok('index.html 在位');
}

let html = '';
try {
  html = readFileSync(HTML, 'utf8');
  ok(`读取成功(${Buffer.byteLength(html, 'utf8')} 字节)`);
} catch (e) {
  bad(`读取失败: ${e.message}`);
}

if (/^\uFEFF?<!doctype html>/i.test(html)) {
  ok('doctype 声明在位');
} else {
  bad('缺少 doctype 声明');
}

for (const tag of ['html', 'head', 'body', 'title', 'main']) {
  const open = new RegExp(`<${tag}[\\s>]`, 'i').test(html);
  const close = new RegExp(`</${tag}\\s*>`, 'i').test(html);
  if (open && close) {
    ok(`<${tag}> 开合闭合`);
  } else {
    bad(`<${tag}> 标签不完整(开=${open} 闭=${close})`);
  }
}

if (/<meta[^>]+charset/i.test(html)) {
  ok('charset 声明在位');
} else {
  bad('缺少 charset 声明');
}

const EXTERNAL_CHECKS = [
  ['图片标签', /<img\b/i],
  ['脚本标签', /<script\b/i],
  ['外链样式/预取标签', /<link\b/i],
  ['内嵌框架', /<iframe\b/i],
  ['任何 src 属性', /\ssrc\s*=/i],
  ['样式导入语句', /@import/i],
  ['样式地址函数', /url\s*\(/i],
  ['远程资源引用', /\s(?:src|href)\s*=\s*["']https?:/i],
];
for (const [name, re] of EXTERNAL_CHECKS) {
  if (re.test(html)) {
    bad(`外链依赖命中: ${name}`);
  } else {
    ok(`零外链: 无${name}`);
  }
}

const KEY_TEXT = [
  'AI 协作开发工作室 · 作品集',
  '我们是谁',
  '能力三行',
  '接单流程(四步)',
  'AI 披露',
  '作品一|', '作品二|', '作品三|', '作品四|', '作品五|', '作品六|',
  '30 天质保',
];
const missingText = KEY_TEXT.filter((s) => !html.includes(s));
if (missingText.length === 0) {
  ok(`关键文案齐: ${KEY_TEXT.length}/${KEY_TEXT.length}`);
} else {
  bad(`关键文案缺失: ${missingText.join(' / ')}`);
}

// ---- 行为层(playwright 可载入才跑) ----

async function browserSmoke() {
  const candidates = [];
  if (process.env.PW_MODULE_DIR) candidates.push(process.env.PW_MODULE_DIR);
  candidates.push(join(ROOT, 'node_modules'));

  let pw = null;
  let origin = '';
  for (const dir of candidates) {
    try {
      const req = createRequire(join(dir, 'package.json'));
      pw = req('playwright');
      origin = dir;
      break;
    } catch {
      // 试下一个候选
    }
  }
  if (!pw) {
    console.log('[smoke][跳过] playwright 未载入(可设 PW_MODULE_DIR 重跑);结构层结论不受影响');
    return;
  }
  console.log(`[smoke] playwright 载自: ${origin}`);

  const { chromium } = pw;
  const tries = [
    ['系统 Chrome', { channel: 'chrome' }],
    ['系统 Edge', { channel: 'msedge' }],
    ['内置内核', {}],
  ];
  let browser = null;
  let used = '';
  for (const [label, opts] of tries) {
    try {
      browser = await chromium.launch({ headless: true, ...opts });
      used = label;
      break;
    } catch {
      // 试下一个通道
    }
  }
  if (!browser) {
    bad('所有浏览器通道启动失败');
    return;
  }
  console.log(`[smoke] 浏览器通道: ${used}(无头)`);

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('requestfailed', (r) => {
      failedRequests.push(`${r.url()} :: ${(r.failure() && r.failure().errorText) || '未知原因'}`);
    });
    await page.goto(pathToFileURL(HTML).href, { waitUntil: 'load', timeout: 20_000 });
    const body = (await page.textContent('body')) || '';
    const missing = KEY_TEXT.filter((s) => !body.includes(s));

    if (consoleErrors.length === 0) ok('浏览器控制台零报错');
    else bad(`控制台报错 ${consoleErrors.length} 条: ${consoleErrors.join(' | ')}`);

    if (pageErrors.length === 0) ok('页面异常零条');
    else bad(`页面异常 ${pageErrors.length} 条: ${pageErrors.join(' | ')}`);

    if (failedRequests.length === 0) ok('失败请求零条');
    else bad(`失败请求 ${failedRequests.length} 条: ${failedRequests.join(' | ')}`);

    if (missing.length === 0) ok(`渲染后关键文案齐: ${KEY_TEXT.length}/${KEY_TEXT.length}`);
    else bad(`渲染后文案缺失: ${missing.join(' / ')}`);

    await page.close();
  } catch (e) {
    bad(`浏览器冒烟执行失败: ${e.message}`);
  } finally {
    await browser.close();
  }
}

try {
  await browserSmoke();
} catch (e) {
  bad(`冒烟流程异常: ${e.message}`);
}

if (failures > 0) {
  console.error(`[smoke] 结论: 不通过(${failures} 项失败)`);
  process.exit(1);
}
console.log('[smoke] 结论: 通过(结构层全过' +
  ', 行为层见上)');
process.exit(0);
