// 原生「基模测试记录」大表读取：一个 sheet = 一个模型，一行 = 一个用例，T1..T5 各占「_分数/_标签/_测试详情」三列。
// 规则（用户 2026-10-13 确认）：
//   白盒表（sheet 名不含「黑盒」）：按「0902-ft—ood」列分，id → ID，ood → 白盒 OOD
//   黑盒表（sheet 名含「黑盒」）：全部算黑盒 OOD
//   Skill标签：「双手协同」单独作为布尔列，其余取第一个作为主 Skill
//   模型名：sheet 名去掉日期前缀（如 261009-）和「FT测试记录-」「FT黑盒测试记录-」
// 同一模型的白盒 sheet 与黑盒 sheet 自动合并。输出标准长表，交给 analyze.parseWorkbook 计算。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const LONG_HEAD = ['模型', '场景', 'OOD类型', '用例ID', '用例名称', 'Skill', '双手协同', '执行序号', '得分', '问题标签', '是否有效', '备注', 'OOD2.0'];

  const headerOf = (rows) => (rows && rows[0] ? rows[0].map(str) : []);
  const isNativeSheet = (rows) => {
    const h = headerOf(rows);
    return h.includes('用例ID') && h.includes('T1_分数');
  };
  const isBlackSheet = (name) => /黑盒/.test(name);
  const modelOfSheet = (name) => str(name).replace(/^\d{6}[-_]?/, '').replace(/^FT(黑盒)?测试记录[-_]?/, '').trim() || str(name);

  function scoredRows(rows) {
    const h = headerOf(rows);
    const cols = [1, 2, 3, 4, 5].map((t) => h.indexOf(`T${t}_分数`)).filter((i) => i >= 0);
    const id = h.indexOf('用例ID');
    return rows.slice(1).filter((r) => r && str(r[id]) && cols.some((i) => str(r[i]) !== '')).length;
  }

  // 列出工作簿里所有可用的模型 sheet：[{ sheet, model, black, scored }]
  function listModels(sheets) {
    return Object.entries(sheets)
      .filter(([, rows]) => isNativeSheet(rows))
      .map(([sheet, rows]) => ({ sheet, model: modelOfSheet(sheet), black: isBlackSheet(sheet), scored: scoredRows(rows) }))
      .filter((x) => x.scored > 0);
  }

  // Skill标签 里多个标签用空格、顿号、逗号、分号分隔；括号内的空格属于标签本身
  // （如「抓取（Pick） 双手协同」是两个标签，「工具操作（Tool Use）」是一个标签）
  function splitSkillTags(raw) {
    const src = str(raw);
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
    return out;
  }

  function parseSkill(raw) {
    const parts = splitSkillTags(raw);
    // skill 保留全部标签（「抓取（Pick） 双手协同」→ 两个小类各计一次）；bimanual 供布尔切面用
    return { skill: parts.join(' '), bimanual: parts.includes('双手协同') };
  }

  // 单个 sheet → 长表行；同时用「满分次数」列（若有）交叉校验
  function sheetToLong(rows, model, black, sheetName, warnings) {
    const h = headerOf(rows);
    const ix = (n) => h.indexOf(n);
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const caseId = str(row[ix('用例ID')]);
      if (!caseId) continue;
      const runs = [1, 2, 3, 4, 5].map((t) => ({ t, sc: str(row[ix(`T${t}_分数`)]), tag: ix(`T${t}_标签`) >= 0 ? str(row[ix(`T${t}_标签`)]) : '' }));
      const unscored = !runs.some((x) => x.sc !== '');
      let scope, ood2 = false;
      // OOD 2.0 = 白盒 OOD + 黑盒 V1.0 的 18 个用例（黑盒 sheet 里「0902-ft—ood」标 id 的行）；OOD 3.0 = 全部 OOD
      if (black) { scope = 'OOD'; ood2 = ix('0902-ft—ood') >= 0 && str(row[ix('0902-ft—ood')]).toLowerCase() === 'id'; }
      else {
        // 老 sheet 没有「0902-ft—ood」列，用「ID/OOD」列
        const s = str(row[ix('0902-ft—ood') >= 0 ? ix('0902-ft—ood') : ix('ID/OOD')]).toLowerCase();
        if (s === 'id') scope = 'ID';
        else if (/ood$/.test(s)) { scope = 'OOD'; ood2 = true; } // 老 sheet 写「道具ood」「动作ood」等，统一算白盒 OOD
        else { warnings.push(`「${sheetName}」第 ${r + 1} 行 ${caseId}：ID/OOD 列为「${s}」，无法判定 ID/OOD，已跳过`); continue; }
      }
      const { skill, bimanual } = parseSkill(row[ix('Skill标签')]);
      const caseName = str(row[ix('prompt_ch')]) || str(row[ix('Prompt')]);
      // 整行无打分：保留一条空分记录，使「记录用例数」能数到它（不进入任何指标计算）
      if (unscored) { out.push([model, scope, scope === 'OOD' ? (black ? '黑盒' : '白盒') : '', caseId, caseName, skill, bimanual ? '是' : '否', '', '', '', '', '', scope === 'OOD' ? (ood2 ? '是' : '否') : '']); continue; }
      let n2 = 0;
      for (const x of runs) {
        if (x.sc === '') continue;
        if (x.sc === '2') n2++;
        out.push([model, scope, scope === 'OOD' ? (black ? '黑盒' : '白盒') : '', caseId, caseName, skill, bimanual ? '是' : '否', x.t, x.sc, x.tag, '', '', scope === 'OOD' ? (ood2 ? '是' : '否') : '']);
      }
      if (ix('满分次数') >= 0) {
        const d = str(row[ix('满分次数')]);
        if (d !== '' && Number(d) !== n2) warnings.push(`「${sheetName}」第 ${r + 1} 行 ${caseId}：表内满分次数=${d}，程序从 T1..T5 数出 ${n2}`);
      }
    }
    return out;
  }

  // books: [{ sheets, label }]；pick: 要的模型名数组（为空则全部）
  // 白盒/黑盒 sheet 名不一致时写成「白盒名|黑盒名」，例如「1wh_8w模型|8w模型」，报告里用第一个名字
  // 返回 { sheets: { 执行明细: 长表 }, used: [{ label, sheet, model }], models: [...] , warnings }
  function toLong(books, pick) {
    const warnings = [], used = [], long = [LONG_HEAD];
    const seen = {};
    const alias = {};
    for (const p of pick || []) for (const n of p.split('|').map(str).filter(Boolean)) alias[n] = p.split('|')[0].trim();
    for (const b of books) {
      for (const m0 of listModels(b.sheets)) {
        if (pick && pick.length && !alias[m0.model]) continue;
        const m = Object.assign({}, m0, { model: alias[m0.model] || m0.model });
        const key = m.model + '|' + (m.black ? '黑' : '白');
        if (seen[key]) { warnings.push(`模型「${m.model}」有多个${m.black ? '黑盒' : '白盒'} sheet（「${seen[key]}」与「${m.sheet}」），只取第一个`); continue; }
        seen[key] = m.sheet;
        long.push(...sheetToLong(b.sheets[m.sheet], m.model, m.black, m.sheet, warnings));
        used.push({ label: b.label, sheet: m.sheet, model: m.model, black: m.black });
      }
    }
    if (pick) for (const p of pick) {
      const name = p.split('|')[0].trim();
      const got = used.filter((u) => u.model === name);
      if (!got.length) warnings.push(`没找到模型「${p}」对应的 sheet`);
      else if (books.length > 1 && got.length < 2) warnings.push(`模型「${name}」只找到 ${got.map((u) => u.sheet).join('')} 一个 sheet；如果另一本表里的名字不同，写成「白盒名|黑盒名」`);
    }
    return { sheets: { 执行明细: long }, used, warnings };
  }

  const isNativeBook = (sheets) => listModels(sheets).length > 0 && !Object.keys(sheets).includes('执行明细');

  V.native = { isNativeBook, isNativeSheet, listModels, modelOfSheet, toLong, LONG_HEAD };
})();
