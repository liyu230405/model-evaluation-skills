#!/usr/bin/env python3
"""基模测试质检初筛 v2。只用 Python 标准库，不用装任何包。

用法：
  python3 prescreen.py baseline 全量表.xlsx [-o baseline.json]
      从历史全量表建基线（每个用例在历史模型上的分数分布、常见标签、人工难度）。
  python3 prescreen.py screen 当天的表.xlsx [--sheet 名称] [--baseline baseline.json] [--new-testers 甲,乙] [-o 输出目录]
      给一个 sheet 的每条试验分档：退回 / 必复核 / 抽检 / 通过。输出五个文件：
      复查报告、复核清单、逐条明细、复核回执、汇总。
  python3 prescreen.py compare 原版.xlsx 终版.xlsx --orig-sheet 名称 --final-sheet 名称 [-o 输出目录]
      QC 前原版 vs QC 后终版：列出改动，算每条规则的召回和精度。两个 sheet 在同一个文件里时，两个路径填同一个。
  python3 prescreen.py audit 复核回执.csv --require-closed [-o 输出目录]
      输出未闭环清单、推荐项精度、盲抽漏检与抽样估计召回；有未闭环项时严格模式失败。

分档规则见 RULES；按当前规则表和标签矩阵检查，不据此自动修改分数。
历史均分用于 V5 异常复核，但不用于退回或自动改分；人工难度只作参照。
标签共标由「标签共存矩阵.csv」统一驱动，QC 改判词也计入 compare 和复核回执。
"""
import argparse
import collections as C
import csv
import datetime as dt
import functools
import hashlib
import itertools
import json
import math
import os
import random
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

# ---------- 读 xlsx ----------
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
# ---------- 解析 sheet ----------
STD_TAGS = ["重试完成", "对象识别错误", "目标位置错误", "约束违背", "动作方式不当", "碰撞", "动作精度不足",
            "抓取失败", "质量瑕疵", "结果失效", "无有效动作", "过度执行", "部分完成"]
ALLOWED_TAGS = set(STD_TAGS) | {"其他"}
# 部分完成只作兜底：已有这些具体失败标签时不再叠加（和 2026-11-16 数据检验里验证过的口径一致）
SPEC = {"抓取失败", "动作精度不足", "动作方式不当", "对象识别错误", "目标位置错误", "结果失效", "约束违背"}
DEFAULT_TAG_MATRIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "标签共存矩阵.csv")


@functools.lru_cache(maxsize=8)
def _load_tag_matrix(path):
    """读取对称共存矩阵；✓ 表示可共存，其他单元格为命中规则编号。"""
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        raise ValueError("标签共存矩阵为空：%s" % path)
    tags = rows[0][1:]
    if len(tags) != len(set(tags)) or set(tags) != ALLOWED_TAGS:
        raise ValueError("标签共存矩阵表头必须恰好包含 13 个标准标签和「其他」。")
    raw, conflicts = {}, {}
    for row in rows[1:]:
        if not row or not row[0]:
            continue
        if len(row) != len(tags) + 1 or row[0] not in tags:
            raise ValueError("标签共存矩阵存在缺列或未知行标签：%s" % row)
        for col, cell in zip(tags, row[1:]):
            cell = cell.strip()
            raw[(row[0], col)] = cell
            if row[0] == col:
                if cell != "—":
                    raise ValueError("标签共存矩阵对角线必须填「—」。")
            elif cell == "✓":
                continue
            elif re.fullmatch(r"R\d+", cell):
                conflicts[frozenset((row[0], col))] = cell
            else:
                raise ValueError("矩阵单元格只能填 ✓、— 或退回规则编号：%s/%s=%s" % (row[0], col, cell))
    if set(raw) != {(a, b) for a in tags for b in tags}:
        raise ValueError("标签共存矩阵行集合与表头不一致。")
    for (a, b), cell in raw.items():
        if raw.get((b, a)) != cell:
            raise ValueError("标签共存矩阵必须对称：%s/%s 与反向单元格不一致。" % (a, b))
    return conflicts


def load_tag_matrix(path=None):
    return _load_tag_matrix(os.path.abspath(path or DEFAULT_TAG_MATRIX))


def matrix_hits(tags, matrix_path=None):
    """返回 (规则编号列表, 冲突组合列表)。只检查标签组合，与分数无关。"""
    matrix = load_tag_matrix(matrix_path)
    unknown = set(matrix.values()) - set(RULES)
    if unknown:
        raise ValueError("标签共存矩阵引用了未定义规则：%s" % "、".join(sorted(unknown)))
    pairs = [(a, b, matrix[frozenset((a, b))])
             for a, b in itertools.combinations(sorted(tags), 2)
             if frozenset((a, b)) in matrix]
    hits = list(dict.fromkeys(rule for _, _, rule in pairs))
    notes = ["%s + %s [%s]" % (a, b, rule) for a, b, rule in pairs]
    return hits, notes


def sv(v):
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def split_tags(s):
    return [t for t in re.split(r"[,，、;；/\s]+", s or "") if t]


def _find(head, *names):
    for j, h in enumerate(head):
        if h in names:
            return j
    return None


def parse_sheet(rows):
    """返回 (表头, 记录列表)。每条记录是一次试验：case, occ(同一用例第几块), t, score, tags, detail, tester 等。"""
    hi = next((i for i, r in enumerate(rows) if r and sv(r[0]) == "用例ID"), None)
    if hi is None:
        return None, []
    head = [sv(c) for c in rows[hi]]
    j_skill = _find(head, "Skill标签", "skill标签", "Skill")
    j_pch = _find(head, "prompt_ch", "Prompt_ch", "中文")
    j_tester = _find(head, "测试员", "测试人员")
    tcols = {}
    for j, h in enumerate(head):
        m = re.match(r"T(\d+)_(分数|标签|测试详情)$", h)
        if m:
            tcols.setdefault(int(m.group(1)), {})[m.group(2)] = j
    out, occ, cur_tester = [], {}, ""
    for r in rows[hi + 1:]:
        if not r or not sv(r[0]):
            continue

        def g(j):
            return sv(r[j]) if j is not None and j < len(r) else ""
        case = g(0)
        occ[case] = occ.get(case, 0) + 1
        if g(j_tester):                      # 合并单元格：只有块的第一行有值，向下补全
            cur_tester = g(j_tester)
        for t, cols in sorted(tcols.items()):
            out.append(dict(case=case, occ=occ[case], t=t, skill=g(j_skill), pch=g(j_pch),
                            score=g(cols.get("分数")), tags=g(cols.get("标签")), detail=g(cols.get("测试详情")),
                            tester=cur_tester))
    return head, out


def scored(recs):
    return [r for r in recs if r["score"] in ("0", "1", "2")]


