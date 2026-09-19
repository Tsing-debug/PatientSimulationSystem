"""火山方舟 — 入组前多轮患者回应 Agent。

技能说明：
  service/skills/patient_turn.md

输入（每轮）：
  - 研究背景、顾虑池（固定）
  - 患者画像（开局第一步）
  - 上一轮状态、最近对话、CRC 最新回答

流程：
  更新状态 → 决定行为 → 生成患者下一句 → 校验格式 →
  保存新状态 / 对话 → 展示台词 → 等待下一轮 CRC 回答。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from service.agent.tts_emotion import resolve_patient_emotion

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seed-character-251128"
DEFAULT_TEMPERATURE = 0.55
DEFAULT_MAX_TOKENS = 3072
DEFAULT_TIMEOUT = 120.0
DEFAULT_DIALOGUE_TAIL = 8  # 提示词中附带的最近对话轮数
DEFAULT_MAX_TURNS = 16  # 患者发言轮数上限（含开局首句）

_SERVICE_ROOT = Path(__file__).resolve().parents[1]
_SKILL_PATH = _SERVICE_ROOT / "skills" / "patient_turn.md"
_DEFAULT_STUDY = "Chronic rhinosinusitis with nasal polyps"
_DEFAULT_BACKGROUND = (
    _SERVICE_ROOT
    / "acknowledge"
    / "relative_experiment"
    / f"{_DEFAULT_STUDY}.background.json"
)
_DEFAULT_CONCERNS = (
    _SERVICE_ROOT
    / "acknowledge"
    / "questions_pool"
    / f"{_DEFAULT_STUDY}.concerns.json"
)
_DEFAULT_OPENING = (
    _SERVICE_ROOT
    / "acknowledge"
    / "opening_state"
    / f"{_DEFAULT_STUDY}.opening.json"
)
_DEFAULT_SESSION_DIR = _SERVICE_ROOT / "acknowledge" / "dialogue_sessions"

ACTIONS = ("回答", "追问", "表达顾虑", "换话题", "结束")

OUTPUT_SCHEMA_EXAMPLE = {
    "患者画像": {
        "年龄": 42,
        "学历": "本科",
        "健康信息理解能力": "低",
        "试验经历": "没有参加过",
        "交流特点": "谨慎，主动提问",
        "决策偏好": "想与家属商量",
        "陪同者": "无",
        "生活限制": ["工作日请假困难"],
        "疾病背景": "自述有鼻息肉，鼻塞伴嗅觉减退，具体病史待询问",
        "筛选状态": "尚未正式筛选",
    },
    "状态": {
        "主要顾虑": ["到院安排", "安慰剂分组"],
        "当前话题": "到院安排",
        "已理解": ["给药是每24周一次皮下注射"],
        "尚不清楚": ["中间要不要来医院随访"],
        "待核实事项": ["完整到院安排"],
        "已讨论清楚的话题": [],
        "当前情绪": "中性",
        "参与态度": "愿意了解",
    },
    "动作": "结束",
    "患者台词": "那麻烦您确认一下到院安排，我回去和家里商量一下。",
    "是否结束": True,
    "结束原因": "等待安排确认，并与家属商量",
}

END_REASON_HINTS = (
    "主要疑问已讨论充分",
    "需与家属商量后再决定",
    "等待安排确认",
    "暂不考虑参加",
    "达到轮数上限，保留未决事项",
)

STATE_KEYS = (
    "主要顾虑",
    "当前话题",
    "已理解",
    "尚不清楚",
    "待核实事项",
    "已讨论清楚的话题",
    "当前情绪",
    "参与态度",
)
PORTRAIT_KEYS = (
    "年龄",
    "学历",
    "健康信息理解能力",
    "试验经历",
    "交流特点",
    "决策偏好",
    "陪同者",
    "生活限制",
    "疾病背景",
    "筛选状态",
)


# ---------------------------------------------------------------------------
# Config / result
# ---------------------------------------------------------------------------
@dataclass
class PatientTurnConfig:
    api_key: str = ""
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    temperature: float = DEFAULT_TEMPERATURE
    max_tokens: int = DEFAULT_MAX_TOKENS
    timeout: float = DEFAULT_TIMEOUT
    skill_path: Path = _SKILL_PATH
    trust_env: bool = True
    dialogue_tail: int = DEFAULT_DIALOGUE_TAIL
    max_turns: int = DEFAULT_MAX_TURNS

    @classmethod
    def from_env(cls, **overrides: Any) -> PatientTurnConfig:
        try:
            from config import setting as cfg
        except ImportError:  # pragma: no cover
            cfg = None

        def _get(*keys: str, default: str = "") -> str:
            for key in keys:
                val = os.getenv(key)
                if val and val.strip():
                    return val.strip()
            if cfg is not None:
                for key in keys:
                    mapped = {
                        "TEXT_GENERATION_API_KEY": "ARK_API_KEY",
                        "ARK_API_KEY": "ARK_API_KEY",
                        "TEXT_GENERATION_MODEL": "ARK_MODEL",
                        "ARK_MODEL": "ARK_MODEL",
                        "ARK_BASE_URL": "ARK_BASE_URL",
                    }.get(key, key)
                    val = getattr(cfg, mapped, None)
                    if val and str(val).strip():
                        return str(val).strip()
            return default

        skill = overrides.pop("skill_path", None)
        no_proxy = os.getenv("ARK_NO_PROXY", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        values: dict[str, Any] = {
            "api_key": _get(
                "TEXT_GENERATION_API_KEY",
                "ARK_API_KEY",
                "VOLC_ARK_API_KEY",
            ),
            "base_url": _get("ARK_BASE_URL", default=DEFAULT_BASE_URL).rstrip("/"),
            "model": _get(
                "TEXT_GENERATION_MODEL",
                "ARK_MODEL",
                default=DEFAULT_MODEL,
            ),
            "temperature": float(
                os.getenv("ARK_TURN_TEMPERATURE", str(DEFAULT_TEMPERATURE))
            ),
            "max_tokens": int(
                os.getenv("ARK_TURN_MAX_TOKENS", str(DEFAULT_MAX_TOKENS))
            ),
            "timeout": float(os.getenv("ARK_TIMEOUT", str(DEFAULT_TIMEOUT))),
            "trust_env": not no_proxy,
            "dialogue_tail": int(
                os.getenv("ARK_TURN_DIALOGUE_TAIL", str(DEFAULT_DIALOGUE_TAIL))
            ),
            "max_turns": int(
                os.getenv("ARK_TURN_MAX_TURNS", str(DEFAULT_MAX_TURNS))
            ),
        }
        if skill is not None:
            values["skill_path"] = Path(skill)
        values.update({k: v for k, v in overrides.items() if v is not None})
        return cls(**values)

    def require_api_key(self) -> None:
        if not self.api_key:
            raise ValueError(
                "缺少鉴权信息：请在项目根目录 .env 中设置 TEXT_GENERATION_API_KEY"
            )


@dataclass
class TurnResult:
    data: dict[str, Any] = field(default_factory=dict)
    raw_text: str = ""
    raw: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return self.data

    @property
    def line(self) -> str:
        return str(self.data.get("患者台词", "") or "")

    @property
    def ended(self) -> bool:
        return bool(self.data.get("是否结束"))

    @property
    def action(self) -> str:
        return str(self.data.get("动作", "") or "")

    @property
    def end_reason(self) -> str:
        return str(self.data.get("结束原因", "") or "")

    @property
    def state(self) -> dict[str, Any]:
        s = self.data.get("状态")
        return s if isinstance(s, dict) else {}


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------
def load_skill(path: Path | None = None) -> str:
    p = path or _SKILL_PATH
    if not p.is_file():
        raise FileNotFoundError(f"技能说明不存在: {p}")
    text = p.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"技能说明为空: {p}")
    return text


def load_json(path: Path | str) -> Any:
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"文件不存在: {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def extract_opening_bundle(opening: dict[str, Any]) -> tuple[dict, dict, str]:
    """从开局 JSON 拆出画像、状态、首句台词。"""
    portrait = opening.get("患者画像")
    state = opening.get("状态")
    line = str(opening.get("患者台词", "") or "").strip()
    if not isinstance(portrait, dict):
        raise ValueError("开局文件缺少有效「患者画像」")
    if not isinstance(state, dict):
        raise ValueError("开局文件缺少有效「状态」")
    return portrait, state, line


def format_dialogue(
    dialogue: Sequence[dict[str, str]] | Sequence[Any],
    *,
    tail: int | None = None,
) -> str:
    items = list(dialogue)
    if tail is not None and tail > 0:
        items = items[-tail:]
    lines: list[str] = []
    for i, item in enumerate(items, 1):
        if isinstance(item, dict):
            role = str(item.get("role", "unknown"))
            content = str(item.get("content", "")).strip()
        else:
            role, content = "unknown", str(item).strip()
        role_zh = {
            "patient": "患者",
            "crc": "CRC",
            "user": "CRC",
            "assistant": "患者",
        }.get(role.lower(), role)
        lines.append(f"{i}. 【{role_zh}】{content}")
    return "\n".join(lines) if lines else "（暂无）"


def build_system_prompt(
    skill: str,
    *,
    max_turns: int = DEFAULT_MAX_TURNS,
    training_focus: str = "",
) -> str:
    schema = json.dumps(OUTPUT_SCHEMA_EXAMPLE, ensure_ascii=False, indent=2)
    focus_para = ""
    if training_focus.strip():
        focus_para = (
            "\n【本回合训练重点】\n"
            f"{training_focus.strip()}\n"
            "这是受训者本次需要强化的沟通能力。你可以据此调整追问强度、"
            "情绪表现和顾虑表达：当受训者体现该能力时给予更积极的回应，"
            "当受训者欠缺该能力时适度加重顾虑或情绪，帮助其获得针对性练习。\n"
        )
    return (
        "你正在 CRC 沟通训练中扮演患者，进行入组前多轮对话。\n"
        "请严格依据技能说明，按「更新状态 → 决定行为 → 生成台词」完成输出。\n\n"
        "【技能说明】\n"
        f"{skill.strip()}\n\n"
        "【任务】\n"
        "先根据CRC回答更新患者状态，再决定回答、追问、表达顾虑、换话题或结束，"
        "最后生成患者下一句话。\n\n"
        "要求：\n"
        "- 保持患者画像一致。\n"
        "- CRC提出问题时优先回应。\n"
        "- 当前疑问没有解答时可以继续追问。\n"
        "- 不要求每轮换话题。\n"
        "- 不要求问完顾虑池。\n"
        "- 不编造未知研究信息。\n"
        "- 输出状态表示听完CRC回答后的情况，"
        "不能把患者刚提出的问题记录为已经理解。\n"
        "- 患者台词必须是新的一句，须回应该 CRC 刚说的内容；"
        "禁止原样或几乎原样重复上一句患者台词。\n"
        "- 「当前情绪」必须与本轮患者台词语气一致，且只能是："
        "开心/悲伤/生气/惊讶/恐惧/厌恶/激动/冷漠/中性；"
        "犹豫追问不要标成恐惧，多数用中性或悲伤。"
        "若 CRC 冷漠、敷衍或不尊重，必须标生气或厌恶，台词也要体现不满。\n"
        "- 退出条件（任一即可结束）：主要疑问讨论充分；需家属商量；"
        "关键安排待确认；暂不考虑；或达到轮数上限。\n"
        f"- 本会话患者发言轮数上限为 {max_turns}（含开局首句）；"
        "若提示已达上限，必须动作=结束，收尾并保留未决事项。\n\n"
        "【输出 Schema 示例】\n"
        f"{schema}\n\n"
        f"{focus_para}\n"
        "动作可选："
        + " / ".join(ACTIONS)
        + "。只输出一个 JSON 对象，不要 markdown 代码块，不要其它说明。"
    )


def build_user_prompt(
    *,
    background: dict[str, Any],
    concerns: list[Any],
    portrait: dict[str, Any],
    prev_state: dict[str, Any],
    dialogue_text: str,
    crc_reply: str,
    patient_turn_count: int,
    max_turns: int,
) -> str:
    remaining = max(0, max_turns - patient_turn_count)
    limit_note = (
        f"当前患者已发言 {patient_turn_count} 轮（含开局），上限 {max_turns}，"
        f"本轮生成后将达到/超过上限，请收尾结束并保留未解决事项。"
        if remaining <= 1
        else f"当前患者已发言 {patient_turn_count} 轮（含开局），上限 {max_turns}，"
        f"还可继续约 {remaining - 1} 轮患者发言。"
    )
    return (
        "【研究背景】\n"
        f"{json.dumps(background, ensure_ascii=False, indent=2)}\n\n"
        "【顾虑池】\n"
        f"{json.dumps(concerns, ensure_ascii=False, indent=2)}\n\n"
        "【患者画像】\n"
        f"{json.dumps(portrait, ensure_ascii=False, indent=2)}\n\n"
        "【上一轮状态】\n"
        f"{json.dumps(prev_state, ensure_ascii=False, indent=2)}\n\n"
        "【最近对话】\n"
        f"{dialogue_text}\n\n"
        "【CRC最新回答】\n"
        f"{crc_reply.strip()}\n\n"
        f"【轮数提示】\n{limit_note}\n\n"
        "请输出更新后的 JSON（患者画像须与输入一致；含动作/是否结束/结束原因）。"
        "患者台词须承接 CRC 最新回答，禁止复读上一句患者台词。"
        "若 CRC 最新回答冷漠、敷衍或不尊重，当前情绪须为生气或厌恶，台词体现不满。"
    )


_JSON_OBJECT_RE = re.compile(r"\{[\s\S]*\}")

_CRC_END_RE = re.compile(
    r"(?:结束|停止|终止|退出|到此为止|不(?:想)?测了|不继续了)"
    r"(?:这次|本次|当前)?(?:测评|测试|评估|沟通|对话|咨询|会话)?"
    r"|(?:测评|测试|评估|沟通|对话|咨询|会话)(?:结束|停止|终止)",
    re.IGNORECASE,
)
_CRC_ABUSE_RE = re.compile(
    r"(?:傻[逼比]|蠢货|废物|垃圾|白痴|智障|脑残|闭嘴|滚(?:蛋|开)?|去死|操你|妈的|"
    r"fuck\s*(?:you|off)?|idiot|stupid|moron|shut\s*up)",
    re.IGNORECASE,
)


def detect_forced_end(crc_reply: str) -> tuple[str, str] | None:
    """Program-level terminal intents must not depend on model discretion."""
    text = str(crc_reply or "").strip()
    if _CRC_END_RE.search(text):
        return "好的，本次沟通就到这里，谢谢。", "CRC 主动结束测评"
    if _CRC_ABUSE_RE.search(text):
        return (
            "我不能接受这样的说话方式，这次沟通先结束吧。",
            "沟通不尊重，患者终止交流",
        )
    return None


def parse_turn_json(text: str) -> dict[str, Any]:
    raw = text.strip()
    if not raw:
        raise ValueError("模型返回为空")
    candidates = [raw]
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, flags=re.IGNORECASE)
    if fence:
        candidates.insert(0, fence.group(1).strip())
    match = _JSON_OBJECT_RE.search(raw)
    if match:
        candidates.insert(0, match.group(0))
    last_err: Exception | None = None
    for cand in candidates:
        try:
            data = json.loads(cand)
        except json.JSONDecodeError as exc:
            last_err = exc
            continue
        if isinstance(data, dict):
            return data
    raise ValueError(f"无法解析回合 JSON: {last_err}; 前200字={raw[:200]!r}")


def _str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _normalize_line_for_compare(text: str) -> str:
    s = re.sub(r"\s+", "", str(text or "").strip())
    s = re.sub(r"[，。！？、；：,.!?;:…~～]+$", "", s)
    return s


def _lines_too_similar(a: str, b: str) -> bool:
    """判定两句患者台词是否实质复读（完全相同或一句包含另一句且长度接近）。"""
    na, nb = _normalize_line_for_compare(a), _normalize_line_for_compare(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(shorter) < 8:
        return False
    if shorter in longer and len(shorter) / len(longer) >= 0.85:
        return True
    return False


def validate_turn_payload(data: dict[str, Any]) -> list[str]:
    """程序格式检查；返回错误列表（空=通过）。"""
    errors: list[str] = []
    if "患者画像" not in data or not isinstance(data["患者画像"], dict):
        errors.append("缺少对象字段「患者画像」")
    if "状态" not in data or not isinstance(data["状态"], dict):
        errors.append("缺少对象字段「状态」")
    if "患者台词" not in data or not str(data.get("患者台词", "")).strip():
        errors.append("缺少非空「患者台词」")
    if "是否结束" not in data or not isinstance(data["是否结束"], bool):
        errors.append("「是否结束」必须是布尔值")

    action = str(data.get("动作", "") or "").strip()
    if action not in ACTIONS:
        errors.append(f"「动作」必须是其一：{' / '.join(ACTIONS)}")

    end_reason = str(data.get("结束原因", "") or "").strip()
    ended = bool(data.get("是否结束")) if isinstance(data.get("是否结束"), bool) else False
    if ended:
        if action != "结束":
            errors.append("是否结束=true 时动作必须为「结束」")
        if not end_reason:
            errors.append("结束时「结束原因」不能为空")
    else:
        if action == "结束":
            errors.append("动作=结束 时是否结束必须为 true")

    state = data.get("状态")
    if isinstance(state, dict):
        for key in STATE_KEYS:
            if key not in state:
                errors.append(f"状态缺少字段「{key}」")
        for list_key in (
            "主要顾虑",
            "已理解",
            "尚不清楚",
            "待核实事项",
            "已讨论清楚的话题",
        ):
            if list_key in state and not isinstance(state[list_key], list):
                errors.append(f"状态「{list_key}」必须是数组")
    return errors


def force_end_for_turn_limit(
    data: dict[str, Any],
    *,
    prev_state: dict[str, Any],
) -> dict[str, Any]:
    """轮数触顶时强制收尾，保留未决事项。"""
    state_in = data.get("状态") if isinstance(data.get("状态"), dict) else {}
    unclear = _str_list(state_in.get("尚不清楚")) or _str_list(
        prev_state.get("尚不清楚")
    )
    pending = _str_list(state_in.get("待核实事项")) or _str_list(
        prev_state.get("待核实事项")
    )
    leftovers = unclear + [x for x in pending if x not in unclear]
    if leftovers:
        tip = "、".join(leftovers[:2])
        line = (
            f"今天先这样吧，还有「{tip}」这些我想再确认一下，"
            "您核实后跟我说一声，我也可以回去和家里商量。"
        )
        reason = "达到轮数上限，保留未决事项"
    else:
        line = "好的，我先了解这些，暂时没有别的问题了，回头再联系您。"
        reason = "达到轮数上限，保留未决事项"

    out = dict(data)
    out["动作"] = "结束"
    out["是否结束"] = True
    out["结束原因"] = reason
    out["患者台词"] = str(data.get("患者台词") or "").strip() or line
    if not str(out.get("结束原因", "")).strip():
        out["结束原因"] = reason
    return out


def normalize_turn(
    data: dict[str, Any],
    *,
    locked_portrait: dict[str, Any],
    prev_state: dict[str, Any],
    force_end: bool = False,
    raw_text: str = "",
    raw: dict[str, Any] | None = None,
    usage: dict[str, Any] | None = None,
    crc_reply: str = "",
) -> TurnResult:
    """锁定画像；规整状态/动作/结束字段；格式校验失败则抛错。"""
    if force_end:
        data = force_end_for_turn_limit(data, prev_state=prev_state)

    portrait = {
        k: locked_portrait.get(k) for k in PORTRAIT_KEYS if k in locked_portrait
    }
    for k, v in locked_portrait.items():
        portrait.setdefault(k, v)

    state_in = data.get("状态") if isinstance(data.get("状态"), dict) else {}
    prev = prev_state if isinstance(prev_state, dict) else {}

    main = _str_list(state_in.get("主要顾虑")) or _str_list(prev.get("主要顾虑"))
    current = str(state_in.get("当前话题") or prev.get("当前话题") or "").strip()
    if not current and main:
        current = main[0]

    action = str(data.get("动作", "") or "").strip()
    ended = bool(data.get("是否结束", False))
    end_reason = str(data.get("结束原因", "") or "").strip()
    line = str(data.get("患者台词", "") or "").strip()

    emotion = resolve_patient_emotion(
        str(state_in.get("当前情绪") or ""),
        line,
        prev_label=str(prev.get("当前情绪") or "中性"),
        crc_reply=crc_reply,
    )

    state = {
        "主要顾虑": main,
        "当前话题": current,
        "已理解": _str_list(state_in.get("已理解")),
        "尚不清楚": _str_list(state_in.get("尚不清楚")),
        "待核实事项": _str_list(state_in.get("待核实事项")),
        "已讨论清楚的话题": _str_list(state_in.get("已讨论清楚的话题")),
        "当前情绪": emotion,
        "参与态度": str(
            state_in.get("参与态度") or prev.get("参与态度") or "愿意了解"
        ).strip(),
    }

    if ended:
        action = "结束"
        if not end_reason:
            end_reason = "对话结束"
    else:
        if action == "结束":
            ended = True
            end_reason = end_reason or "对话结束"
        elif action not in ACTIONS:
            action = "追问"
        end_reason = end_reason if ended else ""

    out = {
        "患者画像": portrait,
        "状态": state,
        "动作": action,
        "患者台词": line,
        "是否结束": ended,
        "结束原因": end_reason if ended else "",
    }
    errors = [e for e in validate_turn_payload(out) if "患者画像" not in e]
    if errors:
        raise ValueError("输出格式检查失败: " + "; ".join(errors))

    return TurnResult(
        data=out,
        raw_text=raw_text,
        raw=raw or {},
        usage=usage or {},
    )


# ---------------------------------------------------------------------------
# Session persistence
# ---------------------------------------------------------------------------
@dataclass
class DialogueSession:
    """会话目录：state.json / dialogue.jsonl / turns/ / meta.json"""

    root: Path
    background: dict[str, Any]
    concerns: list[Any]
    portrait: dict[str, Any]
    state: dict[str, Any]
    dialogue: list[dict[str, str]] = field(default_factory=list)
    background_path: str = ""
    concerns_path: str = ""
    opening_path: str = ""
    study_stem: str = ""
    ended: bool = False
    end_reason: str = ""
    last_action: str = ""
    last_line: str = ""
    training_focus: str = ""

    @property
    def state_path(self) -> Path:
        return self.root / "state.json"

    @property
    def dialogue_path(self) -> Path:
        return self.root / "dialogue.jsonl"

    @property
    def meta_path(self) -> Path:
        return self.root / "meta.json"

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        state_payload: dict[str, Any] = {
            "患者画像": self.portrait,
            "状态": self.state,
            "是否结束": self.ended,
        }
        if self.last_action:
            state_payload["动作"] = self.last_action
        if self.last_line:
            state_payload["患者台词"] = self.last_line
        if self.end_reason:
            state_payload["结束原因"] = self.end_reason
        save_json(self.state_path, state_payload)
        with self.dialogue_path.open("w", encoding="utf-8") as fh:
            for item in self.dialogue:
                fh.write(json.dumps(item, ensure_ascii=False) + "\n")
        save_json(
            self.meta_path,
            {
                "updated_at": datetime.now().isoformat(timespec="seconds"),
                "turns": sum(1 for x in self.dialogue if x.get("role") == "patient"),
                "ended": self.ended,
                "study_stem": self.study_stem,
                "background_path": self.background_path,
                "concerns_path": self.concerns_path,
                "opening_path": self.opening_path,
                "training_focus": self.training_focus,
            },
        )

    def append_turn_snapshot(self, turn: dict[str, Any], *, index: int) -> None:
        save_json(self.root / "turns" / f"{index:03d}.json", turn)

    @classmethod
    def create_from_opening(
        cls,
        *,
        session_dir: Path,
        background: dict[str, Any],
        concerns: list[Any],
        opening: dict[str, Any],
        background_path: str = "",
        concerns_path: str = "",
        opening_path: str = "",
        study_stem: str = "",
        training_focus: str = "",
    ) -> DialogueSession:
        portrait, state, line = extract_opening_bundle(opening)
        session = cls(
            root=session_dir,
            background=background,
            concerns=concerns,
            portrait=portrait,
            state=state,
            dialogue=[],
            background_path=background_path,
            concerns_path=concerns_path,
            opening_path=opening_path,
            study_stem=study_stem,
            training_focus=training_focus,
            ended=False,
            last_line=line,
        )
        if line:
            session.dialogue.append({"role": "patient", "content": line})
        session.save()
        session.append_turn_snapshot(
            {
                "患者画像": portrait,
                "状态": state,
                "患者台词": line,
                "是否结束": False,
            },
            index=0,
        )
        return session

    @classmethod
    def load(cls, session_dir: Path, *, background: dict, concerns: list) -> DialogueSession:
        state_file = load_json(session_dir / "state.json")
        portrait = state_file.get("患者画像")
        state = state_file.get("状态")
        if not isinstance(portrait, dict) or not isinstance(state, dict):
            raise ValueError(f"会话状态文件无效: {session_dir / 'state.json'}")
        dialogue: list[dict[str, str]] = []
        dpath = session_dir / "dialogue.jsonl"
        if dpath.is_file():
            for line in dpath.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                item = json.loads(line)
                if isinstance(item, dict):
                    dialogue.append(
                        {
                            "role": str(item.get("role", "")),
                            "content": str(item.get("content", "")),
                        }
                    )
        meta: dict[str, Any] = {}
        meta_path = session_dir / "meta.json"
        if meta_path.is_file():
            loaded_meta = load_json(meta_path)
            if isinstance(loaded_meta, dict):
                meta = loaded_meta
        return cls(
            root=session_dir,
            background=background,
            concerns=concerns,
            portrait=portrait,
            state=state,
            dialogue=dialogue,
            background_path=str(meta.get("background_path", "")),
            concerns_path=str(meta.get("concerns_path", "")),
            opening_path=str(meta.get("opening_path", "")),
            study_stem=str(meta.get("study_stem", "")),
            training_focus=str(meta.get("training_focus", "") or ""),
            ended=bool(state_file.get("是否结束", meta.get("ended", False))),
            end_reason=str(state_file.get("结束原因", "") or ""),
            last_action=str(state_file.get("动作", "") or ""),
            last_line=str(state_file.get("患者台词", "") or ""),
        )


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------
class PatientTurnAgent:
    def __init__(
        self,
        config: PatientTurnConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or PatientTurnConfig.from_env()
        self._client = client
        self._owns_client = client is None
        self._skill: str | None = None

    def _make_client(self, *, trust_env: bool) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.config.base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            timeout=self.config.timeout,
            trust_env=trust_env,
        )

    async def __aenter__(self) -> PatientTurnAgent:
        if self._client is None:
            self.config.require_api_key()
            self._client = self._make_client(trust_env=self.config.trust_env)
        self._skill = load_skill(self.config.skill_path)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError(
                "PatientTurnAgent 未初始化：请使用 `async with PatientTurnAgent(...)`"
            )
        return self._client

    async def _rebuild_client_without_proxy(self) -> None:
        if not self._owns_client:
            return
        old = self._client
        self._client = self._make_client(trust_env=False)
        self.config.trust_env = False
        if old is not None:
            await old.aclose()
        logger.warning("HTTP 代理失败，已改用直连（可用 --no-proxy）")

    @property
    def skill(self) -> str:
        if self._skill is None:
            self._skill = load_skill(self.config.skill_path)
        return self._skill

    async def _chat(self, messages: list[dict[str, str]]) -> tuple[str, dict, dict]:
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
            "stream": False,
        }

        async def _post() -> httpx.Response:
            return await self._ensure_client().post("/chat/completions", json=body)

        try:
            resp = await _post()
        except httpx.ConnectError:
            if not self.config.trust_env or not self._owns_client:
                raise
            await self._rebuild_client_without_proxy()
            resp = await _post()

        if resp.status_code >= 400:
            raise RuntimeError(
                f"方舟 Chat Completions 失败 HTTP {resp.status_code}: {resp.text[:800]}"
            )
        data = resp.json()
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"方舟响应格式异常: {data!r}") from exc
        usage = data.get("usage") or {}
        return text.strip(), data, usage if isinstance(usage, dict) else {}

    async def respond(
        self,
        *,
        background: dict[str, Any],
        concerns: list[Any],
        portrait: dict[str, Any],
        prev_state: dict[str, Any],
        dialogue: Sequence[dict[str, str]],
        crc_reply: str,
        patient_turn_count: int | None = None,
        training_focus: str = "",
    ) -> TurnResult:
        if not str(crc_reply).strip():
            raise ValueError("CRC 最新回答不能为空")

        # 已有患者发言数（含开局）；本轮将再产生一句患者台词
        if patient_turn_count is None:
            patient_turn_count = sum(
                1 for x in dialogue if str(x.get("role", "")).lower() == "patient"
            )
        # 本轮生成后的患者轮数
        next_count = patient_turn_count + 1
        force_end = next_count >= self.config.max_turns

        prev_patient_line = ""
        for item in reversed(list(dialogue)):
            if str(item.get("role", "")).lower() == "patient":
                prev_patient_line = str(item.get("content", "") or "").strip()
                break

        user_content = build_user_prompt(
            background=background,
            concerns=concerns,
            portrait=portrait,
            prev_state=prev_state,
            dialogue_text=format_dialogue(
                dialogue, tail=self.config.dialogue_tail
            ),
            crc_reply=crc_reply,
            patient_turn_count=patient_turn_count,
            max_turns=self.config.max_turns,
        )
        messages = [
            {
                "role": "system",
                "content": build_system_prompt(
                    self.skill,
                    max_turns=self.config.max_turns,
                    training_focus=training_focus,
                ),
            },
            {"role": "user", "content": user_content},
        ]
        text, raw, usage = await self._chat(messages)
        parsed = parse_turn_json(text)
        result = normalize_turn(
            parsed,
            locked_portrait=portrait,
            prev_state=prev_state,
            force_end=force_end,
            raw_text=text,
            raw=raw,
            usage=usage,
            crc_reply=crc_reply,
        )

        # 模型偶发原样复读上一句患者台词：强制重试一次
        if (
            prev_patient_line
            and _lines_too_similar(result.line, prev_patient_line)
            and not force_end
        ):
            logger.warning("患者台词与上一句过于相似，重试一次生成")
            retry_messages = [
                *messages,
                {
                    "role": "assistant",
                    "content": json.dumps(result.to_dict(), ensure_ascii=False),
                },
                {
                    "role": "user",
                    "content": (
                        "上一版「患者台词」几乎原样重复了上一句患者发言，不合格。"
                        f"上一句患者台词是：{prev_patient_line}\n"
                        f"CRC 本轮说了：{crc_reply.strip()}\n"
                        "请重新输出完整 JSON：台词必须是新的一句，"
                        "先点出/承接 CRC 刚说的内容，再追问、表态或换话题；"
                        "禁止复读上一句。"
                    ),
                },
            ]
            text2, raw2, usage2 = await self._chat(retry_messages)
            parsed2 = parse_turn_json(text2)
            result = normalize_turn(
                parsed2,
                locked_portrait=portrait,
                prev_state=prev_state,
                force_end=force_end,
                raw_text=text2,
                raw=raw2,
                usage=usage2,
                crc_reply=crc_reply,
            )

        return result

    async def apply_crc_reply(
        self,
        session: DialogueSession,
        crc_reply: str,
    ) -> TurnResult:
        """写入 CRC 回答 → 生成患者回合 → 校验 → 保存状态与对话。"""
        session.dialogue.append({"role": "crc", "content": crc_reply.strip()})
        forced_end = detect_forced_end(crc_reply)
        patient_turn_count = sum(
            1 for x in session.dialogue if x.get("role") == "patient"
        )
        if forced_end:
            line, reason = forced_end
            state = dict(session.state)
            state["当前情绪"] = "厌恶" if _CRC_ABUSE_RE.search(crc_reply) else "中性"
            state["参与态度"] = "终止沟通"
            result = normalize_turn(
                {
                    "患者画像": session.portrait,
                    "状态": state,
                    "动作": "结束",
                    "患者台词": line,
                    "是否结束": True,
                    "结束原因": reason,
                },
                locked_portrait=session.portrait,
                prev_state=session.state,
                crc_reply=crc_reply,
            )
        else:
            result = await self.respond(
                background=session.background,
                concerns=session.concerns,
                portrait=session.portrait,
                prev_state=session.state,
                dialogue=session.dialogue,
                crc_reply=crc_reply,
                patient_turn_count=patient_turn_count,
                training_focus=session.training_focus,
            )
        session.state = result.state
        session.portrait = result.data["患者画像"]
        session.dialogue.append({"role": "patient", "content": result.line})
        session.ended = result.ended
        session.end_reason = result.end_reason
        session.last_action = result.action
        session.last_line = result.line
        session.save()
        turn_idx = sum(1 for x in session.dialogue if x.get("role") == "patient")
        session.append_turn_snapshot(result.to_dict(), index=turn_idx)
        return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="入组前多轮患者回应")
    p.add_argument(
        "--study",
        default=_DEFAULT_STUDY,
        help=f"研究 stem（默认 {_DEFAULT_STUDY}）",
    )
    p.add_argument("--background", "-b", default=None)
    p.add_argument("--concerns", "-c", default=None)
    p.add_argument(
        "--opening",
        default=None,
        help="开局 JSON（含患者画像/状态/首句）；新会话时使用",
    )
    p.add_argument(
        "--session",
        "-s",
        default=None,
        help="会话目录；不填则在 dialogue_sessions 下新建",
    )
    p.add_argument(
        "--crc",
        default=None,
        help="单轮模式：直接给出 CRC 最新回答并生成患者下一句后退出",
    )
    p.add_argument(
        "--interactive",
        "-i",
        action="store_true",
        help="交互模式：展示患者台词后等待 CRC 输入，循环第二步",
    )
    p.add_argument(
        "--max-turns",
        type=int,
        default=None,
        help=f"患者发言轮数上限（默认 {DEFAULT_MAX_TURNS}，含开局首句）",
    )
    p.add_argument("--no-proxy", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _new_session_dir(base: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = base / f"session_{stamp}"
    path.mkdir(parents=True, exist_ok=False)
    return path


async def _amain(argv: Iterable[str] | None = None) -> int:
    _root = Path(__file__).resolve().parents[2]
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))

    from service.agent.study_paths import resolve_study

    parser = _build_arg_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    paths = resolve_study(args.study)
    bg_path = Path(args.background) if args.background else paths.background
    concerns_path = Path(args.concerns) if args.concerns else paths.concerns
    opening_path = Path(args.opening) if args.opening else paths.opening

    config = PatientTurnConfig.from_env(
        trust_env=False if args.no_proxy else None,
        max_turns=args.max_turns,
    )
    try:
        config.require_api_key()
    except ValueError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1

    for path, label in (
        (bg_path, "研究背景"),
        (concerns_path, "顾虑池"),
    ):
        if not path.is_file():
            print(f"[FAIL] {label}不存在: {path}", file=sys.stderr)
            return 1

    background = load_json(bg_path)
    concerns = load_json(concerns_path)
    if not isinstance(background, dict) or not isinstance(concerns, list):
        print("[FAIL] 研究背景须为对象，顾虑池须为数组", file=sys.stderr)
        return 1

    artifact_kwargs = {
        "background_path": str(bg_path.resolve()),
        "concerns_path": str(concerns_path.resolve()),
        "opening_path": str(opening_path.resolve()) if opening_path else "",
        "study_stem": paths.stem,
    }

    if args.session:
        session_dir = Path(args.session)
        if (session_dir / "state.json").is_file():
            session = DialogueSession.load(
                session_dir, background=background, concerns=concerns
            )
            # 若 meta 未钉路径，用本次 CLI 路径补全
            if not session.background_path:
                session.background_path = artifact_kwargs["background_path"]
            if not session.concerns_path:
                session.concerns_path = artifact_kwargs["concerns_path"]
            if not session.study_stem:
                session.study_stem = paths.stem
            if session.background_path and Path(session.background_path).resolve() != bg_path.resolve():
                print(
                    f"[WARN] 会话 meta 背景为 {session.background_path}，"
                    f"本次加载为 {bg_path}",
                    file=sys.stderr,
                )
        else:
            if not opening_path.is_file():
                print(f"[FAIL] 开局文件不存在: {opening_path}", file=sys.stderr)
                return 1
            session = DialogueSession.create_from_opening(
                session_dir=session_dir,
                background=background,
                concerns=concerns,
                opening=load_json(opening_path),
                **artifact_kwargs,
            )
    else:
        if not opening_path.is_file():
            print(f"[FAIL] 开局文件不存在: {opening_path}", file=sys.stderr)
            return 1
        session_dir = _new_session_dir(paths.sessions_dir)
        session = DialogueSession.create_from_opening(
            session_dir=session_dir,
            background=background,
            concerns=concerns,
            opening=load_json(opening_path),
            **artifact_kwargs,
        )

    print(f"[session] {session.root}", file=sys.stderr)
    if session.dialogue:
        last = session.dialogue[-1]
        if last.get("role") == "patient":
            print(f"【患者】{last.get('content', '')}")

    interactive = args.interactive or args.crc is None
    if args.crc is not None and not args.interactive:
        interactive = False

    async with PatientTurnAgent(config) as agent:
        if not interactive:
            crc_reply = args.crc or ""
            try:
                result = await agent.apply_crc_reply(session, crc_reply)
            except httpx.ConnectError as exc:
                print(f"[FAIL] 连接失败，可加 --no-proxy。详情: {exc}", file=sys.stderr)
                return 1
            except ValueError as exc:
                print(f"[FAIL] {exc}", file=sys.stderr)
                return 1
            print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
            print(f"\n【患者】{result.line}")
            if result.ended:
                print(
                    f"[ended] 动作={result.action} 原因={result.end_reason}",
                    file=sys.stderr,
                )
            return 0

        # 交互循环：等待 CRC → 患者回应 → 保存 → 再等待
        print(
            "进入交互：输入 CRC 回答后回车；空行跳过；输入 quit/exit 结束。\n"
            f"患者发言轮数上限={config.max_turns}（含开局）。",
            file=sys.stderr,
        )
        while True:
            try:
                crc_reply = input("\n【CRC】> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n[exit]", file=sys.stderr)
                break
            if not crc_reply:
                continue
            if crc_reply.lower() in {"quit", "exit", "q"}:
                break
            try:
                result = await agent.apply_crc_reply(session, crc_reply)
            except httpx.ConnectError as exc:
                print(f"[FAIL] 连接失败，可加 --no-proxy。详情: {exc}", file=sys.stderr)
                return 1
            except ValueError as exc:
                print(f"[FAIL] {exc}", file=sys.stderr)
                continue

            print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
            print(f"【患者】{result.line}")
            print(
                f"[saved] state → {session.state_path} | dialogue → {session.dialogue_path}",
                file=sys.stderr,
            )
            if result.ended:
                print(
                    f"[ended] 动作={result.action} 原因={result.end_reason}",
                    file=sys.stderr,
                )
                break
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()
