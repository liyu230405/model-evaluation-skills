// 分析引擎：执行明细表 → 结构化结果（全部数字由程序计算，LLM 不参与）
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});
  const M = V.math;

  const COLS = {
    model: ['模型', 'model'],
    scope: ['场景', '场景类型', 'scope', 'ID/OOD'],
    oodType: ['OOD类型', 'OOD 类型', '白盒/黑盒', 'ood_type'],
    caseId: ['用例ID', '用例 ID', '用例编号', 'case_id'],
    caseName: ['用例名称', '用例', 'case_name'],
    skill: ['Skill', 'skill', 'Skill小类', '技能'],
    bimanual: ['双手协同', 'bimanual'],
    run: ['执行序号', '轮次', 'run'],
    score: ['得分', '分数', 'score'],
    tags: ['问题标签', '标签', 'tags'],
    valid: ['是否有效', '有效', 'valid'],
    note: ['备注', 'note'],
    ood2: ['OOD2.0', 'ood2'],
  };
  const REQUIRED = ['model', 'scope', 'caseId', 'score'];
  const DEFAULTS = { 报告标题: '模型对比评测报告', 显著性门槛: 0.1, 每用例计划执行次数: 5, 实质变化阈值: 2, 最小检验用例数: 15 };
  const TRUE_SET = new Set(['是', 'y', 'yes', 'true', '1', 'TRUE', 'Y', '√', '有效']);
  const FALSE_SET = new Set(['否', 'n', 'no', 'false', '0', 'FALSE', 'N', '×', '无效']);
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

  function findCol(header, keys) {
    const h = header.map((x) => str(x).replace(/\s+/g, '').toLowerCase());
    for (const k of keys) {
      const i = h.indexOf(k.replace(/\s+/g, '').toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  }

  function normScope(s) {
    const u = str(s).toUpperCase();
    if (u === 'ID' || u === 'IND') return 'ID';
    if (u.startsWith('OOD')) return 'OOD';
    return null;
  }
  function normOodType(s) {
    const t = str(s);
    if (!t) return '';
    if (/白/.test(t) || /white/i.test(t)) return '白盒';
    if (/黑/.test(t) || /black/i.test(t)) return '黑盒';
    return t;
  }
  function parseBool(v) {
    const s = str(v);
    if (!s) return null;
    if (TRUE_SET.has(s)) return true;
    if (FALSE_SET.has(s)) return false;
    return null;
  }
  function splitTags(v) {
    return str(v).split(/[;；,，、|/\n]+/).map((x) => x.trim()).filter((x) => x && x !== '无' && x !== '-');
  }

  // 解析工作簿 { sheetName: rows }
  // opts.defaultModel：表格没有「模型」列时（一个表 = 一个模型），用它作为模型名
  function parseWorkbook(sheets, opts) {
    opts = opts || {};
    const errors = [], warnings = [];
    const names = Object.keys(sheets);
    const pick = (cands) => names.find((n) => cands.includes(n.trim()));
    const dataName = pick(['执行明细', '数据', 'data']) || names[0];
    const rows = sheets[dataName] || [];
    const isHeader = (r) => r && r.some((c) => str(c)) && (findCol(r, COLS.model) >= 0 || (findCol(r, COLS.score) >= 0 && findCol(r, COLS.scope) >= 0));
    const hi = rows.findIndex(isHeader);
    if (hi < 0) return { errors: [`工作表「${dataName}」找不到表头（需含「场景」「得分」列）`], warnings };
    const header = rows[hi];
    const idx = {};
    for (const k of Object.keys(COLS)) idx[k] = findCol(header, COLS[k]);
    if (idx.caseId < 0 && idx.caseName >= 0) { idx.caseId = idx.caseName; warnings.push('没有「用例ID」列，改用「用例名称」对齐用例'); }
    for (const k of REQUIRED) {
      if (idx[k] >= 0 || (k === 'model' && opts.defaultModel)) continue;
      errors.push(k === 'model' ? '缺少「模型」列（一个表只含一个模型时，请在页面上填写模型名）' : `缺少必填列：${COLS[k][0]}`);
    }
    if (errors.length) return { errors, warnings };

    const records = [];
    const modelOrder = [];
    let invalidCount = 0;
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some((c) => str(c))) continue;
      const line = r + 1;
      const get = (k) => (idx[k] >= 0 ? row[idx[k]] : '');
      const model = str(get('model')) || str(opts.defaultModel);
      const scope = normScope(get('scope'));
      const caseId = str(get('caseId'));
      if (!model || !caseId) { errors.push(`第 ${line} 行：模型或用例ID为空`); continue; }
      if (!scope) { errors.push(`第 ${line} 行：场景「${str(get('scope'))}」无法识别，应为 ID 或 OOD`); continue; }
      if (!modelOrder.includes(model)) modelOrder.push(model);
      const rawScore = get('score');
      const validFlag = parseBool(get('valid'));
      let score = null;
      if (str(rawScore) !== '') {
        const n = Number(rawScore);
        if (!(n === 0 || n === 1 || n === 2)) { errors.push(`第 ${line} 行：得分「${str(rawScore)}」不是 0/1/2`); continue; }
        score = n;
      }
      const valid = score !== null && validFlag !== false;
      if (!valid) invalidCount++;
      records.push({
        line, model, scope, caseId,
        oodType: scope === 'OOD' ? normOodType(get('oodType')) : '',
        caseName: str(get('caseName')),
        skill: str(get('skill')),
        bimanual: parseBool(get('bimanual')),
        ood2: scope === 'OOD' ? parseBool(get('ood2')) : null,
        run: str(get('run')),
        score: valid ? score : null,
        tags: valid ? splitTags(get('tags')) : [],
      });
    }
    if (invalidCount) warnings.push(`有 ${invalidCount} 条执行记录无得分或标为无效，已排除在指标计算之外（计入记录数）`);

    // 同一用例在不同记录中元数据不一致时告警
    const meta = {};
    for (const rec of records) {
      const k = rec.scope + '|' + rec.caseId;
      if (!meta[k]) meta[k] = { scope: rec.scope, caseId: rec.caseId, caseName: rec.caseName, skill: rec.skill, bimanual: rec.bimanual, oodType: rec.oodType, ood2: rec.ood2 };
      else {
        const m = meta[k];
        for (const f of ['skill', 'oodType']) {
          if (rec[f] && m[f] && rec[f] !== m[f]) warnings.push(`用例 ${rec.caseId} 的 ${f === 'skill' ? 'Skill' : 'OOD类型'} 不一致（第 ${rec.line} 行「${rec[f]}」 vs「${m[f]}」），以首次出现为准`);
          if (rec[f] && !m[f]) m[f] = rec[f];
        }
        if (m.bimanual === null && rec.bimanual !== null) m.bimanual = rec.bimanual;
        // OOD 2.0 标记不一致时（某表把 3.0 新增用例也标成 id），任一记录标为非 2.0 即按 3.0 新增
        if (rec.ood2 === false && m.ood2 === true) { m.ood2 = false; if (!m._ood2warn) { m._ood2warn = 1; warnings.push(`用例 ${rec.caseId} 的 OOD2.0 标记在不同模型间不一致，按 OOD 3.0 新增处理`); } }
        if (!m.caseName && rec.caseName) m.caseName = rec.caseName;
      }
    }

    const config = Object.assign({}, DEFAULTS);
    const cfgName = pick(['报告配置', '配置', 'config']);
    if (cfgName) for (const row of sheets[cfgName]) {
      const k = str(row[0]), v = row[1];
      if (!k || k.startsWith('#') || k === '配置项') continue;
      config[k] = typeof DEFAULTS[k] === 'number' && str(v) !== '' ? Number(v) : str(v) === '' ? config[k] : v;
    }

    let comparisons = [];
    const cmpName = pick(['对比组', 'comparisons']);
    if (cmpName) {
      const cr = sheets[cmpName];
      for (let i = 1; i < cr.length; i++) {
        const b = str(cr[i][0]), c = str(cr[i][1]);
        if (!b || !c) continue;
        for (const m of [b, c]) if (!modelOrder.includes(m)) errors.push(`对比组第 ${i + 1} 行：模型「${m}」在执行明细中不存在`);
        comparisons.push({ base: b, comp: c, label: str(cr[i][2]) || `${c} vs ${b}` });
      }
    }
    if (!comparisons.length && modelOrder.length >= 2) {
      for (let i = 1; i < modelOrder.length; i++) comparisons.push({ base: modelOrder[0], comp: modelOrder[i], label: `${modelOrder[i]} vs ${modelOrder[0]}` });
      warnings.push(`未填写「对比组」，默认以首个模型「${modelOrder[0]}」为基线`);
    }
    if (!comparisons.length) errors.push('至少需要两个模型才能对比');

    let expConfig = null;
    const expName = pick(['实验配置']);
    if (expName) {
      const er = sheets[expName].filter((r) => r && r.some((c) => str(c)));
      if (er.length > 1) expConfig = { header: er[0].map(str), rows: er.slice(1).map((r) => er[0].map((_, i) => str(r[i]))) };
    }
    return { errors, warnings, records, meta, modelOrder, config, comparisons, expConfig };
  }

  // 合并多个表：parts = [{ sheets, defaultModel, label }]；同一模型出现在多个表中会报错
  function parseTables(parts) {
    const all = { errors: [], warnings: [], records: [], meta: {}, modelOrder: [], config: Object.assign({}, DEFAULTS), comparisons: [], expConfig: null };
    for (const part of parts) {
      const p = parseWorkbook(part.sheets, { defaultModel: part.defaultModel });
      const tag = (m) => `[${part.label}] ${m}`;
      all.errors.push(...p.errors.filter((e) => !e.startsWith('对比组') && e !== '至少需要两个模型才能对比').map(tag));
      all.warnings.push(...(p.warnings || []).filter((w) => !w.startsWith('未填写「对比组」')).map(tag));
      if (!p.records) continue;
      for (const m of p.modelOrder) {
        if (all.modelOrder.includes(m)) all.errors.push(tag(`模型「${m}」已在其他表中出现，请改成不同的模型名`));
        else all.modelOrder.push(m);
      }
      all.records.push(...p.records);
      for (const [k, v] of Object.entries(p.meta)) {
        const m = all.meta[k];
        if (!m) { all.meta[k] = Object.assign({}, v); continue; }
        for (const f of ['skill', 'oodType']) {
          if (v[f] && m[f] && v[f] !== m[f]) all.warnings.push(`用例 ${v.caseId} 的 ${f === 'skill' ? 'Skill' : 'OOD类型'} 在不同表中不一致（「${m[f]}」 vs「${v[f]}」），以先出现的为准`);
          if (v[f] && !m[f]) m[f] = v[f];
        }
        if (v.ood2 === false && m.ood2 === true) { m.ood2 = false; all.warnings.push(`用例 ${v.caseId} 的 OOD2.0 标记在不同表间不一致，按 OOD 3.0 新增处理`); }
        if (m.bimanual === null && v.bimanual !== null) m.bimanual = v.bimanual;
      }
      if (p.config) for (const [k, v] of Object.entries(p.config)) if (v !== DEFAULTS[k]) all.config[k] = v;
      if (!all.expConfig && p.expConfig) all.expConfig = p.expConfig;
      all.comparisons.push(...(p.comparisons || []).filter((c) => !all.comparisons.some((x) => x.base === c.base && x.comp === c.comp)));
    }
    return all;
  }

  // 单个模型、单个用例的聚合
  function caseAgg(runs) {
    const scores = runs.map((r) => r.score).filter((s) => s !== null);
    const n = scores.length;
    const c0 = scores.filter((s) => s === 0).length, c1 = scores.filter((s) => s === 1).length, c2 = scores.filter((s) => s === 2).length;
    return {
      records: runs.length, n, c0, c1, c2,
      full: n ? c2 / n : NaN, mean: n ? (c1 + 2 * c2) / n : NaN, prog: n ? (c1 + c2) / n : NaN,
      anySuccess: c2 > 0 ? 1 : 0,
    };
  }

  // 模型在某切面上的整体水平（按有效执行加权）
  function levelOf(aggs) {
    const s = (k) => aggs.reduce((t, a) => t + a[k], 0);
    const n = s('n'), c0 = s('c0'), c1 = s('c1'), c2 = s('c2');
    return {
      cases: aggs.length, records: s('records'), n, c0, c1, c2,
      full: n ? c2 / n : NaN, mean: n ? (c1 + 2 * c2) / n : NaN, prog: n ? (c1 + c2) / n : NaN, zero: n ? c0 / n : NaN,
      pass5: aggs.length ? s('anySuccess') / aggs.length : NaN,
    };
  }

  const METRICS = [
    { key: 'full', name: '满分率', pct: true },
    { key: 'mean', name: '平均分', pct: false },
    { key: 'prog', name: '有进展率', pct: true },
  ];

  // 水平口径：各模型用自己在该切面的全部有效执行（ownA/ownB）；配对检验只用两边都有的用例（cases）
  function compareSlice(cases, idx, base, comp, cfg, conf, ownA, ownB) {
    const A = cases.map((c) => idx[base][c.key]), B = cases.map((c) => idx[comp][c.key]);
    const res = { cases: cases.length, levelA: levelOf(ownA || A), levelB: levelOf(ownB || B), pairedA: levelOf(A), pairedB: levelOf(B), metrics: {}, testable: cases.length >= cfg.最小检验用例数 };
    for (const m of METRICS) {
      const t = M.pairedT(A.map((x) => x[m.key]), B.map((x) => x[m.key]), conf);
      t.weightedDiff = res.levelB[m.key] - res.levelA[m.key];
      // 展示区间：配对区间平移到执行加权差（测不满的用例不会因等权而被放大，区间中心与展示差值一致）
      if (isFinite(t.lo) && isFinite(t.hi)) { t.ciLo = t.lo + t.weightedDiff - t.meanDiff; t.ciHi = t.hi + t.weightedDiff - t.meanDiff; }
      res.metrics[m.key] = t;
    }
    res.caseDiffs = cases.map((c, i) => ({ caseId: c.caseId, caseName: c.caseName, skill: c.skill, a: A[i], b: B[i], dFull: B[i].full - A[i].full, dSucc: B[i].c2 - A[i].c2 }));
    return res;
  }

  // Skill 层面判定：实质变化 = 成功次数变化 >= 阈值
  function judgeSkill(ups, downs) {
    if (ups + downs === 0) return '噪声';
    if (ups + downs === 1) return '单点观测';
    if (ups > 0 && downs > 0) return '方向混杂';
    return ups > 0 ? '构成证据（上升）' : '构成证据（下降）';
  }

  // Skill 标签按分隔符拆成多个小类：一个用例同时带「抓取」「双手协同」时，这两个小类各计一次
  // （用户 2026-11-11 定：不再把「抓取 双手协同」当成一个独立小类）
  // 只在括号外拆：括号里的空格（如「工具操作（Tool Use）」「物品尺寸辨别(Sizing）」）属于标签本身
  function skillTags(label) {
    const src = String(label == null ? '' : label);
    const out = [];
    let buf = '', depth = 0;
    for (const ch of src) {
      if (ch === '（' || ch === '(') depth++;
      else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && ' \t\n、,，;；/'.includes(ch)) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out.length ? [...new Set(out)] : ['（未标注）'];
  }

  function skillTable(cases, idx, base, comp, cfg, field) {
    const groups = {};
    for (const c of cases) {
      if (field === 'bimanual') {
        const g = c.bimanual === true ? '双手协同' : c.bimanual === false ? '非双手协同' : '未标注';
        (groups[g] = groups[g] || []).push(c);
      } else {
        // 「双手协同」单列在 §5.3 对比，Skill 小类表里不再重复出现（用户 2026-11-12 定）
        for (const t of skillTags(c.skill)) if (t !== '双手协同') (groups[t] = groups[t] || []).push(c);
      }
    }
    // 各模型用自己在该小类的全部有效执行（用户 2026-10-26 定）；cases 传入并集，只有一边有数据的小类另一边为 NaN
    const has = (m, c) => idx[m][c.key] && idx[m][c.key].n > 0;
    return Object.entries(groups).map(([name, cs]) => {
      const A = cs.map((c) => idx[base][c.key]), B = cs.map((c) => idx[comp][c.key]);
      const la = levelOf(cs.filter((c) => has(base, c)).map((c) => idx[base][c.key])), lb = levelOf(cs.filter((c) => has(comp, c)).map((c) => idx[comp][c.key]));
      let up = 0, down = 0;
      const changes = [];
      cs.forEach((c, i) => {
        if (!has(base, c) || !has(comp, c)) return; // 实质变化只看两边都有的用例
        const d = B[i].c2 - A[i].c2;
        if (Math.abs(d) >= cfg.实质变化阈值) { d > 0 ? up++ : down++; changes.push({ caseId: c.caseId, caseName: c.caseName, from: A[i].c2, to: B[i].c2, nA: A[i].n, nB: B[i].n }); }
      });
      return { name, cases: cs.length, casesA: la.cases, casesB: lb.cases, levelA: la, levelB: lb, dMean: lb.mean - la.mean, dFull: lb.full - la.full, subUp: up, subDown: down, verdict: judgeSkill(up, down), changes };
    }).sort((x, y) => y.cases - x.cases || y.dMean - x.dMean);
  }

  // 用例级显著变化（用户 2026-11-11 定）：单用例两模型各 5 次执行做配对 t 检验
  // 显著 = p < alpha；趋势 = 未达显著，但 |Δ均分| >= 阈值且 >=4/5 次执行同向
  function caseChangeRows(cases, idx, rawIdx, base, comp, alpha, cfg) {
    const rows = [];
    const raw = (m, k) => (rawIdx[m] && rawIdx[m][k]) || [];
    const thr = Number(cfg.趋势阈值) || 0.4;
    for (const c of cases) {
      const a = idx[base][c.key], b = idx[comp][c.key];
      if (!a || !b || a.n < 2 || b.n < 2) continue;
      const ra = raw(base, c.key), rb = raw(comp, c.key);
      if (ra.length !== rb.length) continue;
      const dm = b.mean - a.mean, dfull = b.full - a.full;
      if (Math.abs(dm) < 1e-9 && Math.abs(dfull) < 1e-9) continue;
      const t = M.pairedT(ra, rb, 1 - alpha);
      const sig = isFinite(t.p) && t.p < alpha;
      const trend = !sig && Math.abs(dm) >= thr && (t.up >= 4 || t.down >= 4);
      if (!sig && !trend) continue;
      const dir = dm > 0 ? 1 : dm < 0 ? -1 : (dfull > 0 ? 1 : -1);
      rows.push({
        caseId: c.caseId, caseName: c.caseName, skill: c.skill,
        dir, dMean: dm, dFull: dfull, p: t.p, up: t.up, down: t.down,
        nA: a.n, nB: b.n, level: sig ? '显著' : '趋势',
      });
    }
    return rows.sort((x, y) => (y.level === '显著') - (x.level === '显著') || Math.abs(y.dMean) - Math.abs(x.dMean));
  }

  function tagTable(cases, idx, base, comp, records, scope) {
    const keys = new Set(cases.map((c) => c.key));
    const count = (model) => {
      const t = {};
      let n = 0;
      for (const r of records) {
        if (r.model !== model || r.score === null || !keys.has(r.scope + '|' + r.caseId)) continue;
        n++;
        for (const g of new Set(r.tags)) t[g] = (t[g] || 0) + 1;
      }
      return { t, n };
    };
    const ca = count(base), cb = count(comp);
    const names = [...new Set([...Object.keys(ca.t), ...Object.keys(cb.t)])];
    return {
      scope, nA: ca.n, nB: cb.n,
      rows: names.map((g) => {
        const a = ca.t[g] || 0, b = cb.t[g] || 0;
        const pa = ca.n ? a / ca.n : NaN, pb = cb.n ? b / cb.n : NaN;
        return { tag: g, a, b, pa, pb, d: pb - pa };
      }).sort((x, y) => Math.max(y.pa, y.pb) - Math.max(x.pa, x.pb)),
    };
  }

  function analyze(parsed) {
    const { records, meta, config: cfg, comparisons } = parsed;
    const alpha = Number(cfg.显著性门槛) || 0.1;
    const conf = 1 - alpha;
    // idx[model][scope|caseId] = 聚合
    const byModelCase = {};
    for (const r of records) {
      const k = r.scope + '|' + r.caseId;
      ((byModelCase[r.model] = byModelCase[r.model] || {})[k] = byModelCase[r.model][k] || []).push(r);
    }
    const idx = {};
    for (const m of Object.keys(byModelCase)) {
      idx[m] = {};
      for (const [k, runs] of Object.entries(byModelCase[m])) idx[m][k] = caseAgg(runs);
    }
    // 原始逐次得分（用例级配对检验用，n = 单用例执行次数）
    const rawIdx = {};
    for (const r of records) {
      if (r.score === null) continue;
      const k = r.scope + '|' + r.caseId;
      ((rawIdx[r.model] = rawIdx[r.model] || {})[k] = rawIdx[r.model][k] || []).push(r.score);
    }
    const warnings = [];
    const results = comparisons.map((cp) => {
      const { base, comp } = cp;
      const allKeys = new Set([...Object.keys(idx[base] || {}), ...Object.keys(idx[comp] || {})]);
      const shared = [], dropped = [];
      for (const k of allKeys) {
        const a = idx[base][k], b = idx[comp][k];
        if (a && b && a.n > 0 && b.n > 0) shared.push(Object.assign({ key: k }, meta[k]));
        else {
          // 只有一边有有效执行：不进配对检验，但照样计入该模型自己的水平、分布、Skill、标签（用户 2026-10-26 定）
          const only = a && a.n > 0 ? base : b && b.n > 0 ? comp : null;
          dropped.push({ key: k, caseId: meta[k].caseId, scope: meta[k].scope, only, n: only ? idx[only][k].n : 0, reason: only ? `仅 ${only} 有有效执行（${idx[only][k].n} 次）` : '两模型均无有效执行' });
        }
      }
      shared.sort((x, y) => (x.scope === y.scope ? String(x.caseId).localeCompare(String(y.caseId), 'zh', { numeric: true }) : x.scope === 'ID' ? -1 : 1));
      const plan = Number(cfg.每用例计划执行次数) || 0;
      const short = [];
      for (const c of shared) for (const m of [base, comp]) if (plan && idx[m][c.key].n !== plan) short.push(`${m} / ${c.caseId}：有效执行 ${idx[m][c.key].n} 次（计划 ${plan}）`);
      const sel = (f) => shared.filter(f);
      const slicesDef = [
        { key: 'ID', name: 'ID', main: true, f: (c) => c.scope === 'ID' },
        { key: 'OOD', name: '总OOD', main: true, f: (c) => c.scope === 'OOD' },
        { key: 'OOD2', name: 'OOD 2.0', f: (c) => c.scope === 'OOD' && c.ood2 === true },
        { key: 'OOD3N', name: 'OOD 3.0 新增', f: (c) => c.scope === 'OOD' && c.ood2 === false },
        { key: 'OOD_W', name: '白盒OOD', f: (c) => c.scope === 'OOD' && c.oodType === '白盒' },
        { key: 'OOD_B', name: '黑盒OOD', f: (c) => c.scope === 'OOD' && c.oodType === '黑盒' },
        { key: 'ID_BI', name: 'ID-双手协同', f: (c) => c.scope === 'ID' && c.bimanual === true },
        { key: 'ID_NBI', name: 'ID-非双手协同', f: (c) => c.scope === 'ID' && c.bimanual === false },
        { key: 'ALL', name: '全部', f: () => true },
      ];
      const slices = {};
      const hasOod2 = shared.some((c) => c.scope === 'OOD' && c.ood2 === true) && shared.some((c) => c.scope === 'OOD' && c.ood2 === false);
      if (hasOod2) slicesDef[1].name = 'OOD 3.0';
      for (const s of slicesDef) {
        if ((s.key === 'OOD2' || s.key === 'OOD3N') && !hasOod2) continue;
        const cs = sel(s.f);
        if (!cs.length) continue;
        const recorded = [...allKeys].filter((k) => s.f(meta[k])).length;
        const own = (m) => [...allKeys].filter((k) => meta[k] && s.f(meta[k]) && idx[m][k] && idx[m][k].n > 0).map((k) => idx[m][k]);
        slices[s.key] = Object.assign({ key: s.key, name: s.name, main: !!s.main, recorded }, compareSlice(cs, idx, base, comp, cfg, conf, own(base), own(comp)));
      }
      // 交互效应：ID 配对差值 vs OOD 配对差值（两样本 Welch t）
      let interaction = null;
      if (slices.ID && slices.OOD) {
        interaction = {};
        for (const m of METRICS) {
          const dId = slices.ID.caseDiffs.map((x) => x.b[m.key] - x.a[m.key]);
          const dOod = slices.OOD.caseDiffs.map((x) => x.b[m.key] - x.a[m.key]);
          interaction[m.key] = M.welchT(dOod, dId, conf); // (OOD差 - ID差)
        }
      }
      const idCases = sel((c) => c.scope === 'ID'), oodCases = sel((c) => c.scope === 'OOD');
      // Skill / 标签用并集：任一模型有有效执行的用例都参与，各模型只取自己的数据
      const union = [...allKeys].filter((k) => meta[k] && ((idx[base][k] && idx[base][k].n > 0) || (idx[comp][k] && idx[comp][k].n > 0))).map((k) => Object.assign({ key: k }, meta[k]));
      const uId = union.filter((c) => c.scope === 'ID'), uOod = union.filter((c) => c.scope === 'OOD');
      for (const s of Object.values(slices)) for (const m of METRICS) {
        const t = s.metrics[m.key];
        // 展示差值按执行加权，区间/p 按用例级配对；两者偏离过大（>1pp / 均分 >0.02）或方向相反时提示
        if (!isFinite(t.meanDiff) || !isFinite(t.weightedDiff)) continue;
        const tol = m.pct ? 0.01 : 0.02;
        const flip = Math.abs(t.meanDiff) >= 0.0005 && Math.abs(t.weightedDiff) >= 0.0005 && Math.sign(t.meanDiff) !== Math.sign(t.weightedDiff);
        if (Math.abs(t.meanDiff - t.weightedDiff) > tol || flip) {
          warnings.push(`[${cp.label}] ${s.name} ${m.name}：执行加权差（${t.weightedDiff.toFixed(4)}）与用例级配对均差（${t.meanDiff.toFixed(4)}）${flip ? '方向相反' : '相差超过阈值'}，部分用例有效执行缺失较多（见「执行次数与计划不符」），报告差值按执行加权，区间已平移到该差值`);
        }
      }
      return {
        label: cp.label, base, comp, sharedCount: shared.length, dropped, short, slices, interaction,
        skillsID: skillTable(uId, idx, base, comp, cfg, 'skill'),
        skillsOOD: skillTable(uOod, idx, base, comp, cfg, 'skill'),
        caseChangesID: caseChangeRows(idCases, idx, rawIdx, base, comp, alpha, cfg),
        // OOD 用例级显著（2026-11-13 用户定）：与 ID 同一套配对 t 口径，切面照报告 §4.2.1 / §4.2.2
        caseChangesOOD: caseChangeRows(oodCases, idx, rawIdx, base, comp, alpha, cfg),
        caseChangesOOD2: hasOod2 ? caseChangeRows(oodCases.filter((c) => c.ood2 === true), idx, rawIdx, base, comp, alpha, cfg) : [],
        tagsID: uId.length ? tagTable(uId, idx, base, comp, records, 'ID') : null,
        tagsOOD: uOod.length ? tagTable(uOod, idx, base, comp, records, 'OOD') : null,
      };
    });
    const fingerprint = M.sha256(JSON.stringify(records.map((r) => [r.model, r.scope, r.caseId, r.oodType, r.skill, r.bimanual, r.score, r.tags].concat(r.ood2 === true ? ['ood2'] : []))));
    return { config: cfg, alpha, conf, modelOrder: parsed.modelOrder, expConfig: parsed.expConfig, results, warnings, fingerprint, recordCount: records.length, validCount: records.filter((r) => r.score !== null).length };
  }

  V.analyze = { parseWorkbook, parseTables, analyze, METRICS, caseAgg, levelOf, judgeSkill, COLS };
})();
