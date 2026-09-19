"""联调测试：验证 doubao-seed-character 情景扮演问题生成模块。

用法（在项目根目录执行）：
  python tests/test_questions_generate.py
  python tests/test_questions_generate.py --count 3 --topic 费用与补偿
  python tests/test_questions_generate.py --crc "这次试验的药都是免费的，您放心。"
  python tests/test_questions_generate.py --crc "副作用一般都比较轻。" --stream
  python tests/test_questions_generate.py --parse-only
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import setting  # noqa: E402
from service.agent.questions_generate import (  # noqa: E402
    ChatMessage,
    QuestionConfig,
    QuestionsGenerateAgent,
    ScenarioSpec,
    build_system_prompt,
    build_turn_user_prompt,
    parse_question_list,
)

DEFAULT_CRC = (
    "王阿姨您好，我是这项高血压新药试验的 CRC。"
    "参加试验期间研究相关检查和试验用药是免费的，您有什么担心可以现在问我。"
)


def run_parse_question_list() -> int:
    """不调用网络的解析单测。"""
    print("=== 解析单测（无需 API）===")
    cases = [
        ('["费用报销吗？", "有安慰剂吗？"]', 2),
        ('```json\n["副作用大吗？"]\n```', 1),
        ("1. 路费给报销吗？\n2. 能退出吗？", 2),
        ('{"questions": ["隐私会泄露吗？", "要抽几次血？"]}', 2),
    ]
    failed = 0
    for raw, expect_n in cases:
        got = parse_question_list(raw)
        ok = len(got) == expect_n and all(got)
        status = "OK" if ok else "FAIL"
        print(f"  [{status}] expect={expect_n} got={len(got)} -> {got}")
        if not ok:
            failed += 1

    prompt = build_system_prompt(scenario=ScenarioSpec(disease="糖尿病"))
    if "糖尿病" not in prompt or "患者" not in prompt:
        print("[FAIL] system prompt 未包含情景关键字段")
        failed += 1
    else:
        print("[OK] system prompt 构建正常")

    if failed:
        print(f"[FAIL] 解析单测失败 {failed} 项")
        return 1
    print("[OK] 解析单测全部通过")
    return 0


def test_parse_question_list() -> None:
    assert run_parse_question_list() == 0


async def run_batch(count: int, topic: str | None, disease: str) -> int:
    config = QuestionConfig.from_env()
    scenario = ScenarioSpec(
        disease=disease,
        patient_profile="58 岁女性，小学文化，首次参加试验，特别担心费用和被分到安慰剂组",
    )

    print("=== 批量问题生成联调 ===")
    print(f"base_url : {config.base_url}")
    print(f"model    : {config.model}")
    print(f"api_key  : {'已配置' if setting.ARK_API_KEY else '未配置'}")
    print(f"count    : {count}")
    print(f"topic    : {topic or '(不限)'}")
    print(f"disease  : {disease}")
    print()

    if not config.api_key:
        print("[FAIL] 未找到鉴权信息，请在 .env 填写 TEXT_GENERATION_API_KEY")
        return 1

    t0 = time.perf_counter()
    try:
        async with QuestionsGenerateAgent(config) as agent:
            result = await agent.generate_questions(
                count=count,
                scenario=scenario,
                topic=topic,
            )
    except Exception as exc:
        print(f"[FAIL] 生成失败: {type(exc).__name__}: {exc}")
        return 2

    elapsed = (time.perf_counter() - t0) * 1000
    print(f"耗时     : {elapsed:.0f} ms")
    if result.usage:
        print(f"usage    : {result.usage}")
    print("--- 原始输出 ---")
    print(result.text)
    print("--- 解析结果 ---")
    if not result.questions:
        print("[FAIL] 未解析到任何问题")
        return 3

    for i, q in enumerate(result.questions, 1):
        print(f"{i}. {q}")

    if len(result.questions) < max(1, count // 2):
        print(
            f"[WARN] 期望约 {count} 条，实际 {len(result.questions)} 条（模型可能未严格 JSON）"
        )
    print(f"[OK] 生成 {len(result.questions)} 条患者问题")
    return 0


async def run_turn(crc: str, disease: str, stream: bool) -> int:
    config = QuestionConfig.from_env()
    scenario = ScenarioSpec(disease=disease)

    print("=== 多轮追问联调 ===")
    print(f"model    : {config.model}")
    print(f"api_key  : {'已配置' if setting.ARK_API_KEY else '未配置'}")
    print(f"stream   : {stream}")
    print(f"CRC 说   : {crc}")
    print()

    if not config.api_key:
        print("[FAIL] 未找到鉴权信息，请在 .env 填写 TEXT_GENERATION_API_KEY")
        return 1

    t0 = time.perf_counter()
    try:
        async with QuestionsGenerateAgent(config) as agent:
            if stream:
                system = build_system_prompt(scenario=scenario)
                messages = [
                    ChatMessage("system", system),
                    ChatMessage("user", build_turn_user_prompt(crc)),
                ]
                print("--- 患者（流式）---")
                buf: list[str] = []
                async for piece in agent.stream_chat(messages):
                    print(piece, end="", flush=True)
                    buf.append(piece)
                print()
                text = "".join(buf).strip()
            else:
                result = await agent.next_patient_question(crc, scenario=scenario)
                text = result.text
                print("--- 患者 ---")
                print(text)
                if result.usage:
                    print(f"usage: {result.usage}")
    except Exception as exc:
        print(f"[FAIL] 追问失败: {type(exc).__name__}: {exc}")
        return 2

    elapsed = (time.perf_counter() - t0) * 1000
    print(f"耗时: {elapsed:.0f} ms")
    if not text:
        print("[FAIL] 未收到患者回复")
        return 3
    print("[OK] 多轮追问生成成功")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="测试情景扮演问题生成模块")
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--topic", default=None)
    parser.add_argument("--disease", default="高血压")
    parser.add_argument("--crc", default=None, help="CRC 发言；提供则测多轮追问")
    parser.add_argument(
        "--stream",
        action="store_true",
        help="多轮追问时使用流式输出（需同时提供 --crc）",
    )
    parser.add_argument(
        "--parse-only",
        action="store_true",
        help="只跑本地解析单测，不调用方舟 API",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.parse_only:
        raise SystemExit(run_parse_question_list())

    # 先跑解析，再跑联调
    parse_code = run_parse_question_list()
    if parse_code != 0:
        raise SystemExit(parse_code)

    print()
    if args.crc or args.stream:
        crc = args.crc or DEFAULT_CRC
        code = asyncio.run(run_turn(crc, args.disease, args.stream))
    else:
        code = asyncio.run(run_batch(args.count, args.topic, args.disease))
    raise SystemExit(code)


if __name__ == "__main__":
    main()
