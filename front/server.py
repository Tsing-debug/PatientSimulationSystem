"""CRC 入组前对话 — 简易前端 API。

启动：
  python front/server.py
  浏览器打开 http://127.0.0.1:8790

语音：火山引擎 ASR + CRC PatientTurnAgent + 火山 TTS（不依赖 LiveKit）。
密钥在项目根目录 .env：VOLC_API_KEY、TEXT_GENERATION_API_KEY。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from fastapi import Depends, Header

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# 加载项目根 .env（VOLC_API_KEY / TEXT_GENERATION_API_KEY）
from config import setting as _cfg  # noqa: E402, F401

from service.accounts.skill import (  # noqa: E402
    load_study_catalog,
    recommend_study,
)
from service.accounts.store import (  # noqa: E402
    ROLES,
    AccountStore,
    store as account_store,
)
from service.agent.ark_recognize import (  # noqa: E402
    ASRConfig,
    recognize_bytes,
)
from service.agent.evaluation import (  # noqa: E402
    EvalConfig,
    EvaluationAgent,
)
from service.agent.opening_question import (  # noqa: E402
    OpeningConfig,
    OpeningQuestionAgent,
)
from service.agent.patient_turn import (  # noqa: E402
    DialogueSession,
    PatientTurnAgent,
    PatientTurnConfig,
    load_json,
    save_json,
)
from service.agent.personality import sample_persona  # noqa: E402
from service.agent.cde_extract import (  # noqa: E402
    CdeExtractAgent,
    extract_plain_text,
    review_from_cde,
)
from service.agent.study_paths import normalize_stem, resolve_study  # noqa: E402
from service.agent.tts_generate import (  # noqa: E402
    BidirectionalTTSAgent,
    TTSConfig,
)
from service.agent.tts_emotion import (  # noqa: E402
    DEFAULT_SPEAKER,
    emotion_from_session_state,
)

FRONT_DIR = Path(__file__).resolve().parent
SESSIONS_BASE = _ROOT / "service" / "acknowledge" / "dialogue_sessions"

ACK_DIR = _ROOT / "service" / "acknowledge"
STUDY_CATALOG_FILE = ACK_DIR / "study_catalog.json"
PATIENT_INITIALIZATIONS_FILE = (
    _ROOT / "service" / "accounts" / "patient_initializations.json"
)
_patient_initializations_lock = threading.RLock()
UPLOADS_BASE = ACK_DIR / "uploaded_trials"
DRAFTS_BASE = UPLOADS_BASE / "drafts"
UPLOAD_MAX_BYTES = 25 * 1024 * 1024
_DRAFT_TTL_SECONDS = 24 * 3600

app = FastAPI(title="CRC Dialogue Front")
logger = logging.getLogger("front.server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class StartSessionBody(BaseModel):
    study: str = Field(..., min_length=1)
    random_persona: bool = False
    # 可选：本轮训练重点（来自能力画像推荐），会注入患者扮演提示
    focus: str | None = None
    # 前端病例卡的首句；同一研究可挂多个患者，不能复用研究默认首句
    opening_line: str | None = Field(default=None, max_length=500)
    language: str = Field(default="zh", pattern="^(zh|en)$")


class ReplyBody(BaseModel):
    message: str = Field(..., min_length=1)


class TtsBody(BaseModel):
    text: str = Field(..., min_length=1)
    emotion: str | None = None
    emotion_scale: int | None = Field(default=None, ge=1, le=5)
    # If emotion omitted, resolve from this session's 状态.当前情绪
    session_id: str | None = None


def _list_ready_studies() -> list[dict[str, Any]]:
    opening_dir = _ROOT / "service" / "acknowledge" / "opening_state"
    if not opening_dir.is_dir():
        return []
    catalog_by_stem = {
        normalize_stem(str(item.get("stem", ""))): item
        for item in load_study_catalog()
        if isinstance(item, dict) and item.get("stem")
    }
    items: list[dict[str, Any]] = []

    def study_item(stem: str, ready: bool, opening_path: Path | None = None) -> dict[str, Any]:
        catalog = catalog_by_stem.get(normalize_stem(stem), {})
        opening: dict[str, Any] = {}
        if opening_path and opening_path.is_file():
            try:
                loaded = json.loads(opening_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    opening = loaded
            except (OSError, json.JSONDecodeError):
                logger.warning("Invalid opening-state JSON for study %s", stem)
        return {
            "stem": stem,
            "label": str(catalog.get("label") or stem),
            "description": str(catalog.get("description") or ""),
            "tags": catalog.get("tags") if isinstance(catalog.get("tags"), list) else [],
            "ready": ready,
            "patient_card_deleted": stem in _load_patient_initializations().get("deleted_stems", []),
            "opening": opening,
        }

    for p in sorted(opening_dir.glob("*.opening.json")):
        stem = p.name[: -len(".opening.json")]
        paths = resolve_study(stem)
        ready = (
            paths.background.is_file()
            and paths.concerns.is_file()
            and (p.is_file() or (paths.background.is_file() and paths.concerns.is_file()))
        )
        items.append(study_item(stem, ready, p))
    for stem in {
        p.name[: -len(".background.json")]
        for p in (_ROOT / "service" / "acknowledge" / "relative_experiment").glob(
            "*.background.json"
        )
    }:
        if any(x["stem"] == stem for x in items):
            continue
        paths = resolve_study(stem)
        if paths.background.is_file() and paths.concerns.is_file():
            items.append(study_item(stem, True, paths.opening))
    items.sort(key=lambda x: x["stem"])
    return items


def _new_session_dir() -> Path:
    SESSIONS_BASE.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = SESSIONS_BASE / f"session_{stamp}"
    path.mkdir(parents=True, exist_ok=False)
    return path


def _persona_summary(persona: dict[str, Any] | None) -> str:
    if not persona:
        return ""
    from service.agent.personality import Persona

    try:
        constraints = persona.get("life_constraints") or ()
        if isinstance(constraints, list):
            constraints = tuple(constraints)
        return Persona(
            age_band=str(persona.get("age_band", "mid")),
            education=str(persona.get("education", "mid")),
            trial_experience=str(persona.get("trial_experience", "naive")),
            emotion_base=str(persona.get("emotion_base", "hesitant")),
            decision_role=str(persona.get("decision_role", "self")),
            companion=str(persona.get("companion", "alone")),
            life_constraints=tuple(constraints),
            pressure=str(persona.get("pressure", "mid")),
            seed=persona.get("seed") if isinstance(persona.get("seed"), int) else None,
        ).render()
    except Exception:  # noqa: BLE001
        return json.dumps(persona, ensure_ascii=False)


def _session_payload(
    session: DialogueSession,
    detail: dict[str, Any] | None = None,
    *,
    evaluation: dict[str, Any] | None = None,
    persona: dict[str, Any] | None = None,
    persona_text: str | None = None,
) -> dict[str, Any]:
    patient_line = ""
    if session.dialogue:
        last = session.dialogue[-1]
        if last.get("role") == "patient":
            patient_line = str(last.get("content", "") or "")
    if not patient_line:
        patient_line = session.last_line

    if detail is None:
        detail = {
            "患者画像": session.portrait,
            "状态": session.state,
            "患者台词": patient_line,
            "是否结束": session.ended,
        }
        if session.last_action:
            detail["动作"] = session.last_action
        if session.end_reason:
            detail["结束原因"] = session.end_reason

    if persona is None or persona_text is None:
        loaded_persona, loaded_text = _load_persona_bundle(session)
        if persona is None:
            persona = loaded_persona
        if persona_text is None:
            persona_text = loaded_text

    eval_path = session.root / "evaluation.json"
    if evaluation is None and eval_path.is_file():
        try:
            evaluation = load_json(eval_path)
        except Exception:  # noqa: BLE001
            evaluation = None

    emo, emo_scale = emotion_from_session_state(
        session.state,
        session.portrait,
        speaker=DEFAULT_SPEAKER,
        line=patient_line,
    )
    return {
        "session_id": session.root.name,
        "study": session.study_stem,
        "patient_line": patient_line,
        "ended": session.ended,
        "end_reason": session.end_reason,
        "action": session.last_action,
        "detail": detail,
        "persona": persona,
        "persona_text": persona_text,
        "evaluation": evaluation,
        "tts_emotion": emo,
        "tts_emotion_scale": emo_scale,
        "messages": [
            {"role": m["role"], "content": m["content"]} for m in session.dialogue
        ],
    }


def _load_session(session_id: str) -> DialogueSession:
    session_dir = SESSIONS_BASE / session_id
    if not session_dir.is_dir() or not (session_dir / "state.json").is_file():
        raise HTTPException(status_code=404, detail=f"会话不存在: {session_id}")

    meta_path = session_dir / "meta.json"
    meta = load_json(meta_path) if meta_path.is_file() else {}
    stem = str(meta.get("study_stem") or "")
    if not stem:
        raise HTTPException(status_code=400, detail="会话缺少 study_stem")

    paths = resolve_study(stem)
    bg_path = Path(meta["background_path"]) if meta.get("background_path") else paths.background
    concerns_path = (
        Path(meta["concerns_path"]) if meta.get("concerns_path") else paths.concerns
    )
    if not bg_path.is_file() or not concerns_path.is_file():
        raise HTTPException(status_code=400, detail="会话关联的背景/顾虑池文件缺失")

    background = load_json(bg_path)
    concerns = load_json(concerns_path)
    if not isinstance(background, dict) or not isinstance(concerns, list):
        raise HTTPException(status_code=400, detail="背景或顾虑池格式无效")

    return DialogueSession.load(session_dir, background=background, concerns=concerns)


def _attach_persona_meta(
    session: DialogueSession,
    *,
    persona: dict[str, Any] | None,
    persona_text: str,
    random_persona: bool,
) -> None:
    payload = {
        "random_persona": random_persona,
        "persona": persona,
        "persona_text": persona_text,
    }
    save_json(session.root / "persona.json", payload)


def _load_persona_bundle(session: DialogueSession) -> tuple[dict[str, Any] | None, str]:
    path = session.root / "persona.json"
    if not path.is_file():
        meta_path = session.root / "meta.json"
        meta = load_json(meta_path) if meta_path.is_file() else {}
        if isinstance(meta, dict):
            persona = meta.get("persona") if isinstance(meta.get("persona"), dict) else None
            text = str(meta.get("persona_text") or "") or _persona_summary(persona)
            return persona, text
        return None, ""
    data = load_json(path)
    if not isinstance(data, dict):
        return None, ""
    persona = data.get("persona") if isinstance(data.get("persona"), dict) else None
    text = str(data.get("persona_text") or "") or _persona_summary(persona)
    return persona, text


async def _run_evaluation(session: DialogueSession) -> dict[str, Any]:
    config = EvalConfig.from_env(trust_env=False)
    config.require_api_key()
    async with EvaluationAgent(config) as agent:
        report = await agent.evaluate(
            session.dialogue,
            scenario=f"临床试验入组前知情沟通 · {session.study_stem}",
        )
    payload = report.to_dict()
    save_json(session.root / "evaluation.json", payload)
    return payload


def _guess_upload_format(filename: str | None, content_type: str | None) -> str:
    name = (filename or "").lower()
    ctype = (content_type or "").lower()
    for ext in ("wav", "mp3", "ogg", "pcm", "webm"):
        if name.endswith(f".{ext}") or ext in ctype:
            if ext == "webm":
                return "ogg"
            return ext
    return "wav"


def _resolve_tts_emotion(
    *,
    emotion: str | None = None,
    emotion_scale: int | None = None,
    session_id: str | None = None,
    session: DialogueSession | None = None,
    speaker: str | None = None,
) -> tuple[str, int]:
    """Prefer explicit emotion; else map from session 当前情绪。Always clamp to speaker enum."""
    from service.agent.tts_emotion import (
        DEFAULT_EMOTION_SCALE,
        DEFAULT_SPEAKER,
        clamp_emotion,
        emotion_from_session_state,
    )

    sp = speaker or DEFAULT_SPEAKER
    if emotion:
        emo = clamp_emotion(emotion, speaker=sp)
        scale = emotion_scale if emotion_scale is not None else DEFAULT_EMOTION_SCALE
        return emo, max(1, min(5, int(scale)))
    sess = session
    if sess is None and session_id:
        try:
            sess = _load_session(session_id)
        except Exception:  # noqa: BLE001
            sess = None
    if sess is not None:
        emo, scale = emotion_from_session_state(
            sess.state,
            sess.portrait,
            speaker=sp,
            line=sess.last_line,
        )
        if emotion_scale is not None:
            scale = emotion_scale
        return emo, max(1, min(5, int(scale)))
    return clamp_emotion(None, speaker=sp), DEFAULT_EMOTION_SCALE


async def _synthesize_mp3(
    text: str,
    *,
    emotion: str | None = None,
    emotion_scale: int | None = None,
    session_id: str | None = None,
    session: DialogueSession | None = None,
) -> bytes:
    text = text.strip()
    if not text:
        raise ValueError("TTS 文本为空")
    cfg = TTSConfig.from_env()
    emo, scale = _resolve_tts_emotion(
        emotion=emotion,
        emotion_scale=emotion_scale,
        session_id=session_id,
        session=session,
        speaker=cfg.speaker,
    )
    cfg.emotion = emo
    cfg.emotion_scale = scale
    if not (cfg.api_key or (cfg.app_id and cfg.access_key)):
        raise ValueError("缺少 VOLC_API_KEY（项目根目录 .env）")
    async with BidirectionalTTSAgent(cfg) as agent:
        return await agent.synthesize_to_bytes(text)


@app.get("/api/studies")
def list_studies() -> dict[str, Any]:
    return {"studies": _list_ready_studies()}


@app.post("/api/persona/sample")
def sample_persona_api() -> dict[str, Any]:
    persona = sample_persona()
    return {
        "persona": persona.to_dict(),
        "persona_text": persona.render(),
    }


@app.post("/api/sessions")
async def start_session(body: StartSessionBody) -> dict[str, Any]:
    paths = resolve_study(body.study.strip())
    if not paths.background.is_file() or not paths.concerns.is_file():
        raise HTTPException(
            status_code=400,
            detail=f"研究「{paths.stem}」缺少研究背景或顾虑池",
        )

    background = load_json(paths.background)
    concerns = load_json(paths.concerns)
    if not isinstance(background, dict) or not isinstance(concerns, list):
        raise HTTPException(status_code=400, detail="背景须为对象，顾虑池须为数组")

    persona: dict[str, Any] | None = None
    persona_text = ""
    opening_path_str = ""

    if body.random_persona:
        ocfg = OpeningConfig.from_env(trust_env=False)
        try:
            ocfg.require_api_key()
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        try:
            async with OpeningQuestionAgent(ocfg) as agent:
                result = await agent.generate(
                    background=background,
                    concerns=concerns,
                )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"随机人设开局失败: {exc}") from exc
        opening = result.to_dict()
        persona = result.persona if isinstance(result.persona, dict) else None
        persona_text = _persona_summary(persona)
        opening_path_str = "(generated)"
    else:
        if not paths.opening.is_file():
            raise HTTPException(
                status_code=400,
                detail=f"研究「{paths.stem}」缺少开局文件；请改用「随机人设开局」",
            )
        opening = load_json(paths.opening)
        if not isinstance(opening, dict):
            raise HTTPException(status_code=400, detail="开局文件须为对象")
        opening_path_str = str(paths.opening.resolve())
        portrait = opening.get("患者画像")
        if isinstance(portrait, dict):
            persona_text = (
                f"固定开局画像：{portrait.get('年龄', '?')}岁 / "
                f"{portrait.get('学历', '')} / {portrait.get('交流特点', '')} / "
                f"{portrait.get('试验经历', '')}"
                )

    if body.opening_line and body.opening_line.strip():
        opening["患者台词"] = body.opening_line.strip()

    language_instruction = (
        "The patient must speak natural conversational English only for the entire session."
        if body.language == "en"
        else "患者在整个会话中只使用自然口语中文。"
    )
    training_focus = "\n".join(
        part for part in ((body.focus or "").strip(), language_instruction) if part
    )

    session_dir = _new_session_dir()
    session = DialogueSession.create_from_opening(
        session_dir=session_dir,
        background=background,
        concerns=concerns,
        opening=opening,
        background_path=str(paths.background.resolve()),
        concerns_path=str(paths.concerns.resolve()),
        opening_path=opening_path_str,
        study_stem=paths.stem,
        training_focus=training_focus,
    )
    _attach_persona_meta(
        session,
        persona=persona,
        persona_text=persona_text,
        random_persona=body.random_persona,
    )
    return _session_payload(
        session,
        persona=persona,
        persona_text=persona_text,
    )


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    return _session_payload(_load_session(session_id))


@app.post("/api/sessions/{session_id}/reply")
async def reply(session_id: str, body: ReplyBody) -> dict[str, Any]:
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="CRC 回答不能为空")

    session = _load_session(session_id)
    if session.ended:
        raise HTTPException(status_code=400, detail="会话已结束")

    config = PatientTurnConfig.from_env(trust_env=False)
    try:
        config.require_api_key()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        async with PatientTurnAgent(config) as agent:
            result = await agent.apply_crc_reply(session, message)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    evaluation: dict[str, Any] | None = None
    if result.ended:
        try:
            evaluation = await _run_evaluation(session)
        except Exception as exc:  # noqa: BLE001
            evaluation = {
                "error": str(exc),
                "summary": "自动评分失败，可稍后重试",
                "overall_score": None,
                "passed": False,
                "dimensions": [],
            }

    return _session_payload(
        session,
        detail=result.to_dict(),
        evaluation=evaluation,
    )


@app.post("/api/sessions/{session_id}/evaluate")
async def evaluate_session(session_id: str) -> dict[str, Any]:
    session = _load_session(session_id)
    if not session.dialogue:
        raise HTTPException(status_code=400, detail="对话为空，无法评分")
    try:
        evaluation = await _run_evaluation(session)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return _session_payload(session, evaluation=evaluation)


@app.post("/api/tts")
async def tts(body: TtsBody) -> dict[str, Any]:
    """火山 TTS：文本 → base64 mp3（用于朗读患者台词）。"""
    try:
        audio = await _synthesize_mp3(
            body.text,
            emotion=body.emotion,
            emotion_scale=body.emotion_scale,
            session_id=body.session_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"TTS 失败: {exc}") from exc
    cfg = TTSConfig.from_env()
    emo, scale = _resolve_tts_emotion(
        emotion=body.emotion,
        emotion_scale=body.emotion_scale,
        session_id=body.session_id,
        speaker=cfg.speaker,
    )
    return {
        "format": "mp3",
        "audio_base64": base64.b64encode(audio).decode("ascii"),
        "tts_emotion": emo,
        "tts_emotion_scale": scale,
    }


@app.post("/api/tts/raw")
async def tts_raw(body: TtsBody) -> Response:
    try:
        audio = await _synthesize_mp3(
            body.text,
            emotion=body.emotion,
            emotion_scale=body.emotion_scale,
            session_id=body.session_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"TTS 失败: {exc}") from exc
    return Response(content=audio, media_type="audio/mpeg")


@app.post("/api/stt")
async def speech_to_text(
    audio: UploadFile = File(...),
) -> dict[str, Any]:
    """只做语音识别，返回文本，不触发患者回复。

    供问诊界面右下角对话面板的麦克风按钮使用：医生说完一段后文字
    先进输入框可编辑，由医生确认后再发送 —— 与 voice/turn（识别即
    发送）分开。
    """
    raw = await audio.read()
    if not raw or len(raw) < 256:
        raise HTTPException(status_code=400, detail="音频太短或为空")

    fmt = _guess_upload_format(audio.filename, audio.content_type)
    asr_cfg = ASRConfig.from_env(audio_format=fmt)
    try:
        asr = await recognize_bytes(raw, config=asr_cfg)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ASR 失败: {exc}") from exc

    text = (asr.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="未识别到有效语音，请再说一遍")
    return {"text": text}


@app.post("/api/sessions/{session_id}/voice/turn")
async def voice_turn(
    session_id: str,
    audio: UploadFile = File(...),
) -> dict[str, Any]:
    """按住说话一轮：火山 ASR → PatientTurnAgent → 火山 TTS。"""
    session = _load_session(session_id)
    if session.ended:
        raise HTTPException(status_code=400, detail="会话已结束")

    raw = await audio.read()
    if not raw or len(raw) < 256:
        raise HTTPException(status_code=400, detail="音频太短或为空")

    fmt = _guess_upload_format(audio.filename, audio.content_type)
    asr_cfg = ASRConfig.from_env(audio_format=fmt)
    try:
        asr = await recognize_bytes(raw, config=asr_cfg)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ASR 失败: {exc}") from exc

    crc_text = (asr.text or "").strip()
    if not crc_text:
        raise HTTPException(status_code=400, detail="未识别到有效语音，请再说一遍")

    pcfg = PatientTurnConfig.from_env(trust_env=False)
    try:
        pcfg.require_api_key()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        async with PatientTurnAgent(pcfg) as agent:
            result = await agent.apply_crc_reply(session, crc_text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    patient_line = result.line or session.last_line
    audio_b64 = ""
    tts_error = ""
    try:
        mp3 = await _synthesize_mp3(patient_line, session=session)
        audio_b64 = base64.b64encode(mp3).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        tts_error = str(exc)

    evaluation: dict[str, Any] | None = None
    if result.ended:
        try:
            evaluation = await _run_evaluation(session)
        except Exception as exc:  # noqa: BLE001
            evaluation = {
                "error": str(exc),
                "summary": "自动评分失败，可稍后重试",
                "overall_score": None,
                "passed": False,
                "dimensions": [],
            }

    payload = _session_payload(
        session,
        detail=result.to_dict(),
        evaluation=evaluation,
    )
    payload["crc_text"] = crc_text
    payload["audio_format"] = "mp3"
    payload["audio_base64"] = audio_b64
    if tts_error:
        payload["tts_error"] = tts_error
    return payload


# ---------------------------------------------------------------------------
# 账号 / 角色 / 训练记录 / 管理员 API
# ---------------------------------------------------------------------------

class RegisterBody(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)
    display_name: str | None = None


class LoginBody(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class TrainingRecordBody(BaseModel):
    study: str = Field(..., min_length=1)
    session_id: str = ""
    overall_score: float | None = None
    passed: bool = False
    summary: str = ""
    dimensions: list[dict[str, Any]] = Field(default_factory=list)
    strengths: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    training_focus: str = ""


class RolePatchBody(BaseModel):
    role: str | None = None
    disabled: bool | None = None


class PatientInitializationBody(BaseModel):
    trials: list[str] = Field(..., min_length=1)
    language: str = Field(default="zh", pattern="^(zh|en)$")


class PersonalPatientRegenerationBody(BaseModel):
    stems: list[str] = Field(..., min_length=1)


def _bearer_token(authorization: str | None = Header(default=None)) -> str:
    if not authorization:
        return ""
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return ""


def _current_user(
    token: str = Depends(_bearer_token),
) -> dict[str, Any]:
    user = account_store.user_by_token(token) if token else None
    if not user:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return user


def _require_role(user: dict[str, Any], *roles: str) -> None:
    if user.get("role") not in roles:
        raise HTTPException(status_code=403, detail="无权访问该功能")


@app.post("/api/auth/register")
def register(body: RegisterBody) -> dict[str, Any]:
    """注册新用户（默认角色：学生）。"""
    try:
        user = account_store.register(
            body.username,
            body.password,
            body.display_name or "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = account_store.create_token(user["username"])
    return {"token": token, "user": user}


@app.post("/api/auth/login")
def login(body: LoginBody) -> dict[str, Any]:
    user = account_store.authenticate(body.username, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = account_store.create_token(user["username"])
    return {"token": token, "user": user}


@app.post("/api/auth/logout")
def logout(token: str = Depends(_bearer_token)) -> dict[str, Any]:
    account_store.revoke_token(token)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: dict[str, Any] = Depends(_current_user)) -> dict[str, Any]:
    return {"user": user}


@app.post("/api/training/records")
def add_training_record(
    body: TrainingRecordBody,
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """会话结束后上报一条训练记录（含评估结果），用于能力画像。"""
    rec = account_store.add_training_record(
        {
            "username": user["username"],
            "display_name": user.get("display_name", ""),
            "study": body.study,
            "session_id": body.session_id,
            "overall_score": body.overall_score,
            "passed": body.passed,
            "summary": body.summary,
            "dimensions": body.dimensions,
            "strengths": body.strengths,
            "improvements": body.improvements,
            "training_focus": body.training_focus,
        }
    )
    return {"record": rec, "profile": recommend_study(account_store.records_for(user["username"]))}


@app.get("/api/training/records")
def my_training_records(
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    records = account_store.records_for(user["username"])
    return {"records": list(reversed(records))}


@app.get("/api/training/profile")
def training_profile(
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """能力画像 + 下一轮推荐。"""
    records = account_store.records_for(user["username"])
    return recommend_study(records, catalog=load_study_catalog())


def _load_patient_initializations() -> dict[str, Any]:
    if not PATIENT_INITIALIZATIONS_FILE.is_file():
        return {"versions": {}, "languages": {}, "active_stems": [], "deleted_stems": [], "user_initializations": {}, "updated_at": ""}
    try:
        data = json.loads(PATIENT_INITIALIZATIONS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"versions": {}, "languages": {}, "active_stems": [], "deleted_stems": [], "user_initializations": {}, "updated_at": ""}
    versions = data.get("versions") if isinstance(data, dict) else None
    languages = data.get("languages") if isinstance(data, dict) else None
    return {
        "versions": versions if isinstance(versions, dict) else {},
        "languages": languages if isinstance(languages, dict) else {},
        "active_stems": data.get("active_stems", []) if isinstance(data, dict) else [],
        "deleted_stems": data.get("deleted_stems", []) if isinstance(data, dict) else [],
        "user_initializations": data.get("user_initializations", {}) if isinstance(data, dict) else {},
        "updated_at": str(data.get("updated_at", "")) if isinstance(data, dict) else "",
    }


@app.get("/api/patient-initializations")
def patient_initializations(
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """Return the global per-trial reset versions visible to student clients."""
    return _load_patient_initializations()


@app.get("/api/patient-catalog")
def patient_catalog(user: dict[str, Any] = Depends(_current_user)) -> dict[str, Any]:
    """One shared snapshot for students, staff and administrators."""
    with _patient_initializations_lock:
        state = _load_patient_initializations()
        personal = state.get("user_initializations", {}).get(user["username"], {})
        studies = _list_ready_studies()
        for study in studies:
            override = personal.get(study["stem"], {}) if isinstance(personal, dict) else {}
            study["personal_seed"] = override.get("seed") if isinstance(override, dict) else None
        return {**state, "studies": studies}


@app.post("/api/patient-catalog/regenerate")
def regenerate_personal_patients(
    body: PersonalPatientRegenerationBody,
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """Regenerate only the current user's initialized patient cards."""
    stems = list(dict.fromkeys(stem.strip() for stem in body.stems if stem.strip()))
    with _patient_initializations_lock:
        state = _load_patient_initializations()
        active = set(state.get("active_stems", [])) - set(state.get("deleted_stems", []))
        invalid = [stem for stem in stems if stem not in active]
        if invalid:
            raise HTTPException(status_code=400, detail=f"患者未初始化或已删除：{', '.join(invalid)}")
        all_users = dict(state.get("user_initializations", {}))
        mine = dict(all_users.get(user["username"], {}))
        catalog = {str(item.get("stem")): item for item in load_study_catalog()}
        versions = state.get("versions", {})
        for stem in stems:
            label = str(catalog.get(stem, {}).get("label") or stem)
            mine[stem] = {
                "seed": secrets.randbits(31),
                "base_version": int(versions.get(label, 0)),
                "updated_at": datetime.now().isoformat(timespec="seconds"),
            }
        all_users[user["username"]] = mine
        state["user_initializations"] = all_users
        _json_atomic_write(PATIENT_INITIALIZATIONS_FILE, state)
    return {"ok": True, "updated_stems": stems}


