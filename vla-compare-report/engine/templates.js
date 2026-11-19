// 报告模板注册表：报告类型 → 渲染器。
// 扩展方式：新建一个 engine/report_<类型>.js，在这里加一行；不修改任何已有渲染器、不修改计算脚本。
//   { name: '中文名', models: 模型数约定, desc: '一句话说明', render: (A) => md }
// 渲染器只接收 V.analyze 产出的结果对象 A，只能取数、排版、格式化，不允许做统计运算。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});

  // A.alias = { '数据源里的模型全名': '报告里显示的短名' }，缺省则原样输出
  function withAlias(A) {
    const alias = A.alias || {};
    const keys = Object.keys(alias);
    if (!keys.length) return A;
    const R = JSON.parse(JSON.stringify(A));
    for (const r of R.results || []) {
      const b = alias[r.base] || r.base, c = alias[r.comp] || r.comp;
      if (b !== r.base || c !== r.comp) r.label = r.base === r.comp ? `${c}（单模型）` : `${c} vs ${b}`;
      r.base = b; r.comp = c;
    }
    // 长名优先替换，避免「A模型」先吃掉「A模型_random10」这类前缀重叠
    const byLen = keys.slice().sort((x, y) => y.length - x.length);
    if (R.config && R.config.报告标题) for (const k of byLen) R.config.报告标题 = R.config.报告标题.split(k).join(alias[k]);
    return R;
  }

  const REGISTRY = {
    compare: {
      name: '双对比测试报告',
      models: '2 个或以上（第一个为基准，其余各自对基准）',
      desc: '一个基准对 1…7 个对比模型；带差值、90% 区间、p 值与显著性判词。4 个模型以上自动改用 N 模型版式',
      // 版式分派：2 组对比以内走既有双对比/三模型版式，3 组以上走 report_n.js（只换排版，不算数）
      render: (A) => (A.results.length <= 2 ? V.report.render(A) : V.reportN.render(A)),
    },
    single: {
      name: '单测试报告',
      models: '1',
      desc: '单个模型的绝对水平：满分率、平均分、有进展率、0/1/2 分布、Skill 小类、问题标签；无差值、无 p 值',
      render: (A) => V.reportSingle.render(A),
    },
  };

  V.templates = {
    ids: Object.keys(REGISTRY),
    get: (id) => REGISTRY[id],
    list: () => V.templates.ids.map((id) => ({ id, ...REGISTRY[id] })),
    render: (id, A) => {
      const t = REGISTRY[id];
      if (!t) throw new Error(`未知报告类型「${id}」，可用：${V.templates.ids.join(' / ')}`);
      // 显示名替换（规则维护：报告里模型名统一用短名）：只作用于渲染副本，
      // _结果.json / _复核表.xlsx 与 verify.py 仍用数据源里的全名做匹配。
      return t.render(withAlias(A));
    },
  };
})();
