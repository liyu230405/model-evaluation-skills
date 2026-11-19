// 单测试报告模板（v1）：只呈现一个模型的水平，不出现差值 / p 值 / 置信区间。
// 全部数字来自 V.analyze 的结果对象（levelA 水平），本文件只做取数与格式化，不含任何统计计算。
// 与「双对比模板」共用 V.report.fmt 的格式化函数与 11 行实验配置表，保证同一口径同一写法。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});

  const fin = (x) => typeof x === 'number' && isFinite(x);
  const pct = (x) => V.report.fmt.pct(x);
  const sc = (x) => V.report.fmt.sc(x);
  const EXP_ROWS = V.report.EXP_ROWS;

  const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

  const dist = (name, L) => [name, String(L.n), `${L.c0}（${pct(L.c0 / L.n)}）`, `${L.c1}（${pct(L.c1 / L.n)}）`, `${L.c2}（${pct(L.c2 / L.n)}）`];

  function levelTable(model, s) {
    const row = (k, txt, tail) => [k, txt, tail];
    return table(['指标', model, '说明'], [
      ['满分率', pct(s.levelA.full), '分数=2 的执行占有效执行'],
      ['平均分', sc(s.levelA.mean), '0/1/2 三档均值'],
      ['有进展率', pct(s.levelA.prog), '分数>0 的执行占有效执行'],
      ['pass@5', pct(s.levelA.pass5), '该切面至少一次满分的用例占比'],
    ]);
  }

  // 1 核心结论：单模型只陈述水平事实，不做显著性判定（单模型没有对比对象）
  function coreBlock(res, model) {
    const out = [];
    for (const key of ['ID', 'OOD', 'OOD2']) {
      const s = res.slices[key];
      if (!s) continue;
      const L = s.levelA;
      out.push(`- **${s.name}**：满分率 ${pct(L.full)}、平均分 ${sc(L.mean)}、有进展率 ${pct(L.prog)}；0/1/2 分布 ${pct(L.c0 / L.n)} / ${pct(L.c1 / L.n)} / ${pct(L.c2 / L.n)}（${L.n} 次有效执行、${L.cases} 个用例）。`);
    }
    const rank = (list) => list.filter((x) => fin(x.levelA.mean)).sort((a, b) => b.levelA.mean - a.levelA.mean);
    for (const [scope, list] of [['ID', res.skillsID], ['OOD', res.skillsOOD]]) {
      const r = rank(list);
      if (!r.length) continue;
      const top = r.slice(0, 2).map((x) => `${x.name}（均分 ${sc(x.levelA.mean)}、满分率 ${pct(x.levelA.full)}）`).join('、');
      const low = r.slice(-2).reverse().map((x) => `${x.name}（均分 ${sc(x.levelA.mean)}）`).join('、');
      out.push(`- Skill 层面（${scope}）：均分最高的是 ${top}；最低的是 ${low}。`);
    }
    return out.join('\n') + '\n';
  }

  function methodBlock(A) {
    const cfg = A.config, alpha = A.alpha;
    return `平均分、满分率（分数=2）和有进展率（分数>0）按有效执行计算。\n\n本报告为单模型水平报告，不做两模型配对检验，因此不给出 p 值与置信区间；显著性对比请看同批数据的双对比报告。\n`;
  }

  function render(A) {
    const res = A.results[0];
    if (!res) throw new Error('单测试报告需要正好一个模型的结果');
    const model = res.comp === res.base ? res.comp : res.label;
    const cfg = A.config, S = res.slices, out = [];

    out.push(`# ${cfg.报告标题}\n`);
    out.push(`## 1. 核心结论\n`);
    if (cfg.核心结论补充) out.push(`${cfg.核心结论补充}\n`);
    out.push(coreBlock(res, model));

    out.push(`## 2. 统计说明\n`);
    if (cfg.测试背景) out.push(`${cfg.测试背景}\n`);
    out.push(methodBlock(A));
    {
      const rows = [];
      for (const [n, k] of [['ID', 'ID'], ['OOD 2.0', 'OOD2'], [S.OOD ? S.OOD.name : 'OOD', 'OOD'], ['全部', 'ALL']]) {
        const s = S[k];
        if (!s) continue;
        rows.push([n, String(s.recorded), String(s.levelA.cases), String(s.levelA.n)]);
      }
      out.push(table(['范围', '记录用例数', '有效用例数', '有效执行数'], rows));
      out.push('');
    }
    // 单模型自配对会让 analyze 生成「两模型均无有效执行」「执行次数不符」的成对文案，这里按单模型口径改写并去重
    if (res.dropped.length) {
      const why = (r) => String(r).replace(/两模型均无有效执行/g, '该模型无有效执行');
      out.push(`> ⚠️ 以下用例没有有效执行，只计入记录用例数、不参与任何指标：${[...new Set(res.dropped.map((d) => `${d.caseId}（${why(d.reason)}）`))].join('；')}\n`);
    }
    if (res.short.length) out.push(`> ⚠️ 执行次数与计划不符：${[...new Set(res.short)].join('；')}\n`);

    out.push(`## 3. 实验配置\n`);
    out.push(table(['配置项', model], EXP_ROWS.map((k) => [k, ' '])));
    if (cfg.核心差异) out.push(`\n核心差异：${cfg.核心差异}`);
    out.push('');

    out.push(`## 4. 核心指标\n`);
    if (S.ID) {
      out.push(`### 4.1 ID 场景\n`);
      out.push(levelTable(model, S.ID));
      out.push('');
      out.push(table(['模型', '有效执行', '0 分', '1 分', '2 分'], [dist(model, S.ID.levelA)]));
      out.push('');
    }
    if (S.OOD || S.OOD2) {
      out.push(`### 4.2 OOD 场景\n`);
      for (const s of [S.OOD, S.OOD2]) {
        if (!s) continue;
        out.push(`**${s.name}（${s.levelA.cases} 用例）**\n`);
        out.push(levelTable(model, s));
        out.push('');
        out.push(table(['模型', '有效执行', '0 分', '1 分', '2 分'], [dist(model, s.levelA)]));
        out.push('');
      }
    }

    out.push(`## 5. 能力维度\n`);
    let n = 1;
    if (res.skillsID.length) {
      out.push(`### 5.${n++} Skill 小类（ID）\n`);
      out.push(table(['Skill 小类', '用例数', '均分', '满分率'],
        res.skillsID.slice().sort((a, b) => b.levelA.mean - a.levelA.mean).map((s) => [s.name, String(s.cases), sc(s.levelA.mean), pct(s.levelA.full)])));
      out.push('');
    }
    if (res.skillsOOD.length) {
      out.push(`### 5.${n++} Skill 小类（${S.OOD ? S.OOD.name : 'OOD'}）\n`);
      out.push(table(['Skill 小类', '用例数', '均分', '满分率'],
        res.skillsOOD.slice().sort((a, b) => b.levelA.mean - a.levelA.mean).map((s) => [s.name, String(s.cases), sc(s.levelA.mean), pct(s.levelA.full)])));
      out.push('');
    }
    const sub = ['ID_NBI', 'ID_BI'].filter((k) => S[k]);
    if (sub.length) {
      out.push(`### 5.${n++} 双手协同（ID）\n`);
      out.push(table(['切面', '用例数', '均分', '满分率', '有效执行'],
        sub.map((k) => { const s = S[k]; const L = s.levelA; return [s.name.replace(/^ID-/, ''), String(L.cases), sc(L.mean), pct(L.full), String(L.n)]; })));
      out.push('');
    }

    out.push(`## 6. 问题标签\n`);
    n = 1;
    for (const [key, nm] of [['tagsID', 'ID'], ['tagsOOD', S.OOD ? S.OOD.name : 'OOD']]) {
      const t = res[key];
      if (!t || !t.rows.length) continue;
      out.push(`### 6.${n++} ${nm} 场景标签占比\n`);
      out.push(table(['问题标签', '次数', '占比'],
        t.rows.slice().sort((a, b) => b.pa - a.pa).map((r) => [r.tag, String(r.a), pct(r.pa)])));
      out.push(`执行次数：${t.nA}。`);
      out.push('');
    }
    return out.join('\n');
  }

  V.reportSingle = {
    name: '单测试报告',
    render: (A) => {
      const md = render(A);
      const leaked = V.report.lintReport(md);
      if (leaked.length) throw new Error('单模型底稿命中永久禁用语句，禁止输出：\n' + leaked.map((b) => `  第 ${b.line} 行（${b.rule}）：${b.text}`).join('\n'));
      return md;
    },
  };
})();
