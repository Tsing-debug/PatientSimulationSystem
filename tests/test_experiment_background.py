"""联调 / 单元测试：实验背景提炼 Agent。

用法（在项目根目录执行）：
  python tests/test_experiment_background.py
  python tests/test_experiment_background.py --parse-only
  python tests/test_experiment_background.py --live
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from service.agent.experiment_background import (  # noqa: E402
    BackgroundConfig,
    ExperimentBackgroundAgent,
    OUTPUT_KEYS,
    extract_criteria_from_source,
    load_cde_json,
    load_skill,
    normalize_background,
    parse_background_json,
)

SKILL_FILE = ROOT / "service" / "skills" / "experiment_background.md"
SAMPLE_CDE = (
    ROOT
    / "service"
    / "acknowledge"
    / "relative_experiment"
    / "B-cell malignancies.json"
)

FAKE_MODEL_OUTPUT = """
{
  "研究登记号": "CTR20261435",
  "药物": "HRS-3005片",
  "疾病": "B细胞恶性肿瘤",
  "研究设计": "开放、非随机化、单臂I期研究",
  "给药安排": "口服，用药直至达到方案规定的治疗结束标准",
  "入选标准": ["会被覆盖的假条目"],
  "排除标准": ["会被覆盖的假条目"],
  "其他已知信息": [
    "登记资料显示有保险，具体条款未提供",
    "年龄≥18岁，男女均可，非健康受试者"
  ],
  "未提供的信息": [
    "完整到院安排",
    "单次访视耗时",
    "研究总时长",
    "具体费用和补贴安排"
  ]
}
"""


def test_skill_and_sample_exist() -> None:
    assert SKILL_FILE.is_file(), f"missing skill: {SKILL_FILE}"
    assert SAMPLE_CDE.is_file(), f"missing sample: {SAMPLE_CDE}"
    skill = load_skill(SKILL_FILE)
    assert "入排标准" in skill or "入选标准" in skill
    print("[OK] skill + sample CDE present")


def test_parse_and_preserve_criteria() -> None:
    cde = load_cde_json(SAMPLE_CDE)
    src_in, src_ex = extract_criteria_from_source(cde)
    assert len(src_in) >= 1
    assert len(src_ex) >= 1

    parsed = parse_background_json(FAKE_MODEL_OUTPUT)
    report = normalize_background(
        parsed,
        source=cde,
        preserve_criteria_verbatim=True,
    )
    assert report.研究登记号 == "CTR20261435"
    assert report.药物 == "HRS-3005片"
    assert report.入选标准 == src_in
    assert report.排除标准 == src_ex
    assert report.入选标准[0] != "会被覆盖的假条目"

    as_dict = report.to_dict()
    assert tuple(as_dict.keys()) == OUTPUT_KEYS
    print(
        f"[OK] parse/normalize "
        f"inclusion={len(report.入选标准)} exclusion={len(report.排除标准)}"
    )


async def run_live() -> int:
    config = BackgroundConfig.from_env()
    try:
        config.require_api_key()
    except ValueError as exc:
        print(f"[SKIP] live call: {exc}")
        return 0

    async with ExperimentBackgroundAgent(config) as agent:
        result = await agent.extract(SAMPLE_CDE)

    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    print(
        f"[OK] live extract registration={result.研究登记号!r} "
        f"drug={result.药物!r}",
        file=sys.stderr,
    )
    return 0 if result.研究登记号 else 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parse-only", action="store_true")
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()

    test_skill_and_sample_exist()
    test_parse_and_preserve_criteria()
    if args.parse_only:
        return
    if args.live or not args.parse_only:
        # 默认只跑离线；显式 --live 才打 API
        if args.live:
            raise SystemExit(asyncio.run(run_live()))
        print("[OK] offline checks passed (use --live for API call)")


if __name__ == "__main__":
    main()
