#!/usr/bin/env node
// 命令行（对话出报告时由助手调用，也可手动跑）：
//   node cli.js 基线.xlsx 新模型.xlsx [--names 基线名 新模型名] [--title 标题] [--out 输出目录]
//   node cli.js 合表.xlsx [...]          一个表里含多个模型（有「模型」列）也行
//   node cli.js 白盒大表.xlsx 黑盒大表.xlsx --models 基准 A B    三模型：A、B 各自对基准，底稿按三模型版式输出
// 规则：表里有「模型」列就用表里的名字，没有就用 --names 或文件名；第一个表的模型是基线，第二个是新模型。
// 产出：数字底稿.md（程序算出的全部数字，写报告只能引用这里的数）、结果.json、复核表.xlsx（Excel 公式复算）
// 核对报告：node cli.js --check 数字底稿.md 报告.md
const fs = require('fs');
const path = require('path');
for (const f of ['math', 'xlsx', 'native', 'analyze', 'report', 'report_n', 'report_single', 'templates', 'excel', 'base', 'lock']) require(`./engine/${f}.js`);
const V = globalThis.VLA;
const ROOT = __dirname;

const MAX_MODELS = 8;  // 一个基准 + 七个对比
const ERR_TOO_MANY_MODELS = '❌ --models 最多八个：基准 + 七个对比（各自对基准比较）';
const HINT_SINGLE_MODEL = '\n请用 --models 模型名 指定一个（--type single）';
const HINT_COMPARE = '\n请用 --models 基线模型 新模型 指定两个（三模型：--models 基准 A B）';

// 模型没给够时先列可选模型让用户挑；--list 只列不报错
function listingNeeded(args, singleModel) {
  return args.list || args.models.length < (singleModel ? 1 : 2);
}

function printBaseModels(args) {
  console.log('多维表格里可选的模型（模型名｜白盒/黑盒｜子表）：');
  if (args.baseW) for (const t of V.base.list(args.baseW, false)) console.log(`  ${t.model}｜${t.black ? '黑盒' : '白盒'}｜${t.sheet}`);
  if (args.baseB) for (const t of V.base.list(args.baseB, true)) console.log(`  ${t.model}｜${t.black ? '黑盒' : '白盒'}｜${t.sheet}`);
}

function printBookModels(books) {
  console.log('表里可选的模型（模型名｜白盒/黑盒｜有分数的用例数｜sheet）：');
  for (const b of books) for (const m of V.native.listModels(b.sheets)) console.log(`  ${m.model}｜${m.black ? '黑盒' : '白盒'}｜${m.scored}｜${b.label} → ${m.sheet}`);
}

function finishListing(args, singleModel) {
  if (args.list) return;
  console.log(singleModel ? HINT_SINGLE_MODEL : HINT_COMPARE);
  process.exitCode = 2;
}

function modelLimitOk(models) {
  if (models.length <= MAX_MODELS) return true;
  console.error(ERR_TOO_MANY_MODELS);
  process.exitCode = 2;
  return false;
}

async function load(file) {
  const buf = fs.readFileSync(file);
  if (/\.csv$/i.test(file)) return { 执行明细: V.xlsx.parseCSV(buf.toString('utf8')) };
  return V.xlsx.readXlsx(buf);
}

function parseArgs(argv) {
  const o = { files: [], names: [], models: [], labels: [], list: false, title: '', out: '', baseW: '', baseB: '', type: 'compare' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--names') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.names.push(argv[++i]); }
    else if (a === '--models') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.models.push(argv[++i]); }
    // 报告里显示的短名，顺序与 --models 一一对应（规则维护：模型名统一用短名）
    else if (a === '--labels') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.labels.push(argv[++i]); }
    else if (a === '--list') o.list = true;
    else if (a === '--title') o.title = argv[++i] || '';
    else if (a === '--out') o.out = argv[++i] || '';
    else if (a === '--type') o.type = argv[++i] || 'compare';
    else if (a === '--base-w' || a === '--white-base') o.baseW = argv[++i] || '';
    else if (a === '--base-b' || a === '--black-base') o.baseB = argv[++i] || '';
    else o.files.push(a);
  }
  return o;
}

