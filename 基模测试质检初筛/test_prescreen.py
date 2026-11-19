#!/usr/bin/env python3
"""初筛 v2 回归测试。用例为合成数据，只验证规则与闭环，不代表真实 sheet 的判分。"""
import os
import tempfile
import unittest

import prescreen as p


def rec(case, t=1, score="2", tags="", detail="完成", tester=""):
    return dict(case=case, occ=1, t=t, skill="", pch="合成指令", score=score, tags=tags,
                detail=detail, tester=tester)


class MatrixTests(unittest.TestCase):
    def test_matrix_is_valid_and_symmetric(self):
        self.assertTrue(p.load_tag_matrix())

    def test_zero_score_specific_failure_plus_retry_is_returned(self):
        hits, conflicts = p.evaluate_row(rec("SYN-001", score="0", tags="抓取失败,重试完成", detail="抓取失败"), False)
        self.assertIn("R10", hits)
        self.assertEqual("退回", p.tier_of(hits))
        self.assertTrue(any("抓取失败 + 重试完成" in x for x in conflicts))

    def test_all_specific_failures_have_new_conflicts_regardless_of_score(self):
        for tag in sorted(p.SPEC):
            for other, rule in (("重试完成", "R10"), ("过度执行", "R11")):
                with self.subTest(tag=tag, other=other, score="0"):
                    hits = p.check_row(rec("SYN-002", score="0", tags=tag + "," + other, detail="未完成"), False)
                    self.assertIn(rule, hits)

    def test_existing_conflicts_still_come_from_matrix(self):
        cases = (("部分完成,重试完成", "R4"), ("部分完成,质量瑕疵", "R5"),
                 ("结果失效,质量瑕疵", "R6"), ("部分完成,抓取失败", "R7"),
                 ("质量瑕疵,动作精度不足", "R8"), ("无有效动作,碰撞", "R3"))
        for tags, rule in cases:
            with self.subTest(rule=rule):
                self.assertIn(rule, p.check_row(rec("SYN-002", score="0", tags=tags, detail="未完成"), False))

    def test_partial_completion_and_overexecution_are_mutually_exclusive(self):
        hits, conflicts = p.evaluate_row(rec("SYN-002", score="0", tags="部分完成,过度执行", detail="未完成"), False)
        self.assertIn("R12", hits)
        self.assertEqual("退回", p.tier_of(hits))
        self.assertTrue(any("过度执行 + 部分完成" in x or "部分完成 + 过度执行" in x for x in conflicts))

    def test_process_combinations_allowed_by_definition_are_not_returned(self):
        for tags in ("重试完成,质量瑕疵", "重试完成,碰撞", "重试完成,过度执行", "质量瑕疵,过度执行"):
            with self.subTest(tags=tags):
                hits = p.check_row(rec("SYN-002", score="2", tags=tags, detail="最终完成"), False)
                self.assertNotEqual("退回", p.tier_of(hits))


class HistoryAndSamplingTests(unittest.TestCase):
    def base(self, n=5):
        return {"difficulty": {}, "cases": {"SYN-003": {"by_sheet": {"old": [0, 0, n]}, "top_tags": []}},
                "sheet_tot": {"old": [2 * n, n]}}

    def test_history_mean_triggers_case_level_v5(self):
        recs = [rec("SYN-003", t=t, score="0", detail="未完成") for t in range(1, 6)]
        recs += [rec("SYN-004", t=t, score="2", detail="完成") for t in range(1, 6)]
        rows = p.screen_records(recs, self.base(), "new", sample_rate=0)
        target = [x for x in rows if x["用例"] == "SYN-003"]
        self.assertTrue(all("V5" in x["命中规则"].split("、") for x in target))
        self.assertTrue(all(x["历史偏差"] == -1 for x in target))
        self.assertTrue(all(x["档位"] == "必复核" for x in target))

    def test_insufficient_history_does_not_trigger_v5(self):
        recs = [rec("SYN-003", t=t, score="0", detail="未完成") for t in range(1, 6)]
        rows = p.screen_records(recs, self.base(3), "new", sample_rate=0)
        self.assertTrue(all("V5" not in x["命中规则"] for x in rows))

    def test_blind_sample_has_minimum_and_is_reproducible(self):
        recs = [rec("SYN-%02d" % i) for i in range(33)]
        a = p.screen_records(recs, sheet_name="same", sample_rate=0.2, min_sample=5)
        b = p.screen_records(recs, sheet_name="same", sample_rate=0.2, min_sample=5)
        picked_a = [x["用例"] for x in a if x["档位"] == "通过-抽样"]
        picked_b = [x["用例"] for x in b if x["档位"] == "通过-抽样"]
        self.assertEqual(7, len(picked_a))
        self.assertEqual(picked_a, picked_b)
        self.assertTrue(all(x["通过档用例总数"] == 33 for x in a))


