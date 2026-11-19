#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把成稿 .md 发布成飞书文档（交付物是文档链接，md 只作中间稿）。

只做版式搬运：不改任何数字、不新增段落、不重排表格。
md → 飞书 DocxXML 后再导入，因为：
- 章节编号要的是飞书标题块自动编号（`seq="auto"`），Markdown 导入给不了；
- 差值染色要 `<span text-color>` / `<td background-color>`，Markdown 导入会把颜色丢掉。

同时固化的版式规则（与 `参考/报告样式范式.md` 一致）：
- `## / ### / ####` → h1/h2/h3（seq="auto"，自动显示 1. / 4.1 / 4.2.1）
- 标题下 `<callout emoji>` 原样保留
- 表头统一 `background-color="light-gray"`
- 表格「差值」列按语义染色：正=green、负=red（§6 问题标签表反向，标签变多=变差=red）
- 0/1/2 分布表的差值行：0 分、1 分反向染色，2 分正向

用法：
    python3 publish.py <报告.md> [--title 标题] [--parent-token <folder/wiki>]
                       [--position my_library] [--as user] [--dry-run]
"""
import argparse
import json
import os
import re
import subprocess
import sys

HEADING_LEVEL = {"##": 1, "###": 2, "####": 3, "#####": 4}


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(t):
    """行内富文本：**加粗**、[文字](链接) → b / a；其余转义。"""
    out, i, n = [], 0, len(t)
    while i < n:
        if t.startswith("**", i):
            j = t.find("**", i + 2)
            if j > 0:
                out.append("<b>" + esc(t[i + 2:j]) + "</b>")
                i = j + 2
                continue
        if t[i] == "[":
            m = re.match(r"\[([^\]]+)\]\(([^)]+)\)", t[i:])
            if m:
                out.append(f'<a href="{m.group(2)}">{esc(m.group(1))}</a>')
                i += m.end()
                continue
        nxt = min([x for x in (t.find("**", i), t.find("[", i + 1)) if x > -1] or [n])
        out.append(esc(t[i:nxt]))
        i = nxt
    return "".join(out)


def num(v):
    """把差值单元格解析成数字；空值、破折号与 0 都按「不染色」处理。"""
    v = v.strip().replace("**", "")
    if v in ("", "—", "-"):
        return 0.0
    m = re.match(r"[+-]?\d+(?:\.\d+)?", v)
    if not m:
        return None
    try:
        x = float(m.group(0))
    except ValueError:
        return None
    return 0.0 if abs(x) < 1e-12 else x


def tint(v, reverse=False):
    """返回应该用的颜色名（green/red），不需要染色时返回 None。"""
    x = num(v)
    if x is None or x == 0:
        return None
    good = (x > 0) if not reverse else (x < 0)
    return "green" if good else "red"


def table_xml(rows):
    """rows：第一行为表头，其余为数据行。按表头语义决定哪些单元格染色。"""
    head, body = rows[0], rows[1:]
    heads = [h.strip() for h in head]
    is_dist = len(heads) == 5 and heads[0] == "模型" and heads[4] == "2 分"
    is_tag = any("次数" in h for h in heads) and heads[-1] == "差值"
    rules = {}
    for idx, h in enumerate(heads):
        if h.startswith("差值（") or h == "满分率差值":
            rules[idx] = "normal"
        elif h == "差值" and is_tag:
            rules[idx] = "reverse"
        elif h == "均分差值":
            rules[idx] = None
    th = "".join(f'<th background-color="light-gray"><p>{inline(h)}</p></th>' for h in head)
    trs = []
    for r in body:
        cells = []
        first = (r[0] or "").strip()
        for idx, c in enumerate(r):
            c = (c or "").strip()
            col = None
            if is_dist and first == "差值" and idx in (2, 3, 4):
                col = tint(c, reverse=idx in (2, 3))
            elif idx in rules and rules[idx]:
                col = tint(c, reverse=(rules[idx] == "reverse"))
            html = inline(c)
            if col:
                html = f'<span text-color="{col}">{html}</span>'
            cells.append(f"<td><p>{html}</p></td>")
        trs.append("<tr>" + "".join(cells) + "</tr>")
    # 不写 colgroup：飞书自动列宽比按内容长度硬分配更稳（硬分配会把「+0.50」「+50.0pp」折断）
    return ("<table><thead><tr>" + th + "</tr></thead><tbody>" + "".join(trs) + "</tbody></table>")


def parse_table_lines(lines):
    cells = []
    for ln in lines:
        s = ln.strip().strip("|")
        row = [c.strip() for c in s.split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in row if c):
            continue
        cells.append(row)
    return cells


def md_to_xml(body):
    lines = body.splitlines()
    out, i, n = [], 0, len(lines)
    while i < n:
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1
            continue
        # callout
        if s.startswith("<callout"):
            tag = s
            i += 1
            inner = []
            while i < n and "</callout>" not in lines[i]:
                inner.append(lines[i])
                i += 1
            i += 1
            out.append(tag)
            for t in inner:
                t = t.strip()
                if t:
                    out.append(f"<p>{inline(t)}</p>")
            out.append("</callout>")
            continue
        # 标题
        m = re.match(r"^#{2,5}\s+(.*)$", s)
        if m:
            lvl = HEADING_LEVEL[s.split()[0]]
            out.append(f'<h{lvl} seq="auto">{inline(m.group(1))}</h{lvl}>')
            i += 1
            continue
        # 引用块
        if s.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append("<blockquote>" + "".join(f"<p>{inline(t)}</p>" for t in buf if t) + "</blockquote>")
            continue
        # 表格
        if s.startswith("|"):
            buf = []
            while i < n and lines[i].strip().startswith("|"):
                buf.append(lines[i])
                i += 1
            out.append(table_xml(parse_table_lines(buf)))
            continue
        # 列表（支持一层嵌套）
        if re.match(r"^[-*]\s+", s):
            items, base = [], None
            while i < n:
                cur = lines[i]
                m = re.match(r"^(\s*)[-*]\s+(.*)$", cur)
                if not m:
                    break
                indent = len(m.group(1))
                if base is None:
                    base = indent
                if indent > base:
                    items[-1] = (items[-1][0], items[-1][1], items[-1][2] + [m.group(2)])
                else:
                    items.append([indent, m.group(2), []])
                i += 1
            lis = []
            for _, text, subs in items:
                sub = ("<ul>" + "".join(f"<li>{inline(t)}</li>" for t in subs) + "</ul>") if subs else ""
                lis.append(f"<li>{inline(text)}{sub}</li>")
            out.append("<ul>" + "".join(lis) + "</ul>")
            continue
        # 普通段落
        out.append(f"<p>{inline(s)}</p>")
        i += 1
    return "".join(out)


def normalize(md):
    """返回 (title, xml_body, has_callout)"""
    lines = md.splitlines()
    title = None
    i = 0
    if lines and re.match(r"^#\s+", lines[0]):
        title = re.sub(r"^#\s+", "", lines[0]).strip()
        i = 1
        while i < len(lines) and not lines[i].strip():
            i += 1
    body = "\n".join(lines[i:]).rstrip() + "\n"
    return title, md_to_xml(body), "<callout" in body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--title", default=None)
    ap.add_argument("--doc", default=None, help="已有文档 id/URL：原地覆盖内容（不新建，链接不变）")
    ap.add_argument("--parent-token", default=None)
    ap.add_argument("--position", default=None, help="如 my_library")
    ap.add_argument("--as", dest="identity", default="user")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    path = os.path.abspath(a.report)
    if not os.path.exists(path):
        sys.exit(f"找不到报告文件：{path}")
    with open(path, encoding="utf-8") as f:
        md = f.read()
    title, body, has_callout = normalize(md)
    title = a.title or title
    if not title:
        title = os.path.splitext(os.path.basename(path))[0]

    out = os.path.join(os.path.dirname(path), "_发布稿.xml")
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"<title>{esc(title)}</title>{body}\n")

    if a.doc:
        cmd = ["lark-cli", "docs", "+update",
               "--doc", a.doc,
               "--command", "overwrite",
               "--doc-format", "xml",
               "--content", "@" + out,
               "--as", a.identity]
        if a.dry_run:
            print(" ".join(cmd)); return
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            sys.stderr.write(r.stdout + r.stderr)
            sys.exit(f"原地更新失败（exit {r.returncode}）")
        print(f"✅ 已原地更新：{a.doc}")
        print(f"   标题：{title}")
        print(f"   顶部 callout：{'已有' if has_callout else '无'}")
        print(f"   发布稿：{out}")
        return

    cmd = ["lark-cli", "docs", "+create",
           "--title", title,
           "--doc-format", "xml",
           "--content", "@" + out,
           "--as", a.identity]
    if a.parent_token:
        cmd += ["--parent-token", a.parent_token]
    elif a.position:
        cmd += ["--parent-position", a.position]

    if a.dry_run:
        print(" ".join(cmd))
        return

    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit(f"发布失败（exit {r.returncode}）")
    try:
        d = json.loads(r.stdout)
        doc = d["data"]["document"]
    except Exception:
        sys.stderr.write(r.stdout)
        sys.exit("发布返回无法解析")

    print(f"✅ 已发布：{doc['url']}")
    print(f"   标题：{title}")
    print(f"   文档 id：{doc['document_id']}")
    print(f"   顶部 callout：{'已有' if has_callout else '缺失（渲染器应直接产出，检查版式）'}")
    print(f"   发布稿：{out}")


if __name__ == "__main__":
    main()
