#!/usr/bin/env python3
"""拼装报告：§1 用子代理写的文件，§2–§6 照底稿原样，不经过助手手抄（规则维护）。

用法：
  python3 assemble.py --status <work 目录>              只看 §1 是否已交付，立即返回，不等待
  python3 assemble.py <work 目录> <报告输出路径.md>       拼装报告
  python3 assemble.py --import-handback <子代理记录.jsonl> <work 目录>   子代理没有 Write 权限时，从它的会话记录导入 §1

work 目录里需要：
  *_数字底稿.md            cli.js 生成
  s1_conclusion.md         子代理 vla-conclusion 写的 §1 正文（引用块符号会被去掉）
  s1_conclusion.done       子代理最后写的完成标记
  s41.md（可选）           助手写的 4.1 表后解读
  s53.md（可选）           助手写的 5.3 表后总结
  s3_config.md（可选）     用户给了测试配置/研发优化输入时，助手写的第 3 节正文（不带节标题）
缺 §1 文件、缺完成标记、完成标记早于 §1 文件或早于底稿时一律拒绝，不允许助手自己顶替 §1。
"""
import glob
import os
import re
import sys

LINK = "预训练真机评测显著性分析口径（请由使用者补充授权链接）"


def find_draft(work):
    c = glob.glob(os.path.join(work, "*_数字底稿.md"))
    if len(c) != 1:
        sys.exit("❌ %s 里应有且只有 1 份 _数字底稿.md，实际 %d 份" % (work, len(c)))
    return c[0]


def s1_status(work):
    """返回 (是否可用, 说明)"""
    draft = find_draft(work)
    md, done = os.path.join(work, "s1_conclusion.md"), os.path.join(work, "s1_conclusion.done")
    if not os.path.exists(done):
        return False, "子代理还没交付：没有 s1_conclusion.done"
    if not os.path.exists(md):
        return False, "有完成标记但没有 s1_conclusion.md"
    if os.path.getmtime(done) < os.path.getmtime(md):
        return False, "完成标记早于 s1_conclusion.md，§1 可能被改过，需要子代理重写"
    if os.path.getmtime(md) < os.path.getmtime(draft):
        return False, "s1_conclusion.md 早于本轮底稿，是旧的，需要子代理按新底稿重写"
    with open(md, encoding="utf-8") as f:
        body = f.read().strip()
    if not body:
        return False, "s1_conclusion.md 是空的"
    return True, "子代理已交付 §1（%d 字%s）" % (len(body), "，含引用块符号，拼装时会去掉" if body.startswith(">") else "")


def insert_after_table(text, heading, extra):
    """在 heading 这一小节的最后一张表后面插入 extra"""
    start = text.index(heading)
    rest = text[start + len(heading):]
    nxt = re.search(r"\n#{2,4} ", rest)
    end = start + len(heading) + (nxt.start() if nxt else len(rest))
    sec = text[start:end]
    last_table = sec.rstrip("\n").rfind("\n|")
    line_end = sec.find("\n", last_table + 1)
    line_end = len(sec) if line_end == -1 else line_end
    sec = sec[:line_end + 1] + "\n" + extra.strip() + "\n" + sec[line_end + 1:]
    return text[:start] + sec + text[end:]


