/**
 * Real-time voice conversation, backed by LiveKit + Deepgram + Cartesia.
 *
 * Public API surface kept from the legacy push-to-talk implementation so
 * existing consumers (PatientPanel, FloatingVoicePanel, Face, ExamRoom,
 * PatientChatPanel, conversationStore) keep compiling without changes.
 *
 * What changed inside:
 *   - No more browser Whisper / Kokoro / MediaRecorder. The mic streams
 *     over WebRTC into a LiveKit room; the Python voice agent worker
 *     does Deepgram STT → Claude Haiku 4.5 → Cartesia TTS and pipes the
 *     audio back over the same room.
 *   - `init()` now connects the room (and starts the patient's greeting).
 *   - `startListening()` / `stopListeningAndRespond()` are no-ops kept
 *     for backwards compat — real-time means the mic is open the whole
 *     time, no push-to-talk turn boundary.
 *   - `getMouthAmplitude()` reads from an AnalyserNode tapped onto the
 *     remote audio track, so the 3D face lip-sync still works.
 *   - Transcripts (both sides) come from LiveKit transcription events.
 *   - `sendTextMessage()` keeps the legacy /agent/patient/stream path so
 *     the typed-chat panel still functions while voice runs in parallel.
 */

import {
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
  type TranscriptionSegment,
} from 'livekit-client';
import { hasClaudeKey, streamClaude, type ChatMessage } from './claude';
import {
  crcCreateSession,
  crcEvaluateSession,
  crcReply,
  crcTts,
  crcVoiceTurn,
  playBase64Mp3,
  resolveCrcStudy,
  stopCrcAudio,
  type CrcSessionPayload,
} from './crcClient';
import type { CrcEvaluationReport, DialogueBackend } from '../game/types';
import { getTrainingFocus } from '../game/trainingContext';
import { getStoredToken, submitTrainingRecord } from '../game/auth';

const FALLBACK_PERSONA =
  'You are a patient speaking to a doctor. Keep replies to 1–2 short spoken sentences. ' +
  'Output spoken dialogue only — no stage directions, no asterisks, no brackets.';
const FALLBACK_INITIAL: { role: 'assistant'; content: string } = {
  role: 'assistant',
  content: 'Hi doc.',
};

export type ConversationStatus =
  | 'uninitialized'
  | 'loading'
  | 'ready'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface SubtitleEvent {
  who: 'patient' | 'you';
  text: string;
  partial?: boolean;
}

export type PatientEmotion = 'neutral' | 'pain' | 'fear' | 'relief' | 'confused';

export interface ConversationListeners {
  onStatus?: (status: ConversationStatus, detail?: string) => void;
  onProgress?: (msg: string) => void;
  onSubtitle?: (sub: SubtitleEvent) => void;
  onError?: (err: string) => void;
  onEmotion?: (e: PatientEmotion) => void;
  onEnded?: (evaluation?: CrcEvaluationReport) => void;
}

