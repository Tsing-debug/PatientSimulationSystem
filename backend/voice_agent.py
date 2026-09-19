"""Grand Rounds — LiveKit voice agent (Patient persona, real-time).

Runs as a separate process from the FastAPI server. Joins every LiveKit
room created by the frontend and roleplays the patient over WebRTC:

    Browser mic → Deepgram Nova-3 STT → Claude Haiku 4.5 → Cartesia Sonic-2 TTS → Browser

The persona prompt and voice ID come from room metadata (set by the
backend `/voice/token` endpoint when the room is created), so this
worker has zero patient-specific knowledge — TS owns that.

Run:
    backend/.venv-voice/Scripts/python.exe backend/voice_agent.py dev
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession, RoomInputOptions, WorkerOptions, cli
from livekit.plugins import anthropic, cartesia, deepgram, silero

# Load .env.local first (project convention), .env as fallback.
_BACKEND = Path(__file__).resolve().parent
load_dotenv(_BACKEND / ".env.local")
load_dotenv(_BACKEND / ".env")

logger = logging.getLogger("medkit.voice-agent")
logger.setLevel(logging.INFO)


# Cartesia Sonic-2 voice IDs — verified via /voices API (gender attr).
# 2 male + 2 female English voices, picked deterministically per case.
VOICE_IDS = {
    "M": [
        "d709a7e8-9495-4247-aef0-01b3207d11bf",  # Donny - Steady Presence
        "ea7c252f-6cb1-45f5-8be9-b4f6ac282242",  # Logan - Approachable Friend
    ],
    "F": [
        "cec7cae1-ac8b-4a59-9eac-ec48366f37ae",  # Haley - Engaging Friend
        "ea93f57f-7c71-4d79-aeaa-0a39b150f6ca",  # Diana - Gentle Mom
    ],
}

# Chinese Cartesia voices for CRC (language=zh) rooms.
ZH_VOICE_IDS = {
    "M": [
        "eda5bbff-1ff1-4886-8ef1-4e69a77640a0",  # Chinese Commercial Man
        "3a63e2d1-1c1e-425d-8e79-5100bc910e90",  # Chinese Call Center Man
    ],
    "F": [
        "e90c6678-f0d3-4767-9883-5d0ecf5894a8",  # Chinese Female Conversational
        "0b904166-a29f-4d2e-bb20-41ca302f98e9",  # Chinese Commercial Woman
    ],
}

DEFAULT_VOICE = VOICE_IDS["M"][0]
DEFAULT_INSTRUCTIONS = (
    "You are a patient speaking to a doctor. Keep replies to 1-2 short spoken "
    "sentences. Output spoken dialogue only — no stage directions, no asterisks."
)
DEFAULT_INITIAL = "Hi doc."

FAREWELLS_EN = [
    "Thank you, doctor. Take care.",
    "Okay, thanks doc. Goodbye.",
    "Thanks for your help. Bye.",
    "Alright, take care. Goodbye.",
]
FAREWELLS_ZH = [
    "好的，谢谢您，再见。",
    "那我先这样，有消息再联系您。",
    "谢谢，我再考虑一下，再见。",
    "好的，麻烦您了，再见。",
]


def _hash_str(s: str) -> int:
    """FNV-1a, mirrors src/voice/patientPersona.ts so TS-side and Python-side
    pick the same voice slot for the same case ID if frontend chose to defer."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def pick_voice(case_id: str, gender: str, *, language: str = "en") -> str:
    g = gender.upper()
    if language.startswith("zh"):
        pool = ZH_VOICE_IDS.get(g) or ZH_VOICE_IDS["F"]
    else:
        pool = VOICE_IDS.get(g) or VOICE_IDS["M"]
    return pool[_hash_str(case_id) % len(pool)]


