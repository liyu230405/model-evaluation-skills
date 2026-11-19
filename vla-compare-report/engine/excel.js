// 生成「Excel 公式复核表」：所有统计量用 Excel 原生公式（COUNTIFS / T.TEST / T.INV.2T）重算，
// 并与程序计算值逐项比对。Excel / WPS / LibreOffice 打开即自动计算，不依赖本程序。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});
  const H = (v) => ({ v, s: 1 });
  const F = (f, s) => ({ f, s });
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

  function build(parsed, A) {
    const sheets = [];
    // 1. 执行明细（标准化后）
    const D = [[H('模型'), H('场景'), H('OOD类型'), H('用例ID'), H('Skill'), H('双手协同'), H('得分')]];
    for (const r of parsed.records) D.push([r.model, r.scope, r.oodType, r.caseId, r.skill, r.bimanual === true ? '是' : r.bimanual === false ? '否' : '', r.score === null ? null : r.score]);
    const last = D.length;
    const rng = (col) => `执行明细!$${col}$2:$${col}$${last}`;
    sheets.push({ name: '执行明细', rows: D, widths: [18, 8, 10, 14, 14, 10, 8], freeze: 1 });

    // 第 1 行为汇总，第 2 行为表头，核对项从第 3 行开始（cr = check.length + 1）
    const check = [null, [H('对比组'), H('切面'), H('统计量'), H('Excel 公式值'), H('程序计算值'), H('绝对差'), H('结论')]];
    const alpha = A.alpha;

    A.results.forEach((res, ri) => {
      const sname = `对比${ri + 1}`;
      const rows = [];
      rows.push([{ v: `${res.label}：差值 = ${res.comp} − ${res.base}；显著性门槛 α=${alpha}；所有单元格均为公式`, s: 6 }]);
      rows.push([H('场景'), H('OOD类型'), H('用例ID'), H('Skill'), H('双手协同'),
        H('A有效n'), H('A一分'), H('A两分'), H('A满分率'), H('A均分'), H('A进展率'),
        H('B有效n'), H('B一分'), H('B两分'), H('B满分率'), H('B均分'), H('B进展率'),
        H('d满分率'), H('d均分'), H('d进展率'), H('d成功次数')]);
      // 用例排序：ID 在前；OOD 按白盒/黑盒分段，保证每个切面是连续区域
      const cases = [];
      for (const s of ['ID', 'OOD']) {
        const sl = res.slices[s];
        if (sl) cases.push(...sl.caseDiffs.map((c) => Object.assign({ scope: s }, parsed.meta[s + '|' + c.caseId])));
      }
      const ord = { '': 0, 白盒: 1, 黑盒: 2 };
      cases.sort((x, y) => (x.scope !== y.scope ? (x.scope === 'ID' ? -1 : 1) : (ord[x.oodType] ?? 3) - (ord[y.oodType] ?? 3)));
      const first = 3;
      cases.forEach((c, i) => {
        const r = first + i;
        // SUMPRODUCT 精确相等匹配，避免 COUNTIFS 的通配符与数字/文本混淆
        const key = (model) => `(${rng('A')}="${String(model).replace(/"/g, '""')}")*(${rng('B')}=$A${r})*(${rng('D')}=$C${r})`;
        const cnt = (model, cond) => `SUMPRODUCT(${key(model)}*${cond})`;
        const nV = `ISNUMBER(${rng('G')})`, is1 = `(${rng('G')}=1)*${nV}`, is2 = `(${rng('G')}=2)`;
        rows.push([c.scope, c.oodType, c.caseId, c.skill, c.bimanual === true ? '是' : c.bimanual === false ? '否' : '',
          F(cnt(res.base, nV)), F(cnt(res.base, is1)), F(cnt(res.base, is2)),
          F(`H${r}/F${r}`, 2), F(`(G${r}+2*H${r})/F${r}`, 3), F(`(G${r}+H${r})/F${r}`, 2),
          F(cnt(res.comp, nV)), F(cnt(res.comp, is1)), F(cnt(res.comp, is2)),
          F(`N${r}/L${r}`, 2), F(`(M${r}+2*N${r})/L${r}`, 3), F(`(M${r}+N${r})/L${r}`, 2),
          F(`O${r}-I${r}`, 2), F(`P${r}-J${r}`, 3), F(`Q${r}-K${r}`, 2), F(`N${r}-H${r}`)]);
      });
      // 切面区段
      const segs = [];
      const seg = (key, name, pred) => {
        const ix = cases.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
        if (!ix.length || !res.slices[key]) return;
        if (ix[ix.length - 1] - ix[0] + 1 !== ix.length) return; // 非连续区域不出
        segs.push({ key, name, r1: first + ix[0], r2: first + ix[ix.length - 1] });
      };
      seg('ID', 'ID', (c) => c.scope === 'ID');
      seg('OOD', '总OOD', (c) => c.scope === 'OOD');
      seg('OOD_W', '白盒OOD', (c) => c.scope === 'OOD' && c.oodType === '白盒');
      seg('OOD_B', '黑盒OOD', (c) => c.scope === 'OOD' && c.oodType === '黑盒');

      rows.push([]);
      rows.push([H('切面'), H('指标'), H('用例数n'), H('A水平(加权)'), H('B水平(加权)'), H('差值(B−A加权)'), H('SD_d'), H('t临界值'),
        H('区间下限'), H('区间上限'), H('p(T.TEST配对双侧)'), H('升'), H('降'), H('平'), H('可分辨范围'), H('配对均差(仅参考)')]);
      const MET = [['full', '满分率', 'I', 'O', 'R'], ['mean', '平均分', 'J', 'P', 'S'], ['prog', '有进展率', 'K', 'Q', 'T']];
      let r;
      for (const sg of segs) {
        for (const [k, mname, ac, bc, dc] of MET) {
          r = rows.length + 1;
          const R = (c) => `${c}${sg.r1}:${c}${sg.r2}`;
          const levelA = k === 'full' ? `SUM(${R('H')})/SUM(${R('F')})` : k === 'mean' ? `(SUM(${R('G')})+2*SUM(${R('H')}))/SUM(${R('F')})` : `(SUM(${R('G')})+SUM(${R('H')}))/SUM(${R('F')})`;
          const levelB = k === 'full' ? `SUM(${R('N')})/SUM(${R('L')})` : k === 'mean' ? `(SUM(${R('M')})+2*SUM(${R('N')}))/SUM(${R('L')})` : `(SUM(${R('M')})+SUM(${R('N')}))/SUM(${R('L')})`;
          const st = 4;
          rows.push([sg.name, mname, F(`COUNT(${R(dc)})`), F(levelA, k === 'mean' ? 3 : 2), F(levelB, k === 'mean' ? 3 : 2),
            F(`E${r}-D${r}`, st), F(`IF(C${r}>1,STDEV.S(${R(dc)}),"")`, st), F(`IF(C${r}>1,T.INV.2T(${alpha},C${r}-1),"")`, st),
            F(`IF(C${r}>1,F${r}-H${r}*G${r}/SQRT(C${r}),"")`, st), F(`IF(C${r}>1,F${r}+H${r}*G${r}/SQRT(C${r}),"")`, st),
            F(`IFERROR(T.TEST(${R(bc)},${R(ac)},2,1),IF(ABS(P${r})<1E-12,1,0))`, 4),
            F(`COUNTIF(${R(dc)},">1E-12")`), F(`COUNTIF(${R(dc)},"<-1E-12")`), F(`C${r}-L${r}-M${r}`),
            F(`IF(C${r}>1,H${r}*G${r}/SQRT(C${r}),"")`, st), F(`AVERAGE(${R(dc)})`, st)]);
          const t = res.slices[sg.key].metrics[k];
          const L = res.slices[sg.key];
          const items = [['用例数', 'C', t.n], ['A水平', 'D', L.levelA[k]], ['B水平', 'E', L.levelB[k]], ['差值', 'F', t.weightedDiff],
            ['区间下限', 'I', t.ciLo], ['区间上限', 'J', t.ciHi], ['配对均差', 'P', t.meanDiff], ['p 值', 'K', t.p], ['升', 'L', t.up], ['降', 'M', t.down]];
          for (const [nm, col, val] of items) {
            const cr = check.length + 1;
            if (num(val) === null) continue;
            check.push([res.label, sg.name, `${mname}·${nm}`, F(`'${sname}'!${col}${r}`, 4), { v: val, s: 4 },
              F(`IFERROR(ABS(D${cr}-E${cr}),"")`, 4), F(`IF(F${cr}="","—",IF(F${cr}<1E-6,"一致","不一致"))`)]);
          }
        }
      }
      // 交互效应（Welch）
      const sId = segs.find((s) => s.key === 'ID'), sOod = segs.find((s) => s.key === 'OOD');
      if (sId && sOod && res.interaction) {
        rows.push([]);
        rows.push([H('交互效应'), H('指标'), H('OOD差均值−ID差均值'), H('p(T.TEST Welch双侧)')]);
        for (const [k, mname, , , dc] of MET) {
          r = rows.length + 1;
          rows.push(['ID vs 总OOD', mname, F(`AVERAGE(${dc}${sOod.r1}:${dc}${sOod.r2})-AVERAGE(${dc}${sId.r1}:${dc}${sId.r2})`, 4),
            F(`IFERROR(T.TEST(${dc}${sOod.r1}:${dc}${sOod.r2},${dc}${sId.r1}:${dc}${sId.r2},2,3),"")`, 4)]);
          const it = res.interaction[k];
          for (const [nm, col, val] of [['交互差值', 'C', it.diff], ['交互 p', 'D', it.p]]) {
            const cr = check.length + 1;
            if (num(val) === null) continue;
            check.push([res.label, 'ID×OOD', `${mname}·${nm}`, F(`'${sname}'!${col}${r}`, 4), { v: val, s: 4 },
              F(`IFERROR(ABS(D${cr}-E${cr}),"")`, 4), F(`IF(F${cr}="","—",IF(F${cr}<1E-6,"一致","不一致"))`)]);
          }
        }
      }
      sheets.push({ name: sname, rows, widths: [10, 9, 14, 12, 9, ...Array(16).fill(10)], freeze: 2 });
    });

    const n = check.length;
    check[0] = [{ v: `核对汇总：共 ${n - 2} 项；不一致项数 →`, s: 5 }, null, null, F(`COUNTIF(G3:G${n},"不一致")`, 5), { v: '（应为 0）', s: 6 }];
    sheets.splice(1, 0, { name: '核对', rows: check, widths: [26, 12, 20, 16, 16, 14, 10], freeze: 2 });
    return V.xlsx.writeXlsx(sheets);
  }

  V.excel = { build };
})();
