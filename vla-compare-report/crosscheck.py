#!/usr/bin/env python3
"""跨报告一致性核对：本轮结果里与旧报告重合的模型，逐项比对单模型的数字。

用法：python3 crosscheck.py 本轮结果1.json [本轮结果2.json ...] [--desk 报告目录] [--exclude 报告文件名前缀]
      python3 crosscheck.py 本轮结果.json --prev 旧结果.json      （对旧 _结果.json 做全量逐项比对）
  默认：对每个重合模型，在桌面（--desk）找标题含该模型、修改时间最新的一份报告 .md（排除本轮报告和单模型数字文档），
  读它第 4 节核心指标表（ID / OOD 3.0 / OOD 2.0 的满分率、平均分、有进展率、pass@5、0 分占比），与本轮展示值逐项比对。
  本轮多份结果之间共有的模型（如同一个新模型对两个基线）也互相比对。
--prev 模式比对单模型水平（不是差值）：各切面的用例数、有效执行数、0/1/2 分次数、各项水平，以及 Skill 小类水平和问题标签次数；
两边交集用例数不同时水平不可直接比，只提示、不判不一致。
只读 _结果.json，不改 engine / cli.js / verify.py。
"""
import glob
import json
import os
import sys

SLICE_FIELDS = ["cases", "n", "c0", "c1", "c2", "full", "mean", "prog", "zero", "pass5"]
PCT = {"full", "prog", "zero", "pass5"}
SLICE_NAME = {"ID": "ID", "OOD": "OOD 3.0", "OOD2": "OOD 2.0", "OOD3N": "OOD 3.0 新增", "OOD_W": "白盒OOD",
              "OOD_B": "黑盒OOD", "ID_BI": "ID-双手协同", "ID_NBI": "ID-非双手协同", "ALL": "全部"}


def fmt(field, v):
    if v is None:
        return "—"
    if field in PCT:
        return "%.1f%%" % (v * 100)
    if field == "mean":
        return "%.2f" % v
    return "%g" % v


def models_in(path):
    """返回 [(模型名, 该模型在某一对比组里的全部单模型数字)]；三模型结果里基准出现在两组，各记一条"""
    d = json.load(open(path, encoding="utf-8"))
    out = []
    for r in d["results"]:
        for side, m in (("levelA", r["base"]), ("levelB", r["comp"])):
            tag_side = "a" if side == "levelA" else "b"
            out.append((m, dict(
                file=path,
                pair=r["label"],
                slices={k: s[side] for k, s in r["slices"].items() if s.get(side)},
                skillsID={x["name"]: x[side] for x in r.get("skillsID", [])},
                skillsOOD={x["name"]: x[side] for x in r.get("skillsOOD", [])},
                tagsID={x["tag"]: x[tag_side] for x in r["tagsID"]["rows"]} if r.get("tagsID") else {},
                tagsOOD={x["tag"]: x[tag_side] for x in r["tagsOOD"]["rows"]} if r.get("tagsOOD") else {},
            )))
    return out


def same(a, b):
    if a is None or b is None:
        return a is b
    return abs(float(a) - float(b)) < 1e-9