def clean_s1(raw):
    """§1 统一成正文（不用引用块），并去掉与顶部 callout 重复的那句结论。

    规则维护：结论节就是普通小标题 + 要点，引用块样式只留给统计说明里的提示，
    自动生成的分工是 callout 写一句结论、§1 只写各切面的要点。
    """
    lines = []
    for ln in raw.strip().splitlines():
        if ln.lstrip().startswith(">"):
            ln = ln.lstrip()[1:]
            if ln.startswith(" "):
                ln = ln[1:]
        lines.append(ln.rstrip())
    text = "\n".join(lines).strip()
    text = re.sub(r"^\*\*\s*\**\s*(?:核心)?结论\s*[：:].*?\*\*\s*$", "", text, flags=re.M)
    text = re.sub(r"^(?:核心)?结论\s*[：:].*$", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


# 第 3 节「测试配置对比」的固定行序：只列用户给到的行，值不给就留空（规则维护）
CONFIG_ROWS = ["模型地址", "finetune分支", "真机测试推理分支", "真机测试镜像", "测试机器", "启动脚本"]


def compact_config(sections, work):
    """把底稿里 11 行「实验配置」压成「测试配置对比」：只保留有值的行，表头旧模型标「（基线）」。

    - 用户在对话里给了配置 / 研发优化输入时，助手写 <work>/s3_config.md（不带节标题），原样替换；
    - 没有 s3_config.md 时，按底稿表里实际填了值的行输出；一行都没有值就退回 6 行空模板。
    """
    m = re.search(r"^##\s+(?:\d+\.\s*)?(?:测试配置对比|实验配置对比|测试配置|实验配置)\s*$", sections, re.M)
    if not m:
        return sections
    end = sections.find("\n## ", m.end())
    end = len(sections) if end == -1 else end
    sec = sections[m.end():end]

    custom = os.path.join(work, "s3_config.md")
    if os.path.exists(custom):
        with open(custom, encoding="utf-8") as f:
            body = f.read().strip()
        body = re.sub(r"^#{2,4}\s*(?:\d+\.\s*)?(?:测试配置对比|实验配置对比|测试配置|实验配置)\s*$", "", body, flags=re.M).strip()
        new = "## 测试配置对比\n\n" + body + "\n"
        return sections[:m.start()] + new + sections[end:]

    rows = [ln for ln in sec.splitlines() if ln.strip().startswith("|")]
    if len(rows) < 2:
        return sections
    cells = [[c.strip() for c in ln.strip().strip("|").split("|")] for ln in rows]
    header = cells[0]
    sep = rows[1]
    valued = [c for c in cells[2:] if any(x.strip() and x.strip() != "—" for x in c[1:])]
    if valued:
        table = valued
    else:
        table = [[r] + [""] * (len(header) - 1) for r in CONFIG_ROWS]
    if header[0] != "配置项":
        header[0] = "配置项"
    if len(header) > 1 and "（基线）" not in header[1]:
        header[1] += "（基线）"
    lines = ["| " + " | ".join(header) + " |", sep]
    lines += ["| " + " | ".join(c[:len(header)]) + " |" for c in table]
    new = "## 测试配置对比\n\n" + "\n".join(lines) + "\n"
    return sections[:m.start()] + new + sections[end:]


def build_callout(draft, work):
    """标题下的 callout：优先用 <work>/s0_core.md（结论撰写方写的一句话，不带统计数字），
    没有就用底稿自带的自动结论块。两者都保证是一层 callout。"""
    p = os.path.join(work, "s0_core.md")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            core = f.read().strip()
        core = re.sub(r"<callout[^>]*>|</callout>", "", core).strip()
        core = re.sub(r"^#{2,6}\s*(?:核心)?结论\s*$", "", core, flags=re.M).strip()
        if re.search(r"\d\s*%|\d\s*pp|p\s*[=<>]|[+\-−]\s*\d", core):
            print("⚠️ 核心结论块里出现统计数字，按规范应只写定性判断：" + core.splitlines()[0][:60])
        return '<callout emoji="⭐">\n%s\n</callout>' % core
    m = re.search(r"<callout[^>]*>.*?</callout>", draft, re.S)
    return m.group(0) if m else None


def assemble(work, out):
    ok, msg = s1_status(work)
    if not ok:
        sys.exit("❌ 拒绝拼装：" + msg)
    if os.path.exists(out):
        sys.exit("❌ %s 已存在。多轮生成不覆盖旧版，请换新时间戳" % out)

    with open(find_draft(work), encoding="utf-8") as f:
        draft = f.read()
    title = draft.split("\n", 1)[0]
    # §2 起照底稿原样；§1 由子代理文件提供，底稿里的结论段不参与拼装
    stat = re.search(r"^##\s+(?:\d+\.\s*)?统计说明\s*$", draft, re.M)
    if not stat:
        sys.exit("❌ 底稿里找不到「## 统计说明」，确认是 cli.js 新生成的底稿")
    sections = "## 统计说明" + draft[stat.end():]
    sections = sections.replace("详细方法解读见预训练真机评测显著性分析口径", "详细方法解读见" + LINK)
    sections = re.sub(r"\n> ⚠️ 执行次数与计划不符.*\n", "", sections)
    sections = re.sub(r"^\*\*(OOD [23]\.0（\d+ 用例）)\*\*$", r"#### \1", sections, flags=re.M)
    sections = compact_config(sections, work)
    for name, heading in (("s41.md", "### 4.1 "), ("s53.md", "### 5.3 ")):
        p = os.path.join(work, name)
        if os.path.exists(p) and heading in sections:
            with open(p, encoding="utf-8") as f:
                sections = insert_after_table(sections, heading, f.read())

    with open(os.path.join(work, "s1_conclusion.md"), encoding="utf-8") as f:
        s1 = clean_s1(f.read())
    callout = build_callout(draft, work)
    head = "%s\n\n%s" % (title, callout) if callout else title
    text = "%s\n\n## 结论\n\n%s\n\n%s" % (head, s1, sections)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print("✅ 已拼装：%s（§1 来自子代理文件，%s）" % (out, msg))


def import_handback(transcript, work):
    """子代理没有 Write 权限时（会话中途改定义不生效），从它的会话记录 .jsonl 里取出最后一次交回的原文，
    写成 s1_conclusion.md 和完成标记。全程由程序完成，助手不手抄（2026-10-30）"""
    import json
    msg = None
    with open(transcript, encoding="utf-8") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            for x in (d.get("message", {}).get("content") or []):
                if isinstance(x, dict) and x.get("type") == "tool_use" and x.get("name") == "SubagentHandback":
                    msg = (x.get("input") or {}).get("message")
    if not msg or not msg.strip():
        sys.exit("❌ %s 里没有子代理交回的 §1 正文，子代理可能还没结束" % transcript)
    draft = find_draft(work)
    if os.path.getmtime(transcript) < os.path.getmtime(draft):
        sys.exit("❌ 子代理记录早于本轮底稿，是旧一轮的结论，不能用")
    md, done = os.path.join(work, "s1_conclusion.md"), os.path.join(work, "s1_conclusion.done")
    if os.path.exists(md) or os.path.exists(done):
        sys.exit("❌ %s 里已有 §1 文件，不覆盖" % work)
    with open(md, "w", encoding="utf-8") as f:
        f.write(msg.strip() + "\n")
    with open(done, "w", encoding="utf-8") as f:
        f.write("done（导入自 %s）\n" % transcript)
    print("✅ 已从子代理记录导入 §1：%s" % md)


def main(argv):
    if len(argv) == 3 and argv[0] == "--import-handback":
        import_handback(argv[1], argv[2])
        return 0
    if len(argv) == 2 and argv[0] == "--status":
        ok, msg = s1_status(argv[1])
        print(("✅ " if ok else "⏳ ") + msg)
        return 0 if ok else 1
    if len(argv) == 2:
        assemble(*argv)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