# ---------- 分档规则 ----------
# 档位：退回 > 必复核 > 抽检 > 通过。每条规则有编号、档位、说明、出处。
RULES = {
    "R1": ("退回", "分数不是 0、1、2", "评分规范"),
    "R2": ("退回", "标签不在 13 个标准标签和「其他」之内", "评分规范"),
    "R3": ("退回", "「无有效动作」不能与其他标签同时出现，且只能打 0 分", "评分规范、精简版"),
    "R4": ("退回", "「重试完成」与「部分完成」同时出现", "评分规范"),
    "R5": ("退回", "「部分完成」与「质量瑕疵」同时出现", "评分规范"),
    "R6": ("退回", "「结果失效」与「质量瑕疵」同时出现", "评分规范"),
    "R7": ("退回", "「部分完成」是兜底，已有具体失败标签时不再叠加", "精简版"),
    "R8": ("退回", "「质量瑕疵」与「动作精度不足」同时出现（互斥）", "标签定义；共存矩阵"),
    "R9": ("退回", "0 分、1 分没有填测试详情", "记录完整性规则"),
    "R10": ("退回", "具体失败标签与「重试完成」共存（由标签共存矩阵判定）", "标签定义；0 分也检查"),
    "R11": ("退回", "具体失败标签与「过度执行」共存（由标签共存矩阵判定）", "标签定义；0 分也检查"),
    "R12": ("退回", "「部分完成」与「过度执行」共存：当前指令未完成与已完成相矛盾", "标签定义；共存矩阵"),
    "V1": ("必复核", "1 分", "边界分数需要人工复核"),
    "V2": ("必复核", "带「其他」标签", "非标准标签需要人工复核"),
    "V3": ("必复核", "只打了「部分完成」", "单一部分完成标签需要人工复核"),
    "V4": ("必复核", "新测试员的记录", "方案 5.4（名单由用户用 --new-testers 给出）"),
    "V5": ("必复核", "用例本次均分与历史校准期望分偏差达到阈值", "历史异常辅助复核；阈值默认 1.0，可用 --history-threshold 调整"),
    "S1": ("抽检", "带「目标位置错误」", "标签定义与抽检覆盖要求"),
    "S2": ("抽检", "只有「碰撞」或「过度执行」标签却不是 2 分", "文档里这两个标签只记录、不扣分"),
    "S3": ("抽检", "同一用例的 T1 到 T5 没填全", "方案 5.1"),
    "S4": ("抽检", "没有分数却有标签", "不打分的步骤分数栏应留空，只在测试详情写原因"),
}
TIER_ORDER = {"退回": 3, "必复核": 2, "抽检": 1, "通过": 0}


def evaluate_row(r, case_t_filled, rules_off=(), new_testers=(), matrix_path=None):
    """返回 (命中规则, 标签冲突组合)。共标检查由矩阵驱动，且不受分数影响。"""
    score, tags = r["score"], set(split_tags(r["tags"]))
    s = int(score) if score in ("0", "1", "2") else None
    hits, conflicts = matrix_hits(tags, matrix_path)
    if score != "" and s is None:
        hits.append("R1")
    if tags - ALLOWED_TAGS:
        hits.append("R2")
    # 「无有效动作」与其他标签的冲突由矩阵处理；这里只补充分数约束。
    if "无有效动作" in tags and s is not None and s != 0:
        hits.append("R3")
    if s in (0, 1) and not r["detail"]:
        hits.append("R9")
    if s == 1:
        hits.append("V1")
    if "其他" in tags:
        hits.append("V2")
    if tags == {"部分完成"}:
        hits.append("V3")
    if r["tester"] and r["tester"] in new_testers:
        hits.append("V4")
    if "目标位置错误" in tags:
        hits.append("S1")
    if tags and tags <= {"碰撞", "过度执行"} and s is not None and s != 2:
        hits.append("S2")
    if case_t_filled and score == "" and not tags and not r["detail"]:
        hits.append("S3")
    if score == "" and tags:
        hits.append("S4")
    hits = [h for h in dict.fromkeys(hits) if h not in rules_off]
    conflicts = [note for note in conflicts if note.rsplit("[", 1)[-1].rstrip("]") in hits]
    return hits, conflicts


def check_row(r, case_t_filled, rules_off=(), new_testers=(), matrix_path=None):
    """兼容旧调用：只返回规则编号。"""
    return evaluate_row(r, case_t_filled, rules_off, new_testers, matrix_path)[0]


def tier_of(hits):
    return max((RULES[h][0] for h in hits), key=lambda t: TIER_ORDER[t], default="通过")


# ---------- 基线（参照列 + V5 用例级异常复核）----------
def main_skill(s):
    return (s or "").split("\n")[0].split("、")[0].split(",")[0].split("，")[0].split("（")[0].split("(")[0].strip()


def load_sheets(path):
    book = read_xlsx(path)
    res = {}
    for name, rows in book.items():
        head, recs = parse_sheet(rows) if rows else (None, [])
        res[name] = dict(head=head, recs=recs, rows=rows)
    return res


def first_block(recs):
    """同一用例在 sheet 里重复出现时只取第一块，避免重复计数。"""
    return [r for r in recs if r["occ"] == 1]


def sheet_key(recs):
    return {(r["case"], r["t"]): (r["score"], frozenset(split_tags(r["tags"]))) for r in recs if r["score"] != ""}


def find_difficulty(book):
    """在表里找带「用例ID」和「难度」两列的 sheet（通用评测集），返回 {用例: 难度}。"""
    out = {}
    for name, v in book.items():
        h = v["head"]
        if h and "难度" in h and "用例ID" in h:
            j = h.index("难度")
            for r in v["rows"][1:]:
                if r and sv(r[0]) and len(r) > j and sv(r[j]):
                    out[sv(r[0])] = sv(r[j])
    return out


def is_candidate(name, recs, min_scored=250):
    if re.search(r"原版|yuan|重测|废弃|模板|勿动", name):
        return False
    return len(scored(first_block(recs))) >= min_scored


def build_baseline(path, exclude=(), dup_thr=0.95):
    book = load_sheets(path)
    cands = {n: first_block(v["recs"]) for n, v in book.items()
             if n not in exclude and is_candidate(n, v["recs"])}
    # 改名副本：同用例同 T 的分数和标签几乎一致的 sheet 只留记录多的一份
    keys = {n: sheet_key(r) for n, r in cands.items()}
    dropped = {}
    for a in sorted(cands, key=lambda n: -len(keys[n])):
        if a in dropped:
            continue
        for b in sorted(cands):
            if b == a or b in dropped or len(keys[b]) > len(keys[a]):
                continue
            common = [k for k in keys[a] if k in keys[b]]
            if len(common) >= 100 and sum(keys[a][k] == keys[b][k] for k in common) / len(common) >= dup_thr:
                dropped[b] = a
    used = [n for n in cands if n not in dropped]
    sheet_tot = {}
    cases = C.defaultdict(lambda: dict(by_sheet={}, tags=C.Counter(), skill="", pch=""))
    for n in used:
        rr_all = scored(cands[n])
        sheet_tot[n] = [sum(int(r["score"]) for r in rr_all), len(rr_all)]
        by = C.defaultdict(list)
        for r in rr_all:
            by[r["case"]].append(r)
        for c, rr in by.items():
            e = cases[c]
            # 每个 sheet 存 [0 分次数, 1 分次数, 2 分次数]，初筛时可以把被筛的 sheet 自己排除
            e["by_sheet"][n] = [sum(r["score"] == k for r in rr) for k in "012"]
            for r in rr:
                e["tags"].update(split_tags(r["tags"]))
            e["skill"] = e["skill"] or main_skill(rr[0]["skill"])
            e["pch"] = e["pch"] or rr[0]["pch"]
    for e in cases.values():
        e["top_tags"] = [t for t, _ in e.pop("tags").most_common(3)]
    return dict(built=dt.datetime.now().strftime("%Y-%m-%d %H:%M"), source=os.path.basename(path),
                sheets_used=used, sheets_dropped=dropped, sheet_tot=sheet_tot,
                difficulty=find_difficulty(book), cases=dict(cases))