def compare(m, new, old):
    """返回 (比对项数, 不一致列表, 提示列表)"""
    diffs, notes, count = [], [], 0
    for key in sorted(set(new["slices"]) | set(old["slices"]), key=lambda k: list(SLICE_NAME).index(k) if k in SLICE_NAME else 99):
        name = SLICE_NAME.get(key, key)
        a, b = new["slices"].get(key), old["slices"].get(key)
        if a is None or b is None:
            notes.append("%s：只有一边有该切面" % name)
            continue
        if a.get("cases") != b.get("cases"):
            notes.append("%s：交集用例数不同（本轮 %s / 旧 %s），水平不可直接比" % (name, a.get("cases"), b.get("cases")))
            continue
        for f in SLICE_FIELDS:
            count += 1
            if not same(a.get(f), b.get(f)):
                diffs.append("%s %s：本轮 %s / 旧 %s" % (name, f, fmt(f, a.get(f)), fmt(f, b.get(f))))
    for scope in ("skillsID", "skillsOOD"):
        label = "Skill(ID)" if scope == "skillsID" else "Skill(OOD)"
        for sk in sorted(set(new[scope]) | set(old[scope])):
            a, b = new[scope].get(sk), old[scope].get(sk)
            if a is None or b is None:
                diffs.append("%s %s：只有一边有" % (label, sk))
                continue
            for f in ("cases", "n", "full", "mean"):
                count += 1
                if not same(a.get(f), b.get(f)):
                    diffs.append("%s %s %s：本轮 %s / 旧 %s" % (label, sk, f, fmt(f, a.get(f)), fmt(f, b.get(f))))
    for scope in ("tagsID", "tagsOOD"):
        label = "标签(ID)" if scope == "tagsID" else "标签(OOD)"
        for t in sorted(set(new[scope]) | set(old[scope])):
            a, b = new[scope].get(t, 0), old[scope].get(t, 0)
            count += 1
            if a != b:
                diffs.append("%s %s 次数：本轮 %s / 旧 %s" % (label, t, a, b))
    return count, diffs, notes


METRIC_ROWS = {"满分率": "full", "平均分": "mean", "有进展率": "prog", "pass@5": "pass5", "0 分占比": "zero"}


def scope_of(text):
    if "OOD 2.0" in text:
        return "OOD2"
    if "OOD 3.0" in text or "OOD 场景" in text:
        return "OOD"
    if "ID" in text and "OOD" not in text:
        return "ID"
    return None


def md_core(path, model):
    """从报告 .md 的第 4 节核心指标表里读出某模型 ID / OOD 3.0 / OOD 2.0 的五项水平（展示值字符串）"""
    out, scope, in4 = {}, None, False
    lines = open(path, encoding="utf-8").read().split("\n")
    i = 0
    while i < len(lines):
        l = lines[i].strip()
        if l.startswith("## "):
            in4 = l.startswith("## 4")
        if in4 and not l.startswith("|"):
            s = scope_of(l) if (l.startswith("#") or l.startswith("**")) else None
            scope = s or scope
        if in4 and l.startswith("|") and i + 1 < len(lines) and set(lines[i + 1].replace("|", "").strip()) <= set("-: "):
            head = [c.strip() for c in l.strip("|").split("|")]
            if _bare(model) in [_bare(h) for h in head] and "指标" in head:
                col, set_col = [_bare(h) for h in head].index(_bare(model)), head.index("测试集") if "测试集" in head else None
                row_scope = scope
                j = i + 2
                while j < len(lines) and lines[j].strip().startswith("|"):
                    cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                    if set_col is not None and cells[set_col]:
                        row_scope = scope_of(cells[set_col]) or row_scope
                    name = cells[head.index("指标")]
                    key = next((v for k, v in METRIC_ROWS.items() if name.startswith(k)), None)
                    if key and row_scope:
                        out[(row_scope, key)] = cells[col]
                    j += 1
                i = j
                continue
        i += 1
    return out


def md_report(model, new, md_path):
    old = md_core(md_path, model)
    print("\n[%s] 对照旧报告（核心指标）" % model)
    print("  本轮：%s（%s）" % (os.path.basename(new["file"]), new["pair"]))
    print("  对照：%s" % md_path)
    if not old:
        # 读不到就算不通过，不能默默跳过后报「全部一致」（2026-10-30 修）
        print("  ❌ 旧报告第 4 节里没读到该模型的核心指标表，无法核对；用 --prev 指定旧 _结果.json 再跑")
        return False
    diffs = []
    for (sc, f), shown in sorted(old.items()):
        lv = new["slices"].get(sc)
        mine = fmt(f, lv.get(f)) if lv else "—"
        if mine != shown:
            diffs.append("%s %s：本轮 %s / 旧报告 %s" % (SLICE_NAME[sc], f, mine, shown))
    if diffs:
        print("  ❌ %d 项不一致（共比对 %d 项）：" % (len(diffs), len(old)))
        for x in diffs:
            print("     - " + x)
    else:
        print("  ✅ 一致（共比对 %d 项：%s）" % (len(old), "、".join(sorted({SLICE_NAME[s] for s, _ in old}, key=list(SLICE_NAME.values()).index))))
    return not diffs