def parse_metadata(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("room metadata is not valid JSON: %r", raw[:120])
        return {}


async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()

    meta = parse_metadata(ctx.room.metadata)
    case_id = meta.get("caseId") or meta.get("case_id") or "unknown"
    speaker_gender = (meta.get("voiceGender") or meta.get("gender") or "M").upper()
    system_prompt = meta.get("systemPrompt") or DEFAULT_INSTRUCTIONS
    initial_line = meta.get("initialLine") or DEFAULT_INITIAL
    # Deepgram language code. CRC Chinese rooms pass "zh"; default English.
    language = (meta.get("language") or "en").lower()
    if language.startswith("zh"):
        dg_language = "zh"
    else:
        dg_language = "en"

    voice_id = meta.get("voiceId") or pick_voice(
        case_id, speaker_gender, language=dg_language
    )

    logger.info(
        "joining room=%s case=%s gender=%s voice=%s lang=%s",
        ctx.room.name, case_id, speaker_gender, voice_id, dg_language,
    )

    session = AgentSession(
        stt=deepgram.STT(model="nova-3", language=dg_language),
        llm=anthropic.LLM(model="claude-haiku-4-5-20251001", temperature=0.8),
        tts=cartesia.TTS(model="sonic-2", voice=voice_id),
        vad=silero.VAD.load(),
    )

    agent = Agent(instructions=system_prompt)

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(),
    )

    # Frontend signals end-of-visit by publishing a small JSON payload to
    # the room data channel. We speak ONE short farewell out loud via
    # session.say (direct TTS — no LLM round-trip) so the patient actually
    # says goodbye before the room is torn down. Without this the audio
    # cuts mid-sentence on dispatch.
    farewells = FAREWELLS_ZH if dg_language.startswith("zh") else FAREWELLS_EN
    farewell_pick = farewells[_hash_str(case_id) % len(farewells)]

    # RPC method invoked by the doctor's browser when they click "Dispatch".
    # Speaks ONE short goodbye via direct TTS so the patient actually says
    # bye out loud before the room is torn down.
    # RPC method invoked by the doctor's browser when they TYPE a line
    # into the composer dock instead of speaking it. We need the patient
    # to answer OUT LOUD through the same TTS path, otherwise typed turns
    # come back as silent text while spoken turns are voiced.
    #
    # Returns immediately ("ok") and speaks in a background task — the
    # frontend must not block on the full LLM+TTS round-trip, or its RPC
    # timeout would fire and fall back to the text-only stream (double reply).
    @ctx.room.local_participant.register_rpc_method("say_text")
    async def _on_say_text(data: rtc.RpcInvocationData) -> str:
        text = (data.payload or "").strip()
        if not text:
            return "empty"
        logger.info("rpc say_text from %s: %r", data.caller_identity, text[:120])

        if dg_language.startswith("zh"):
            instr = (
                f'严格保持角色。医生（研究者）刚刚对你说了这句话：“{text}”。'
                f'用中文口语化回答，只说 1-2 句短话。不要旁白、不要括号、不要星号、不要动作描写。'
            )
        else:
            instr = (
                f'Stay strictly in character. The doctor just said: "{text}". '
                f'Reply naturally in spoken English, 1-2 short sentences only. '
                f'No stage directions, no brackets, no asterisks, no actions.'
            )

        async def _speak() -> None:
            try:
                await session.generate_reply(instructions=instr)
            except Exception as e:  # pragma: no cover - defensive
                logger.exception("say_text generate_reply failed: %s", e)

        asyncio.create_task(_speak())
        return "ok"

    @ctx.room.local_participant.register_rpc_method("farewell")
    async def _on_farewell(data: rtc.RpcInvocationData) -> str:
        logger.info("rpc farewell invoked by %s", data.caller_identity)
        try:
            session.say(farewell_pick)
            logger.info("farewell speaking: %r", farewell_pick)
        except Exception as e:
            logger.exception("session.say failed: %s", e)
            return "error"
        return "ok"

    # Patient blurts their chief complaint as soon as the doctor walks up.
    if dg_language.startswith("zh"):
        open_instr = (
            f'严格保持角色。用中文自然说出这句开场白（患者或陪同家属），'
            f'只说这一句短话：\"{initial_line}\"'
        )
    else:
        open_instr = (
            f'Stay strictly in character. Speak this opening line, naturally, '
            f'as the patient (or accompanying parent for pediatric cases) '
            f'arriving in the room: "{initial_line}". One short sentence only.'
        )
    await session.generate_reply(instructions=open_instr)


if __name__ == "__main__":
    # `agent_name="medkit-voice"` opts the worker out of automatic dispatch and
    # into explicit-by-name dispatch. Backend rooms are created with
    # `RoomAgentDispatch(agent_name="medkit-voice")` so this matches.
    cli.run_app(
        WorkerOptions(entrypoint_fnc=entrypoint, agent_name="medkit-voice")
    )
