#!/usr/bin/env node
// 局域网静态服务：node server.js [端口]，同一网络下用 http://<本机IP>:<端口> 访问。
// 只提供静态文件，不接收上传——表格在浏览器本地解析计算，数据不离开访问者的电脑。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2] || process.env.PORT || 8770);
const ROOT = __dirname;
const ALLOW = /^\/(index\.html|engine\/[\w-]+\.js|web\/[\w.-]+|templates\/[^/]+\.xlsx|example\/[^/]+\.xlsx)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (p === '/') p = '/index.html';
  if (req.method !== 'GET' || !ALLOW.test(p) || p.includes('..')) { res.writeHead(404).end('not found'); return; }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((x) => x && x.family === 'IPv4' && !x.internal).map((x) => x.address);
  console.log(`VLA 评测计算器已启动：\n  本机    http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  局域网  http://${ip}:${PORT}`);
  console.log('（无登录鉴权：同一网络内任何人都能打开页面；页面只做本地计算，不上传数据）');
});
