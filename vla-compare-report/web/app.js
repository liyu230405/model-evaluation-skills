// 前端：只负责读文件、调用引擎、渲染。不在此处做任何统计计算。
(function () {
  const V = globalThis.VLA, F = V.report.fmt;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let state = null;

  // ---------- 引擎自检：与 scipy 1.18 的参考值比对 ----------
  function selfTest() {
    const M = V.math;
    const a = [0.2, 0.4, 0, 1, 0.6, 0.8, 0.2], b = [0.4, 0.4, 0.2, 0.8, 1, 0.8, 0.6];
    const t = M.pairedT(a, b, 0.9);
    const w = M.welchT([0.1, 0.3, -0.2, 0.5], [0, -0.4, 0.2, -0.1, 0.3], 0.9);
    const cases = [
      [t.p, 0.14034630086737934], [t.lo, -0.02058765293023848], [t.hi, 0.3063019386445241],
      [w.p, 0.3983203151167148], [M.tQuantile(0.95, 51), 1.6752849504249099], [M.tQuantile(0.95, 26), 1.7056179197592738],
    ];
    const ok = cases.every(([x, y]) => Math.abs(x - y) < 1e-9) && M.sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const el = $('#selftest');
    el.textContent = ok ? '引擎自检通过（对照 scipy）' : '引擎自检失败，请勿使用';
    el.className = 'badge ' + (ok ? 'ok' : 'bad');
    return ok;
  }

  function msgs(list) {
    $('#msgs').innerHTML = list.map(([cls, m]) => `<div class="msg ${cls}">${esc(m)}</div>`).join('');
  }

  // ---------- 表格槽位：每个槽一个文件 + 模型名（表里没有「模型」列时使用） ----------
  const slots = [];
  const stem = (n) => n.replace(/\.(xlsx|csv)$/i, '');
  function addSlot(label) {
    const i = slots.length, slot = { sheets: null, file: '', name: '' };
    slots.push(slot);
    const div = document.createElement('div');
    div.className = 'slot';
    div.innerHTML = `<div class="drop" tabindex="0" role="button" aria-label="${esc(label)}：点击或拖入表格">
        <b>${esc(label)}</b><span class="hint fname">点击或拖入 .xlsx / .csv</span></div>
      <label>模型名 <input class="mname" type="text" placeholder="默认取文件名；表里有「模型」列则以表为准"></label>
      <input type="file" accept=".xlsx,.csv" hidden>`;
    const drop = div.querySelector('.drop'), file = div.querySelector('input[type=file]'), nm = div.querySelector('.mname');
    const take = async (f) => {
      try {
        const buf = await f.arrayBuffer();
        slot.sheets = /\.csv$/i.test(f.name) ? { 执行明细: V.xlsx.parseCSV(new TextDecoder().decode(buf)) } : await V.xlsx.readXlsx(buf);
        slot.file = f.name;
        if (!nm.value) nm.value = stem(f.name);
        slot.name = nm.value.trim();
        div.querySelector('.fname').textContent = '已载入 ' + f.name;
        recompute();
      } catch (e) { console.error(e); msgs([['err', `${f.name} 读取失败：${e.message}`]]); }
    };
    slot.take = take;
    slot.setName = (v) => { nm.value = v; slot.name = v; };
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) take(f); });
    file.addEventListener('change', () => { const f = file.files[0]; if (f) take(f); file.value = ''; });
    nm.addEventListener('change', () => { slot.name = nm.value.trim() || stem(slot.file); if (slot.sheets) recompute(); });
    $('#slots').appendChild(div);
    return slot;
  }

  function fail(list) { msgs(list); $('#result').hidden = true; $('#picker').hidden = true; }

  // ---------- 原生大表：一个 sheet 一个模型，选白盒/黑盒 sheet ----------
  let nBooks = null;
  function nativePicker(loaded) {
    nBooks = loaded.map((x) => ({ sheets: x.sheets, label: x.file }));
    const all = nBooks.flatMap((b) => V.native.listModels(b.sheets));
    const W = [...new Set(all.filter((m) => !m.black).map((m) => m.model))], B = [...new Set(all.filter((m) => m.black).map((m) => m.model))];
    const keep = (id) => $(id).value;
    const fill = (id, list, pref) => {
      const cur = keep(id);
      $(id).innerHTML = '<option value="">（不用）</option>' + list.map((m) => `<option>${esc(m)}</option>`).join('');
      $(id).value = list.includes(cur) ? cur : list.includes(pref) ? pref : '';
    };
    fill('#nBaseW', W, W[0]); fill('#nCompW', W, W[1]);
    fill('#nBaseB', B, $('#nBaseW').value); fill('#nCompB', B, $('#nCompW').value);
    $('#npicker').hidden = false; $('#picker').hidden = true; $('#result').hidden = true;
    msgs([['ok', `识别到白盒模型 ${W.length} 个、黑盒模型 ${B.length} 个，请选择后点「计算」`]]);
  }
  function nativeApply() {
    const name = (w, b) => [w, b].filter(Boolean);
    const base = name($('#nBaseW').value, $('#nBaseB').value), comp = name($('#nCompW').value, $('#nCompB').value);
    const err = !base.length || !comp.length ? '基线和新模型各至少选一个 sheet' : base[0] === comp[0] ? '基线模型和新模型不能是同一个' : '';
    $('#nErr').textContent = err; $('#nErr').hidden = !err;
    if (err) return;
    // 「白盒名|黑盒名」别名，与 cli.js --models 相同；报告里用第一个名字
    const pick = [base, comp].map((n) => [...new Set(n)].join('|'));
    const L = V.native.toLong(nBooks, pick);
    const parsed = V.analyze.parseTables([{ sheets: L.sheets, label: '大表', defaultModel: '' }]);
    const warn = [...L.used.map((u) => `📄 ${u.model}（${u.black ? '黑盒' : '白盒'}）← ${u.label} / ${u.sheet}`), ...L.warnings, ...parsed.warnings];
    if (parsed.errors.length || parsed.modelOrder.length < 2) return fail([...parsed.errors.map((e) => ['err', e]), ['err', '选中的 sheet 里没有足够的有分数用例'], ...warn.map((w) => ['warn', w])]);
    parsed.comparisons = [{ base: base[0], comp: comp[0], label: `${comp[0]} vs ${base[0]}` }];
    state = { parsed, baseWarnings: warn };
    run();
  }

  function recompute() {
    const loaded = slots.filter((x) => x.sheets);
    if (!loaded.length) return;
    if (loaded.every((x) => V.native.isNativeBook(x.sheets))) return nativePicker(loaded);
    $('#npicker').hidden = true;
    const parts = loaded.map((x) => ({ sheets: x.sheets, defaultModel: x.name || stem(x.file), label: x.file }));
    const parsed = V.analyze.parseTables(parts);
    if (parsed.errors.length) return fail([...parsed.errors.map((e) => ['err', e]), ...parsed.warnings.map((w) => ['warn', w])]);
    const models = parsed.modelOrder;
    if (models.length < 2) return fail([['warn', `已识别模型：${models.join('、') || '无'}。还需要再导入一个模型的表。`]]);
    parsed.comparisons = parsed.comparisons.filter((c) => models.includes(c.base) && models.includes(c.comp));
    if (!parsed.comparisons.length) parsed.comparisons = models.slice(1).map((comp) => ({ base: models[0], comp, label: `${comp} vs ${models[0]}` }));
    state = { parsed, baseWarnings: parsed.warnings };
    buildPicker();
    run();
  }

  // 用当前 parsed.comparisons 计算并渲染
  function run() {
    const { parsed } = state;
    const A = V.analyze.analyze(parsed);
    msgs([...state.baseWarnings.map((w) => ['warn', w]), ...A.warnings.map((w) => ['warn', w])]);
    // 数字底稿只用于「核对报告数字」，页面不展示、不提供报告下载
    Object.assign(state, { A, facts: V.report.render(A) });
    $('#cmpSel').innerHTML = A.results.map((r, i) => `<option value="${i}">${esc(r.label)}</option>`).join('');
    $('#fp').textContent = `数据指纹 ${A.fingerprint.slice(0, 16)} · 记录 ${A.recordCount} · 有效 ${A.validCount}`;
    $('#result').hidden = false;
    render();
    if ($('#polished').value.trim()) $('#runCheck').click();
  }

  // ---------- 模型选择 ----------
  function pairRow(base, comp) {
    const opts = (sel) => state.parsed.modelOrder.map((m) => `<option${m === sel ? ' selected' : ''}>${esc(m)}</option>`).join('');
    const div = document.createElement('div');
    div.className = 'pair';
    div.innerHTML = `<label>基线模型 <select class="pBase">${opts(base)}</select></label>
      <span aria-hidden="true">→</span>
      <label>对比模型（新模型） <select class="pComp">${opts(comp)}</select></label>
      <button class="ghost pDel" aria-label="删除这组对比">删除</button>`;
    div.querySelector('.pDel').addEventListener('click', () => { div.remove(); });
    $('#pairs').appendChild(div);
  }
  function buildPicker() {
    const { parsed } = state;
    $('#modelCount').textContent = parsed.modelOrder.length;
    $('#modelList').textContent = parsed.modelOrder.join('、');
    $('#pairs').innerHTML = '';
    for (const c of parsed.comparisons) pairRow(c.base, c.comp);
    $('#pairErr').hidden = true;
    $('#picker').hidden = false;
  }
  function applyPairs() {
    const rows = [...document.querySelectorAll('#pairs .pair')];
    const list = rows.map((r) => ({ base: r.querySelector('.pBase').value, comp: r.querySelector('.pComp').value }));
    const err = !list.length ? '至少保留一组对比' : list.some((c) => c.base === c.comp) ? '基线模型和对比模型不能是同一个' : '';
    $('#pairErr').textContent = err;
    $('#pairErr').hidden = !err;
    if (err) return;
    // 沿用表格里同一组的自定义标题
    const old = state.parsed.comparisons;
    state.parsed.comparisons = list.map((c) => {
      const hit = old.find((o) => o.base === c.base && o.comp === c.comp);
      return { base: c.base, comp: c.comp, label: hit ? hit.label : `${c.comp} vs ${c.base}` };
    });
    run();
  }

  const cls = (x) => (x > 1e-12 ? 'up' : x < -1e-12 ? 'down' : '');
  const fD = (k, x) => (k === 'mean' ? F.scd(x) : F.pp(x));
  const fL = (k, x) => (k === 'mean' ? F.sc(x) : F.pct(x));
  const NAMES = { full: '满分率', mean: '平均分', prog: '有进展率' };

  // 置信区间森林图（SVG）
  function forest(res, k) {
    const rows = ['ID', 'OOD', 'OOD_W', 'OOD_B', 'ID_BI', 'ID_NBI'].map((s) => res.slices[s]).filter(Boolean);
    const vals = rows.flatMap((s) => [s.metrics[k].ciLo, s.metrics[k].ciHi, s.metrics[k].weightedDiff]).filter(isFinite);
    const ext = Math.max(0.05, ...vals.map(Math.abs)) * 1.1;
    const W = 560, L = 120, R = 20, rowH = 26, Hh = rows.length * rowH + 30;
    const x = (v) => L + ((v + ext) / (2 * ext)) * (W - L - R);
    const lab = (v) => (k === 'mean' ? v.toFixed(2) : (v * 100).toFixed(0) + 'pp');
    let g = `<line x1="${x(0)}" x2="${x(0)}" y1="4" y2="${Hh - 22}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="3 3"/>`;
    for (const v of [-ext, -ext / 2, ext / 2, ext]) g += `<text x="${x(v)}" y="${Hh - 6}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">${lab(v)}</text>`;
    g += `<text x="${x(0)}" y="${Hh - 6}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">0</text>`;
    rows.forEach((s, i) => {
      const t = s.metrics[k], y = 14 + i * rowH;
      const color = !s.testable ? '#8a8f99' : t.p < state.A.alpha ? (t.weightedDiff > 0 ? 'var(--up)' : 'var(--down)') : 'var(--accent)';
      g += `<text x="0" y="${y + 4}" font-size="12" fill="currentColor">${esc(s.name)}（${s.cases}）</text>`;
      if (isFinite(t.ciLo)) g += `<line x1="${x(t.ciLo)}" x2="${x(t.ciHi)}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="2"/>`;
      g += `<circle cx="${x(t.weightedDiff)}" cy="${y}" r="4" fill="${color}"><title>${esc(s.name)} ${fD(k, t.weightedDiff)} ${F.fmtCI(k, t)} p=${F.pv(t.p)}</title></circle>`;
    });
    return `<div class="ci"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${NAMES[k]}差值与置信区间">${g}</svg></div>`;
  }

  function distBar(L) {
    const w = (c) => (L.n ? (c / L.n) * 100 : 0);
    return `<div class="dist" title="0分 ${L.c0} / 1分 ${L.c1} / 2分 ${L.c2}"><span style="width:${w(L.c0)}%;background:#c9ced6"></span><span style="width:${w(L.c1)}%;background:#f0b44c"></span><span style="width:${w(L.c2)}%;background:#2f9e62"></span></div>`;
  }

  function coreTab(res) {
    const A = state.A, ci = Math.round(A.conf * 100);
    let h = '';
    for (const key of ['ID', 'OOD']) {
      const s = res.slices[key];
      if (!s) continue;
      const t = s.metrics.full;
      h += `<div class="card"><h2>${esc(s.name)} · ${s.cases} 个用例</h2><div class="kpis">`;
      for (const k of ['full', 'mean', 'prog']) {
        const m = s.metrics[k];
        h += `<div class="kpi"><div class="k">${NAMES[k]}${k === 'full' ? '（主指标）' : ''}</div>
          <div class="v ${cls(m.weightedDiff ?? m.meanDiff)}">${fD(k, m.weightedDiff ?? m.meanDiff)}</div>
          <div class="s">${fL(k, s.levelA[k])} → ${fL(k, s.levelB[k])}<br>${ci}% 区间 ${s.testable ? F.fmtCI(k, m) : '—'} · p=${s.testable ? F.pv(m.p) : '—'}<br>${F.dirCount(m)}</div></div>`;
      }
      h += `</div><div class="note">可分辨范围（${ci}% 区间半宽）：满分率 ${isFinite(t.mde) ? (t.mde * 100).toFixed(1) + 'pp' : '—'}，用例级差值标准差 SD_d ${isFinite(t.sd) ? (t.sd * 100).toFixed(1) + 'pp' : '—'}，t 临界值 ${isFinite(t.tcrit) ? t.tcrit.toFixed(4) : '—'}，df=${t.df}</div>
        <h3>0/1/2 三档分布</h3><div class="legend"><span><i style="background:#c9ced6"></i>0 分</span><span><i style="background:#f0b44c"></i>1 分</span><span><i style="background:#2f9e62"></i>2 分</span></div>
        <table><tr><th>模型</th><th>有效执行</th><th>0 分</th><th>1 分</th><th>2 分</th><th>pass@5</th><th class="l">分布</th></tr>
        ${[[res.base, s.levelA], [res.comp, s.levelB]].map(([n, L]) => `<tr><td>${esc(n)}</td><td>${L.n}</td><td>${L.c0}（${F.pct(L.c0 / L.n)}）</td><td>${L.c1}（${F.pct(L.c1 / L.n)}）</td><td>${L.c2}（${F.pct(L.c2 / L.n)}）</td><td>${F.pct(L.pass5)}</td><td class="l">${distBar(L)}</td></tr>`).join('')}</table></div>`;
    }
    h += `<div class="grid">${['full', 'mean'].map((k) => `<div class="card"><h2>${NAMES[k]}差值 · ${ci}% 置信区间</h2>${forest(res, k)}<div class="note">蓝色区间跨 0；绿/红为 p&lt;${A.alpha} 的提升/退步；灰色为用例数 &lt; ${A.config.最小检验用例数}、只报点估计的切面。</div></div>`).join('')}</div>`;
    const rows = Object.values(res.slices).map((s) => ['full', 'mean', 'prog'].map((k) => {
      const m = s.metrics[k], sig = s.testable && m.p < A.alpha;
      return `<tr class="${sig ? 'sig' : ''}"><td>${esc(s.name)}${s.main ? '' : '（探索性）'}</td><td class="l">${NAMES[k]}</td><td>${m.n}</td><td>${fL(k, s.levelA[k])}</td><td>${fL(k, s.levelB[k])}</td>
        <td class="${cls(m.weightedDiff ?? m.meanDiff)}">${fD(k, m.weightedDiff ?? m.meanDiff)}</td><td>${s.testable ? F.fmtCI(k, m) : '—'}</td><td>${s.testable ? F.pv(m.p) : '—'}</td><td>${F.dirCount(m)}</td></tr>`;
    }).join('')).join('');
    h += `<div class="card"><h2>全部切面</h2><div class="scroll"><table><tr><th>切面</th><th class="l">指标</th><th>用例数</th><th>${esc(res.base)}</th><th>${esc(res.comp)}</th><th>差值</th><th>${ci}% 区间</th><th>p</th><th>方向计数</th></tr>${rows}</table></div>
      <div class="note">高亮行 = p&lt;${A.alpha}。差值为两边加权水平直接相减（${esc(res.comp)} − ${esc(res.base)}），水平值按有效执行加权。</div></div>`;
    if (res.interaction) {
      const it = res.interaction;
      h += `<div class="card"><h2>ID × OOD 交互效应（落差是否扩大）</h2><table><tr><th>指标</th><th>OOD 差值 − ID 差值</th><th>${ci}% 区间</th><th>p（Welch）</th></tr>
        ${['full', 'mean', 'prog'].map((k) => `<tr><td>${NAMES[k]}</td><td class="${cls(it[k].diff)}">${fD(k, it[k].diff)}</td><td>${F.fmtCI(k, it[k])}</td><td>${F.pv(it[k].p)}</td></tr>`).join('')}</table>
        <div class="note">单模型的 ID-OOD 差距不可检验（题目不同源）；两模型落差的差异可以检验，这是唯一干净的泛化结论。</div></div>`;
    }
    return h;
  }

  function casesTab(res) {
    const rows = [];
    for (const key of ['ID', 'OOD']) {
      const s = res.slices[key];
      if (!s) continue;
      for (const c of s.caseDiffs) {
        const sub = Math.abs(c.dSucc) >= state.A.config.实质变化阈值;
        rows.push(`<tr><td>${key}</td><td class="l">${esc(c.caseId)}</td><td class="l">${esc(c.skill || '')}</td>
          <td>${c.a.c0}/${c.a.c1}/${c.a.c2}</td><td>${c.b.c0}/${c.b.c1}/${c.b.c2}</td>
          <td>${F.pct(c.a.full)}</td><td>${F.pct(c.b.full)}</td><td class="${cls(c.dFull)}">${F.pp(c.dFull)}</td>
          <td>${F.sc(c.a.mean)}</td><td>${F.sc(c.b.mean)}</td><td class="${cls(c.dSucc)}">${c.dSucc > 0 ? '+' : ''}${c.dSucc}${sub ? ' ●' : ''}</td></tr>`);
      }
    }
    return `<div class="card"><h2>用例级明细（检验的原始输入）</h2><div class="note">每行是一个配对样本。0/1/2 列为该用例各档得分次数；● 表示成功次数变化 ≥ ${state.A.config.实质变化阈值}（实质变化）。</div>
      <div class="scroll"><table><tr><th>场景</th><th class="l">用例ID</th><th class="l">Skill</th><th>${esc(res.base)} 0/1/2</th><th>${esc(res.comp)} 0/1/2</th><th>A 满分率</th><th>B 满分率</th><th>差值</th><th>A 均分</th><th>B 均分</th><th>成功次数差</th></tr>${rows.join('')}</table></div></div>`;
  }

  function skillsTab(res) {
    const one = (title, list) => !list.length ? '' : `<div class="card"><h2>${title}</h2><div class="scroll"><table>
      <tr><th class="l">Skill</th><th>用例数</th><th>A 均分</th><th>B 均分</th><th>均分差</th><th>A 满分率</th><th>B 满分率</th><th>满分率差</th><th>实质 升/降</th><th class="l">判定</th><th class="l">实质变化用例</th></tr>
      ${list.map((s) => `<tr class="${s.verdict.startsWith('构成证据') ? 'sig' : ''}"><td class="l">${esc(s.name)}</td><td>${s.cases}</td><td>${F.sc(s.levelA.mean)}</td><td>${F.sc(s.levelB.mean)}</td><td class="${cls(s.dMean)}">${F.scd(s.dMean)}</td>
        <td>${F.pct(s.levelA.full)}</td><td>${F.pct(s.levelB.full)}</td><td class="${cls(s.dFull)}">${F.pp(s.dFull)}</td><td>${s.subUp} / ${s.subDown}</td><td class="l">${s.verdict}</td>
        <td class="l">${s.changes.map((c) => `${esc(c.caseId)} ${c.from}→${c.to}`).join('，')}</td></tr>`).join('')}</table></div></div>`;
    return `<div class="card note">判别标准对正负对称：多个用例实质变化且方向一致 → 构成证据；方向混杂 → 平均值无意义；仅 1 个用例 → 单点观测；无实质变化 → 噪声。</div>` +
      one('ID · Skill 小类', res.skillsID) + one('OOD · Skill 小类', res.skillsOOD);
  }

  function tagsTab(res) {
    const one = (tg) => !tg || !tg.rows.length ? '' : `<div class="card"><h2>${tg.scope} 问题标签（${esc(res.base)} ${tg.nA} 次 / ${esc(res.comp)} ${tg.nB} 次有效执行）</h2>
      <table><tr><th class="l">标签</th><th>A 次数</th><th>B 次数</th><th>A 占比</th><th>B 占比</th><th>差值</th></tr>
      ${tg.rows.map((r) => `<tr><td class="l">${esc(r.tag)}</td><td>${r.a}</td><td>${r.b}</td><td>${F.pct(r.pa)}</td><td>${F.pct(r.pb)}</td><td class="${cls(-r.d)}">${F.pp(r.d)}</td></tr>`).join('')}</table>
      <div class="note">标签占比是失败形态描述，不做检验；占比上升标红（问题变多）。</div></div>`;
    return one(res.tagsID) + one(res.tagsOOD) || '<div class="card note">表格中没有填写问题标签。</div>';
  }

  function render() {
    const res = state.A.results[Number($('#cmpSel').value) || 0];
    $('#tab-core').innerHTML = coreTab(res);
    $('#tab-cases').innerHTML = casesTab(res);
    $('#tab-skills').innerHTML = skillsTab(res);
    $('#tab-tags').innerHTML = tagsTab(res);
  }

  function download(name, data, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const baseName = () => String(state.A.results[0].label).replace(/[\\/:*?"<>|]/g, '_');

  // ---------- 事件 ----------
  addSlot('表 1 · 白盒大表（或基线模型长表）');
  addSlot('表 2 · 黑盒大表（或新模型长表）');
  $('#nApply').addEventListener('click', nativeApply);
  $('#addSlot').addEventListener('click', () => addSlot(`表 ${slots.length + 1}`));
  $('#loadExample').addEventListener('click', async (e) => {
    e.preventDefault();
    for (const [i, n] of [[0, '基模测试记录-示例'], [1, '基模黑盒场景测试记录-示例']]) {
      const r = await fetch(`example/${n}.xlsx`);
      slots[i].setName('');
      await slots[i].take(new File([await r.arrayBuffer()], `${n}.xlsx`));
    }
  });
  $('#cmpSel').addEventListener('change', render);
  $('#addPair').addEventListener('click', () => {
    const m = state.parsed.modelOrder;
    pairRow(m[0], m[m.length - 1]);
  });
  $('#applyPairs').addEventListener('click', applyPairs);
  $('#uploadMd').addEventListener('click', () => $('#mdFile').click());
  $('#mdFile').addEventListener('change', async () => {
    const f = $('#mdFile').files[0];
    if (!f) return;
    $('#polished').value = await f.text();
    $('#mdName').textContent = `已载入 ${f.name}`;
    $('#mdFile').value = '';
    $('#runCheck').click();
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
  }));
  $('#dlJson').addEventListener('click', () => download(baseName() + '_结果.json', JSON.stringify(state.A, null, 2), 'application/json'));
  $('#dlXlsx').addEventListener('click', () => download(baseName() + '_复核表.xlsx', V.excel.build(state.parsed, state.A), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  $('#runCheck').addEventListener('click', () => {
    if (!$('#polished').value.trim()) { $('#checkOut').innerHTML = ''; return; }
    const banned = V.report.lintReport($('#polished').value);
    const bad = V.report.checkNumbers(state.facts, $('#polished').value);
    const banHtml = !banned.length ? ''
      : `<div class="msg err">🚫 ${banned.length} 处永久禁用语句（边界声明/内部提示，规则要求一律删除或改写）：</div><table><tr><th>行</th><th>规则</th><th class="l">原文</th></tr>${banned.map((b) => `<tr><td>${b.line}</td><td>${esc(b.rule)}</td><td class="l">${esc(b.text)}</td></tr>`).join('')}</table>`;
    const numHtml = !bad.length
      ? '<div class="msg" style="background:#e3f5ea;color:#145c36">✅ 报告中的所有数字都能在程序计算结果中找到出处</div>'
      : `<div class="msg err">❌ ${bad.length} 个数字在程序计算结果中找不到出处（日期、版本号、步数等非统计数字可忽略，其余需核对）：</div><table><tr><th>行</th><th>数字</th><th class="l">原文</th></tr>${bad.map((b) => `<tr><td>${b.line}</td><td>${esc(b.num)}</td><td class="l">${esc(b.text)}</td></tr>`).join('')}</table>`;
    $('#checkOut').innerHTML = banHtml + numHtml;
  });

  selfTest();
  V.app = { slots, recompute }; // 便于调试
})();
