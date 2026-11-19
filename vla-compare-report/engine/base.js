// 多维表格（Base）数据源：把「一个子表 = 一个模型」的飞书多维表格直接读成工作簿结构，
// 与本地 xlsx 大表完全同构（第一行表头、之后一行一个用例），交给 engine/native.js 原样解析。
// 依赖：本机能跑 lark-cli，且以用户身份有该 Base 的读权限。
(function () {
  const { execFileSync } = require('child_process');
  const V = (globalThis.VLA = globalThis.VLA || {});

  // 需要的列（与《基模测试记录》大表同名列）；表里没有的自动跳过
  const WANT = [
    '用例ID', 'prompt_ch', 'Prompt', 'Skill标签',
    'T1_分数', 'T2_分数', 'T3_分数', 'T4_分数', 'T5_分数',
    'T1_标签', 'T2_标签', 'T3_标签', 'T4_标签', 'T5_标签',
    '满分次数', '0902-ft—ood', 'ID/OOD', 'ood类型',
  ];

  function run(args) {
    let out;
    try {
      out = execFileSync('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
    } catch (e) {
      const msg = (e.stderr && e.stderr.toString()) || e.message;
      throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} 执行失败：${String(msg).slice(0, 400)}`);
    }
    const j = JSON.parse(out.toString());
    if (!j.ok) throw new Error(`多维表格接口返回失败：${JSON.stringify(j.error).slice(0, 400)}`);
    return j.data;
  }

  // 单选/多选返回数组，附件/关联/人员返回对象，统一压成字符串
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(cell).filter((s) => s !== '').join(',');
    if (typeof v === 'object') return '';
    return typeof v === 'string' ? v.replace(/\s*\n\s*/g, ' ').trim() : v;
  };

  // 允许直接贴 wiki / base 链接；wiki 节点先解析出底层 bitable 的 obj_token
  const cache = {};
  function resolve(token) {
    const t = String(token || '').trim();
    if (!/^https?:\/\//.test(t) && t.length <= 32) return t;
    if (cache[t]) return cache[t];
    const d = run(['wiki', '+node-get', '--node-token', t, '--as', 'user', '--format', 'json']);
    if (d.obj_type && d.obj_type !== 'bitable') throw new Error(`链接指向的是 ${d.obj_type}，不是多维表格：${d.title || t}`);
    return (cache[t] = d.obj_token);
  }

  // 列出 Base 里所有「可当模型表」的子表（不做记录读取，快）
  function list(baseToken, black) {
    baseToken = resolve(baseToken);
    const tables = run(['base', '+table-list', '--base-token', baseToken, '--as', 'user', '--format', 'json']).tables || [];
    return tables
      .filter((t) => !/勿动|用例|错误标签|模板/.test(t.name))
      .map((t) => ({ sheet: t.name, tableId: t.id, model: V.native.modelOfSheet(t.name), black: /黑盒/.test(t.name) || !!black, records: t.records_count }))
      .filter((t) => t.model && t.records > 0);
  }

  // 读一个子表 → [[表头...], [行...]]，与 xlsx sheet 结构一致
  function fetchSheet(baseToken, tableId, sheetName) {
    const fl = run(['base', '+field-list', '--base-token', baseToken, '--table-id', tableId, '--as', 'user', '--format', 'json']).fields || [];
    const have = new Set(fl.map((f) => f.name));
    const cols = WANT.filter((n) => have.has(n));
    if (!cols.includes('用例ID') || !cols.includes('T1_分数')) {
      return { sheet: sheetName, rows: null, skipped: '缺少「用例ID」或「T1_分数」列' };
    }
    const base = ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--as', 'user', '--format', 'json', '--limit', '200'];
    for (const c of cols) base.push('--field-id', c);
    const rows = [], header = [];
    let offset = 0;
    for (let guard = 0; guard < 200; guard++) {
      const d = run(base.concat(['--offset', String(offset)]));
      if (!header.length) header.push(...(d.fields || []));
      for (const r of d.data || []) rows.push(r.map(cell));
      if (!d.has_more || !(d.data || []).length) break;
      offset += d.data.length;
    }
    // 表头按 WANT 顺序重排，保证列序稳定（与 xlsx 版本一致）
    const idx = cols.map((c) => header.indexOf(c));
    const head = cols.slice();
    const body = rows.map((r) => idx.map((i) => (i >= 0 ? r[i] : '')));
    for (const r of body) while (r.length < head.length) r.push('');
    return { sheet: sheetName, rows: [head, ...body] };
  }

  // 读整本 Base → { 子表名: rows }；pick 为空则全部
  function book(baseToken, pick, black, log) {
    const all = list(baseToken, black);
    const sheets = {}, used = [];
    let cands = all;
    if (pick && pick.length) {
      const names = new Set();
      for (const p of pick) for (const n of p.split('|').map((s) => s.trim()).filter(Boolean)) names.add(n);
      cands = all.filter((t) => names.has(t.model));
    }
    for (const t of cands) {
      const got = fetchSheet(baseToken, t.tableId, t.sheet);
      if (!got.rows) { if (log) log(`⚠️  子表「${t.sheet}」${got.skipped}，已跳过`); continue; }
      sheets[t.sheet] = got.rows;
      used.push(t);
      if (log) log(`📥 读取「${t.sheet}」${got.rows.length - 1} 条用例`);
    }
    return { sheets, used };
  }

  V.base = { list, book, fetchSheet, resolve, WANT };
  if (typeof module !== 'undefined' && module.exports) module.exports = V.base;
})();