def reference(base, case, sheet_name, sheet_mean, exclude=()):
    """这个用例的历史参照（排除被筛的 sheet 自己）：模型数、历史均分、0/1/2 比例、期望分、常见标签、难度。
    期望分 = 各历史模型在该用例的均分的平均 + (本 sheet 整体均分 − 历史整体均分)，截到 [0,2]；
    历史少于 5 次试验时期望分为空。期望分只驱动 V5 异常复核，不用于退回或建议改分。"""
    out = dict(n_models=0, hist_n=0, hist_mean=None, dist="", expect=None, top_tags="",
               difficulty=base.get("difficulty", {}).get(case, ""))
    e = base["cases"].get(case)
    if not e:
        return out
    skip = {sheet_name, *exclude}
    bs = {s: v for s, v in e["by_sheet"].items() if s not in skip}
    n = sum(sum(v) for v in bs.values())
    if not bs or n == 0:
        return out
    means = [(v[1] + 2 * v[2]) / sum(v) for v in bs.values() if sum(v)]
    tot = [v for s, v in base["sheet_tot"].items() if s not in skip]
    gm = sum(v[0] for v in tot) / sum(v[1] for v in tot)
    hm = sum(means) / len(means)
    d = [sum(v[k] for v in bs.values()) / n for k in range(3)]
    out.update(n_models=len(means), hist_n=n, hist_mean=round(hm, 2), dist="%.0f/%.0f/%.0f%%" % tuple(x * 100 for x in d),
               top_tags="、".join(e["top_tags"]))
    if n >= 5:
        out["expect"] = round(min(2.0, max(0.0, hm + sheet_mean - gm)), 2)
    return out


# ---------- 初筛 ----------
def screen_records(recs, base=None, sheet_name="", new_testers=(), rules_off=(), seed=None, sample_rate=0.20,
                   exclude=(), matrix_path=None, history_threshold=1.0, history_min_n=5, min_sample=5):
    """逐条分档。历史异常按用例触发 V5；通过档按用例整行、可复现随机盲抽。"""
    recs = first_block(recs)
    filled = C.defaultdict(bool)
    for r in recs:
        if r["score"] != "" or r["tags"] or r["detail"]:
            filled[r["case"]] = True
    sc = scored(recs)
    sheet_mean = sum(int(r["score"]) for r in sc) / len(sc) if sc else 1.0
    ref_cache, rows = {}, []
    for r in recs:
        if r["score"] == "" and not r["tags"] and not r["detail"] and not filled[r["case"]]:
            continue                                   # 整个用例都没填：不是这一批的内容
        hits, conflicts = evaluate_row(r, filled[r["case"]], rules_off, new_testers, matrix_path)
        tier = tier_of(hits)
        if r["case"] not in ref_cache:
            ref_cache[r["case"]] = reference(base, r["case"], sheet_name, sheet_mean, exclude) if base else {}
        ref = ref_cache[r["case"]]
        rows.append(dict(档位=tier, 用例=r["case"], T=r["t"], 分数=r["score"], 标签=r["tags"], 测试员=r["tester"],
                         命中规则="、".join(hits), 原因="；".join(RULES[h][1] for h in hits),
                         冲突组合="；".join(conflicts), 测试详情=r["detail"], 用例说明=r["pch"],
                         历史模型数=ref.get("n_models", ""), 历史试验数=ref.get("hist_n", ""),
                         历史均分="" if ref.get("hist_mean") is None else ref.get("hist_mean"),
                         历史0_1_2占比=ref.get("dist", ""),
                         期望分="" if ref.get("expect") is None else ref.get("expect"), 历史偏差="",
                         历史常见标签=ref.get("top_tags", ""), 人工难度=ref.get("difficulty", "")))

    # V5 是用例级信号：历史足够且本次均分偏离校准期望分时，该用例所有有分试验都进必复核。
    # 它只提示「表现异常，值得看」，不表示分数错误，也不触发退回。
    by_case = C.OrderedDict()
    for x in rows:
        by_case.setdefault(x["用例"], []).append(x)
    if base and history_threshold > 0 and "V5" not in rules_off:
        for case, xs in by_case.items():
            scored_x = [x for x in xs if x["分数"] in ("0", "1", "2")]
            if not scored_x:
                continue
            ref = ref_cache.get(case, {})
            if not ref.get("hist_n") or ref["hist_n"] < history_min_n or ref.get("expect") is None:
                continue
            current_mean = sum(int(x["分数"]) for x in scored_x) / len(scored_x)
            delta = current_mean - ref["expect"]
            if abs(delta) + 1e-9 >= history_threshold:
                for x in scored_x:
                    hits = [h for h in x["命中规则"].split("、") if h]
                    if "V5" not in hits:
                        hits.append("V5")
                    x["命中规则"] = "、".join(hits)
                    x["原因"] = "；".join(RULES[h][1] for h in hits)
                    x["历史偏差"] = round(delta, 2)
                    x["档位"] = tier_of(hits)

    # 默认抽 20% 且至少 5 行；不填 seed 时由 sheet 名和用例顺序生成稳定种子。
    # 与固定抽第 10、30… 行相比，既避免位置偏差，也保证同一 sheet 重跑结果一致。
    passed = [xs for xs in by_case.values() if all(x["档位"] == "通过" for x in xs)]
    sample_n = 0
    if sample_rate > 0 and passed:
        sample_n = min(len(passed), max(math.ceil(len(passed) * sample_rate), min_sample))
        stable_seed = int.from_bytes(hashlib.sha256(
            (sheet_name + "\0" + "\0".join(xs[0]["用例"] for xs in passed)).encode("utf-8")).digest()[:8], "big")
        rng = random.Random(stable_seed if seed is None else seed)
        picked = {xs[0]["用例"] for xs in rng.sample(passed, sample_n)}
        for xs in passed:
            if xs[0]["用例"] in picked:
                for x in xs:
                    x["档位"] = "通过-抽样"
    for x in rows:
        x["通过档用例总数"] = len(passed)
        x["盲抽样本数"] = sample_n
    return rows