def _bare(name):
    name = name.strip()
    return name[:-2] if name.endswith("模型") else name


def title_models(basename):
    """从报告文件名里取出模型名列表：「A模型 vs B模型 [基模]测试对比报告_时间戳.md」→ [A, B]。
    按「 vs 」切开后整词比较，避免「5w」误匹配「45w」「5w-rtc」（2026-10-30 修）"""
    head = basename.split("测试对比报告")[0]
    if head == basename:
        return []
    head = head.strip()
    if head.endswith("基模"):
        head = head[:-2]
    return [_bare(x) for x in head.split(" vs ") if x.strip()]


def latest_md(model, desk, exclude_names):
    """桌面上标题里有该模型（整词匹配）、修改时间最新的一份报告（排除本轮报告和单模型数字文档）"""
    c = [p for p in glob.glob(os.path.join(desk, "*.md"))
         if _bare(model) in title_models(os.path.basename(p)) and "单模型" not in p
         and not any(os.path.basename(p).startswith(t) for t in exclude_names)]
    return max(c, key=os.path.getmtime) if c else None


def report(m, new, old, title):
    count, diffs, notes = compare(m, new, old)
    print("\n[%s] %s" % (m, title))
    print("  本轮：%s（%s）" % (os.path.basename(new["file"]), new["pair"]))
    print("  对照：%s（%s）" % (old["file"], old["pair"]))
    for n in notes:
        print("  ⚠️ " + n)
    if diffs:
        print("  ❌ %d 项不一致（共比对 %d 项）：" % (len(diffs), count))
        for x in diffs:
            print("     - " + x)
    else:
        print("  ✅ 一致（共比对 %d 项）" % count)
    return not diffs


def main(argv):
    new_files, prev_files, exclude_md = [], [], []
    desk = os.path.expanduser("~/Desktop")
    mode = new_files
    it = iter(argv)
    for a in it:
        if a == "--prev":
            mode = prev_files
        elif a == "--desk":
            desk = next(it)
        elif a == "--exclude":
            exclude_md.append(os.path.basename(next(it)))
        else:
            mode.append(a)
    if not new_files:
        print(__doc__)
        return 2
    new = {}
    for f in new_files:
        for m, v in models_in(f):
            new.setdefault(m, []).append(v)
    ok = True
    # 本轮内部：同一模型出现在多份结果或同一份三模型结果的多组里
    for m, vs in new.items():
        for v in vs[1:]:
            ok &= report(m, v, vs[0], "本轮内部互比")
    # 对旧报告：默认读桌面上最新一版报告 .md 的核心指标；--prev 给旧 _结果.json 时做全量逐项比对
    # 本轮报告（标题 = 本轮结果的报告标题）不算旧报告
    exclude_md += [json.load(open(f, encoding="utf-8"))["config"]["报告标题"] for f in new_files]
    prev = {}
    for f in prev_files:
        for m, v in models_in(f):
            prev.setdefault(m, v)
    for m, vs in new.items():
        if prev_files:
            if m in prev:
                ok &= report(m, vs[0], prev[m], "对照旧结果")
            continue
        md = latest_md(m, desk, set(exclude_md))
        if md is None:
            print("\n[%s] 桌面上没有含该模型的旧报告，跳过（新模型首次出现）" % m)
            continue
        ok &= md_report(m, vs[0], md)
    print("\n" + ("✅ 重合模型全部一致" if ok else "❌ 有不一致，交付前要查明原因（数据表是否改过、是否换了 sheet）并告诉用户"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
