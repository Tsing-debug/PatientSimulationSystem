import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Html } from '@react-three/drei';
import type { ActivePatient, CrcEvaluationReport } from '../../game/types';
import type { ConversationStatus, SubtitleEvent } from '../../voice/conversation';
import { getExistingConversation, getOrCreatePatientConversation } from '../../voice/conversationStore';
import { store } from '../../game/store';
import { startWavRecording, type WavRecorderHandle } from '../../voice/wavRecorder';

interface Props {
  bedPosition: [number, number, number];
  /** Bed rotation around Y (radians). Service-room beds are -PI/2, triage is 0. */
  bedRotationY?: number;
  /** Mouth offset in the bed's LOCAL frame (x along the bed, y up, z across).
   *  Default: lying-on-bed head position (-0.88, 1.0, 0). Polyclinic passes
   *  a seated-patient offset since the patient sits in a chair. */
  headOffset?: [number, number, number];
  patient: ActivePatient;
  onClose: () => void;
}

export function FloatingVoicePanel({
  bedPosition,
  bedRotationY = 0,
  headOffset,
  patient,
}: Props) {
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [subtitle, setSubtitle] = useState<SubtitleEvent>({ who: 'patient', text: '…' });
  const [error, setError] = useState('');
  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceStarting, setVoiceStarting] = useState(false);
  const [progress, setProgress] = useState('');
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<WavRecorderHandle | null>(null);
  const recordingRef = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  recordingRef.current = recording;

  // Stable listener object — built ONCE per mount.
  const listenersRef = useRef<{
    onStatus: (s: ConversationStatus) => void;
    onProgress: (m: string) => void;
    onSubtitle: (sub: SubtitleEvent) => void;
    onError: (e: string) => void;
    onEnded: (evaluation?: CrcEvaluationReport) => void;
  } | null>(null);
  if (listenersRef.current === null) {
    listenersRef.current = {
      onStatus: (s) => setStatus(s),
      onProgress: (m) => setProgress(m),
      // Only the patient's voice goes into the speech bubble above their
      // head — the doctor's transcript stays in the chat panel.
      onSubtitle: (sub) => { if (sub.who === 'patient') setSubtitle(sub); },
      onError: (e) => setError(e),
      onEnded: (evaluation) => {
        store.finishPolyclinicCase();
        if (evaluation && typeof evaluation.overall_score === 'number') {
          store.setCrcEvaluation(evaluation);
        } else {
          store.failCrcEvaluation('会话已结束，但自动评分失败，请稍后重试。');
        }
        store.setScreen('debrief');
      },
    };
  }
  const listeners = listenersRef.current;

  useEffect(() => {
    let cancelled = false;
    setStatus('uninitialized');
    setSubtitle({ who: 'patient', text: '…' });
    setVoiceReady(false);
    setVoiceStarting(false);
    setError('');
    setRecording(false);
    recorderRef.current = null;

    const conv = getOrCreatePatientConversation(patient.bedIndex, patient.case, listeners);
    const current = conv.getStatus();
    if (current !== 'uninitialized') {
      setVoiceReady(true);
      setStatus(current);
    } else {
      setVoiceStarting(true);
      conv
        .init()
        .then(() => { if (!cancelled) setVoiceReady(true); })
        .catch(() => { /* onError set */ })
        .finally(() => { if (!cancelled) setVoiceStarting(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient.bedIndex, patient.case.id]);

  const firstName = patient.case.name.split(' ')[0];
  const isCrc = store.getState().dialogueBackend === 'crc';

  const beginRecord = async () => {
    if (!isCrc || !voiceReady || recordingRef.current) return;
    const st = statusRef.current;
    if (st === 'thinking' || st === 'speaking' || st === 'loading') return;
    try {
      recorderRef.current = await startWavRecording();
      recordingRef.current = true;
      setRecording(true);
      setError('');
    } catch (err: any) {
      setError(err?.message ?? '无法打开麦克风');
    }
  };

  const endRecord = async () => {
    if (!recordingRef.current || !recorderRef.current) return;
    const handle = recorderRef.current;
    recorderRef.current = null;
    recordingRef.current = false;
    setRecording(false);
    try {
      const blob = await handle.stop();
      const conv = getExistingConversation(patient.bedIndex);
      if (!conv) throw new Error('会话不存在');
      await conv.sendVoiceBlob(blob);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  // Space / Enter hold-to-talk (ignore when typing in inputs)
  useEffect(() => {
    if (!isCrc || !voiceReady) return;

    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return;
      if (isTypingTarget(e.target)) return;
      if (e.repeat) return;
      e.preventDefault();
      void beginRecord();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      void endRecord();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCrc, voiceReady, patient.bedIndex]);

  const statusLabel =
    status === 'listening' || recording ? '录音中…' :
    status === 'thinking' ? '思考中…' :
    status === 'speaking' ? `${firstName.toUpperCase()} 说话中` :
    status === 'loading' ? '连接中…' :
    voiceReady ? (isCrc ? 'CRC 在线' : '在线') :
    voiceStarting ? '连接中…' : '离线';

  const idleHint =
    recording ? '松开空格/回车发送…' :
    status === 'speaking' ? `${firstName} 正在说话…` :
    status === 'thinking' ? `${firstName} 正在思考…` :
    status === 'listening' ? '请讲。' :
    voiceStarting ? (progress || '连接中…') :
    voiceReady
      ? (isCrc
        ? '按住 空格 或 回车 说话；也可点按钮。检查→对话可打字。'
        : '直接开口即可 — 实时。按 T 结束。')
      : '连接中…';

  const live = voiceReady && (status === 'listening' || status === 'speaking' || status === 'thinking' || status === 'ready' || recording);
  const statusColor =
    recording || status === 'listening' ? 'var(--mint-deep)' :
    status === 'speaking' ? 'var(--peach-deep)' :
    status === 'thinking' ? 'var(--butter-deep)' :
    live ? 'var(--mint-deep)' : 'var(--ink-soft)';

  const [ox, oy, oz] = headOffset ?? [-0.88, 1.0, 0];
  const cos = Math.cos(bedRotationY);
  const sin = Math.sin(bedRotationY);
  const mouthX = bedPosition[0] + ox * cos + oz * sin;
  const mouthY = oy;
  const mouthZ = bedPosition[2] - ox * sin + oz * cos;

  const beginPtt = async (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    await beginRecord();
  };

  return (
    <Html
      position={[mouthX, mouthY, mouthZ]}
      zIndexRange={[100, 0]}
      style={{ pointerEvents: 'auto', userSelect: 'none', transform: 'translate(-50%, -110%)' }}
    >
      <div
        style={{
          position: 'relative',
          minWidth: 240,
          maxWidth: 320,
          background: 'white',
          border: '3px solid var(--line)',
          borderRadius: 'var(--r-md)',
          boxShadow: '0 4px 0 var(--line), 0 8px 16px rgba(43,30,22,0.18)',
          padding: '10px 14px 12px',
          fontFamily: 'Nunito, system-ui, sans-serif',
          color: 'var(--ink)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 900, letterSpacing: '-0.01em' }}>
            {patient.case.name}
            <span style={{ fontSize: 11, color: 'var(--ink-soft)', marginLeft: 6, fontWeight: 700 }}>
              {patient.case.age}{patient.case.gender}
            </span>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 10,
              letterSpacing: '0.12em',
              color: statusColor,
              textTransform: 'uppercase',
              fontWeight: 900,
              whiteSpace: 'nowrap',
              padding: '3px 8px',
              borderRadius: 'var(--r-pill)',
              background: 'var(--cream)',
              border: '2px solid var(--line)',
            }}
          >
            <span
              className={live ? 'breathe' : undefined}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: statusColor,
                display: 'inline-block',
              }}
            />
            {statusLabel}
          </div>
        </div>

        <div style={{ fontStyle: 'italic', fontSize: 13, lineHeight: 1.4, color: 'var(--ink)', fontWeight: 600 }}>
          {subtitle.text && subtitle.text !== '…' ? (
            <span>&ldquo;{subtitle.text}&rdquo;</span>
          ) : (
            <span style={{ color: 'var(--ink-soft)', fontStyle: 'normal', fontSize: 12, fontWeight: 700 }}>
              {idleHint}
            </span>
          )}
        </div>

        {isCrc && voiceReady && (
          <button
            type="button"
            onPointerDown={(e) => { void beginPtt(e); }}
            onPointerUp={() => { void endRecord(); }}
            onPointerCancel={() => { void endRecord(); }}
            style={{
              marginTop: 10,
              width: '100%',
              border: '3px solid var(--line)',
              borderRadius: 12,
              padding: '10px 12px',
              fontWeight: 900,
              fontSize: 13,
              cursor: 'pointer',
              background: recording ? 'var(--peach)' : 'var(--mint)',
              boxShadow: '0 3px 0 var(--line)',
              touchAction: 'none',
              userSelect: 'none',
            }}
          >
            {recording ? '松开结束（空格/回车）' : '按住说话 · 空格/回车'}
          </button>
        )}

        {error && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              background: 'var(--rose)',
              border: '2.5px solid var(--line)',
              borderRadius: 10,
              boxShadow: '0 2px 0 var(--line)',
              fontSize: 11,
              fontWeight: 800,
              color: 'var(--ink)',
            }}
          >
            ⚠ {error}
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -12,
            transform: 'translateX(-50%)',
            width: 0,
            height: 0,
            borderLeft: '12px solid transparent',
            borderRight: '12px solid transparent',
            borderTop: '12px solid var(--line)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -8,
            transform: 'translateX(-50%)',
            width: 0,
            height: 0,
            borderLeft: '9px solid transparent',
            borderRight: '9px solid transparent',
            borderTop: '9px solid white',
          }}
        />
      </div>
    </Html>
  );
}