const USAGE = `用法：node cli.js 基模测试记录.xlsx [基模黑盒场景测试记录.xlsx] --list            列出大表里的模型
      node cli.js 基模测试记录.xlsx [基模黑盒场景测试记录.xlsx] --models 基线 新模型 [--title 标题] [--out 输出目录]
      node cli.js 基模测试记录.xlsx [基模黑盒场景测试记录.xlsx] --models 基准 A B [C…] [--title 标题] [--out 输出目录]   多模型：A、B、C… 各自对基准
      node cli.js 基线.xlsx 新模型.xlsx [--names 基线名 新模型名] [--title 标题] [--out 输出目录]
      node cli.js --base-w <白盒baseToken> --base-b <黑盒baseToken> --models 基线 新模型 [--title 标题] [--out 输出目录]   直接读飞书多维表格
      node cli.js --base-w <白盒baseToken> --base-b <黑盒baseToken> --list              列出多维表格里的模型
      node cli.js ... --models 新模型 --type single [--title 标题] [--out 输出目录]   单测试报告（只看一个模型的水平）
      node cli.js --templates                                       列出可用报告模板
      node cli.js --check 数字底稿.md 报告.md
      node cli.js --lock-status                                        查看计算文件指纹是否一致
      node cli.js --relock --reason "改了什么、为什么"                  确认变更并留痕（记入 compute-lock.json 的 history）`;

