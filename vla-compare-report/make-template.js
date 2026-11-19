#!/usr/bin/env node
// 生成空白填写模板与示例数据：node make-template.js
// 模板 = 原生「基模测试记录」格式：一个 sheet 一个模型，一行一个用例，T1..T5 各占「_分数/_标签/_测试详情」三列。
// sheet 命名：白盒「FT测试记录-〈模型名〉」，黑盒「FT黑盒测试记录-〈模型名〉」（sheet 名含「黑盒」即全部算黑盒 OOD）。
const fs = require('fs');
const path = require('path');
require('./engine/xlsx.js');
const X = globalThis.VLA.xlsx;
const H = (v) => ({ v, s: 1 });
const N = (v) => ({ v, s: 6 });

// 列名与顺序照用户下载的《基模测试记录》大表
const T = [];
for (let t = 1; t <= 5; t++) T.push(`T${t}_分数`, `T${t}_标签`, `T${t}_测试详情`);
const HEADER = ['用例ID', '0902-ft—ood', 'Stage', 'Story', 'Prompt', 'prompt_ch', 'Skill标签', 'Factor', 'Factor取值', '道具', '道具及摆放示例图', '布置图片', 'story(英文版）',
  ...T, '其他问题记录', '视频', '测试员', 'reviewer', '父记录', '测试机器'];
const W = HEADER.map((h) => (/_分数$/.test(h) ? 8 : /_标签$/.test(h) ? 14 : /_测试详情$/.test(h) ? 18 : h === 'Prompt' || h === 'prompt_ch' ? 26 : 12));

const guide = [
  [H('VLA 模型对比评测 · 填写说明（与《基模测试记录》大表同格式）')],
  [],
  [H('规则'), H('说明'), H('')],
  ['一个 sheet = 一个模型', '白盒 sheet 名「FT测试记录-〈模型名〉」，黑盒 sheet 名「FT黑盒测试记录-〈模型名〉」；可带日期前缀如「261009-」', '程序按去掉前缀后的模型名合并白盒/黑盒'],
  ['一行 = 一个用例', '同一用例在各模型 sheet 里的「用例ID」必须一致，配对检验按它对齐', ''],
  [],
  [H('列'), H('说明'), H('取值')],
  ['用例ID', '必填', '如 FT-02-1'],
  ['0902-ft—ood', '白盒 sheet 必填：id → ID 场景，ood → 白盒 OOD；黑盒 sheet 忽略此列，全部算黑盒 OOD', 'id / ood'],
  ['prompt_ch', '用例名称（空则取 Prompt）', '选填'],
  ['Skill标签', '逗号分隔；「双手协同」单独识别，其余取第一个作为 Skill 小类', '如「切割（Cut）,双手协同」'],
  ['T1_分数 … T5_分数', '每次执行得分；留空视为未执行', '0 / 1 / 2'],
  ['T1_标签 … T5_标签', '该次执行的问题标签，多个用 ; 或 、 分隔', '选填'],
  ['满分次数（可选列）', '若有，程序会和 T1..T5 数出的 2 分次数交叉核对', '选填'],
  ['其余列', '程序不读，照大表原样保留即可', ''],
  [],
  [N('口径：用例级聚合 → 两模型用例级差值 → 双侧配对 t 检验；α=0.10，90% 置信区间。计算全部由程序完成，不经过 LLM。')],
];

function write(file, sheets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, X.writeXlsx(sheets));
  console.log('已生成', file);
}
const sheet = (name, rows) => ({ name, rows, widths: W, freeze: 1 });

write(path.join(__dirname, 'templates', '评测数据模板.xlsx'), [
  sheet('FT测试记录-基线模型', [HEADER.map(H)]),
  sheet('FT测试记录-新模型', [HEADER.map(H)]),
  sheet('FT黑盒测试记录-基线模型', [HEADER.map(H)]),
  sheet('FT黑盒测试记录-新模型', [HEADER.map(H)]),
  { name: '填写说明', rows: guide, widths: [22, 70, 30] },
]);

// ---------- 示例数据（合成，可复现）：一本白盒大表 + 一本黑盒大表，各含两个模型 ----------
let seed = 20261013;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const SK = ['抓取（Pick）', '放置（Place）', '折叠（Fold）', '固定（Hold）', '展开（Unfold）', '倾倒（Pour）', '调整（Adjust）', '悬挂（Hang）'];
const TAGS = ['动作精度不足', '抓取失败', '质量瑕疵', '重试完成', '无有效动作', '目标位置错误'];
const white = [], black = [];
for (let i = 1; i <= 52; i++) white.push({ id: `SYN-${String(i).padStart(3, '0')}`, scope: 'id', skill: SK[i % SK.length], bi: i % 3 === 0, p: rnd() });
for (let i = 1; i <= 9; i++) white.push({ id: `SYN-${String(52 + i).padStart(3, '0')}`, scope: 'ood', skill: SK[i % 4], bi: i % 4 === 0, p: rnd() });
// 黑盒前 12 例标 id（= OOD 2.0 部分），其余留空（= OOD 3.0 新增）
for (let i = 1; i <= 24; i++) black.push({ id: `SYN-BB-${String(i).padStart(3, '0')}`, scope: i <= 12 ? 'id' : '', skill: SK[i % 4], bi: i % 4 === 0, p: rnd() });
const models = [{ name: '基线模型', shift: 0 }, { name: '新模型', shift: 0.04 }];
function rowsFor(cases, m) {
  const out = [HEADER.map(H)];
  for (const c of cases) {
    const p = Math.min(0.95, Math.max(0.02, c.p + m.shift + (c.skill.startsWith('折叠') && m.shift ? 0.3 : 0) + (rnd() - 0.5) * 0.2));
    const r = Object.fromEntries(HEADER.map((h) => [h, '']));
    Object.assign(r, { 用例ID: c.id, '0902-ft—ood': c.scope, prompt_ch: `示例用例 ${c.id}`, Skill标签: c.skill + (c.bi ? ',双手协同' : '') });
    for (let t = 1; t <= 5; t++) {
      const u = rnd();
      const s = u < p ? 2 : u < p + (1 - p) * 0.45 ? 1 : 0;
      r[`T${t}_分数`] = String(s);
      r[`T${t}_标签`] = s === 2 ? (rnd() < 0.1 ? '重试完成' : '') : TAGS[Math.floor(rnd() * (c.scope === 'ood' ? 6 : 5))];
    }
    out.push(HEADER.map((h) => r[h]));
  }
  return out;
}
write(path.join(__dirname, 'example', '基模测试记录-示例.xlsx'), models.map((m) => sheet(`FT测试记录-${m.name}`, rowsFor(white, m))));
write(path.join(__dirname, 'example', '基模黑盒场景测试记录-示例.xlsx'), models.map((m) => sheet(`FT黑盒测试记录-${m.name}`, rowsFor(black, m))));