@app.delete("/api/admin/patient-cards/{stem}")
def delete_patient_card(stem: str, user: dict[str, Any] = Depends(_current_user)) -> dict[str, Any]:
    _require_role(user, "admin")
    if not any(item.get("stem") == stem for item in load_study_catalog()):
        raise HTTPException(status_code=404, detail="试验不存在")
    with _patient_initializations_lock:
        state = _load_patient_initializations()
        state["deleted_stems"] = sorted(set(state.get("deleted_stems", [])) | {stem})
        state["active_stems"] = [x for x in state.get("active_stems", []) if x != stem]
        _json_atomic_write(PATIENT_INITIALIZATIONS_FILE, state)
    return {"ok": True}


@app.get("/api/admin/users")
def admin_list_users(user: dict[str, Any] = Depends(_current_user)) -> dict[str, Any]:
    _require_role(user, "admin")
    return {"users": account_store.list_users()}


@app.patch("/api/admin/users/{username}")
def admin_update_user(
    username: str,
    body: RolePatchBody,
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    _require_role(user, "admin")
    try:
        if body.role is not None:
            updated = account_store.set_user_role(username, body.role)
        if body.disabled is not None:
            updated = account_store.set_user_disabled(username, body.disabled)
        if body.role is None and body.disabled is None:
            updated = account_store.get_user(username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail=f"用户不存在: {username}")
    return {"user": updated}


@app.delete("/api/admin/users/{username}")
def admin_delete_user(
    username: str,
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    _require_role(user, "admin")
    try:
        account_store.delete_user(username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/api/admin/stats")
def admin_stats(user: dict[str, Any] = Depends(_current_user)) -> dict[str, Any]:
    # 工作人员可查看整体训练统计（只读），用户管理仅限管理员
    _require_role(user, "admin", "staff")
    return account_store.stats()


@app.get("/api/admin/records")
def admin_records(
    user: dict[str, Any] = Depends(_current_user),
    limit: int = 200,
) -> dict[str, Any]:
    _require_role(user, "admin", "staff")
    return {"records": account_store.all_records(limit=limit)}


@app.get("/api/admin/studies")
def admin_studies(user: dict[str, Any] = Depends(_current_user)) -> dict[str, Any]:
    _require_role(user, "admin")
    return {"catalog": load_study_catalog(), "roles": list(ROLES)}


@app.post("/api/admin/patient-initializations")
async def admin_initialize_patients(
    body: PatientInitializationBody,
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """Increment selected trial versions so every student refreshes those patients."""
    _require_role(user, "admin")
    trials = list(dict.fromkeys(x.strip() for x in body.trials if x.strip()))
    if not trials:
        raise HTTPException(status_code=400, detail="至少选择一个试验项目")
    catalog = load_study_catalog()
    selected = []
    for trial in trials:
        item = next((x for x in catalog if trial in (x.get("label"), x.get("stem"))), None)
        if item is None:
            raise HTTPException(status_code=400, detail=f"试验不存在：{trial}")
        selected.append(item)
    for item in selected:
        try:
            await _ensure_study_assets(item["stem"])
        except Exception as exc:
            logger.exception("Patient initialization failed: %s", item["stem"])
            raise HTTPException(status_code=503, detail=f"「{item.get('label', item['stem'])}」训练资料生成失败，尚未初始化。模型服务可能繁忙，请稍后再次点击初始化。") from exc
    with _patient_initializations_lock:
        state = _load_patient_initializations()
        versions = dict(state["versions"])
        languages = dict(state["languages"])
        for trial in trials:
            versions[trial] = int(versions.get(trial, 0)) + 1
            languages[trial] = body.language
        updated = {
            "versions": versions,
            "languages": languages,
            "active_stems": sorted(set(state.get("active_stems", [])) | {item["stem"] for item in selected}),
            "deleted_stems": sorted(set(state.get("deleted_stems", [])) - {item["stem"] for item in selected}),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "updated_trials": trials,
        }
        # An administrator's global initialization has higher precedence: all
        # personal variants for these studies are cleared for every account.
        selected_stems = {item["stem"] for item in selected}
        updated["user_initializations"] = {
            username: {
                stem: value for stem, value in overrides.items()
                if stem not in selected_stems
            }
            for username, overrides in state.get("user_initializations", {}).items()
            if isinstance(overrides, dict)
        }
        _json_atomic_write(PATIENT_INITIALIZATIONS_FILE, updated)
    return updated


def _json_atomic_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _purge_stale_drafts() -> None:
    if not DRAFTS_BASE.is_dir():
        return
    now = time.time()
    for draft_dir in DRAFTS_BASE.iterdir():
        try:
            if now - draft_dir.stat().st_mtime > _DRAFT_TTL_SECONDS:
                shutil.rmtree(draft_dir, ignore_errors=True)
        except OSError:
            continue


@app.post("/api/admin/studies/import")
async def admin_import_study(
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """管理员上传 CDE 临床试验资料（doc / docx / pdf / html / md / txt / json），
    抽取或校验成结构化登记草稿，用于新增一种疾病类型的训练病例。

    流程：文件落草稿目录（draft_id）→ 结构化 JSON 直接校验；
    其余格式先转纯文本，再调用方舟 LLM 抽取成 CDE 登记结构。
    """
    _require_role(user, "admin")
    _purge_stale_drafts()
    if not file.filename:
        raise HTTPException(status_code=400, detail="缺少文件名")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(raw) > UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"文件过大（上限 {UPLOAD_MAX_BYTES // (1024 * 1024)}MB）",
        )

    suffix = Path(file.filename).suffix.lower()
    method = "json" if suffix in {".json"} else "llm"
    try:
        if suffix in {".json"}:
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HTTPException(status_code=400, detail=f"JSON 解析失败：{exc}") from exc
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=400, detail="JSON 根节点必须是对象（CDE 登记结构）")
            review = review_from_cde(parsed)
        else:
            text = extract_plain_text(raw, file.filename)
            async with CdeExtractAgent() as agent:
                result = await agent.extract(text)
            review = review_from_cde(result["cde"], result.get("suggest"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    draft_id = uuid.uuid4().hex
    draft_dir = DRAFTS_BASE / draft_id
    draft_dir.mkdir(parents=True, exist_ok=True)
    try:
        (draft_dir / f"source{suffix}").write_bytes(raw)
        _json_atomic_write(draft_dir / "review.json", review)
    except OSError as exc:
        shutil.rmtree(draft_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"草稿保存失败：{exc}") from exc

    return {
        "ok": True,
        "draft_id": draft_id,
        "method": method,
        "filename": file.filename,
        **review,
    }


class StudyRegisterBody(BaseModel):
    draft_id: str = ""
    stem: str = Field(..., min_length=1)
    label: str = ""
    description: str = ""
    difficulty: int = 1
    focus_dimensions: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    cde: dict[str, Any] = Field(default_factory=dict)
    generate_assets: bool = True


def _existing_stems() -> set[str]:
    """已占用的病例键名：各产物目录中的文件名 + 目录登记。"""
    existing: set[str] = set()
    for sub in ("relative_experiment", "opening_state", "questions_pool"):
        root = ACK_DIR / sub
        if not root.is_dir():
            continue
        for p in root.glob("*.json"):
            existing.add(normalize_stem(p.name))
    for item in load_study_catalog():
        if isinstance(item, dict) and item.get("stem"):
            existing.add(normalize_stem(str(item["stem"])))
    existing.discard("")
    return existing


_asset_locks: dict[str, asyncio.Lock] = {}


async def _ensure_study_assets(stem: str) -> None:
    from service.agent.run_pipeline import _amain as pipeline_main

    async with _asset_locks.setdefault(stem, asyncio.Lock()):
        paths = resolve_study(stem)
        for stage, path in (("background", paths.background), ("concerns", paths.concerns), ("opening", paths.opening)):
            if path.is_file():
                continue
            for attempt in range(3):
                try:
                    code = await pipeline_main(["--study", stem, "--stages", stage])
                    if code != 0 or not path.is_file():
                        raise RuntimeError(f"Stage {stage} failed with exit {code}")
                    break
                except Exception as exc:
                    if attempt == 2 or not any(marker in str(exc) for marker in ("429", "503", "ServerOverloaded")):
                        raise
                    await asyncio.sleep(2 ** (attempt + 1))


async def _generate_study_assets(stem: str) -> None:
    """后台生成训练资产（背景 / 顾虑池 / 开场状态），失败仅记录日志，不影响登记。"""
    from service.agent.run_pipeline import _amain as pipeline_main

    try:
        await _ensure_study_assets(stem)
        logger.info("[admin/studies] assets generated stem=%s", stem)
    except Exception:  # noqa: BLE001
        logger.exception("[admin/studies] assets generation failed stem=%s", stem)


@app.post("/api/admin/studies")
async def admin_register_study(
    body: StudyRegisterBody,
    user: dict[str, Any] = Depends(_current_user),
) -> dict[str, Any]:
    """确认登记：审阅后的草稿落盘为新的疾病类型病例（CDE JSON + 目录登记 + 源文件归档）。"""
    _require_role(user, "admin")
    stem = normalize_stem(body.stem)
    if not stem:
        raise HTTPException(status_code=400, detail="缺少病例键名 stem")
    if any(ch in stem for ch in ('/', "\\", ":", "*", "?", '"', "<", ">", "|")):
        raise HTTPException(status_code=400, detail="stem 含非法字符")

    existing = _existing_stems()
    if stem in existing:
        raise HTTPException(status_code=409, detail=f"「{stem}」已存在病例目录中，请更换键名")

    cde = body.cde if isinstance(body.cde, dict) else {}
    entry: dict[str, Any] = {
        "stem": stem,
        "label": (body.label or body.cde.get("title_and_background", {}).get("indication") or stem).strip(),
        "description": body.description.strip(),
        "difficulty": body.difficulty if isinstance(body.difficulty, int) else 1,
        "focus_dimensions": [str(x) for x in body.focus_dimensions][:6],
        "tags": [str(x) for x in body.tags][:6],
    }

    cde_file = ACK_DIR / "relative_experiment" / f"{stem}.json"
    try:
        _json_atomic_write(cde_file, cde)

        catalog_doc: dict[str, Any] = {"version": 1, "studies": load_study_catalog()}
        if not any(s.get("stem") == stem for s in catalog_doc["studies"] if isinstance(s, dict)):
            catalog_doc["studies"].append(entry)
        _json_atomic_write(STUDY_CATALOG_FILE, catalog_doc)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"登记写入失败：{exc}") from exc

    # 归档上传的原始资料（若有草稿）
    if body.draft_id:
        draft_dir = DRAFTS_BASE / body.draft_id
        if draft_dir.is_dir():
            try:
                sources = [p for p in draft_dir.iterdir() if p.is_file() and p.name.startswith("source.")]
                if sources:
                    target_dir = UPLOADS_BASE / stem
                    target_dir.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(sources[0]), str(target_dir / sources[0].name))
                shutil.rmtree(draft_dir, ignore_errors=True)
            except OSError as exc:
                logger.warning("[admin/studies] archive draft failed stem=%s: %s", stem, exc)

    if body.generate_assets:
        asyncio.create_task(_generate_study_assets(stem))

    return {
        "ok": True,
        "study": entry,
        "generating": bool(body.generate_assets),
        "hint": "训练资产（背景/顾虑池/开场）正在后台生成，约 1~2 分钟，可稍后刷新查看。"
        if body.generate_assets
        else "",
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONT_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONT_DIR), name="static")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8790, reload=False)


if __name__ == "__main__":
    main()