async function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const flagVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] || '') : ''; };

  // 计算文件指纹锁：先过闸门，包括 --check 与 --templates 在内的所有命令都不例外
  if (flag('--lock-status')) {
    const r = V.lock.check(ROOT);
    if (r.missingLock) { console.log('❌ 没有指纹清单 compute-lock.json'); process.exitCode = 1; return; }
    console.log(r.ok ? '✅ 计算/渲染/复算文件与指纹清单一致' : `❌ ${r.problems.length} 处与指纹清单不一致`);
    for (const f of V.lock.targets(ROOT)) {
      const p = r.problems.find((x) => x.file === f);
      const tag = p ? (p.status === 'unlisted' ? '＋未登记' : '❌') : '✅';
      console.log(`   ${tag} ${f}  ${String((r.lock.files || {})[f] || '').slice(0, 12)}…`);
    }
    const h = r.lock.history || [];
    if (h.length) console.log(`   最近一次变更：${h[h.length - 1].time}｜${h[h.length - 1].reason}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (flag('--relock')) {
    try {
      const nx = V.lock.relock(ROOT, flagVal('--reason'));
      const last = nx.history[nx.history.length - 1];
      console.log('✅ 已更新指纹清单 compute-lock.json');
      for (const c of last.changes) console.log(`   变更：${c.file} ${String(c.from || '（新登记）').slice(0, 12)}… → ${String(c.to).slice(0, 12)}…`);
      if (!last.changes.length) console.log('   本次没有任何文件变化，仅记录一条说明');
    } catch (e) { console.error('❌', e.message); process.exitCode = 1; }
    return;
  }
  if (!V.lock.guard(ROOT)) { process.exitCode = 1; return; }

  if (argv[0] === '--templates') {
    console.log('可用报告模板（--type）：');
    for (const t of V.templates.list()) console.log(`  ${t.id.padEnd(9)} ${t.name}｜模型数 ${t.models}｜${t.desc}`);
    return;
  }
  if (argv[0] === '--check') {
    if (argv.length < 3) { console.log(USAGE); process.exitCode = 2; return; }
    const draft = fs.readFileSync(argv[1], 'utf8'), polished = fs.readFileSync(argv[2], 'utf8');
    const bad = V.report.checkNumbers(draft, polished);
    const banned = V.report.lintReport(polished);
    if (banned.length) {
      console.log(`🚫 发现 ${banned.length} 处永久禁用语句（用户规则：这类边界声明以后一律不得出现在报告里，必须删除或改写）：`);
      for (const b of banned) console.log(`  第 ${b.line} 行［${b.rule}］：${b.text}`);
      process.exitCode = 1;
      return;
    }
    if (!bad.length) { console.log('✅ 报告中的所有数字都能在数字底稿中找到出处，且无永久禁用语句'); return; }
    console.log(`❌ 发现 ${bad.length} 个数字底稿中不存在的数字（需确认是否为非统计数字，如日期、版本号）：`);
    for (const b of bad) console.log(`  第 ${b.line} 行「${b.num}」：${b.text}`);
    process.exitCode = 1;
    return;
  }
  // 流程：参数 → 取数（多维表格 / 本地表）→ 长表解析 → 定对比组与标题 → 统计 → 落盘
  const o = parseArgs(argv);
  if (!o.files.length && !o.baseW && !o.baseB) { console.log(USAGE); process.exitCode = 2; return; }
  const T = V.templates.get(o.type);
  if (!T) { console.error(`❌ 未知报告类型「${o.type}」，可用：${V.templates.ids.join(' / ')}`); process.exitCode = 2; return; }
  const singleModel = o.type === 'single';   // 单测试报告：只要一个模型
  const fromBase = !!(o.baseW || o.baseB);
  if (fromBase && !o.baseB) console.log('⚠️  只给了白盒多维表格 --base-w，黑盒数据（--base-b）缺失，OOD 会偏少');

  const stem = (f) => path.basename(f).replace(/\.(xlsx|csv)$/i, '');
  // 取数：多维表格直读，或读本地 xlsx / csv（每本表一个 label）
  const books = [];
  if (fromBase) {
    if (listingNeeded(o, singleModel)) {
      printBaseModels(o);
      finishListing(o, singleModel);
      return;
    }
    if (!modelLimitOk(o.models)) return;
    for (const [tok, black, label] of [[o.baseW, false, '基模测试记录（多维表格）'], [o.baseB, true, '基模黑盒场景测试记录（多维表格）']]) {
      if (!tok) continue;
      try {
        const r = V.base.book(tok, o.models, black, (m) => console.log(m));
        books.push({ sheets: r.sheets, label });
      } catch (e) { console.error('❌', e.message); process.exitCode = 1; return; }
    }
  } else {
    for (const f of o.files) books.push({ sheets: await load(f), label: path.basename(f) });
  }

  let parts;
  if (books.every((b) => V.native.isNativeBook(b.sheets))) {
    // 原生大表：一个 sheet 一个模型，白盒/黑盒两本按模型名合并
    if (listingNeeded(o, singleModel)) {
      printBookModels(books);
      finishListing(o, singleModel);
      return;
    }
    if (singleModel && o.models.length !== 1) { console.error('❌ 单测试报告（--type single）只接受一个模型'); process.exitCode = 2; return; }
    if (!modelLimitOk(o.models)) return;
    const L = V.native.toLong(books, o.models);
    for (const u of L.used) console.log(`📄 ${u.model}（${u.black ? '黑盒' : '白盒'}）← ${u.label} / ${u.sheet}`);
    for (const w of L.warnings) console.log('⚠️ ', w);
    if (L.used.length < (singleModel ? 1 : 2)) { process.exitCode = 1; return; }
    parts = [{ sheets: L.sheets, label: '大表', defaultModel: '' }];
    const nm = o.models.map((x) => x.split('|')[0].trim());
    // 第一个是基准（由用户指定，不自动挑）；其余各自对基准比较，不做相互比较（规则维护）
    parts.comparisons = singleModel
      ? [{ base: nm[0], comp: nm[0], label: `${nm[0]}（单模型）` }]
      : nm.slice(1).map((c) => ({ base: nm[0], comp: c, label: `${c} vs ${nm[0]}` }));
  } else {
    parts = books.map((b, i) => ({ sheets: b.sheets, defaultModel: o.names[i] || stem(o.files[i]), label: b.label }));
  }
  const parsed = V.analyze.parseTables(parts);
  if (parts.comparisons) parsed.comparisons = parts.comparisons;
  for (const w of parsed.warnings) console.log('⚠️ ', w);
  if (parsed.errors.length) { for (const e of parsed.errors) console.error('❌', e); process.exitCode = 1; return; }
  if (singleModel && parsed.modelOrder.length !== 1) {
    console.error(`❌ 单测试报告只接受一个模型，当前识别到 ${parsed.modelOrder.length} 个（${parsed.modelOrder.join('、')}）`);
    process.exitCode = 1; return;
  }
  // 单模型没有配对对象：用自己和自己配一组，analyze 照常算水平，渲染层只取水平列
  if (singleModel && !parsed.comparisons.length) {
    const only = parsed.modelOrder[0];
    parsed.comparisons = [{ base: only, comp: only, label: `${only}（单模型）` }];
  }
  if (parsed.modelOrder.length < 2 && !singleModel) { console.error(`❌ 只识别到 ${parsed.modelOrder.length} 个模型（${parsed.modelOrder.join('、')}），至少需要两个`); process.exitCode = 1; return; }
  // 两个表、各一个模型：表 1 为基线、表 2 为新模型；否则沿用表里的「对比组」，没有则第一个模型为基线
  if (!parsed.comparisons.length) {
    const [base, ...rest] = parsed.modelOrder;
    parsed.comparisons = rest.map((comp) => ({ base, comp, label: `${comp} vs ${base}` }));
  }
  if (o.title) parsed.config.报告标题 = o.title;
  else if (singleModel) parsed.config.报告标题 = `${parsed.modelOrder[0]} 单模型测试报告`;
  else if (parsed.config.报告标题 === '模型对比评测报告') {
    const C = parsed.comparisons;
    parsed.config.报告标题 = `${C.map((c) => c.comp).reverse().join(' vs ')} vs ${C[0].base} 测试对比报告`;
  }

  const analysis = V.analyze.analyze(parsed);
  // --labels：只在渲染层换显示名；模型全名仍用于取数与复算
  if (o.labels.length) {
    const alias = {};
    parsed.modelOrder.forEach((m, i) => { if (o.labels[i]) alias[m] = o.labels[i]; });
    analysis.alias = alias;
    const L = (m) => alias[m] || m;
    if (!o.title) {
      analysis.config.报告标题 = singleModel ? `${L(parsed.modelOrder[0])} 单模型测试报告`
        : `${parsed.comparisons.map((c) => L(c.comp)).reverse().join(' vs ')} vs ${L(parsed.comparisons[0].base)} 测试对比报告`;
    }
  }
  for (const w of analysis.warnings) console.log('⚠️ ', w);
  // 绝对路径：verify.py 要按这个路径找回 _输入长表.xlsx
  const outDir = path.resolve(o.out || (fromBase ? process.cwd() : path.dirname(path.resolve(o.files[0]))));
  fs.mkdirSync(outDir, { recursive: true });
  const fileStem = String(analysis.config.报告标题).replace(/[\\/:*?"<>|]/g, '_');
  const outFile = (suffix) => path.join(outDir, fileStem + suffix);
  if (parts.comparisons) {
    // 大表抽出来的长表落盘，verify.py 读它独立复算；源 sheet 一并记录
    fs.writeFileSync(outFile('_输入长表.xlsx'), V.xlsx.writeXlsx([{ name: '执行明细', rows: parts[0].sheets.执行明细, freeze: 1 }]));
    analysis.sources = [{ file: outFile('_输入长表.xlsx'), defaultModel: '', from: fromBase ? [`bitable:${o.baseW || ''}|${o.baseB || ''}`] : o.files.map((f) => path.resolve(f)) }];
  } else analysis.sources = parts.map((p, i) => ({ file: fromBase ? 'bitable' : path.resolve(o.files[i]), defaultModel: p.defaultModel }));
  if (fromBase) analysis.baseSource = { baseW: o.baseW, baseB: o.baseB, models: o.models };
  fs.writeFileSync(outFile('_数字底稿.md'), V.templates.render(o.type, analysis));
  fs.writeFileSync(outFile('_结果.json'), JSON.stringify(analysis, null, 2));
  fs.writeFileSync(outFile('_复核表.xlsx'), V.excel.build(parsed, analysis));
  console.log(`✅ 模板：${T.name}（${o.type}）｜模型：${parsed.modelOrder.join('、')}；对比：${analysis.results.map((r) => r.label).join('；')}`);
  console.log(`   数据指纹 ${analysis.fingerprint.slice(0, 16)} · 记录 ${analysis.recordCount} · 有效 ${analysis.validCount}`);
  for (const s of ['_数字底稿.md', '_结果.json', '_复核表.xlsx', ...(parts.comparisons ? ['_输入长表.xlsx'] : [])]) console.log('  ', outFile(s));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
