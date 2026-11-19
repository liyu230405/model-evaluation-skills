// 计算文件指纹锁：冻结「产生数字」和「独立复算」的文件。
// 启动时比对 SHA-256，不一致就拒绝运行；确需改动必须显式 --relock 并写明原因，留痕。
// 说明：这是流程约束不是安全机制——防的是顺手改口径、AI 自作主张改公式，不是防有权限的人。
//
// 锁定范围（锁「算」「排」「验」，不锁「读」）：
//   engine/math.js     统计函数：配对 t、区间、加权
//   engine/analyze.js  聚合、水平、切面、Skill 判定
//   engine/native.js   大表解析口径（ID/OOD 归属、Skill 拆分、模型命名）——决定哪些数据进计算
//   engine/report.js   六节底稿渲染（数字的舍入与格式化在这里定型）
//   engine/excel.js    Excel 公式复核表（第二套独立实现）
//   verify.py          独立复算
//   crosscheck.py      跨报告一致性核对
//   engine/report_*.js 任何新增渲染器（必须 --relock 登记后才放行）
// 不锁：xlsx.js / base.js（纯数据搬运），lock.js 自身。
(function () {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const V = (globalThis.VLA = globalThis.VLA || {});

  const FILES = ['engine/math.js', 'engine/analyze.js', 'engine/native.js', 'engine/report.js', 'engine/excel.js', 'verify.py', 'crosscheck.py'];
  const RENDERER = /^engine\/report_[^/\\]+\.js$/;   // report_single.js 等新增渲染器
  const LOCK = 'compute-lock.json';

  function digest(file) {
    const raw = fs.readFileSync(file);
    // 统一换行与 BOM，避免不同机器 checkout 造成假报警
    const s = raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  }

  function readLock(root) {
    const p = path.join(root, LOCK);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  // 本轮应被锁定的文件清单：固定集合 + 目录里现存的 report_*.js
  function targets(root) {
    const out = FILES.slice();
    const dir = path.join(root, 'engine');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const rel = `engine/${f}`;
        if (RENDERER.test(rel) && !out.includes(rel)) out.push(rel);
      }
    }
    return out;
  }

  function check(root) {
    const lock = readLock(root);
    if (!lock) return { ok: false, missingLock: true, problems: [] };
    const problems = [];
    for (const f of targets(root)) {
      const p = path.join(root, f);
      const expected = (lock.files || {})[f];
      if (!fs.existsSync(p)) { problems.push({ file: f, expected, actual: null, status: 'missing' }); continue; }
      const actual = digest(p);
      if (expected === undefined) { problems.push({ file: f, expected: null, actual, status: 'unlisted' }); continue; }
      if (expected !== actual) problems.push({ file: f, expected, actual, status: 'changed' });
    }
    return { ok: problems.length === 0, problems, lock };
  }

  function relock(root, reason) {
    if (!reason || !String(reason).trim()) throw new Error('--relock 必须同时给出 --reason（说明为什么改这些文件）');
    const prev = readLock(root);
    const files = {}, changes = [];
    for (const f of targets(root)) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) throw new Error(`要锁定的文件不存在：${f}`);
      const h = digest(p);
      files[f] = h;
      if (prev && (prev.files || {})[f] !== h) changes.push({ file: f, from: (prev.files || {})[f] || null, to: h });
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const tz = -now.getTimezoneOffset() / 60;
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+${pad(tz)}:00`;
    const next = {
      version: 1,
      algorithm: 'sha256',
      note: '计算/渲染/复算文件的指纹。改动必须 node cli.js --relock --reason "..."，会被记进 history。',
      locked: FILES.slice(),
      rendererPattern: 'engine/report_*.js（新增渲染器需 --relock 登记）',
      files,
      history: (prev && prev.history ? prev.history.slice() : []).concat([{ time: stamp, reason: String(reason).trim(), changes }]),
    };
    fs.writeFileSync(path.join(root, LOCK), JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  // 启动闸门：返回 true = 放行
  function guard(root) {
    const r = check(root);
    if (r.ok) return true;
    if (r.missingLock) {
      console.error('❌ 找不到计算文件指纹清单 compute-lock.json，拒绝运行。');
      console.error('   首次使用或换机器后，请运行：node cli.js --relock --reason "初始建立指纹锁"');
      return false;
    }
    console.error('❌ 计算/渲染/复算文件与指纹清单不一致，拒绝出数（报告里的数字会跟着变）：');
    for (const p of r.problems) {
      if (p.status === 'missing') console.error(`   ${p.file}：文件缺失（清单里有，磁盘上没有）`);
      else if (p.status === 'unlisted') console.error(`   ${p.file}：未登记的新文件（渲染器必须登记后才算数）`);
      else console.error(`   ${p.file}：期望 ${String(p.expected).slice(0, 12)}… 实际 ${String(p.actual).slice(0, 12)}…`);
    }
    console.error('   如果这是有意的变更，运行：node cli.js --relock --reason "改了什么、为什么"');
    return false;
  }

  V.lock = { FILES, LOCK, digest, check, relock, guard, targets };
})();