class JudgmentComparisonTests(unittest.TestCase):
    def test_score_unchanged_but_judgment_changed_counted(self):
        orig = [rec("SYN-006", detail="任务完成"), rec("SYN-007", detail="任务完成")]
        final = [rec("SYN-006", detail="仅接近目标，任务未完成"), rec("SYN-007", detail="对象未移动")]
        out, md = p.compare(orig, final)
        self.assertEqual(2, len(out))
        self.assertTrue(all(x["QC改判词"] and not x["QC改分"] and not x["QC改标签"] and x["QC改动"] for x in out))
        self.assertIn("其中仅改判词 2", md)

    def test_format_only_judgment_change_is_ignored(self):
        out, _ = p.compare([rec("SYN-008", detail="完成。")], [rec("SYN-008", detail=" 完成 ")])
        self.assertFalse(out[0]["QC改判词"])


class ReceiptTests(unittest.TestCase):
    def receipt(self, case, tier="必复核", status="已复核", changed="否", kind="", reviewer="QC", when="2026-11-16 18:00"):
        return dict(批次="test", 用例=case, 推荐档位=tier, 命中规则="", 需看的T="T1", 状态=status,
                    是否修改=changed, 修改类型=kind, 复核人=reviewer, 复核时间=when, 备注="",
                    通过档用例总数="10", 盲抽样本数="2")

    def test_returned_items_remain_open_until_complete(self):
        rows = [self.receipt("SYN-009", "退回", status="待处理", changed="", reviewer="", when=""),
                self.receipt("SYN-010", "退回", changed="")]
        md, pending, metrics = p.audit_receipt_rows(rows)
        self.assertEqual(2, len(pending))
        self.assertIsNone(metrics["estimated_recall"])
        self.assertIn("未闭环 2 行", md)
        self.assertIn("SYN-009", md)
        self.assertIn("SYN-010", md)

    def test_receipt_estimates_precision_recall_and_includes_judgment(self):
        rows = [self.receipt("A", changed="是", kind="判词"), self.receipt("B"),
                self.receipt("C", "通过-抽样", changed="是", kind="判词"), self.receipt("D", "通过-抽样")]
        _, pending, metrics = p.audit_receipt_rows(rows)
        self.assertFalse(pending)
        self.assertAlmostEqual(0.5, metrics["precision"])
        self.assertAlmostEqual(1 / 6, metrics["estimated_recall"])
        self.assertEqual(1, metrics["blind_changed"])

    def test_screen_outputs_receipt_template(self):
        rows = p.screen_records([rec("SYN-009", score="1", tags="部分完成,重试完成", detail="部分完成")], sample_rate=0)
        with tempfile.TemporaryDirectory() as d:
            base = p.write_outputs(rows, d, "test", report=True)
            self.assertTrue(os.path.exists(base + "_复核回执.csv"))
            receipts = p.receipt_rows(rows, p.case_rows(rows), "test")
            self.assertEqual("待处理", receipts[0]["状态"])
            self.assertEqual("SYN-009", receipts[0]["用例"])


if __name__ == "__main__":
    unittest.main()