TIER_ORDER_OUT = ["退回", "必复核", "抽检", "通过-抽样", "通过"]
HOW = {"退回": "退回测试员当场改，改后仍需回执", "必复核": "QC 逐条看并填写回执", "抽检": "QC 按比例抽并填写回执",
       "通过-抽样": "从通过档可复现随机抽的，QC 盲看并填写回执", "通过": "不看；由盲抽估计漏检"}
REF_COLS = ["历史模型数", "历史试验数", "历史均分", "历史0_1_2占比", "期望分", "历史偏差", "历史常见标签", "人工难度"]


def tier_rank(t):
    return TIER_ORDER_OUT.index(t)


def case_rows(rows):
    """把逐条记录按用例合成一行：档位取各 T 里最高的那档；「需看的 T」列出档位不是「通过」的那几次。
    每个 T 一组列（分数、标签、规则、详情），QC 在一行里就能对比同一用例的几次试验。"""
    by = C.OrderedDict()
    for x in rows:
        by.setdefault(x["用例"], []).append(x)
    ts = sorted({x["T"] for x in rows})
    out = []
    for case, xs in by.items():
        xs = sorted(xs, key=lambda x: x["T"])
        top = min((x["档位"] for x in xs), key=tier_rank)
        look = [x for x in xs if x["档位"] != "通过"]
        hits = C.Counter(h for x in xs for h in x["命中规则"].split("、") if h)
        sc = [x["分数"] for x in xs]
        d = C.OrderedDict(档位=top, 用例=case,
                          需看的T="、".join("T%d（%s）" % (x["T"], x["档位"]) for x in look),
                          命中规则="、".join("%s×%d" % (h, n) if n > 1 else h for h, n in sorted(hits.items())),
                          原因="；".join(RULES[h][1] for h in sorted(hits)),
                          冲突组合="；".join(dict.fromkeys(x["冲突组合"] for x in xs if x.get("冲突组合"))),
                          五次分数=" ".join(s if s != "" else "空" for s in sc),
                          本次均分=round(sum(int(s) for s in sc if s in ("0", "1", "2")) / max(1, sum(s in ("0", "1", "2") for s in sc)), 2),
                          测试员="、".join(sorted({x["测试员"] for x in xs if x["测试员"]})), 用例说明=xs[0]["用例说明"])
        for k in REF_COLS:
            d[k] = xs[0][k]
        tx = {x["T"]: x for x in xs}
        for t in ts:
            x = tx.get(t)
            d["T%d_分数" % t] = x["分数"] if x else ""
            d["T%d_标签" % t] = x["标签"] if x else ""
            d["T%d_规则" % t] = x["命中规则"] if x else ""
            d["T%d_详情" % t] = x["测试详情"] if x else ""
        for k in ("QC改动", "QC改分", "QC改标签", "QC改判词"):  # compare 时才有
            if k in xs[0]:
                d[k] = sum(bool(x[k]) for x in xs)
        out.append(d)
    return out


def write_csv(path, rows, fields=None):
    fields = fields or (list(rows[0].keys()) if rows else [])
    with open(path, "w", newline="", encoding="utf-8-sig") as f:      # utf-8-sig：Excel 直接打开不乱码
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


RECEIPT_FIELDS = ["批次", "用例", "推荐档位", "命中规则", "需看的T", "状态", "是否修改", "修改类型",
                  "复核人", "复核时间", "备注", "通过档用例总数", "盲抽样本数"]


def receipt_rows(rows, cr, label):
    """每个被推荐或盲抽的用例一行；未填回执前一律保持待处理。"""
    pass_total = rows[0].get("通过档用例总数", "") if rows else ""
    sample_n = rows[0].get("盲抽样本数", "") if rows else ""
    out = []
    for c in sorted(cr, key=lambda c: (tier_rank(c["档位"]), c["用例"])):
        if c["档位"] == "通过":
            continue
        out.append(dict(批次=label, 用例=c["用例"], 推荐档位=c["档位"], 命中规则=c["命中规则"], 需看的T=c["需看的T"],
                        状态="待处理", 是否修改="", 修改类型="", 复核人="", 复核时间="", 备注="",
                        通过档用例总数=pass_total, 盲抽样本数=sample_n))
    return out


