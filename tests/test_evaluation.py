"""联调测试：验证 CRC 沟通评分模块（evaluate.md + TEXT_GENERATION_API_KEY）。

用法（在项目根目录执行）：
  python tests/test_evaluation.py
  python tests/test_evaluation.py --parse-only
  python tests/test_evaluation.py --bad
  python tests/test_evaluation.py --trainee 小李
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import setting  # noqa: E402
from service.agent.evaluation import (  # noqa: E402
    CORE_PRINCIPLES,
    RUBRIC_DIMENSIONS,
    ChatMessage,
    EvalConfig,
    EvaluationAgent,
    load_rubric,
    normalize_report,
    parse_evaluation_json,
)

RUBRIC_FILE = ROOT / "service" / "skills" / "evaluate.md"

GOOD_DIALOGUE = [
    ChatMessage("patient", "参加这个试验，检查和药都免费吗？路费能报销吗？"),
    ChatMessage(
        "crc",
        "王阿姨您好，我是这项研究的 CRC。研究相关检查和试验用药都是免费的；"
        "交通补贴按知情同意书里的标准发放。您文化程度怎么样都没关系，"
        "我可以用大白话给您讲，您想到什么就问，我绝不着急。",
    ),
    ChatMessage("patient", "会不会分到安慰剂？万一有副作用谁负责？"),
    ChatMessage(
        "crc",
        "这项研究是随机双盲，分组我们工作人员也不知道，是为了结果更公正。"
        "不管分到哪一组，您的安全都有保障；若出现不适请马上联系我。"
        "不想参加随时可以退出，不会影响您以后在本院看病。"
        "知情同意书您可以带回家和家人一起看，想清楚再签。",
    ),
    ChatMessage("patient", "那随访的时候你们会打电话问我情况吗？"),
    ChatMessage(
        "crc",
        "会的，随访期间我会主动问候您近况，问问有没有不舒服、吃药有没有漏，"
        "有变化及时跟我说，我们一起处理。",
    ),
]

BAD_DIALOGUE = [
    ChatMessage("patient", "这个药有没有副作用？我听不懂那些术语。"),
    ChatMessage(
        "crc",
        "就是 RCT double-blind，AE/SAE 按方案上报，你签了 ICF 就不能反悔。"
        "别问那么多，快点签字，耽误后面筛查。",
    ),
    ChatMessage("patient", "那我不想参加了可以吗？"),
    ChatMessage(
        "crc",
        "都说到这份上了还退出？那你就别浪费我们时间。",
    ),
]


def run_local() -> int:
    """不调用网络：标准文件、解析与规整。"""
    print("=== 本地单测（无需 API）===")
    failed = 0

    try:
        rubric = load_rubric(RUBRIC_FILE)
    except Exception as exc:
        print(f"[FAIL] 读取评分标准失败: {exc}")
        return 1

    if "沟通准备" not in rubric or "共情能力" not in rubric:
        print("[FAIL] evaluate.md 内容缺少关键章节")
        failed += 1
    else:
        print(f"[OK] 已加载评分标准 ({len(rubric)} chars) → {RUBRIC_FILE}")

    expected_dims = sum(len(v) for v in RUBRIC_DIMENSIONS.values())
    print(f"[OK] 内置维度数: {expected_dims}；核心原则: {', '.join(CORE_PRINCIPLES)}")

    sample = {
        "overall_score": 82,
        "passed": True,
        "summary": "整体沟通较规范",
        "dimensions": [
            {
                "category": "沟通准备",
                "dimension": "信息传递",
                "score": 85,
                "passed": True,
                "evidence": "使用大白话解释",
                "suggestion": "可再确认理解",
            }
        ],
        "principles": {"以患者为中心": "尚可"},
        "strengths": ["态度温和"],
        "improvements": ["可增加理解确认"],
    }
    # 包在 markdown 里也应能解析
    wrapped = "如下：\n```json\n" + json.dumps(sample, ensure_ascii=False) + "\n```"
    try:
        parsed = parse_evaluation_json(wrapped)
        report = normalize_report(parsed, raw_text=wrapped, pass_score=70)
    except Exception as exc:
        print(f"[FAIL] 解析/规整失败: {exc}")
        return 1

    if len(report.dimensions) != expected_dims:
        print(
            f"[FAIL] 规整后维度应为 {expected_dims}，实际 {len(report.dimensions)}"
        )
        failed += 1
    else:
        print(f"[OK] 缺失维度已补齐至 {expected_dims} 项")

    if report.dimensions[0].dimension != "信息传递" or report.dimensions[0].score != 85:
        print("[FAIL] 已知维度分数未保留")
        failed += 1
    else:
        print("[OK] 已知维度分数保留正确")

    if failed:
        print(f"[FAIL] 本地单测失败 {failed} 项")
        return 1
    print("[OK] 本地单测全部通过")
    return 0


def test_local() -> None:
    assert run_local() == 0


async def run_eval(*, use_bad: bool, trainee: str | None) -> int:
    config = EvalConfig.from_env()
    dialogue = BAD_DIALOGUE if use_bad else GOOD_DIALOGUE
    label = "不合格示例" if use_bad else "合格示例"

    print(f"=== CRC 评分联调（{label}）===")
    print(f"base_url : {config.base_url}")
    print(f"model    : {config.model}")
    print(f"api_key  : {'已配置' if setting.ARK_API_KEY else '未配置'}")
    print(f"rubric   : {config.rubric_path}")
    print(f"trainee  : {trainee or '(未指定)'}")
    print()

    if not config.api_key:
        print("[FAIL] 未找到鉴权信息，请在 .env 填写 TEXT_GENERATION_API_KEY")
        return 1

    if not Path(config.rubric_path).is_file():
        print(f"[FAIL] 评分标准不存在: {config.rubric_path}")
        return 1

    t0 = time.perf_counter()
    try:
        async with EvaluationAgent(config) as agent:
            report = await agent.evaluate(
                dialogue,
                scenario="高血压新药临床试验知情同意与随访沟通",
                trainee_name=trainee,
            )
    except Exception as exc:
        print(f"[FAIL] 评分失败: {type(exc).__name__}: {exc}")
        return 2

    elapsed = (time.perf_counter() - t0) * 1000
    print(f"耗时     : {elapsed:.0f} ms")
    if report.usage:
        print(f"usage    : {report.usage}")
    print(f"总分     : {report.overall_score}")
    print(f"合格     : {report.passed}")
    print(f"总评     : {report.summary}")
    print("--- 各维度 ---")
    for d in report.dimensions:
        flag = "PASS" if d.passed else "FAIL"
        print(f"  [{flag}] {d.category}/{d.dimension}: {d.score:.0f}")
        if d.evidence:
            print(f"         依据: {d.evidence[:80]}")
        if d.suggestion:
            print(f"         建议: {d.suggestion[:80]}")

    if report.principles:
        print("--- 核心原则 ---")
        for k, v in report.principles.items():
            print(f"  - {k}: {v[:100]}")

    if report.strengths:
        print("--- 优点 ---")
        for s in report.strengths:
            print(f"  + {s}")
    if report.improvements:
        print("--- 改进 ---")
        for s in report.improvements:
            print(f"  * {s}")

    expected = sum(len(v) for v in RUBRIC_DIMENSIONS.values())
    if len(report.dimensions) != expected:
        print(f"[FAIL] 维度数量异常: {len(report.dimensions)} != {expected}")
        return 3
    if report.overall_score <= 0 and not report.summary:
        print("[FAIL] 未得到有效评分结果")
        return 3

    # 粗略方向校验：好对话通常更高，差对话通常更低
    if use_bad and report.overall_score >= 85:
        print(
            f"[WARN] 不合格示例得分偏高 ({report.overall_score})，请人工抽查模型尺度"
        )
    if not use_bad and report.overall_score < 40:
        print(
            f"[WARN] 合格示例得分偏低 ({report.overall_score})，请人工抽查模型尺度"
        )

    print(f"[OK] 评分完成 overall={report.overall_score} passed={report.passed}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="测试 CRC 沟通评分模块")
    parser.add_argument(
        "--parse-only",
        action="store_true",
        help="只跑本地单测，不调用方舟 API",
    )
    parser.add_argument(
        "--bad",
        action="store_true",
        help="使用不合格示例对话",
    )
    parser.add_argument("--trainee", default=None, help="受训 CRC 姓名")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.parse_only:
        raise SystemExit(run_local())

    code = run_local()
    if code != 0:
        raise SystemExit(code)
    print()
    code = asyncio.run(run_eval(use_bad=args.bad, trainee=args.trainee))
    raise SystemExit(code)


if __name__ == "__main__":
    main()