function detectEmotion(text: string): PatientEmotion {
  const t = text.toLowerCase();
  if (/\b(hurts?|pain(?:ful)?|ache|aching|ow|ouch|sore|burn(?:s|ing)?|sharp|throb|stab|rip(?:ping)?|tear(?:ing)?|crush(?:ing)?|killing me|agony|can'?t breathe|chest)\b/.test(t)) return 'pain';
  if (/\b(scared|afraid|frightened|terrified|worr(?:ied|y)|nervous|anxious|help me|please help|dying|die|gonna die|save me)\b/.test(t)) return 'fear';
  if (/\b(okay|i'?m okay|fine|better|good now|thanks|thank you|relieved?|easier|breathing better|no more pain)\b/.test(t)) return 'relief';
  if (/\b(i don'?t (?:know|understand)|not sure|confused|what does that mean|what do you mean|sorry what)\b/.test(t)) return 'confused';
  return 'neutral';
}

export interface ConversationOptions {
  systemPrompt?: string;
  initialMessage?: { role: 'assistant'; content: string };
  /** Speaker gender ('M'|'F') — used by backend voice picker. */
  voiceGender?: 'M' | 'F';
  /** Stable case id — backend uses this for logging + voice slot pick. */
  caseId?: string;
  /** Preserved for back-compat. Ignored — voice ID is chosen server-side now. */
  voice?: string;
  /** If set, persist/restore the conversation history to localStorage under this key. */
  storageKey?: string;
  /** `crc` uses front/server.py; `livekit` is the original medkit voice path. */
  backend?: DialogueBackend;
  /** CRC study stem when backend === 'crc'. */
  crcStudy?: string;
  crcLanguage?: 'zh' | 'en';
}

interface VoiceTokenResponse {
  token: string;
  url: string;
  roomName: string;
}

async function fetchVoiceToken(opts: {
  caseId: string;
  systemPrompt: string;
  initialLine: string;
  gender: 'M' | 'F';
}): Promise<VoiceTokenResponse> {
  const r = await fetch('/voice/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!r.ok) throw new Error(`/voice/token ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

export class Conversation {
  private messages: ChatMessage[] = [];
  private listeners: ConversationListeners = {};
  private status: ConversationStatus = 'uninitialized';

  private room: Room | null = null;
  private remoteAudioTrack: RemoteAudioTrack | null = null;
  private analyser: AnalyserNode | null = null;
  private audioCtx: AudioContext;
  private ampBuf: Uint8Array;

  private systemPrompt: string;
  private initialMessage: { role: 'assistant'; content: string };
  private voiceGender: 'M' | 'F';
  private caseId: string;
  private storageKey: string | null = null;
  private backend: DialogueBackend = 'livekit';
  private crcStudy: string;
  private crcLanguage: 'zh' | 'en';
  private crcSessionId: string | null = null;
  /** Bumps whenever a new CRC utterance starts — drops stale TTS responses. */
  private crcSpeakSeq = 0;
  /** 当前 CRC 会话是否已上报训练记录（防重复上报）。 */
  private crcRecordSubmitted = false;

  private messageSubscribers = new Set<(msgs: ReadonlyArray<ChatMessage>) => void>();

  // Latest agent text spoken — drives the 3D face emotion.
  private currentEmotion: PatientEmotion = 'neutral';

  constructor(
    audioCtx: AudioContext,
    listeners: ConversationListeners = {},
    options: ConversationOptions = {}
  ) {
    this.audioCtx = audioCtx;
    this.listeners = listeners;
    this.systemPrompt = options.systemPrompt ?? FALLBACK_PERSONA;
    this.initialMessage = options.initialMessage ?? FALLBACK_INITIAL;
    this.voiceGender = options.voiceGender ?? 'M';
    this.caseId = options.caseId ?? 'unknown';
    this.storageKey = options.storageKey ?? null;
    this.backend = options.backend ?? 'livekit';
    this.crcStudy = options.crcStudy ?? resolveCrcStudy(this.caseId);
    this.crcLanguage = options.crcLanguage ?? 'zh';
    this.ampBuf = new Uint8Array(1024);

    const restored = this.loadMessages();
    this.messages = restored && restored.length > 0 ? restored : [this.initialMessage];
  }

  isCrcBackend(): boolean {
    return this.backend === 'crc';
  }

  getCrcSessionId(): string | null {
    return this.crcSessionId;
  }

  private async speakCrcLine(text: string, emotion?: string | null) {
    const line = text.trim();
    if (!line) return;
    const seq = ++this.crcSpeakSeq;
    try {
      stopCrcAudio();
      const tts = await crcTts(line, {
        sessionId: this.crcSessionId,
        emotion: emotion ?? undefined,
      });
      if (seq !== this.crcSpeakSeq) return;
      if (tts.audio_base64) playBase64Mp3(tts.audio_base64);
    } catch (err) {
      console.warn('CRC TTS failed:', err);
    }
  }

  /** CRC push-to-talk: WAV blob → ASR → PatientTurn → TTS. */
  async sendVoiceBlob(blob: Blob): Promise<void> {
    if (this.backend !== 'crc') {
      throw new Error('sendVoiceBlob 仅支持 CRC 模式');
    }
    if (!this.crcSessionId) {
      this.listeners.onError?.('CRC 会话尚未创建');
      return;
    }
    if (this.status !== 'ready' && this.status !== 'listening') return;

    const seq = ++this.crcSpeakSeq;
    stopCrcAudio();
    this.setStatus('thinking', '识别中…');
    this.listeners.onProgress?.('火山 ASR + CRC 回复中…');
    try {
      const data = await crcVoiceTurn(this.crcSessionId, blob);
      if (seq !== this.crcSpeakSeq) return;
      const crcText = (data.crc_text || '').trim();
      if (crcText) {
        this.listeners.onSubtitle?.({ who: 'you', text: crcText });
        this.messages.push({ role: 'user', content: crcText });
      }
      const line = (data.patient_line || '').trim();
      if (line) {
        this.setEmotion(detectEmotion(line));
        this.listeners.onSubtitle?.({ who: 'patient', text: line });
        this.messages.push({ role: 'assistant', content: line });
        this.setStatus('speaking');
        if (data.audio_base64) {
          playBase64Mp3(data.audio_base64);
          setTimeout(() => {
            if (this.status === 'speaking') this.setStatus('ready');
          }, 2800);
        } else {
          try {
            const tts = await crcTts(line, {
              sessionId: this.crcSessionId,
              emotion: data.tts_emotion,
              emotionScale: data.tts_emotion_scale,
            });
            if (seq === this.crcSpeakSeq && tts.audio_base64) playBase64Mp3(tts.audio_base64);
          } catch {
            /* optional */
          }
          this.setStatus('ready');
        }
      } else {
        this.setStatus('ready');
      }
      this.saveMessages();
      this.emitMessages();
      if (data.ended) {
        void this.maybeSubmitCrcRecord(data);
        this.listeners.onEnded?.(data.evaluation as CrcEvaluationReport | undefined);
      }
    } catch (err: any) {
      console.error('CRC voice turn failed:', err);
      this.listeners.onError?.(err?.message ?? String(err));
      this.setStatus('ready');
    }
  }

  private saveMessages() {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.messages));
    } catch { /* quota or privacy-mode — silently ignore */ }
  }

  /**
   * 会话结束时上报训练记录（登录用户），并刷新能力画像。
   * 仅当评估结果可用且该会话尚未上报过时执行。
   */
  private async maybeSubmitCrcRecord(data: CrcSessionPayload, force = false): Promise<void> {
    if ((!force && !data.ended) || !data.evaluation) return;
    if (this.crcRecordSubmitted) return;
    const token = getStoredToken();
    if (!token || token === 'guest') return;
    const ev = data.evaluation as {
      overall_score?: number | null;
      passed?: boolean;
      summary?: string;
      dimensions?: Array<Record<string, unknown>>;
      strengths?: string[];
      improvements?: string[];
    };
    if (ev?.overall_score == null) return;
    this.crcRecordSubmitted = true;
    try {
      const res = await submitTrainingRecord({
        study: this.crcStudy,
        session_id: this.crcSessionId ?? '',
        overall_score: typeof ev.overall_score === 'number' ? ev.overall_score : null,
        passed: Boolean(ev.passed),
        summary: typeof ev.summary === 'string' ? ev.summary : '',
        dimensions: Array.isArray(ev.dimensions) ? (ev.dimensions as any) : [],
        strengths: Array.isArray(ev.strengths) ? ev.strengths : [],
        improvements: Array.isArray(ev.improvements) ? ev.improvements : [],
        training_focus: getTrainingFocus(),
      });
      // 用最新画像刷新 Store（动态导入避免循环依赖）
      if (res?.profile) {
        try {
          const { store } = await import('../game/store');
          store.setSkillProfile(res.profile);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // 上报失败不阻断对话流程，仅打日志
      console.warn('训练记录上报失败:', err);
      this.crcRecordSubmitted = false;
    }
  }

  /** Manually finish a CRC encounter, request its report, and persist training data. */
  async evaluateCrcSession(): Promise<CrcEvaluationReport> {
    if (this.backend !== 'crc' || !this.crcSessionId) {
      throw new Error('CRC 会话尚未建立，请先与患者完成至少一轮沟通。');
    }
    const data = await crcEvaluateSession(this.crcSessionId);
    if (!data.evaluation || typeof data.evaluation !== 'object') {
      throw new Error('评分接口未返回评估报告。');
    }
    await this.maybeSubmitCrcRecord(data, true);
    return data.evaluation as CrcEvaluationReport;
  }

  private loadMessages(): ChatMessage[] | null {
    if (!this.storageKey) return null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter(
        (m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      );
    } catch {
      return null;
    }
  }

  setListeners(listeners: ConversationListeners) {
    this.listeners = listeners;
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  getMessages(): ReadonlyArray<ChatMessage> {
    return [...this.messages];
  }

  subscribeMessages(fn: (msgs: ReadonlyArray<ChatMessage>) => void): () => void {
    this.messageSubscribers.add(fn);
    return () => { this.messageSubscribers.delete(fn); };
  }

  private emitMessages() {
    const snap = [...this.messages];
    this.messageSubscribers.forEach((fn) => fn(snap));
  }

  /** Live mouth amplitude from the AnalyserNode tapped onto the remote
   *  audio track. 0..1, usable directly as a mouth-open factor. */
  getMouthAmplitude(): number {
    if (!this.analyser) return 0;
    if (this.ampBuf.length !== this.analyser.frequencyBinCount) {
      this.ampBuf = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.analyser.getByteTimeDomainData(this.ampBuf as any);
    let sum = 0;
    const n = this.ampBuf.length;
    for (let i = 0; i < n; i++) {
      const d = (this.ampBuf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / n);
    // Cartesia output peaks around ~0.3 RMS on loud vowels — same multiplier
    // we used for Kokoro looks right here too.
    return Math.min(1, rms * 3.2);
  }

  getCurrentEmotion(): PatientEmotion {
    return this.currentEmotion;
  }

  private setEmotion(e: PatientEmotion) {
    if (e === this.currentEmotion) return;
    this.currentEmotion = e;
    this.listeners.onEmotion?.(e);
  }

  private setStatus(s: ConversationStatus, detail?: string) {
    this.status = s;
    this.listeners.onStatus?.(s, detail);
  }

  private attachAnalyser(track: RemoteAudioTrack) {
    try {
      const mst = track.mediaStreamTrack;
      if (!mst) return;
      const stream = new MediaStream([mst]);
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      // We do NOT connect analyser to destination — LiveKit attaches the
      // track to a hidden <audio> element for actual playback. The analyser
      // is read-only.
      this.analyser = analyser;
      this.ampBuf = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      console.warn('analyser attach failed:', err);
    }
  }

  private detachAnalyser() {
    this.analyser = null;
  }

  private wireRoomEvents(room: Room) {
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        this.remoteAudioTrack = track as RemoteAudioTrack;
        this.attachAnalyser(this.remoteAudioTrack);
        // LiveKit auto-attaches remote audio for playback in the page;
        // call attach() explicitly to be safe across browsers.
        const el = (track as RemoteAudioTrack).attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        // Tag for dispose-time cleanup.
        (el as any).__convRoomId = room.name;
        void participant;
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track === this.remoteAudioTrack) {
        try { (track as RemoteAudioTrack).detach().forEach((el) => el.remove()); } catch { /* noop */ }
        this.remoteAudioTrack = null;
        this.detachAnalyser();
      }
    });

    // Transcription events fire for both local (user) and remote (agent)
    // participants. We distinguish by participant identity vs. local id.
    room.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant?: Participant) => {
      const isLocal = participant?.identity === room.localParticipant.identity;
      for (const seg of segments) {
        if (isLocal) {
          this.handleUserTranscription(seg);
        } else {
          this.handleAgentTranscription(seg);
        }
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      this.setStatus('uninitialized');
    });
  }

  private handleUserTranscription(seg: TranscriptionSegment) {
    if (!seg.text) return;
    if (!seg.final) {
      this.listeners.onSubtitle?.({ who: 'you', text: seg.text, partial: true });
      if (this.status !== 'listening') this.setStatus('listening');
      return;
    }
    const final = seg.text.trim();
    if (!final) return;
    this.listeners.onSubtitle?.({ who: 'you', text: final });
    this.messages.push({ role: 'user', content: final });
    this.saveMessages();
    this.emitMessages();
    this.setStatus('thinking', 'Thinking…');
  }

  private handleAgentTranscription(seg: TranscriptionSegment) {
    if (!seg.text) return;
    if (!seg.final) {
      this.setEmotion(detectEmotion(seg.text));
      this.listeners.onSubtitle?.({ who: 'patient', text: seg.text, partial: true });
      if (this.status !== 'speaking') this.setStatus('speaking');
      return;
    }
    const final = seg.text.trim();
    if (!final) return;
    this.setEmotion(detectEmotion(final));
    this.listeners.onSubtitle?.({ who: 'patient', text: final });
    this.messages.push({ role: 'assistant', content: final });
    this.saveMessages();
    this.emitMessages();
    this.setStatus('ready');
  }

  async init() {
    if (this.status !== 'uninitialized') return;
    this.setStatus('loading');

    if (this.backend === 'crc') {
      await this.initCrc();
      return;
    }

    try {
      if (!hasClaudeKey()) {
        throw new Error('Patient backend unavailable.');
      }

      this.listeners.onProgress?.('Requesting voice session…');
      const initialLine = this.initialMessage.content;
      const tok = await fetchVoiceToken({
        caseId: this.caseId,
        systemPrompt: this.systemPrompt,
        initialLine,
        gender: this.voiceGender,
      });

      this.listeners.onProgress?.('Connecting to voice room…');
      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.wireRoomEvents(room);
      await room.connect(tok.url, tok.token);
      this.room = room;

      // Resume audio context after the user gesture chain finishes so
      // both playback and the analyser tap can run.
      if (this.audioCtx.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch { /* noop */ }
      }

      // Open the mic. Real-time means it stays open until dispose().
      this.listeners.onProgress?.('Enabling microphone…');
      await room.localParticipant.setMicrophoneEnabled(true);

      this.listeners.onProgress?.('Live.');
      this.setStatus('ready');

      // Always start a fresh encounter with a placeholder subtitle. The
      // patient's actual opening line will replace it as soon as the
      // agent's first transcription arrives.
      this.listeners.onSubtitle?.({ who: 'patient', text: '…' });
      this.setEmotion(detectEmotion(initialLine));
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error('Conversation init failed:', err);
      this.setStatus('error', msg);
      this.listeners.onError?.(msg);
      throw err;
    }
  }

  /** Boot CRC session on :8790 (proxied /api) — text + optional Volc TTS. */
  private async initCrc() {
    try {
      this.listeners.onProgress?.(`连接 CRC 会话（${this.crcStudy}）…`);
      // Fresh encounter — don't reuse stale localStorage history against a new CRC session.
      if (this.storageKey) {
        try { localStorage.removeItem(this.storageKey); } catch { /* noop */ }
      }
      const session = await crcCreateSession({
        study: this.crcStudy,
        language: this.crcLanguage,
        randomPersona: false,
        focus: getTrainingFocus(),
        // The selected patient owns the opening line. The backend study is
        // shared by the small demo roster, so never let its default opening
        // overwrite this case-specific first sentence.
        openingLine: this.initialMessage.content,
      });
      this.crcSessionId = session.session_id;
      this.crcRecordSubmitted = false;
      const line = (session.patient_line || this.initialMessage.content || '').trim();
      this.initialMessage = { role: 'assistant', content: line || '您好。' };
      this.messages = [{ role: 'assistant', content: this.initialMessage.content }];
      this.saveMessages();
      this.emitMessages();

      this.listeners.onSubtitle?.({ who: 'patient', text: this.initialMessage.content });
      this.setEmotion(detectEmotion(this.initialMessage.content));
      this.setStatus('ready');
      this.listeners.onProgress?.('CRC 已就绪（文字对话；可朗读）');

      // Best-effort speak opening line via Volc TTS
      try {
        const seq = ++this.crcSpeakSeq;
        stopCrcAudio();
        const tts = await crcTts(this.initialMessage.content, {
          sessionId: this.crcSessionId,
          emotion: session.tts_emotion,
          emotionScale: session.tts_emotion_scale,
        });
        if (seq !== this.crcSpeakSeq) return;
        playBase64Mp3(tts.audio_base64);
        this.setStatus('speaking');
        setTimeout(() => {
          if (this.status === 'speaking') this.setStatus('ready');
        }, 2500);
      } catch {
        /* TTS optional */
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error('CRC Conversation init failed:', err);
      this.setStatus('error', msg);
      this.listeners.onError?.(msg);
      throw err;
    }
  }

  /** Back-compat no-op. Real-time means mic is always live. */
  async startListening() {
    if (this.status === 'uninitialized') return;
    if (this.room) {
      try { await this.room.localParticipant.setMicrophoneEnabled(true); } catch { /* noop */ }
    }
  }

  /** Back-compat no-op. The agent decides turn boundaries via VAD. */
  async stopListeningAndRespond() {
    /* no-op */
  }

  cancel() {
    // Best-effort: mute mic until next turn. The agent's VAD will pick
    // back up when we unmute, but real-time has no abort signal we own.
    if (this.room) {
      this.room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    }
    this.setStatus('ready');
  }

  /** Trigger the LiveKit voice agent to speak ONE short farewell out loud
   *  and wait until the audio finishes before resolving. We publish a tiny
   *  data-channel signal; the Python worker listens and calls
   *  `session.generate_reply()` with a farewell instruction so the patient
   *  actually *speaks* the goodbye via Cartesia TTS. Falls back to the
   *  HTTP text-only path when voice isn't connected. */
  async sayFarewell(): Promise<void> {
    this.setStatus('thinking', 'Saying goodbye…');
    this.listeners.onSubtitle?.({ who: 'patient', text: '…' });

    if (this.backend === 'crc') {
      const bye = '好的，谢谢您，再见。';
      this.listeners.onSubtitle?.({ who: 'patient', text: bye });
      this.messages.push({ role: 'assistant', content: bye });
      this.saveMessages();
      this.emitMessages();
      await this.speakCrcLine(bye);
      this.setStatus('ready');
      return;
    }

    // Stop the doctor's mic so the agent's farewell can't trigger another
    // STT round-trip and a follow-up reply.
    if (this.room) {
      try { await this.room.localParticipant.setMicrophoneEnabled(false); } catch { /* noop */ }
    }

    if (this.room && this.room.state === 'connected') {
      try {
        // RPC into the agent participant. We're the only OTHER participant
        // (doctor) in the room, so any remote participant is the patient
        // agent. Match by identity prefix or, failing that, take the first.
        const remotes = Array.from(this.room.remoteParticipants.values());
        console.log('[farewell] remote participants:', remotes.map((p) => p.identity));
        const agent =
          remotes.find((p) => p.identity.startsWith('agent-')) ?? remotes[0];
        if (agent) {
          console.log('[farewell] performing RPC to', agent.identity);
          const result = await this.room.localParticipant.performRpc({
            destinationIdentity: agent.identity,
            method: 'farewell',
            payload: '',
          });
          console.log('[farewell] RPC result:', result);
        } else {
          console.warn('[farewell] no agent participant in room');
        }
      } catch (err) {
        console.error('[farewell] RPC failed:', err);
      }

      // Wait for the agent to actually start speaking (status flips to
      // 'speaking' when LiveKit forwards the first transcription segment),
      // then wait for it to drop back to 'ready'. Pad a short tail so the
      // last syllable plays through before the room is torn down. Hard cap
      // at 7 s in case events are missed.
      const deadline = Date.now() + 7000;
      let sawSpeaking = false;
      while (Date.now() < deadline) {
        if (this.status === 'speaking') sawSpeaking = true;
        if (sawSpeaking && this.status !== 'speaking') break;
        await new Promise((r) => window.setTimeout(r, 100));
      }
      // Tail flush — Cartesia stream lags the final transcription by ~0.5s.
      await new Promise((r) => window.setTimeout(r, 800));
      // Wipe persisted history so a re-encounter with this case doesn't
      // pop the farewell as the "last assistant message" on greeting.
      if (this.storageKey) {
        try { localStorage.removeItem(this.storageKey); } catch { /* noop */ }
      }
      this.setStatus('ready');
      return;
    }

    // Voice not connected — fall back to the old text-only flow so the
    // subtitle still shows a goodbye line.
    const farewellPrompt =
      "Okay, we're all done. Take care of yourself. Goodbye. " +
      "[This is your final reply. Say a short goodbye — thanks, okay, bye — " +
      "and NOTHING ELSE. Do NOT ask any questions. No follow-ups. " +
      "One or two short sentences, then silence.]";
    this.messages.push({ role: 'user', content: farewellPrompt });
    this.emitMessages();

    const controller = new AbortController();
    let assistantText = '';
    try {
      for await (const token of streamClaude(this.systemPrompt, this.messages, controller.signal)) {
        assistantText += token;
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('Farewell LLM error:', err);
    }
    const trimmed = assistantText.trim();
    if (trimmed) {
      this.setEmotion(detectEmotion(trimmed));
      this.listeners.onSubtitle?.({ who: 'patient', text: trimmed });
      this.messages.push({ role: 'assistant', content: trimmed });
      this.saveMessages();
      this.emitMessages();
    }
    this.setStatus('ready');
  }

  /** Text-chat turn — CRC PatientTurn or legacy /agent/patient/stream. */
  async sendTextMessage(text: string, _opts?: { speak?: boolean }): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    if (this.status !== 'ready' && this.status !== 'listening') return;

    this.listeners.onSubtitle?.({ who: 'you', text: clean });
    this.messages.push({ role: 'user', content: clean });
    this.saveMessages();
    this.emitMessages();
    this.setStatus('thinking', 'Thinking…');

    if (this.backend === 'crc') {
      if (!this.crcSessionId) {
        this.listeners.onError?.('CRC 会话尚未创建');
        this.setStatus('error', 'no crc session');
        return;
      }
      try {
        const data = await crcReply(this.crcSessionId, clean);
        const line = (data.patient_line || '').trim();
        if (line) {
          this.setEmotion(detectEmotion(line));
          this.listeners.onSubtitle?.({ who: 'patient', text: line });
          this.messages.push({ role: 'assistant', content: line });
          this.saveMessages();
          this.emitMessages();
          if (_opts?.speak !== false) {
            void this.speakCrcLine(line, data.tts_emotion);
          }
        }
        this.setStatus(data.ended ? 'ready' : 'ready');
        if (data.ended) {
          void this.maybeSubmitCrcRecord(data);
          this.listeners.onEnded?.(data.evaluation as CrcEvaluationReport | undefined);
        }
      } catch (err: any) {
        console.error('CRC reply failed:', err);
        this.listeners.onError?.(err?.message ?? String(err));
        this.setStatus('ready');
      }
      return;
    }

    // LiveKit path: hand the typed line to the voice agent so the patient
    // answers OUT LOUD through the same TTS pipeline a spoken turn uses.
    // The reply arrives asynchronously via TranscriptionReceived, which
    // already pushes it into `messages` — so we must NOT also run the
    // text-only stream below (that would produce two answers). Falls back
    // to the HTTP stream when the worker predates the `say_text` RPC.
    if (this.room && this.room.state === 'connected') {
      const voiced = await this.askAgentAloud(clean);
      if (voiced) {
        // Status flips on its own when the agent's transcription lands.
        // Safety net in case the agent never speaks (LLM/TTS failure).
        window.setTimeout(() => {
          if (this.status === 'thinking') this.setStatus('ready');
        }, 9000);
        return;
      }
    }

    const controller = new AbortController();
    let assistantText = '';
    try {
      for await (const token of streamClaude(this.systemPrompt, this.messages, controller.signal)) {
        assistantText += token;
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('Text-chat LLM error:', err);
        this.listeners.onError?.(`Claude failed: ${err?.message ?? err}`);
        this.setStatus('ready');
        return;
      }
    }

    const trimmed = assistantText.trim();
    if (trimmed) {
      this.setEmotion(detectEmotion(trimmed));
      this.listeners.onSubtitle?.({ who: 'patient', text: trimmed });
      this.messages.push({ role: 'assistant', content: trimmed });
      this.saveMessages();
      this.emitMessages();
    }
    this.setStatus('ready');
  }

  /** Ask the LiveKit voice agent to answer a typed line out loud.
   *  Resolves false when the RPC isn't available (worker not restarted). */
  private async askAgentAloud(text: string): Promise<boolean> {
    const room = this.room;
    if (!room || room.state !== 'connected') return false;
    const remotes = Array.from(room.remoteParticipants.values());
    const agent =
      remotes.find((p) => p.identity.startsWith('agent-')) ?? remotes[0];
    if (!agent) return false;
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: 'say_text',
        payload: text,
      });
      return true;
    } catch (err) {
      console.warn('[say_text] RPC unavailable — falling back to text stream:', err);
      return false;
    }
  }

  reset() {
    this.cancel();
    this.messages = [this.initialMessage];
    this.emitMessages();
    if (this.storageKey) {
      try { localStorage.removeItem(this.storageKey); } catch { /* noop */ }
    }
  }

  dispose() {
    this.crcSpeakSeq += 1;
    stopCrcAudio();
    if (this.room) {
      try { this.room.disconnect(); } catch { /* noop */ }
      this.room = null;
    }
    this.crcSessionId = null;
    this.detachAnalyser();
    this.remoteAudioTrack = null;
    // Remove any audio elements we appended for playback.
    document.querySelectorAll('audio[__convRoomId]').forEach((el) => el.remove());
    this.setStatus('uninitialized');
  }
}
