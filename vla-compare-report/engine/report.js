// 报告生成：结构化结果 → Markdown。所有数字只从 analyze 结果格式化，不做任何新计算。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});

  const fin = (x) => typeof x === 'number' && isFinite(x);
  // 差值 = 两边先按展示精度舍入（百分比 0.1%、均分 0.01）再相减（2026-11-02 用户定，取代 10-22「原始值相减再舍入」：
  // 读者拿表里两个数相减必须对得上，如 71.2% → 71.5% 写 +0.3pp 而不是 +0.4pp）
  // 舍入加 1e-9 防浮点误差（如 0.0235 → 2.4pp）；舍入后为 0 不带正负号
  const rnd = (x, k) => Math.round(Math.abs(x) * k + 1e-9) / k;
  const sg = (x, k) => (rnd(x, k) === 0 ? '' : x > 0 ? '+' : '-');
  const pct = (x) => (fin(x) ? (rnd(x, 1000) * 100).toFixed(1) + '%' : '—');
  const ppn = (x) => (fin(x) ? sg(x, 1000) + (rnd(x, 1000) * 100).toFixed(1) : '—');
  const pp = (x) => (fin(x) ? ppn(x) + 'pp' : '—');
  const sc = (x) => (fin(x) ? rnd(x, 100).toFixed(2) : '—');
  const scd = (x) => (fin(x) ? sg(x, 100) + rnd(x, 100).toFixed(2) : '—');
  const pv = (p) => (fin(p) ? (p < 0.001 ? '<0.001' : p.toFixed(p < 0.1 ? 3 : 2)) : '—');
  const isPct = (k) => k !== 'mean';
  const rs = (x, k) => Math.sign(x) * rnd(x, k);
  const dP = (a, b) => (fin(a) && fin(b) ? (Math.round(rs(b, 1000) * 1000) - Math.round(rs(a, 1000) * 1000)) / 1000 : NaN);
  const dS = (a, b) => (fin(a) && fin(b) ? (Math.round(rs(b, 100) * 100) - Math.round(rs(a, 100) * 100)) / 100 : NaN);
  const dL = (k, a, b) => (isPct(k) ? dP(a, b) : dS(a, b));
  const fmtD = (k, x) => (isPct(k) ? pp(x) : scd(x));
  const fmtL = (k, x) => (isPct(k) ? pct(x) : sc(x));
  // 区间 = 配对 t 区间平移到展示差值（中心 = 直接相减的差值，宽度与 p 仍按用例级配对）
  // d 给出时区间再平移到展示差值（中心 = 舍入后相减的差值）
  const fmtCI = (k, t, d) => {
    if (!fin(t.ciLo)) return '—';
    const sh = fin(d) && fin(t.weightedDiff) ? d - t.weightedDiff : 0, lo = t.ciLo + sh, hi = t.ciHi + sh;
    return isPct(k) ? `[${ppn(lo)}, ${ppn(hi)}]pp` : `[${scd(lo)}, ${scd(hi)}]`;
  };
  // 方向计数不再写进底稿/报告（2026-10-16 老板反馈可读性差），只留给网页核验页展示
  const dirCount = (t) => `${t.up} 升 / ${t.down} 降 / ${t.flat} 平`;
  const NAMES = { full: '满分率', mean: '平均分', prog: '有进展率' };
  // 实验配置对比固定 11 行（用户 2026-10-15 定），顺序不可改
  const EXP_ROWS = ['训练步数', 'Pre Train 数据量', '数据类型', '训练卡数', '坐标系', '代码版本', '开训 Checkpoint', 'finetune步数', 'finetune分支', '真机测试推理分支', '真机测试镜像时间'];

  // 展示差值 = 两边原始水平直接相减后舍入；区间以该差值为中心，宽度与 p 为用例级配对 t

  // 结论判词：完全由规则决定（显著性门槛、区间、方向计数、用例数）
  function verdict(t, alpha, testable, d) {
    if (!testable) return `用例数 ${t.n} < 15，仅报点估计，不做显著性判定`;
    if (!fin(t.p)) return '无法检验';
    const dir = d > 0 ? '提升' : '退步';
    if (t.p < alpha) return `达到显著（p<${alpha}），方向为${dir}`;
    if (Math.abs(d) < 1e-9) return '点估计约为 0，区间跨 0';
    const same = d > 0 ? t.up : t.down, opp = d > 0 ? t.down : t.up;
    if (same < 1.5 * Math.max(opp, 1)) return '方向混杂，未达统计学显著';
    return `略有${d > 0 ? '上升' : '下降'}，但未达统计学显著`;
  }

  function metricLine(slice, k, alpha) {
    const t = slice.metrics[k];
    const a = slice.levelA[k], b = slice.levelB[k];
    const head = `${slice.name} ${NAMES[k]} ${fmtL(k, a)} → ${fmtL(k, b)}`;
    const d = dL(k, a, b);
    if (!slice.testable) return `${head}（${fmtD(k, d)}）。${verdict(t, alpha, false, d)}。`;
    return `${head}（${fmtD(k, d)}，${Math.round((1 - alpha) * 100)}% 区间 ${fmtCI(k, t, d)}，p=${pv(t.p)}）。${verdict(t, alpha, true, d)}。`;
  }

  // 核心结论句式（用户 2026-10-20 定）：指标从〈旧模型〉水平 →〈新模型〉水平（差值，p=），再说上升/下降与是否显著。
  // 不写 90% 区间；不显著统一「略有上升/下降，但未达统计学显著」，不写「方向混杂」。
  function coreSentence(res, slice, k, alpha) {
    const t = slice.metrics[k];
    const a = slice.levelA[k], b = slice.levelB[k];
    const d = dL(k, a, b);
    const head = `${NAMES[k]}从${res.base} ${fmtL(k, a)} → ${res.comp} ${fmtL(k, b)}`;
    if (!slice.testable) return `${head}（${fmtD(k, d)}），用例数 ${t.n} < 15，仅报点估计`;
    const body = `${head}（${fmtD(k, d)}，p=${pv(t.p)}）`;
    if (rnd(d, isPct(k) ? 1000 : 100) === 0) return `${body}，持平，未达统计学显著`;
    const dir = d > 0 ? '上升' : '下降';
    if (fin(t.p) && t.p < alpha) return `${body}，${dir}，达到统计学显著`;
    return `${body}，略有${dir}，但未达统计学显著`;
  }

  function table(head, rows) {
    return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  }

  // 显著行按历史报告范式加粗（不再用颜色：飞书文档导入会丢掉 span 颜色，加粗才留得住）
  const bd = (txt, on) => (on ? `**${txt}**` : txt);

  function metricTable(res, slice, alpha) {
    const ci = Math.round((1 - alpha) * 100);
    const rows = ['full', 'mean', 'prog'].map((k) => {
      const t = slice.metrics[k];
      return [NAMES[k], fmtL(k, slice.levelA[k]), fmtL(k, slice.levelB[k]), fmtD(k, dL(k, slice.levelA[k], slice.levelB[k])),
        slice.testable ? fmtCI(k, t, dL(k, slice.levelA[k], slice.levelB[k])) : '—', slice.testable ? pv(t.p) : '—'];
    });
    rows.push(['pass@5', pct(slice.levelA.pass5), pct(slice.levelB.pass5), pp(dP(slice.levelA.pass5, slice.levelB.pass5)), '—', '—']);
    // 不再列 0 分占比（用户 2026-10-20 定）
    return table(['指标', res.base, res.comp, `差值（${res.comp}−${res.base}）`, `${ci}% 区间`, 'p 值'], rows);
  }

  function distTable(res, slice) {
    const r = (name, L) => [name, String(L.n), `${L.c0}（${pct(L.c0 / L.n)}）`, `${L.c1}（${pct(L.c1 / L.n)}）`, `${L.c2}（${pct(L.c2 / L.n)}）`];
    const A = slice.levelA, B = slice.levelB;
    const d = ['差值', '—', pp(dP(A.c0 / A.n, B.c0 / B.n)), pp(dP(A.c1 / A.n, B.c1 / B.n)), pp(dP(A.c2 / A.n, B.c2 / B.n))];
    return table(['模型', '有效执行', '0 分', '1 分', '2 分'], [r(res.base, A), r(res.comp, B), d]);
  }

  // 5、6 节差值列不着色、不加粗（照历史报告范式：只有 §4 的显著行加粗）

  function skillSection(res, skills, scopeName) {
    // 按均分差值降序，并列时按满分率差值降序；不再列「实质变化」「判定」两列（用户 2026-10-19 定）
    const rs = skills.map((s) => ({ s, dm: dS(s.levelA.mean, s.levelB.mean), df: dP(s.levelA.full, s.levelB.full) }))
      .sort((x, y) => (fin(x.dm) ? 0 : 1) - (fin(y.dm) ? 0 : 1) || (fin(x.dm) && fin(y.dm) ? y.dm - x.dm || y.df - x.df : 0) || y.s.cases - x.s.cases);
    // 第 5 节均分差值、满分率差值都着色（照 CT 报告定稿，用户 2026-10-22 定，取代 10-20 只着色满分率）
    // 两模型在该小类的用例数不同（某用例只有一边测了）时写「基线 / 新模型」
    const nCase = (s) => (s.casesA === undefined || (s.casesA === s.cases && s.casesB === s.cases) ? String(s.cases) : `${s.casesA} / ${s.casesB}`);
    const rows = rs.map(({ s, dm, df }) => [s.name, nCase(s), sc(s.levelA.mean), sc(s.levelB.mean), scd(dm),
      pct(s.levelA.full), pct(s.levelB.full), pp(df)]);
    const head = ['Skill 小类', skills.some((s) => s.casesA !== undefined && (s.casesA !== s.cases || s.casesB !== s.cases)) ? `用例数（${res.base} / ${res.comp}）` : '用例数', `${res.base} 均分`, `${res.comp} 均分`, '均分差值', `${res.base} 满分率`, `${res.comp} 满分率`, '满分率差值'];
    // 表下不再列构成证据 / 单点观测 / 方向混杂说明行（用户 2026-10-22 定，判定仍留在 _结果.json）
    return table(head, rows);
  }

  // 4.1 下的「显著变化用例」板块（用户 2026-11-11 定）：判定显著/趋势，归因列留空由人工填写
  // Skill 列把多标签拆开显示：「装配（Assembly） 双手协同 精细操作」→「装配（Assembly）、双手协同、精细操作」
  function skillLabel(raw) {
    const src = String(raw == null ? '' : raw);
    const out = [];
    let buf = '', depth = 0;
    for (const ch of src) {
      if (ch === '（' || ch === '(') depth++;
      else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && ' \t\n、,，;；|/'.includes(ch)) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out.length ? out.join('、') : '（未标注）';
  }

  function caseChangeBlock(res, alpha, rowsIn) {
    const rows = rowsIn || res.caseChangesID || [];
    // 表列带用例ID（用户 2026-11-13 定）：prompt 之外要能直接查到 FT-xx-x，便于回表核对
    const head = ['用例ID', '用例（prompt）', 'Skill', '判定', '均分差值', '满分率差值', 'p 值', '归因'];
    if (!rows.length) return table(head, [['—', '—', '—', '—', '—', '—', '—', ' ']]);
    return table(head, rows.map((c) => [c.caseId, c.caseName || c.caseId, skillLabel(c.skill),
      `${c.level}${c.dir > 0 ? '变好' : '变差'}`, scd(c.dMean), pp(c.dFull), pv(c.p), ' ']));
  }

  function tagSection(res, tg) {
    const rows = tg.rows.map((r) => ({ r, d: dP(r.pa, r.pb) })).sort((x, y) => y.d - x.d || (y.r.a + y.r.b) - (x.r.a + x.r.b))
      .map(({ r, d }) => [r.tag, String(r.a), String(r.b), pct(r.pa), pct(r.pb), pp(d)]);
    return table(['问题标签', `${res.base} 次数`, `${res.comp} 次数`, `${res.base} 占比`, `${res.comp} 占比`, '差值'], rows);
  }

  function comparisonSection(res, A, no) {
    const alpha = A.alpha, ci = Math.round((1 - alpha) * 100);
    const S = res.slices, out = [];
    out.push(`## ${res.label}\n`);
    out.push(`基线：${res.base}；对比：${res.comp}；差值一律为「${res.comp} − ${res.base}」。交集用例 ${res.sharedCount} 个。`);
    if (res.dropped.length) out.push(`\n> ⚠️ 以下用例只有一个模型有有效执行，不参与配对检验（p 值、区间），水平、分布、Skill、标签按各模型自己的数据计入：${res.dropped.map((d) => `${d.caseId}（${d.reason}）`).join('；')}`);
    if (res.short.length) out.push(`\n> ⚠️ 执行次数与计划不符：${res.short.join('；')}`);

    out.push(`\n### 核心指标（主结论切面）\n`);
    for (const key of ['ID', 'OOD', 'OOD2']) {
      const s = S[key];
      if (!s) continue;
      out.push(`**${s.name}**（${s.cases} 个用例；有效执行 ${res.base} ${s.levelA.n} 次 / ${res.comp} ${s.levelB.n} 次）\n`);
      out.push(metricTable(res, s, alpha));
      out.push('');
      out.push(distTable(res, s));
      out.push('');
      if (key === 'ID') {
        out.push(`#### 显著变化用例（ID）\n`);
        out.push(caseChangeBlock(res, alpha));
        out.push('');
      }
    }

    if (S.ID && S.OOD) {
      out.push(`### ID 与 OOD 落差\n`);
      const r = (name, la, lb) => [name, pct(la.full), pct(lb.full), pp(dP(la.full, lb.full)), sc(la.mean), sc(lb.mean), scd(dS(la.mean, lb.mean))];
      out.push(table(['模型', 'ID 满分率', `${S.OOD.name} 满分率`, 'OOD - ID', 'ID 平均分', `${S.OOD.name} 平均分`, 'OOD - ID'],
        [r(res.base, S.ID.levelA, S.OOD.levelA), r(res.comp, S.ID.levelB, S.OOD.levelB)]));
      // 不再写单模型落差说明与交互检验段（用户 2026-10-22 定，交互结果仍留在 _结果.json）
      out.push('');
    }

    // 不做 ID/OOD 子切面探索（用户 2026-10-22 定），只保留双手协同
    const sub = ['ID_NBI', 'ID_BI'].filter((k) => S[k]);
    if (sub.length) {
      out.push(`### 双手协同对比（ID）\n`);
      const rows = sub.map((k) => {
        const s = S[k], t = s.metrics.full, tm = s.metrics.mean;
        return [s.name.replace(/^ID-/, ''), String(s.cases), pct(s.levelA.full), pct(s.levelB.full), pp(dP(s.levelA.full, s.levelB.full)), s.testable ? fmtCI('full', t, dP(s.levelA.full, s.levelB.full)) : '—', s.testable ? pv(t.p) : '—', scd(dS(s.levelA.mean, s.levelB.mean)), s.testable ? pv(tm.p) : '—'];
      });
      out.push(table(['切面', '用例数', `${res.base} 满分率`, `${res.comp} 满分率`, '满分率差值', `${ci}% 区间`, 'p', '均分差值', '均分 p'], rows));
      out.push('');
    }

    let n = 4;
    if (res.skillsID.length) { out.push(`### Skill 小类对比（ID）\n`); out.push(skillSection(res, res.skillsID, 'ID')); out.push(''); }
    if (res.skillsOOD.length) { out.push(`### Skill 小类对比（OOD）\n`); out.push(skillSection(res, res.skillsOOD, 'OOD')); out.push(''); }
    if (res.tagsID && res.tagsID.rows.length) { out.push(`### 问题标签分布（ID）\n`); out.push(tagSection(res, res.tagsID)); out.push(''); }
    if (res.tagsOOD && res.tagsOOD.rows.length) { out.push(`### 问题标签分布（OOD）\n`); out.push(tagSection(res, res.tagsOOD)); out.push(''); }
    return out.join('\n');
  }

  // 单组对比版式（照 CT 报告定稿，用户 2026-10-22 定）：4 核心指标 / 5 能力维度 / 6 问题标签，无第 7 节
  function singleSections(res, A) {
    const alpha = A.alpha, ci = Math.round((1 - alpha) * 100), S = res.slices, out = [];
    if (res.dropped.length) out.push(`> 以下用例只有一个模型有有效执行，不参与配对检验（p 值、区间），水平、分布、Skill、标签按各模型自己的数据计入：${res.dropped.map((d) => `${d.caseId}（${d.reason}）`).join('；')}\n`);
    if (res.short.length) out.push(`> 执行次数与计划不符：${res.short.join('；')}\n`);
    out.push(`## 核心指标对比\n`);
    const block = (s) => { out.push(metricTable(res, s, alpha)); out.push(''); out.push(distTable(res, s)); out.push(''); };
    if (S.ID) { out.push(`### ID 场景核心指标对比\n`); block(S.ID); out.push(`#### 显著变化用例（ID）\n`); out.push(caseChangeBlock(res, alpha)); out.push(''); }
    if (S.OOD || S.OOD2) {
      out.push(`### OOD 场景核心指标对比\n`);
      const nc = (s) => (s.levelA.cases === s.levelB.cases ? `${s.levelB.cases} 用例` : `${res.comp} ${s.levelB.cases} / ${res.base} ${s.levelA.cases} 用例`);
      for (const s of [S.OOD, S.OOD2]) if (s) {
        out.push(`**${s.name}（${nc(s)}）**\n`); block(s);
        // OOD 用例级显著（2026-11-13 用户定，口径同 ID）：实证指回用例本身
        const rows = s.key === 'OOD2' ? res.caseChangesOOD2 : res.caseChangesOOD;
        if (rows) { out.push(`#### 显著变化用例（${s.name}）\n`); out.push(caseChangeBlock(res, alpha, rows)); out.push(''); }
      }
    }
    if (S.ID && S.OOD) {
      out.push(`### ID vs OOD 落差对比\n`);
      const r = (name, la, lb) => [name, pct(la.full), pct(lb.full), pp(dP(la.full, lb.full)), sc(la.mean), sc(lb.mean), scd(dS(la.mean, lb.mean))];
      out.push(table(['模型', 'ID 满分率', `${S.OOD.name} 满分率`, 'OOD - ID', 'ID 平均分', `${S.OOD.name} 平均分`, 'OOD - ID'],
        [r(res.base, S.ID.levelA, S.OOD.levelA), r(res.comp, S.ID.levelB, S.OOD.levelB)]));
      out.push('');
    }
    out.push(`## 能力维度\n`);
    let n = 1;
    if (res.skillsID.length) { out.push(`### Skill 小类对比（ID）\n`); out.push(skillSection(res, res.skillsID)); out.push(''); }
    if (res.skillsOOD.length) { const o = S.OOD; out.push(`### Skill 小类对比（${o ? `${o.name}，${o.levelA.cases === o.levelB.cases ? o.levelB.cases : `${res.comp} ${o.levelB.cases} / ${res.base} ${o.levelA.cases}`} 用例` : 'OOD'}）\n`); out.push(skillSection(res, res.skillsOOD)); out.push(''); }
    const sub = ['ID_NBI', 'ID_BI'].filter((k) => S[k]);
    if (sub.length) {
      out.push(`### 双手协同对比（ID）\n`);
      const rows = sub.map((k) => {
        const s = S[k], t = s.metrics.full, tm = s.metrics.mean;
        return [s.name.replace(/^ID-/, ''), String(s.cases), pct(s.levelA.full), pct(s.levelB.full), pp(dP(s.levelA.full, s.levelB.full)), s.testable ? fmtCI('full', t, dP(s.levelA.full, s.levelB.full)) : '—', s.testable ? pv(t.p) : '—', scd(dS(s.levelA.mean, s.levelB.mean)), s.testable ? pv(tm.p) : '—'];
      });
      out.push(table(['切面', '用例数', `${res.base} 满分率`, `${res.comp} 满分率`, '满分率差值', `${ci}% 区间`, 'p', '均分差值', '均分 p'], rows));
      out.push('');
    }
    out.push(`## 问题标签\n`);
    n = 1;
    if (res.tagsID && res.tagsID.rows.length) { out.push(`### ID 场景标签占比对比\n`); out.push(tagSection(res, res.tagsID)); out.push(''); }
    if (res.tagsOOD && res.tagsOOD.rows.length) { out.push(`### ${S.OOD ? S.OOD.name : 'OOD'} 场景标签占比对比\n`); out.push(tagSection(res, res.tagsOOD)); out.push(''); }
    return out.join('\n');
  }

  // 顶部 callout 的核心结论句：方向上取自各切面差值符号，显著性取自 p 与 alpha，全程不写数字
  function autoConclusion(A) {
    const seg = [], sig = [];
    for (const key of ['ID', 'OOD']) {
      const s = A.results[0] && A.results[0].slices[key];
      if (!s) continue;
      const dm = dS(s.levelA.mean, s.levelB.mean), df = dP(s.levelA.full, s.levelB.full);
      seg.push(`${s.name} ${dm > 0 && df > 0 ? '略有上升' : dm < 0 && df < 0 ? '略有下降' : '涨跌互现'}`);
      for (const k of ['full', 'mean', 'prog']) if (fin(s.metrics[k].p) && s.metrics[k].p < A.alpha) sig.push(`${s.name} ${NAMES[k]}`);
    }
    if (!seg.length) return '';
    return `${seg.join('、')}，${sig.length ? `其中 ${sig.join('、')}达统计显著。` : '各指标变化均未达统计显著。'}`;
  }

  // 核心结论一组对比的一块：每个切面一条（三指标平级，句式见 coreSentence，用户 2026-10-20 定）+ Skill 一条
  // 定稿句式（照 2026-11 四份报告）：模型名只出现在句首，指标只写数值，判词统一收在句尾
  function blockSentence(slice, alpha) {
    const items = ['full', 'mean', 'prog'].map((k) => {
      const t = slice.metrics[k], a = slice.levelA[k], b = slice.levelB[k], d = dL(k, a, b);
      return slice.testable ? `${NAMES[k]}从 ${fmtL(k, a)} → ${fmtL(k, b)}（${fmtD(k, d)}，p=${pv(t.p)}）`
        : `${NAMES[k]}从 ${fmtL(k, a)} → ${fmtL(k, b)}（${fmtD(k, d)}）`;
    });
    const dm = dS(slice.levelA.mean, slice.levelB.mean), df = dP(slice.levelA.full, slice.levelB.full);
    const dir = dm > 0 && df > 0 ? '均略有上升' : dm < 0 && df < 0 ? '均略有下降' : '涨跌互现';
    if (!slice.testable) return `${items.join('；')}，用例数 ${slice.metrics.full.n} < 15，仅报点估计。`;
    const sigK = ['full', 'mean', 'prog'].filter((k) => fin(slice.metrics[k].p) && slice.metrics[k].p < alpha);
    return `${items.join('；')}，${dir}，${sigK.length ? `其中${sigK.map((k) => NAMES[k]).join('、')}达统计显著` : '但未达统计显著'}。`;
  }

  function coreBlock(res, alpha) {
    const out = [`**${res.base} → ${res.comp}**\n`];
    for (const key of ['ID', 'OOD', 'OOD2']) {
      const s = res.slices[key];
      if (!s) continue;
      out.push(`- **${s.name}**：${blockSentence(s, alpha)}`);
    }
    out.push('');
    return out.join('\n');
  }

  // 统计说明方法段：措辞按用户 2026-10-19 给定的原文，两模型、三模型版式共用
  function methodBlock(A) {
    const cfg = A.config, alpha = A.alpha, ci = Math.round((1 - alpha) * 100);
    return [
      `平均分、满分率（分数=2）和有进展率（分数>0）按有效执行计算。p<${alpha.toFixed(2)} 为统计显著（真机评测样本量受成本限制，0.05 过严），置信区间取 ${ci}% 与门槛配套。\n`,
      `检验方法为用例级配对 t 检验（双侧）——每个用例先聚合 5 次执行的指标值，再对两模型的用例差值做检验，n 取用例数而非执行数（同一用例的多次执行不是独立重复）。详细方法解读见预训练真机评测显著性分析口径\n`,
      `Skill 小类按标签拆分统计：一个用例同时带多个标签时，在各小类分别计入一次，因此能力维度各行用例数之和大于用例总数。\n`,
    ].join('\n');
  }

  function render(A) {
    if (isThree(A)) return render3(A);
    const cfg = A.config, alpha = A.alpha, ci = Math.round((1 - alpha) * 100);
    const out = [];
    out.push(`# ${cfg.报告标题}\n`);
    out.push(`<callout emoji="🌟">\n**核心结论：${cfg.核心结论补充 || autoConclusion(A)}**\n</callout>\n`);
    out.push(`## 结论\n`);
    for (const res of A.results) out.push(coreBlock(res, alpha));

    out.push(`## 统计说明\n`);
    if (cfg.测试背景) out.push(`${cfg.测试背景}\n`);
    out.push(methodBlock(A));
    const r0 = A.results[0];
    if (r0) {
      const rows = [];
      for (const [n, k] of [['ID', 'ID'], ['OOD 2.0', 'OOD2'], [r0.slices.OOD ? r0.slices.OOD.name : 'OOD', 'OOD'], ['全部', 'ALL']]) {
        const s = r0.slices[k];
        if (s) rows.push([n, String(s.recorded), s.levelA.cases === s.levelB.cases ? String(s.levelB.cases) : `${s.levelB.cases} / ${s.levelA.cases}`, `${s.levelB.n} / ${s.levelA.n}`]);
      }
      out.push(table(['范围', '记录用例数', `有效用例数（${r0.comp} / ${r0.base}）`, `有效执行数（${r0.comp} / ${r0.base}）`], rows));
      out.push('');
    }

    // 用户规则：表头固定 11 行，内容一律空置（由人工在交付后填写），不读表格里的实验配置
    out.push(`## 测试配置对比\n`);
    const modelsInCmp = [];
    for (const r of A.results) for (const m of [r.base, r.comp]) if (!modelsInCmp.includes(m)) modelsInCmp.push(m);
    out.push(table(['配置项', ...modelsInCmp], EXP_ROWS.map((k) => [k, ...modelsInCmp.map(() => ' ')])));
    if (cfg.核心差异) out.push(`\n核心差异：${cfg.核心差异}`);
    out.push('');
    if (A.results.length === 1) out.push(singleSections(A.results[0], A));
    else A.results.forEach((res, i) => out.push(comparisonSection(res, A, i + 4)));
    return out.join('\n');
  }

  // ===== 三模型版式（用户 2026-10-22 定）：用户指定一个基准，A、B 各自对基准比较 =====
  // 只有「A vs 基准」「B vs 基准」两组对比，任何一节都不写 A vs B 互比；基准不自动挑，由 cli --models 第一个决定。
  // 数字来源与两模型版式完全相同（同一套 analyze 结果），只是把两组对比并排组织：
  // 标签表、0/1/2 分布、ID-OOD 落差表三模型并列；基准在两组里的水平不一致（交集用例不同）时退回逐组列表。
  const isThree = (A) => A.results.length === 2 && A.results[0].base === A.results[1].base;
  const sameLevel = (x, y) => !!x && !!y && ['n', 'c0', 'c1', 'c2'].every((f) => x[f] === y[f]);
  const sameTags = (t1, t2) => !!t1 && !!t2 && t1.nA === t2.nA && t1.rows.every((r) => (t2.rows.find((x) => x.tag === r.tag) || { a: 0 }).a === r.a)
    && t2.rows.every((r) => (t1.rows.find((x) => x.tag === r.tag) || { a: 0 }).a === r.a);

  function render3(A) {
    const cfg = A.config, alpha = A.alpha, ci = Math.round((1 - alpha) * 100);
    const R = A.results, base = R[0].base, models = [base, R[0].comp, R[1].comp];
    const oodName = (R[0].slices.OOD || R[1].slices.OOD || { name: 'OOD' }).name;
    const out = [];
    out.push(`# ${cfg.报告标题}\n`);

    out.push(`<callout emoji="🌟">\n**核心结论：${cfg.核心结论补充 || autoConclusion(A)}**\n</callout>\n`);
    out.push(`## 结论\n`);
    out.push(`基准模型：${base}；${R[0].comp}、${R[1].comp} 分别与 ${base} 比较，共两组对比。\n`);
    for (const res of R) out.push(coreBlock(res, alpha));

    out.push(`## 统计说明\n`);
    if (cfg.测试背景) out.push(`${cfg.测试背景}\n`);
    out.push(methodBlock(A));
    {
      const rows = [];
      for (const [n, k] of [['ID', 'ID'], ['OOD 2.0', 'OOD2'], [oodName, 'OOD'], ['全部', 'ALL']]) {
        const s0 = R[0].slices[k], s1 = R[1].slices[k];
        if (!s0 && !s1) continue;
        const rec = s0 && s1 && s0.recorded === s1.recorded ? String(s0.recorded) : R.map((r) => (r.slices[k] ? String(r.slices[k].recorded) : '—')).join(' / ');
        rows.push([n, rec, ...R.map((r) => { const s = r.slices[k]; return s ? `${s.cases} / ${s.levelB.n} / ${s.levelA.n}` : '—'; })]);
      }
      out.push(table(['范围', '记录用例数', ...R.map((r) => `${r.comp} vs ${r.base}（有效用例数 / ${r.comp} / ${r.base} 有效执行数）`)], rows));
      out.push('');
    }
    for (const res of R) {
      if (res.dropped.length) out.push(`> [${res.label}] 以下用例只有一个模型有有效执行，不参与配对检验（p 值、区间），水平、分布、Skill、标签按各模型自己的数据计入：${res.dropped.map((d) => `${d.caseId}（${d.reason}）`).join('；')}\n`);
      if (res.short.length) out.push(`> [${res.label}] 执行次数与计划不符：${res.short.join('；')}\n`);
    }

    // 第 3 节固定 11 行、内容空置（用户 2026-10-15 定），列顺序：基准、A、B
    out.push(`## 测试配置对比\n`);
    out.push(table(['配置项', ...models], EXP_ROWS.map((k) => [k, ...models.map(() => ' ')])));
    if (cfg.核心差异) out.push(`\n核心差异：${cfg.核心差异}`);
    out.push('');

    out.push(`## 核心指标对比\n`);
    out.push(`差值一律为「对比模型 − ${base}」。\n`);
    const sliceBlock = (key, h) => {
      const o = [];
      const ss = R.map((r) => r.slices[key]);
      if (!ss.some(Boolean)) return o;
      if (h) o.push(`${h}\n`);
      R.forEach((res, i) => {
        const s = ss[i];
        if (!s) return;
        o.push(`**${res.label}**（${s.cases} 个用例；有效执行 ${res.base} ${s.levelA.n} 次 / ${res.comp} ${s.levelB.n} 次）\n`);
        o.push(metricTable(res, s, alpha));
        o.push('');
      });
      if (ss[0] && ss[1] && sameLevel(ss[0].levelA, ss[1].levelA)) {
        const r = (name, L) => [name, String(L.n), `${L.c0}（${pct(L.c0 / L.n)}）`, `${L.c1}（${pct(L.c1 / L.n)}）`, `${L.c2}（${pct(L.c2 / L.n)}）`];
        const d = (res, s) => [`差值（${res.comp}−${res.base}）`, '—', ...['c0', 'c1', 'c2'].map((c) => pp(dP(s.levelA[c] / s.levelA.n, s.levelB[c] / s.levelB.n)))];
        o.push(table(['模型', '有效执行', '0 分', '1 分', '2 分'], [r(base, ss[0].levelA), r(R[0].comp, ss[0].levelB), r(R[1].comp, ss[1].levelB), d(R[0], ss[0]), d(R[1], ss[1])]));
      } else {
        R.forEach((res, i) => { if (ss[i]) { o.push(`**${res.base} → ${res.comp}**\n`); o.push(distTable(res, ss[i])); o.push(''); } });
      }
      o.push('');
      return o;
    };
    out.push(`### ID 场景核心指标对比\n`);
    out.push(...sliceBlock('ID'));
    R.forEach((res) => {
      out.push(`#### 显著变化用例（ID）｜${res.label}\n`);
      out.push(caseChangeBlock(res, alpha));
      out.push('');
    });
    out.push(`### OOD 场景核心指标对比\n`);
    out.push(...sliceBlock('OOD', `#### ${oodName}`));
    out.push(...sliceBlock('OOD2', `#### OOD 2.0`));
    // 不做 OOD 子切面探索（用户 2026-10-22 定）

    if (R.every((r) => r.slices.ID && r.slices.OOD)) {
      out.push(`### ID vs OOD 落差对比\n`);
      const r = (name, la, lb) => [name, pct(la.full), pct(lb.full), pp(dP(la.full, lb.full)), sc(la.mean), sc(lb.mean), scd(dS(la.mean, lb.mean))];
      const S0 = R[0].slices, S1 = R[1].slices;
      const baseSame = sameLevel(S0.ID.levelA, S1.ID.levelA) && sameLevel(S0.OOD.levelA, S1.OOD.levelA);
      const rows = baseSame ? [r(base, S0.ID.levelA, S0.OOD.levelA)]
        : R.map((res) => r(`${base}（${res.label} 交集）`, res.slices.ID.levelA, res.slices.OOD.levelA));
      rows.push(r(R[0].comp, S0.ID.levelB, S0.OOD.levelB), r(R[1].comp, S1.ID.levelB, S1.OOD.levelB));
      out.push(table(['模型', 'ID 满分率', `${oodName} 满分率`, 'OOD - ID', 'ID 平均分', `${oodName} 平均分`, 'OOD - ID'], rows));
      // 不再写交互检验段（用户 2026-10-22 定）
      out.push('');
    }

    const who = `${R[0].comp} / ${R[1].comp} vs ${base}`;
    out.push(`## 能力维度\n`);
    let n = 1;
    for (const [f, nm] of [['skillsID', 'ID'], ['skillsOOD', oodName]]) {
      if (!R.some((r) => r[f].length)) continue;
      out.push(`### Skill 小类对比（${nm}）\n`);
      R.forEach((res) => { if (res[f].length) { out.push(`**${res.base} → ${res.comp}**\n`); out.push(skillSection(res, res[f], f === 'skillsID' ? 'ID' : 'OOD')); out.push(''); } });
    }
    if (R.some((r) => r.slices.ID_BI || r.slices.ID_NBI)) {
      out.push(`### 双手协同对比（ID）\n`);
      const rows = [];
      R.forEach((res) => {
        const rs = ['ID_BI', 'ID_NBI'].map((k) => res.slices[k]).filter(Boolean).map((s) => ({ s, df: dP(s.levelA.full, s.levelB.full) })).sort((x, y) => y.df - x.df);
        for (const { s, df } of rs) {
          const t = s.metrics.full, tm = s.metrics.mean;
          rows.push([res.label, s.name.replace('ID-', ''), String(s.cases), pct(s.levelA.full), pct(s.levelB.full), pp(df), s.testable ? fmtCI('full', t, dP(s.levelA.full, s.levelB.full)) : '—', s.testable ? pv(t.p) : '—', scd(dS(s.levelA.mean, s.levelB.mean)), s.testable ? pv(tm.p) : '—']);
        }
      });
      out.push(table(['对比组', '分组', '用例数', `${base} 满分率`, '对比模型满分率', '满分率差值', `${ci}% 区间`, 'p', '均分差值', '均分 p'], rows));
      out.push('');
    }

    out.push(`## 问题标签\n`);
    n = 1;
    for (const [f, nm] of [['tagsID', 'ID'], ['tagsOOD', oodName]]) {
      const T = R.map((r) => r[f]);
      if (!T.some((t) => t && t.rows.length)) continue;
      if (T[0] && T[1] && sameTags(T[0], T[1])) {
        out.push(`### ${nm} 场景标签占比对比\n`);
        const tags = [...new Set([...T[0].rows, ...T[1].rows].map((r) => r.tag))];
        const get = (t, g) => t.rows.find((r) => r.tag === g) || { a: 0, b: 0, pa: t.nA ? 0 : NaN, pb: t.nB ? 0 : NaN };
        const rows = tags.map((g) => {
          const x = get(T[0], g), y = get(T[1], g);
          return { g, x, y, d1: dP(x.pa, x.pb), d2: dP(y.pa, y.pb) };
        }).sort((p, q) => q.d1 - p.d1 || q.d2 - p.d2 || (q.x.a + q.x.b + q.y.b) - (p.x.a + p.x.b + p.y.b))
          .map(({ g, x, y, d1, d2 }) => [g, String(x.a), String(x.b), String(y.b), pct(x.pa), pct(x.pb), pct(y.pb), pp(d1), pp(d2)]);
        out.push(table(['问题标签', `${base} 次数`, `${R[0].comp} 次数`, `${R[1].comp} 次数`, `${base} 占比`, `${R[0].comp} 占比`, `${R[1].comp} 占比`,
          `差值（${R[0].comp}−${base}）`, `差值（${R[1].comp}−${base}）`], rows));
        out.push('');
      } else {
        out.push(`### ${nm} 场景标签占比对比\n`);
        R.forEach((res, i) => { if (T[i] && T[i].rows.length) { out.push(`**${res.base} → ${res.comp}**\n`); out.push(tagSection(res, T[i])); out.push(''); } });
      }
    }
    return out.join('\n');
  }

  // 数字一致性检查：润色稿中的每个数字都必须出现在程序生成稿中
  function extractNumbers(md) {
    const clean = md.replace(/`[0-9a-f]{16,64}`/g, '');
    return (clean.match(/[+-]?\d+(?:\.\d+)?/g) || []).map((s) => s.replace(/^\+/, ''));
  }
  function checkNumbers(draft, polished) {
    const allowed = new Set(extractNumbers(draft).flatMap((s) => [s, s.replace(/^-/, '')]));
    const bad = [];
    polished.split('\n').forEach((line, i) => {
      // 小节编号（如「### 5.1」）和「」里的 sheet 名/模型名不是统计数字，不参与核对
      const body = line.replace(/^\s*#+\s*[\d.]+/, '').replace(/「[^」]*」/g, '');
      for (const n of extractNumbers(body)) if (!allowed.has(n) && !allowed.has(n.replace(/^-/, ''))) bad.push({ line: i + 1, num: n, text: line.trim().slice(0, 120) });
    });
    return bad;
  }

  // 永久规则：以下边界声明/内部提示一律不得进入报告（程序底稿与人工润色稿都适用）。
  // 用户 2026-10-13 明确「以后完全不允许出现」。新增同类声明时往这里加模式即可，
  // render 自检与 cli.js --check、网页核对三处共用本清单。
  const FORBIDDEN_PATTERNS = [
    { re: /<!--/, why: 'HTML 注释（内部提示不得残留进交付报告）' },
    { re: /[➡⬅⬆⬇↔-↙⤴⤵]️|[\u{1F300}-\u{1FAFF}]/u, why: 'emoji（结论箭头用文字箭头 →，2026-10-26 用户定）' },
    { re: /数据指纹\s*SHA/, why: '数据指纹块（指纹在交付时口头/终端给出，不写进报告正文）' },
    { re: /嵌套关系/, why: '三指标嵌套关系声明' },
    { re: /本表不构成能力排序/, why: 'Skill 表免责声明' },
    { re: /一次执行可带多个标签|标签差异只作描述/, why: '问题标签占比免责声明' },
    { re: /额外检验/, why: '子切面额外检验声明' },
    { re: /人工补充/, why: '「人工补充」占位节或占位提示' },
    { re: /不挑\s*p\s*值最小/, why: '三指标取舍声明' },
  ];
  function lintReport(md) {
    const bad = [];
    String(md).split('\n').forEach((line, i) => {
      // callout 的图标位允许 emoji（2026-11 四份定稿报告都用图标），正文仍一律禁止
      if (/^<callout emoji="[^"]+">$/.test(line.trim())) return;
      for (const { re, why } of FORBIDDEN_PATTERNS) {
        if (re.test(line)) { bad.push({ line: i + 1, rule: why, text: line.trim().slice(0, 120) }); break; }
      }
    });
    return bad;
  }

  V.report = { render: (A) => {
      const md = render(A);
      const leaked = lintReport(md);
      if (leaked.length) throw new Error('程序生成的底稿命中永久禁用语句，禁止输出：\n' + leaked.map((b) => `  第 ${b.line} 行（${b.rule}）：${b.text}`).join('\n'));
      return md;
    }, checkNumbers, lintReport, FORBIDDEN_PATTERNS, EXP_ROWS, autoConclusion, fmt: { pct, pp, sc, scd, pv, fmtCI, dirCount },
    // 版式工具箱：供 N 模型渲染器（report_n.js）复用同一套排版/格式化函数，避免两套实现导致小数位与差值口径漂移。
    // 只导出已有函数，不新增任何计算。
    kit: { table, metricTable, distTable, caseChangeBlock, skillSection, tagSection, coreBlock, methodBlock, dP, dS, sameLevel } };
})();
