#!/usr/bin/env python3
"""独立复算：用 Python 标准库读 xlsx + scipy 重算全部统计量，与 cli.js 输出的 _结果.json 逐项比对。

用法：python3 verify.py 结果.json            （按 JSON 里记录的源文件路径重读表格）
      python3 verify.py 结果.json 表1.xlsx 表2.xlsx
实现与 JS 引擎互不共享代码，两边一致才说明数字可信。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
ood2 = set()
not2 = set()
from scipy import stats

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def read_xlsx(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    out = {}
    for sh in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", NS):
        t = rels[sh.get(RNS)]
        t = t[1:] if t.startswith("/") else "xl/" + t
        rows = {}
        for row in ET.fromstring(z.read(t)).iter("{%s}row" % NS["m"]):
            r = {}
            for c in row.findall("m:c", NS):
                col = 0
                for ch in re.match(r"[A-Z]+", c.get("r")).group():
                    col = col * 26 + ord(ch) - 64
                typ, v = c.get("t"), c.find("m:v", NS)
                if typ == "s":
                    val = shared[int(v.text)]
                elif typ == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
                elif v is None:
                    val = ""
                elif typ in ("str", "e", "b"):
                    val = v.text
                else:
                    val = float(v.text)
                r[col - 1] = val
            rows[int(row.get("r")) - 1] = [r.get(i, "") for i in range(max(r) + 1)] if r else []
        out[sh.get("name")] = [rows.get(i, []) for i in range(max(rows) + 1)] if rows else []
    return out


def s(v):
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def load_records(book, default_model=""):
    name = next((n for n in book if n.strip() in ("执行明细", "数据", "data")), list(book)[0])
    rows = book[name]
    hi = next(i for i, r in enumerate(rows)
              if any(s(c) in ("模型", "model") for c in r) or ({"得分", "场景"} <= {s(c) for c in r}))
    head = [s(c).replace(" ", "").lower() for c in rows[hi]]

    def col(*names):
        for n in names:
            n = n.replace(" ", "").lower()
            if n in head:
                return head.index(n)
        return -1

    ci = dict(model=col("模型", "model"), scope=col("场景", "场景类型", "scope", "ID/OOD"),
              ood=col("OOD类型", "白盒/黑盒", "ood_type"), case=col("用例ID", "用例编号", "case_id"), name=col("用例名称", "任务名称", "case_name"),
              score=col("得分", "分数", "score"), ood2=col("OOD2.0", "ood2"), valid=col("是否有效", "有效", "valid"))
    recs = []
    for r in rows[hi + 1:]:
        g = lambda k: s(r[ci[k]]) if ci[k] >= 0 and ci[k] < len(r) else ""
        if not any(s(c) for c in r):
            continue
        sc = g("score")
        valid = sc != "" and g("valid") not in ("否", "n", "no", "false", "0", "FALSE", "N", "×", "无效")
        scope = "ID" if g("scope").upper() in ("ID", "IND") else "OOD"
        ood = g("ood")
        ood = "白盒" if "白" in ood or "white" in ood.lower() else "黑盒" if "黑" in ood or "black" in ood.lower() else ood
        recs.append(dict(model=g("model") or default_model, scope=scope, case=g("case") or g("name"), ood=ood if scope == "OOD" else "", ood2=scope == "OOD" and g("ood2") == "是",
                         score=float(sc) if valid else None))
    return recs


def case_metrics(recs):
    agg = defaultdict(list)
    meta = {}
    global ood2
    for r in recs:
        if r["score"] is not None:
            agg[(r["model"], r["scope"], r["case"])].append(r["score"])
        meta.setdefault((r["scope"], r["case"]), r["ood"] or meta.get((r["scope"], r["case"]), ""))
        if r["scope"] == "OOD":
            # 任一记录标为非 2.0 即按 3.0 新增（与 engine/analyze.js 一致）
            k = (r["scope"], r["case"])
            if r["ood2"] and k not in not2:
                ood2.add(k)
            elif not r["ood2"]:
                not2.add(k); ood2.discard(k)
    m = {}
    for k, v in agg.items():
        v = np.array(v)
        m[k] = dict(full=np.mean(v == 2), mean=np.mean(v), prog=np.mean(v >= 1),
                    n=len(v), s_full=float((v == 2).sum()), s_mean=float(v.sum()), s_prog=float((v >= 1).sum()))
    return m, meta


def skill_tokens(label):
    """Skill 标签按分隔符拆成多个小类（与 engine/analyze.js skillTags 一致，用户 2026-11-11 定）。"""
    src, out, buf, depth = label or "", [], "", 0
    for ch in src:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if depth == 0 and ch in " \t\n、,，;；/":
            if buf.strip():
                out.append(buf.strip())
            buf = ""
            continue
        buf += ch
    if buf.strip():
        out.append(buf.strip())
    return set(out) if out else {"（未标注）"}


def case_p(a, b):
    """单用例逐次得分配对 t（与 engine/math.js pairedT 的门槛处理一致）。"""
    a, b = np.array(a, dtype=float), np.array(b, dtype=float)
    d = b - a
    if len(d) > 1 and d.std(ddof=1) > 1e-12:
        return float(stats.ttest_rel(b, a).pvalue)
    return 0.0 if abs(d.mean()) > 1e-12 else 1.0


def paired(a, b, conf):
    a, b = np.array(a), np.array(b)
    d = b - a
    out = dict(n=len(d), meanDiff=d.mean(), up=int((d > 1e-12).sum()), down=int((d < -1e-12).sum()))
    if len(d) > 1 and d.std(ddof=1) > 1e-12:
        out["p"] = stats.ttest_rel(b, a).pvalue
        out["lo"], out["hi"] = stats.t.interval(conf, len(d) - 1, loc=d.mean(), scale=stats.sem(d))
    return out


def main(result_json, files):
    A = json.load(open(result_json, encoding="utf-8"))
    srcs = A.get("sources") or []
    if not files:
        files = [x["file"] for x in srcs]
    if not files:
        print("结果 JSON 未记录源文件，请在命令行给出表格路径")
        sys.exit(2)
    recs = []
    for i, f in enumerate(files):
        recs += load_records(read_xlsx(f), srcs[i]["defaultModel"] if i < len(srcs) else "")
    m, meta = case_metrics(recs)
    conf = A["conf"]
    checked, bad = 0, []
    preds = {"ID": lambda sc, o: sc == "ID", "OOD": lambda sc, o: sc == "OOD",
             "OOD2": lambda sc, o, c=None: c in ood2, "OOD3N": lambda sc, o, c=None: sc == "OOD" and c not in ood2, "OOD_W": lambda sc, o: sc == "OOD" and o == "白盒", "OOD_B": lambda sc, o: sc == "OOD" and o == "黑盒"}
    for res in A["results"]:
        base, comp = res["base"], res["comp"]
        for key, pred in preds.items():
            if key not in res["slices"]:
                continue
            cases = sorted(c for c in meta if (pred(c[0], meta[c], c) if key in ("OOD2", "OOD3N") else pred(c[0], meta[c])) and (base, *c) in m and (comp, *c) in m)
            for k in ("full", "mean", "prog"):
                ref = paired([m[(base, *c)][k] for c in cases], [m[(comp, *c)][k] for c in cases], conf)
                got = res["slices"][key]["metrics"][k]
                # 执行加权差：两模型各自「汇总次数 ÷ 有效执行数」后相减
                # 水平口径：各模型用自己在该切面的全部有效执行（不要求另一模型也有）
                own = lambda mod: [c for c in meta if (pred(c[0], meta[c], c) if key in ("OOD2", "OOD3N") else pred(c[0], meta[c])) and (mod, *c) in m]
                pool = lambda mod: sum(m[(mod, *c)]["s_" + k] for c in own(mod)) / sum(m[(mod, *c)]["n"] for c in own(mod))
                ref["weightedDiff"] = pool(comp) - pool(base)
                if "lo" in ref:  # 展示区间 = 配对区间平移到执行加权差
                    ref["ciLo"] = ref["lo"] + ref["weightedDiff"] - ref["meanDiff"]
                    ref["ciHi"] = ref["hi"] + ref["weightedDiff"] - ref["meanDiff"]
                for f, v in ref.items():
                    checked += 1
                    if got.get(f) is None or abs(got[f] - v) > 1e-9:
                        bad.append(f"{res['label']} {key} {k}.{f}: JS={got.get(f)} Python={v}")
    c2, b2 = check_skill_tag(A, files, srcs)
    checked += c2
    bad += b2
    print(f"复核 {checked} 项统计量（含 Skill / 标签 {c2} 项），不一致 {len(bad)} 项")
    for b in bad:
        print("  ❌", b)
    sys.exit(1 if bad else 0)


def check_skill_tag(A, files, srcs):
    """Skill 表与标签表复算：各模型用自己在该范围的全部有效执行（用户 2026-10-26 定），不要求另一模型也有。"""
    rows = []
    for i, f in enumerate(files):
        book = read_xlsx(f)
        name = next((n for n in book if n.strip() in ("执行明细", "数据", "data")), list(book)[0])
        rs = book[name]
        hi = next(j for j, r in enumerate(rs) if any(s(c) in ("模型", "model") for c in r) or ({"得分", "场景"} <= {s(c) for c in r}))
        head = [s(c).replace(" ", "") for c in rs[hi]]
        ix = lambda *ns: next((head.index(n) for n in ns if n in head), -1)
        ci = dict(model=ix("模型"), scope=ix("场景"), case=ix("用例ID"), skill=ix("Skill"), score=ix("得分"), tags=ix("问题标签"), valid=ix("是否有效"))
        dm = srcs[i]["defaultModel"] if i < len(srcs) else ""
        for r in rs[hi + 1:]:
            g = lambda k: s(r[ci[k]]) if 0 <= ci[k] < len(r) else ""
            if not any(s(c) for c in r):
                continue
            sc = g("score")
            ok = sc != "" and g("valid") not in ("否", "n", "no", "false", "0", "FALSE", "N", "×", "无效")
            rows.append(dict(model=g("model") or dm, scope="ID" if g("scope").upper() in ("ID", "IND") else "OOD", case=g("case"), skill=g("skill"),
                             score=float(sc) if ok else None, tags=[t.strip() for t in re.split(r"[;；,，、|/\n]+", g("tags")) if t.strip() and t.strip() not in ("无", "-")] if ok else []))
    skill = {}
    for r in rows:
        skill.setdefault((r["scope"], r["case"]), r["skill"] or "（未标注）")
    checked, bad = 0, []

    def cmp(label, got, want):
        nonlocal checked
        checked += 1
        gn = got is None or (isinstance(got, float) and np.isnan(got))
        wn = want is None or (isinstance(want, float) and np.isnan(want))
        if gn != wn or (not gn and abs(got - want) > 1e-9):
            bad.append(f"{label}: JS={got} Python={want}")

    for res in A["results"]:
        for scope, f in (("ID", "skillsID"), ("OOD", "skillsOOD")):
            for row in res.get(f, []):
                if row["name"] == "双手协同":
                    continue  # §5.3 单列，Skill 小类表不含该行
                for side, mod in (("A", res["base"]), ("B", res["comp"])):
                    sc = [r["score"] for r in rows if r["model"] == mod and r["scope"] == scope and r["score"] is not None and row["name"] in skill_tokens(skill[(scope, r["case"])])]
                    ncase = len({r["case"] for r in rows if r["model"] == mod and r["scope"] == scope and r["score"] is not None and row["name"] in skill_tokens(skill[(scope, r["case"])])})
                    v = np.array(sc)
                    lab = f"{res['label']} {f} {row['name']} {mod}"
                    cmp(lab + " 用例数", row.get("cases" + side), ncase)
                    cmp(lab + " 均分", row["level" + side].get("mean"), v.mean() if len(v) else None)
                    cmp(lab + " 满分率", row["level" + side].get("full"), np.mean(v == 2) if len(v) else None)
        for scope, f in (("ID", "tagsID"), ("OOD", "tagsOOD")):
            tg = res.get(f)
            if not tg:
                continue
            for side, mod in (("A", res["base"]), ("B", res["comp"])):
                runs = [r for r in rows if r["model"] == mod and r["scope"] == scope and r["score"] is not None]
                cmp(f"{res['label']} {f} {mod} 执行数", tg["n" + side], len(runs))
                for row in tg["rows"]:
                    k = sum(1 for r in runs if row["tag"] in set(r["tags"]))
                    cmp(f"{res['label']} {f} {row['tag']} {mod} 次数", row[side.lower()], k)
                    cmp(f"{res['label']} {f} {row['tag']} {mod} 占比", row["p" + side.lower()], k / len(runs) if runs else None)

        raws = {}
        for r in rows:
            if r["score"] is not None:
                raws.setdefault((r["model"], r["scope"], r["case"]), []).append(r["score"])
        thr = float((A.get("config") or {}).get("趋势阈值") or 0.4)
        alpha = float(A["alpha"])
        def check_cases(scope, ood2_only, field, tag):
            exp = {}
            keys = {r["case"] for r in rows if r["scope"] == scope and (not ood2_only or (scope, r["case"]) in ood2)}
            for case in keys:
                a = raws.get((res["base"], scope, case), [])
                b = raws.get((res["comp"], scope, case), [])
                if len(a) != len(b) or len(a) < 2:
                    continue
                aa, bb = np.array(a, float), np.array(b, float)
                dm, dfull = bb.mean() - aa.mean(), (bb == 2).mean() - (aa == 2).mean()
                if abs(dm) < 1e-9 and abs(dfull) < 1e-9:
                    continue
                p = case_p(a, b)
                up, down = int(((bb - aa) > 1e-12).sum()), int(((bb - aa) < -1e-12).sum())
                sig = p < alpha
                trend = (not sig) and abs(dm) >= thr and (up >= 4 or down >= 4)
                if sig or trend:
                    exp[case] = (float(dm), float(dfull), float(p))
            got = {row["caseId"]: (float(row["dMean"]), float(row["dFull"]), float(row["p"])) for row in res.get(field, [])}
            cmp(f"{res['label']} {tag} 用例变化 条数", len(got), len(exp))
            for case in sorted(set(exp) | set(got)):
                if case not in got:
                    bad.append(f"{res['label']} {tag} 用例变化 {case} 缺失")
                elif case not in exp:
                    bad.append(f"{res['label']} {tag} 用例变化 {case} 多出")
                else:
                    cmp(f"{res['label']} {tag} 用例变化 {case} 均分差", got[case][0], exp[case][0])
                    cmp(f"{res['label']} {tag} 用例变化 {case} 满分率差", got[case][1], exp[case][1])
                    cmp(f"{res['label']} {tag} 用例变化 {case} p", got[case][2], exp[case][2])

        check_cases("ID", False, "caseChangesID", "ID")
        check_cases("OOD", False, "caseChangesOOD", "OOD")
        check_cases("OOD", True, "caseChangesOOD2", "OOD2")
    return checked, bad


if __name__ == "__main__":
    if len(sys.argv) < 2 or not sys.argv[1].endswith(".json"):
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2:])
