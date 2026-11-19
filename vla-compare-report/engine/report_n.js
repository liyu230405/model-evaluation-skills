// N 模型渲染器（基准 + 多个对比模型，>3 个模型时使用）。
// 只做版式：所有数字取自已算好的 A.results，排版函数全部借用 V.report.kit，不重写、不新算任何统计量。
// 结构仍为固定 6 节（核心结论 / 统计说明 / 实验配置 / 核心指标 / 能力维度 / 问题标签），
// 与两模型、三模型版式的差别只有两点：§2 范围表列出全部对比组；§4–§6 每组对比各成一块。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});
  const kit = () => V.report.kit;
  const fmt = () => V.report.fmt;

  function oodName(R) {
    const s = R.map((r) => r.slices.OOD).find(Boolean);
    return s ? s.name : 'OOD';
  }

  // §2 范围表：一行一个范围，一列一组对比（有效用例数 / 对比模型有效执行数 / 基准有效执行数）
  function rangeTable(R) {
    const K = kit();
    const rows = [];
    for (const [name, k] of [['ID', 'ID'], ['OOD 2.0', 'OOD2'], [oodName(R), 'OOD'], ['全部', 'ALL']]) {
      const vals = R.map((r) => (r.slices[k] ? String(r.slices[k].recorded) : null));
      if (!vals.some((v) => v !== null)) continue;
      const same = vals.every((v) => v === vals[0]);
      rows.push([
        name,
        same ? vals[0] : vals.map((v) => (v === null ? '—' : v)).join(' / '),
        ...R.map((r) => {
          const s = r.slices[k];
          if (!s) return '—';
          // 与三模型版式保持同一写法：有效用例数 / 对比模型有效执行数 / 基准有效执行数
          return `${s.cases} / ${s.levelB.n} / ${s.levelA.n}`;
        }),
      ]);
    }
    const head = ['范围', '记录用例数', ...R.map((r) => `${r.comp} vs ${r.base}（有效用例数 / ${r.comp} 执行 / ${r.base} 执行）`)];
    return K.table(head, rows);
  }

  // 一个切面（ID / OOD / OOD2）在各组对比下的指标表 + 0/1/2 分布表
  function sliceBlocks(R, key, alpha) {
    const K = kit(), out = [];
    for (const r of R) {
      const s = r.slices[key];
      if (!s) continue;
      out.push(`**${r.label}**（${s.cases} 个用例；有效执行 ${r.base} ${s.levelA.n} 次 / ${r.comp} ${s.levelB.n} 次）\n`);
      out.push(K.metricTable(r, s, alpha));
      out.push('');
      out.push(K.distTable(r, s));
      out.push('');
      if (key === 'ID') { out.push(`#### 显著变化用例（ID）\n`); out.push(K.caseChangeBlock(r, alpha)); out.push(''); }
    }
    return out;
  }

  function renderN(A) {
    const K = kit(), F = fmt();
    const cfg = A.config, alpha = A.alpha, R = A.results;
    const base = R[0].base;
    const comps = R.map((r) => r.comp);
    const out = [];

    out.push(`# ${cfg.报告标题}\n`);

    // 顶部 callout + 结论节（照 2026-11 四份定稿：callout 在标题下、章节不编号）
    out.push(`<callout emoji="🌟">\n**核心结论：${cfg.核心结论补充 || V.report.autoConclusion(A)}**\n</callout>\n`);
    out.push(`## 结论\n`);
    out.push(`基准模型：${base}；${comps.join('、')} 分别与 ${base} 比较，共 ${R.length} 组对比。\n`);
    for (const res of R) out.push(K.coreBlock(res, alpha));

    // §2 统计说明
    out.push(`## 统计说明\n`);
    if (cfg.测试背景) out.push(`${cfg.测试背景}\n`);
    out.push(K.methodBlock(A));
    out.push(rangeTable(R));
    out.push('');

    for (const res of R) {
      if (res.dropped.length) out.push(`> [${res.label}] 以下用例只有一个模型有有效执行，不参与配对检验（p 值、区间），水平、分布、Skill、标签按各模型自己的数据计入：${res.dropped.map((d) => `${d.caseId}（${d.reason}）`).join('；')}\n`);
      if (res.short.length) out.push(`> [${res.label}] 执行次数与计划不符：${res.short.join('；')}\n`);
    }

    // §3 实验配置（固定 11 行、内容空置，列顺序：基准、各对比模型）
    out.push(`## 测试配置对比\n`);
    const models = [base, ...comps];
    out.push(K.table(['配置项', ...models], V.report.EXP_ROWS.map((k) => [k, ...models.map(() => ' ')])));
    if (cfg.核心差异) out.push(`\n核心差异：${cfg.核心差异}`);
    out.push('');

    // §4 核心指标
    out.push(`## 核心指标对比\n`);
    out.push(`差值一律为「对比模型 − ${base}」。\n`);
    out.push(`### ID 场景核心指标对比\n`);
    out.push(...sliceBlocks(R, 'ID', alpha));
    out.push(`### OOD 场景核心指标对比\n`);
    out.push(...sliceBlocks(R, 'OOD', alpha));
    out.push(...sliceBlocks(R, 'OOD2', alpha));

    const cross = R.filter((r) => r.slices.ID && r.slices.OOD);
    if (cross.length) {
      out.push(`### ID vs OOD 落差对比\n`);
      const row = (name, la, lb) => [name, F.pct(la.full), F.pct(lb.full), F.pp(K.dP(la.full, lb.full)), F.sc(la.mean), F.sc(lb.mean), F.scd(K.dS(la.mean, lb.mean))];
      const sameBase = cross.every((r) => K.sameLevel(r.slices.ID.levelA, cross[0].slices.ID.levelA) && K.sameLevel(r.slices.OOD.levelA, cross[0].slices.OOD.levelA));
      const rows = sameBase
        ? [row(base, cross[0].slices.ID.levelA, cross[0].slices.OOD.levelA)]
        : cross.map((r) => row(`${base}（${r.label} 交集）`, r.slices.ID.levelA, r.slices.OOD.levelA));
      for (const r of cross) rows.push(row(r.comp, r.slices.ID.levelB, r.slices.OOD.levelB));
      out.push(K.table(['模型', 'ID 满分率', `${oodName(R)} 满分率`, 'OOD - ID', 'ID 平均分', `${oodName(R)} 平均分`, 'OOD - ID'], rows));
      out.push('');
    }

    // §5 能力维度（Skill 小类 + 双手协同），每组对比一块
    out.push(`## 能力维度\n`);
    let n = 1;
    if (R.some((r) => r.skillsID.length)) {
      out.push(`### Skill 小类对比（ID）\n`);
      for (const r of R) {
        if (!r.skillsID.length) continue;
        out.push(`**${r.label}**\n`);
        out.push(K.skillSection(r, r.skillsID, 'ID'));
        out.push('');
      }
    }
    if (R.some((r) => r.skillsOOD.length)) {
      out.push(`### Skill 小类对比（${oodName(R)}）\n`);
      for (const r of R) {
        if (!r.skillsOOD.length) continue;
        out.push(`**${r.label}**\n`);
        out.push(K.skillSection(r, r.skillsOOD, 'OOD'));
        out.push('');
      }
    }
    const subs = ['ID_NBI', 'ID_BI'];
    if (R.some((r) => subs.some((k) => r.slices[k]))) {
      out.push(`### 双手协同对比（ID）\n`);
      for (const r of R) {
        const ss = subs.filter((k) => r.slices[k]);
        if (!ss.length) continue;
        out.push(`**${r.label}**\n`);
        const rows = ss.map((k) => {
          const s = r.slices[k], t = s.metrics.full;
          return [s.name.replace(/^ID-/, ''), String(s.cases), F.pct(s.levelA.full), F.pct(s.levelB.full), F.pp(K.dP(s.levelA.full, s.levelB.full)),
            s.testable ? F.fmtCI('full', t, K.dP(s.levelA.full, s.levelB.full)) : '—', s.testable ? F.pv(t.p) : '—'];
        });
        out.push(K.table(['切面', '用例数', `${r.base} 满分率`, `${r.comp} 满分率`, '满分率差值', `${Math.round((1 - alpha) * 100)}% 区间`, 'p'], rows));
        out.push('');
      }
    }

    // §6 问题标签
    out.push(`## 问题标签\n`);
    n = 1;
    if (R.some((r) => r.tagsID && r.tagsID.rows.length)) {
      out.push(`### ID 场景标签占比对比\n`);
      for (const r of R) {
        if (!r.tagsID || !r.tagsID.rows.length) continue;
        out.push(`**${r.label}**\n`);
        out.push(K.tagSection(r, r.tagsID));
        out.push('');
      }
    }
    if (R.some((r) => r.tagsOOD && r.tagsOOD.rows.length)) {
      out.push(`### ${oodName(R)} 场景标签占比对比\n`);
      for (const r of R) {
        if (!r.tagsOOD || !r.tagsOOD.rows.length) continue;
        out.push(`**${r.label}**\n`);
        out.push(K.tagSection(r, r.tagsOOD));
        out.push('');
      }
    }
    return out.join('\n');
  }

  V.reportN = {
    render: (A) => {
      const md = renderN(A);
      const leaked = V.report.lintReport(md);
      if (leaked.length) throw new Error('程序生成的底稿命中永久禁用语句，禁止输出：\n' + leaked.map((b) => `  第 ${b.line} 行（${b.rule}）：${b.text}`).join('\n'));
      return md;
    },
  };
})();