def write_outputs(rows, outdir, label, extra_md="", keep=lambda x: x["档位"] != "通过", report=False):
    """输出复核清单（按用例一行）、逐条明细（每次试验一行）、汇总；report=True 时再出一份给人看的复查报告。"""
    os.makedirs(outdir, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    base = os.path.join(outdir, "%s_%s" % (label, stamp))
    cr = case_rows(rows)
    keep_case = {x["用例"] for x in rows if keep(x)}
    write_csv(base + "_复核清单.csv",
              sorted([c for c in cr if c["用例"] in keep_case], key=lambda c: (tier_rank(c["档位"]), c["用例"])))
    write_csv(base + "_逐条明细.csv",
              sorted([x for x in rows if keep(x)], key=lambda x: (tier_rank(x["档位"]), x["用例"], x["T"])))
    cnt = C.Counter(x["档位"] for x in rows)
    ccnt = C.Counter(c["档位"] for c in cr)
    rule = C.Counter(h for x in rows for h in x["命中规则"].split("、") if h)
    n, nc = len(rows), len(cr)
    L = ["# 初筛汇总：%s" % label, "",
         "生成时间 %s；共 %d 个用例行、%d 条试验记录。" % (dt.datetime.now().strftime("%Y-%m-%d %H:%M"), nc, n), "",
         "复核清单按用例一行：一个用例只要有一次试验进了某档，整行就进这一档（取最高的档），"
         "「需看的 T」列出具体要看哪几次。逐条明细里是每次试验一行。", "",
         "| 档位 | 用例行 | 占用例 | 试验记录 | 占记录 | 处理 |", "|---|---|---|---|---|---|"]
    for t in TIER_ORDER_OUT:
        L.append("| %s | %d | %.1f%% | %d | %.1f%% | %s |" % (
            t, ccnt[t], 100 * ccnt[t] / nc if nc else 0, cnt[t], 100 * cnt[t] / n if n else 0, HOW[t]))
    need = n - cnt["通过"]
    needc = nc - ccnt["通过"]
    L += ["", "要处理的合计：%d 个用例行（%.1f%%），其中要看的试验 %d 条（%.1f%%）。退回也必须填写回执闭环。" % (
        needc, 100 * needc / nc if nc else 0, need, 100 * need / n if n else 0), "",
          "| 规则 | 档位 | 命中记录 | 涉及用例 | 说明 | 出处 |", "|---|---|---|---|---|---|"]
    rcase = C.defaultdict(set)
    for x in rows:
        for h in x["命中规则"].split("、"):
            if h:
                rcase[h].add(x["用例"])
    for h in sorted(rule, key=lambda k: (-TIER_ORDER[RULES[k][0]], k)):
        L.append("| %s | %s | %d | %d | %s | %s |" % (h, RULES[h][0], rule[h], len(rcase[h]), RULES[h][1], RULES[h][2]))
    if extra_md:
        L += ["", extra_md]
    with open(base + "_汇总.md", "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    if report:
        write_report(rows, cr, base + "_复查报告.md", label, os.path.basename(base))
        write_csv(base + "_复核回执.csv", receipt_rows(rows, cr, label), RECEIPT_FIELDS)
    return base


SHORT = {"R1": "分数不是 0/1/2", "R2": "标签不在清单里", "R3": "无有效动作与别的标签共存，或打了 1/2 分",
         "R4": "重试完成 + 部分完成", "R5": "部分完成 + 质量瑕疵", "R6": "结果失效 + 质量瑕疵",
         "R7": "部分完成叠加了具体失败标签", "R8": "质量瑕疵 + 动作精度不足", "R9": "0/1 分没写测试详情",
         "R10": "具体失败标签 + 重试完成", "R11": "具体失败标签 + 过度执行",
         "V1": "1 分", "V2": "带「其他」", "V3": "只打了部分完成", "V4": "新测试员", "V5": "本次均分偏离历史期望",
         "S1": "带目标位置错误", "S2": "只有碰撞/过度执行却不是 2 分", "S3": "这一次没填", "S4": "没分数却有标签"}


def _md(s, n=None):
    s = re.sub(r"\s+", " ", str(s or "")).replace("|", "／").strip()
    return s if n is None or len(s) <= n else s[:n] + "…"


def write_report(rows, cr, path, label, csv_prefix):
    """给人看的复查报告：先一句话说要看多少，再按档位列用例；要看的那次试验加粗。"""
    by = C.defaultdict(dict)
    for x in rows:
        by[x["用例"]][x["T"]] = x
    ts = sorted({x["T"] for x in rows})
    tier_cases = C.defaultdict(list)
    for c in cr:
        tier_cases[c["档位"]].append(c)
    nc, n = len(cr), len(rows)
    look = [c for c in cr if c["档位"] != "通过"]
    L = ["# 复查报告：%s" % label, "",
         "生成时间 %s。共 %d 个用例、%d 次试验。" % (dt.datetime.now().strftime("%Y-%m-%d %H:%M"), nc, n), "",
         "> **要处理 %d 个用例**：退回测试员 %d 个，必复核 %d 个，抽检 %d 个，盲抽 %d 个。其余 %d 个用例不用看。" % (
             len(look), len(tier_cases["退回"]), len(tier_cases["必复核"]), len(tier_cases["抽检"]),
             len(tier_cases["通过-抽样"]), len(tier_cases["通过"])), ""]

    def reasons(xs):
        hs = C.Counter(h for x in xs for h in x["命中规则"].split("、") if h)
        return "；".join(SHORT[h] + ("（%d 次）" % k if k > 1 else "") for h, k in sorted(hs.items()))

    def cell(x, bold):
        if x is None:
            return ""
        s = _md((x["分数"] or "空") + (" " + x["标签"] if x["标签"] else ""), 18)
        return "**%s**" % s if bold else s

    def case_table(cases, title, note, all_detail=False):
        if not cases:
            return
        L.extend(["## %s（%d 个用例）" % (title, len(cases)), "", note, "",
                  "| 用例 | 指令 | " + " | ".join("T%d" % t for t in ts) + " | 为什么要看 | 历史均分 | %s |" % (
                      "测试详情" if all_detail else "测试详情（要看的那几次）"),
                  "|---" * (len(ts) + 5) + "|"])
        for c in cases:
            xs = by[c["用例"]]
            flag = [x for x in xs.values() if x["档位"] not in ("通过", "通过-抽样")]
            src = list(xs.values()) if all_detail else flag
            det = "；".join(dict.fromkeys(_md(x["测试详情"]) for x in sorted(src, key=lambda x: x["T"]) if x["测试详情"]))
            hm = c["历史均分"]
            why = reasons(flag)
            if c.get("历史偏差") not in ("", None):
                why += "；本次均分 %s，历史期望 %s，偏差 %s" % (c["本次均分"], c["期望分"], c["历史偏差"])
            L.append("| %s | %s | %s | %s | %s | %s |" % (
                c["用例"], _md(c["用例说明"], 16),
                " | ".join(cell(xs.get(t), xs.get(t) is not None and xs[t]["档位"] not in ("通过", "通过-抽样")) for t in ts),
                why, hm if hm not in ("", None) else "无历史", _md(det, 60)))
        L.append("")

    ret = tier_cases["退回"]
    if ret:
        L += ["## 退回测试员（%d 个用例）" % len(ret), "",
              "这些违反了文档写明的规则，请测试员改完再交 QC。", "",
              "| 用例 | 第几次 | 分数 | 标签 | 问题 | 测试详情 |", "|---|---|---|---|---|---|"]
        for c in ret:
            for t, x in sorted(by[c["用例"]].items()):
                if x["档位"] == "退回":
                    hs = [h for h in x["命中规则"].split("、") if h and RULES[h][0] == "退回"]
                    L.append("| %s | T%d | %s | %s | %s | %s |" % (
                        c["用例"], t, x["分数"] or "空", _md(x["标签"]) or "—",
                        "；".join([RULES[h][1] for h in hs] + ([x["冲突组合"]] if x.get("冲突组合") else [])), _md(x["测试详情"], 60) or "—"))
        L += ["", "同一用例里其他要复核的试验见下面「必复核」或复核清单。", ""]
    also = [c for c in ret if any(RULES[h][0] == "必复核" for x in by[c["用例"]].values()
                                  for h in x["命中规则"].split("、") if h)]
    case_table(sorted(tier_cases["必复核"] + also, key=lambda c: c["用例"]), "必复核",
               "QC 逐个看。**加粗**的是要看的那几次；格子里是「分数 标签」。" +
               ("表里另含上面 %d 个退回用例（%s），它们改完后也要复核。" % (len(also), "、".join(c["用例"] for c in also)) if also else ""))
    case_table(tier_cases["抽检"], "抽检", "按比例抽着看。")
    case_table(tier_cases["通过-抽样"], "盲抽", "从「不用看」里可复现随机抽的整行，按正常标准看一遍并填写回执，用来估计漏检。", all_detail=True)
    rest = [c["用例"] for c in tier_cases["通过"]]
    if rest:
        L += ["## 不用看（%d 个用例）" % len(rest), "", "、".join(rest), ""]
    L += ["## 说明", "",
          "- 判断依据：退回是文档写明的规则；必复核是 QC 历史上最常改的情形（1 分、带「其他」、只打部分完成），"
          "出处和数据见 README。",
          "- 历史均分通过 V5 参与异常复核：默认本次用例均分与历史校准期望分相差至少 1.0 才标出；只提示复核，不代表应该改分。",
          "- 所有退回、必复核、抽检和盲抽都必须填写 `%s_复核回执.csv`；状态保持「待处理」就是未闭环，不能宣称本批完成。" % csv_prefix,
          "- 完整的测试详情、冲突组合和每次试验的规则编号在 `%s_复核清单.csv` 与 `%s_逐条明细.csv`。" % (csv_prefix, csv_prefix)]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def screen_notes(rows, recs, base):
    """汇总里的补充：按测试员的分布、重复出现的用例、没有历史参照的用例。"""
    L = []
    if any(x["测试员"] for x in rows):
        by = C.defaultdict(C.Counter)
        for x in rows:
            k = x["测试员"] or "（空）"
            by[k]["n"] += 1
            by[k][x["档位"]] += 1
            by[k]["1分"] += x["分数"] == "1"
        L += ["| 测试员 | 记录 | 1 分占比 | 退回 | 必复核 |", "|---|---|---|---|---|"]
        for k, c in sorted(by.items()):
            L.append("| %s | %d | %.0f%% | %d | %d |" % (k, c["n"], 100 * c["1分"] / c["n"], c["退回"], c["必复核"]))
        L.append("")
    else:
        L += ["表里没有测试员，或测试员列为空：按测试员的统计和新测试员规则（V4）用不上。", ""]
    dup = sorted({r["case"] for r in recs if r["occ"] > 1})
    if dup:
        L += ["注意：这些用例在 sheet 里出现了不止一块，只筛了第一块：%s。" % "、".join(dup), ""]
    if base:
        nohist = sorted({x["用例"] for x in rows if not x["历史模型数"]})
        if nohist:
            L += ["没有历史参照的用例 %d 个（历史均分、期望分为空）：%s。" % (len(nohist), "、".join(nohist[:30])), ""]
    L.append("历史均分通过 V5 参与异常复核（只进必复核，不自动改分）；人工难度只作参照。")
    if rows:
        total = rows[0].get("通过档用例总数", 0)
        sample_n = rows[0].get("盲抽样本数", 0)
        power = 1 - (1 - 0.05) ** sample_n
        L.append("本次通过档 %d 个用例，盲抽 %d 个；若真实漏检率为 5%%，至少发现一个漏检的概率约 %.0f%%。"
                 "概率不足 80%% 时不得据此宣称「没有漏检」，应扩大样本或跨批累计。" % (total, sample_n, 100 * power))
    return "\n".join(L)


def cmd_baseline(a):
    base = build_baseline(a.table, exclude=set(a.exclude or []))
    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False)
    print("基线已写入 %s：用 %d 个 sheet，去掉 %d 个改名副本，%d 个用例，%d 个用例带人工难度。" % (
        a.output, len(base["sheets_used"]), len(base["sheets_dropped"]), len(base["cases"]), len(base["difficulty"])))
    for n, m in base["sheets_dropped"].items():
        print("  去重：%s ≈ %s" % (n, m))


def pick_sheet(book, name, hint):
    if name:
        if name not in book:
            sys.exit("表里没有 sheet「%s」。可选：%s" % (name, "、".join(n for n, v in book.items() if v["recs"])[:600]))
        return name
    cands = [n for n, v in book.items() if scored(v["recs"])]
    if not cands:
        sys.exit("表里没有已打分的 sheet。")
    return cands[-1] if hint == "last" else cands[0]


def cmd_screen(a):
    book = load_sheets(a.table)
    name = pick_sheet(book, a.sheet, "last")
    base = None
    if a.baseline and os.path.exists(a.baseline):
        base = json.load(open(a.baseline, encoding="utf-8"))
    elif a.baseline:
        print("提示：找不到基线 %s，历史参照列为空，V5 不触发。" % a.baseline)
    new_testers = {x.strip() for x in (a.new_testers or "").split(",") if x.strip()}
    rows = screen_records(book[name]["recs"], base, name, new_testers, set(a.rules_off or []), a.seed, a.sample_rate,
                          matrix_path=a.tag_matrix, history_threshold=a.history_threshold,
                          history_min_n=a.history_min_n, min_sample=a.min_sample)
    if not rows:
        sys.exit("sheet「%s」里没有可筛的记录。" % name)
    base_path = write_outputs(rows, a.output_dir, re.sub(r"[\\/:*?\"<>|\s]+", "_", name)[:40],
                              screen_notes(rows, book[name]["recs"], base), report=True)
    print("sheet「%s」：%d 条。输出：%s_复查报告.md / _复核清单.csv / _逐条明细.csv / _复核回执.csv / _汇总.md" % (name, len(rows), base_path))
    print(open(base_path + "_复查报告.md", encoding="utf-8").read())


# ---------- 原版 vs 终版 ----------
def normalize_judgment(s):
    """用于发现判词文本变化：统一全半角并去空白；不擅自判断两句话语义等价。"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or "")).strip("。；;，,")


def compare(orig_recs, final_recs, base=None, orig_name="", new_testers=(), rules_off=(), final_name="",
            matrix_path=None, history_threshold=1.0, history_min_n=5):
    """逐条比较 QC 前后；改分、改标签、改判词都算 QC 改动。"""
    rows = screen_records(orig_recs, base, orig_name, new_testers, rules_off, sample_rate=0.0,
                          exclude={final_name}, matrix_path=matrix_path, history_threshold=history_threshold,
                          history_min_n=history_min_n)   # 参照里去掉同批次终版，避免泄漏
    fin = {(r["case"], r["t"]): r for r in first_block(final_recs)}
    out = []
    for x in rows:
        f = fin.get((x["用例"], x["T"]))
        if f is None:
            continue
        sc = x["分数"] != f["score"]
        tg = set(split_tags(x["标签"])) != set(split_tags(f["tags"]))
        jd = normalize_judgment(x["测试详情"]) != normalize_judgment(f["detail"])
        out.append(dict(x, QC改分=sc, QC改标签=tg, QC改判词=jd, QC改动=sc or tg or jd,
                        终版分数=f["score"], 终版标签=f["tags"], 终版测试详情=f["detail"]))
    n, chg = len(out), [x for x in out if x["QC改动"]]
    only_j = [x for x in out if x["QC改判词"] and not x["QC改分"] and not x["QC改标签"]]
    L = ["## 原版 vs 终版", "",
         "配对 %d 条；QC 改动 %d 条（%.1f%%）：改分 %d、改标签 %d、改判词 %d；其中仅改判词 %d。" % (
             n, len(chg), 100 * len(chg) / n if n else 0, sum(x["QC改分"] for x in out),
             sum(x["QC改标签"] for x in out), sum(x["QC改判词"] for x in out), len(only_j)), "",
         "「精度」= 被标出的记录里 QC 确实改了的比例；「召回」= QC 改动里被标出的比例。三类改动都计入总召回。",
         "判词变化按全半角统一、去空白后的文本比较；语义是否等价仍由 QC 判定。", "",
         "| 触发条件 | 标出 | 占全部 | 其中 QC 改了 | 精度 | 召回（全部改动） | 召回（改分） | 召回（改判词） | 召回（仅改判词） |",
         "|---|---|---|---|---|---|---|---|---|"]

    def line(name, f):
        hit = [x for x in out if f(x)]
        h = [x for x in hit if x["QC改动"]]
        score_total = sum(x["QC改分"] for x in out)
        judgment_total = sum(x["QC改判词"] for x in out)
        L.append("| %s | %d | %.0f%% | %d | %s | %s | %s | %s | %s |" % (
            name, len(hit), 100 * len(hit) / n if n else 0, len(h),
            "%.0f%%" % (100 * len(h) / len(hit)) if hit else "-",
            "%.0f%%" % (100 * len(h) / len(chg)) if chg else "-",
            "%.0f%%" % (100 * sum(x["QC改分"] for x in hit) / score_total) if score_total else "-",
            "%.0f%%" % (100 * sum(x["QC改判词"] for x in hit) / judgment_total) if judgment_total else "-",
            "%.0f%%" % (100 * sum(x["QC改判词"] and not x["QC改分"] and not x["QC改标签"] for x in hit) / len(only_j)) if only_j else "-"))
    line("档位：退回", lambda x: x["档位"] == "退回")
    line("档位：退回 + 必复核", lambda x: x["档位"] in ("退回", "必复核"))
    line("档位：退回 + 必复核 + 抽检", lambda x: x["档位"] in ("退回", "必复核", "抽检"))
    for h in sorted({h for x in out for h in x["命中规则"].split("、") if h}):
        line("规则 %s %s" % (h, RULES[h][1][:18]), lambda x, h=h: h in x["命中规则"].split("、"))
    miss = [x for x in chg if x["档位"] == "通过"]
    L += ["", "初筛判为「通过」但 QC 改了的有 %d 条（占改动的 %.0f%%）。" % (len(miss), 100 * len(miss) / len(chg) if chg else 0)]
    # 按用例行看：QC 打开一行时，这一行的 5 次试验都会看到
    cr = case_rows(out)
    nc, cchg = len(cr), [c for c in cr if c["QC改动"]]
    L += ["", "按用例行（QC 打开一行就会看到这个用例的全部试验）：共 %d 行，QC 改过的有 %d 行。" % (nc, len(cchg)), "",
          "| 进入清单的档位 | 用例行 | 占全部 | 其中 QC 改过 | 精度 | 召回（改过的行） | 覆盖的改动条数 |",
          "|---|---|---|---|---|---|---|"]
    for name, tiers in (("退回", ("退回",)), ("退回 + 必复核", ("退回", "必复核")),
                        ("退回 + 必复核 + 抽检", ("退回", "必复核", "抽检"))):
        hit = [c for c in cr if c["档位"] in tiers]
        h = [c for c in hit if c["QC改动"]]
        L.append("| %s | %d | %.0f%% | %d | %s | %s | %d/%d（%.0f%%） |" % (
            name, len(hit), 100 * len(hit) / nc if nc else 0, len(h),
            "%.0f%%" % (100 * len(h) / len(hit)) if hit else "-",
            "%.0f%%" % (100 * len(h) / len(cchg)) if cchg else "-",
            sum(c["QC改动"] for c in hit), len(chg), 100 * sum(c["QC改动"] for c in hit) / len(chg) if chg else 0))
    if any(x["测试员"] for x in out):
        by = C.defaultdict(lambda: [0, 0])
        for x in out:
            by[x["测试员"] or "（空）"][0] += 1
            by[x["测试员"] or "（空）"][1] += x["QC改动"]
        L += ["", "| 测试员 | 记录 | QC 改动 | 被改率 |", "|---|---|---|---|"]
        for k, (a, b) in sorted(by.items()):
            L.append("| %s | %d | %d | %.0f%% |" % (k, a, b, 100 * b / a))
    return out, "\n".join(L)


def cmd_compare(a):
    bo, bf = load_sheets(a.orig), load_sheets(a.final)
    for nm, bk in ((a.orig_sheet, bo), (a.final_sheet, bf)):
        if nm not in bk:
            sys.exit("表里没有 sheet「%s」。" % nm)
    base = json.load(open(a.baseline, encoding="utf-8")) if a.baseline and os.path.exists(a.baseline) else None
    new_testers = {x.strip() for x in (a.new_testers or "").split(",") if x.strip()}
    out, md = compare(bo[a.orig_sheet]["recs"], bf[a.final_sheet]["recs"], base, a.orig_sheet, new_testers,
                      set(a.rules_off or []), a.final_sheet, a.tag_matrix, a.history_threshold, a.history_min_n)
    label = re.sub(r"[\\/:*?\"<>|\s]+", "_", a.orig_sheet)[:40] + "_对比"
    base_path = write_outputs(out, a.output_dir, label, md, keep=lambda x: x["档位"] != "通过" or x["QC改动"])
    print("配对 %d 条。输出：%s_复核清单.csv / _逐条明细.csv / _汇总.md" % (len(out), base_path))
    print(md)


# ---------- 回执闭环与漏检估计 ----------
def wilson_interval(k, n, z=1.96):
    if not n:
        return None, None
    p = k / n
    den = 1 + z * z / n
    center = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return max(0.0, center - half), min(1.0, center + half)


def sample_size_for_detection(rate, confidence=0.8):
    """至少发现一个漏检达到 confidence 所需样本量。"""
    if rate <= 0 or rate >= 1:
        return None
    return max(1, math.ceil(math.log(1 - confidence) / math.log(1 - rate)))


def receipt_incomplete(x):
    if x.get("状态", "").strip() != "已复核":
        return "状态不是已复核"
    if x.get("是否修改", "").strip() not in ("是", "否"):
        return "是否修改未填或非法"
    if not x.get("复核人", "").strip() or not x.get("复核时间", "").strip():
        return "复核人或复核时间未填"
    kinds = set(split_tags(x.get("修改类型", "")))
    if x.get("是否修改", "").strip() == "是" and not kinds:
        return "已修改但未填修改类型"
    if kinds - {"分数", "标签", "判词"}:
        return "修改类型只能包含分数、标签、判词"
    return ""


def audit_receipt_rows(rows, pass_total=None, target_miss_rate=0.05, confidence=0.8):
    """返回 (汇总 Markdown, 未闭环行, 指标)。指标按用例计算，修改含判词。"""
    pending = []
    for x in rows:
        reason = receipt_incomplete(x)
        if reason:
            pending.append(dict(x, 未闭环原因=reason))
    reviewed = [x for x in rows if not receipt_incomplete(x)]
    recommended = [x for x in reviewed if x.get("推荐档位") != "通过-抽样"]
    blind = [x for x in reviewed if x.get("推荐档位") == "通过-抽样"]
    changed = lambda xs: [x for x in xs if x.get("是否修改") == "是"]
    tp = len(changed(recommended))
    blind_changed = len(changed(blind))
    if pass_total is None:
        vals = [int(float(x["通过档用例总数"])) for x in rows if x.get("通过档用例总数", "").strip()]
        pass_total = max(vals) if vals else None
    precision = tp / len(recommended) if recommended else None
    estimated_fn = pass_total * blind_changed / len(blind) if blind and pass_total is not None and not pending else None
    estimated_recall = tp / (tp + estimated_fn) if estimated_fn is not None and tp + estimated_fn > 0 else None
    low, high = wilson_interval(blind_changed, len(blind))
    power = 1 - (1 - target_miss_rate) ** len(blind)
    required = sample_size_for_detection(target_miss_rate, confidence)
    pct = lambda v: "-" if v is None else "%.1f%%" % (100 * v)
    L = ["# 初筛闭环审计", "",
         "回执 %d 行，已闭环 %d 行，**未闭环 %d 行**。修改包括分数、标签和判词。" % (len(rows), len(reviewed), len(pending)), "",
         "| 指标 | 结果 | 口径 |", "|---|---|---|",
         "| 推荐项精度 | %s（%d/%d） | 已复核的非盲抽推荐项中，确实修改的比例 |" % (pct(precision), tp, len(recommended)),
         "| 盲抽发现漏检 | %d/%d | 盲抽中发现需要修改的用例；含仅改判词 |" % (blind_changed, len(blind)),
         "| 盲抽漏检率 | %s | 点估计；95%% Wilson 区间 %s ～ %s |" % (
             pct(blind_changed / len(blind) if blind else None), pct(low), pct(high)),
         "| 估计整体召回 | %s | 推荐项全部闭环后，按盲抽漏检率外推通过档；不是全量真值 |" % pct(estimated_recall),
         "| 当前盲抽发现能力 | %s | 假设真实漏检率 %.1f%%，至少发现一个漏检的概率 |" % (pct(power), 100 * target_miss_rate),
         "| 建议下一批盲抽量 | %s | 漏检率 %.1f%% 时，达到 %.0f%% 发现概率所需样本 |" % (
             required if required is not None else "-", 100 * target_miss_rate, 100 * confidence), ""]
    if pending:
        L += ["## 未闭环", "", "以下项目必须处理并补齐回执；退回项不会因生成下一份报告而自动消失。", "",
              "| 用例 | 推荐档位 | 状态 | 未闭环原因 |", "|---|---|---|---|"]
        L += ["| %s | %s | %s | %s |" % (x.get("用例", ""), x.get("推荐档位", ""), x.get("状态", ""), x["未闭环原因"])
              for x in pending]
    else:
        L += ["所有推荐和盲抽均已闭环。"]
    if estimated_recall is None:
        L += ["", "当前不能估计整体召回：先补齐全部回执，并确保有已复核盲抽及通过档用例总数。需要精确召回时用 compare 对照原版与终版。"]
    return "\n".join(L) + "\n", pending, dict(precision=precision, estimated_recall=estimated_recall,
                                               blind_changed=blind_changed, blind_reviewed=len(blind))


def cmd_audit(a):
    with open(a.receipt, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("回执里没有记录。")
    missing = set(RECEIPT_FIELDS) - set(rows[0])
    if missing:
        sys.exit("回执缺少列：%s" % "、".join(sorted(missing)))
    md, pending, _ = audit_receipt_rows(rows, a.pass_total, a.target_miss_rate, a.confidence)
    os.makedirs(a.output_dir, exist_ok=True)
    base = os.path.join(a.output_dir, "闭环审计_" + dt.datetime.now().strftime("%Y%m%d-%H%M"))
    with open(base + "_汇总.md", "w", encoding="utf-8") as f:
        f.write(md)
    write_csv(base + "_未闭环.csv", pending, RECEIPT_FIELDS + ["未闭环原因"])
    print(md)
    print("输出：%s_汇总.md / _未闭环.csv" % base)
    if a.require_closed and pending:
        sys.exit(2)


def main():
    p = argparse.ArgumentParser(description="基模测试质检初筛 v2")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("baseline", help="从历史全量表建基线")
    b.add_argument("table")
    b.add_argument("-o", "--output", default="baseline.json")
    b.add_argument("--exclude", nargs="*", help="不进基线的 sheet 名")
    b.set_defaults(fn=cmd_baseline)
    s = sub.add_parser("screen", help="给一个 sheet 分档并生成复核回执")
    s.add_argument("table")
    s.add_argument("--sheet", help="sheet 名；不填就用表里最后一个已打分的 sheet")
    s.add_argument("--baseline", default="baseline.json")
    s.add_argument("--new-testers", help="新测试员名单，逗号分隔；他们的记录全部进必复核")
    s.add_argument("--rules-off", nargs="*", help="临时关掉的规则编号，如 V2")
    s.add_argument("--tag-matrix", default=DEFAULT_TAG_MATRIX, help="标签共存矩阵 CSV")
    s.add_argument("--history-threshold", type=float, default=1.0, help="V5 均分偏差阈值，默认 1.0；0 关闭")
    s.add_argument("--history-min-n", type=int, default=5, help="V5 所需最少历史试验数，默认 5")
    s.add_argument("--sample-rate", type=float, default=0.20, help="通过档盲抽比例，默认 0.20")
    s.add_argument("--min-sample", type=int, default=5, help="盲抽最少用例数，默认 5")
    s.add_argument("--seed", type=int, help="盲抽种子；不填由 sheet 名和用例顺序生成稳定种子")
    s.add_argument("-o", "--output-dir", default="out")
    s.set_defaults(fn=cmd_screen)
    c = sub.add_parser("compare", help="QC 前原版 vs QC 后终版，含判词变化，算召回和精度")
    c.add_argument("orig")
    c.add_argument("final")
    c.add_argument("--orig-sheet", required=True)
    c.add_argument("--final-sheet", required=True)
    c.add_argument("--baseline", default="baseline.json")
    c.add_argument("--new-testers")
    c.add_argument("--rules-off", nargs="*")
    c.add_argument("--tag-matrix", default=DEFAULT_TAG_MATRIX)
    c.add_argument("--history-threshold", type=float, default=1.0)
    c.add_argument("--history-min-n", type=int, default=5)
    c.add_argument("-o", "--output-dir", default="out")
    c.set_defaults(fn=cmd_compare)
    r = sub.add_parser("audit", help="审计复核回执，输出未闭环清单和盲抽漏检估计")
    r.add_argument("receipt", help="screen 生成并已填写的 _复核回执.csv")
    r.add_argument("--pass-total", type=int, help="通过档用例总数；默认从回执读取")
    r.add_argument("--target-miss-rate", type=float, default=0.05, help="发现能力目标漏检率，默认 0.05")
    r.add_argument("--confidence", type=float, default=0.8, help="发现概率目标，默认 0.8")
    r.add_argument("--require-closed", action="store_true", help="仍有未闭环项时以退出码 2 失败")
    r.add_argument("-o", "--output-dir", default="out")
    r.set_defaults(fn=cmd_audit)
    a = p.parse_args()
    if hasattr(a, "sample_rate") and not 0 <= a.sample_rate <= 1:
        p.error("--sample-rate 必须在 0 到 1 之间")
    if hasattr(a, "history_threshold") and a.history_threshold < 0:
        p.error("--history-threshold 不能小于 0")
    if hasattr(a, "target_miss_rate") and not 0 < a.target_miss_rate < 1:
        p.error("--target-miss-rate 必须在 0 到 1 之间")
    if hasattr(a, "confidence") and not 0 < a.confidence < 1:
        p.error("--confidence 必须在 0 到 1 之间")
    a.fn(a)


if __name__ == "__main__":
    main()
