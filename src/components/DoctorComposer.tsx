import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { POLYCLINIC_BED_INDEX, useGameState } from '../game/store';
import { getExistingConversation } from '../voice/conversationStore';
import { sttTranscribe } from '../voice/crcClient';
import { startWavRecording, type WavRecorderHandle } from '../voice/wavRecorder';
import type { ConversationStatus } from '../voice/conversation';
import type { ChatMessage } from '../voice/claude';

/** First-person composer HUD — the doctor's own "speaking" surface.
 *
 *  The 3D speech bubble above the patient only ever shows what the
 *  PATIENT says (by design — it hangs over their head). This dock is
 *  the doctor's counterpart: a compact bottom-right card that
 *  1) echoes what the doctor just said (typed or recognised) and
 *  2) lets them speak (mic button → ASR → editable draft) or type.
 *
 *  Mic flow is click-to-start / click-to-stop, and the result lands in
 *  the input box instead of being sent straight away, so the doctor can
 *  fix an ASR slip before committing to it.
 *
 *  It owns nothing — the conversation is booted by FloatingVoicePanel
 *  via conversationStore; we just subscribe. */

const MAX_LOG = 3;

interface Props {
  patientName: string;
  /** True while mouse-look / pointer-lock is engaged. The mic button is
   *  disabled then — the pointer is captured, so clicks never land. */
  lookEngaged?: boolean;
}

export function DoctorComposer({ patientName, lookEngaged = false }: Props) {
  const game = useGameState();
  // Push-to-talk only exists on the CRC backend. The LiveKit path keeps
  // the mic open the whole time and streams transcripts automatically.
  const isCrc = game.dialogueBackend === 'crc';
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const [focused, setFocused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const recorderRef = useRef<WavRecorderHandle | null>(null);
  const recordingRef = useRef(false);

  // Attach to the live conversation. Retry briefly in case we mount
  // before voice has connected.
  useEffect(() => {
    let disposed = false;
    let retry = 0;
    let stop: (() => void) | null = null;

    const attach = () => {
      if (disposed) return;
      const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
      if (!conv) {
        if (retry++ < 40) window.setTimeout(attach, 150);
        return;
      }
      setStatus(conv.getStatus());
      setMessages(conv.getMessages());
      stop = conv.subscribeMessages((msgs) => setMessages(msgs));
    };
    attach();

    const tick = window.setInterval(() => {
      if (disposed) return;
      const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
      if (conv) setStatus(conv.getStatus());
    }, 400);

    return () => {
      disposed = true;
      window.clearInterval(tick);
      stop?.();
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, showLog]);

  const firstName = patientName.split(' ')[0];

  const connected =
    status !== 'uninitialized' && status !== 'error' && status !== 'loading';
  const busy = sending || status === 'thinking' || status === 'speaking';

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (!conv) return;
    setSending(true);
    setDraft('');
    try {
      await conv.sendTextMessage(text, { speak: true });
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // ── Mic: click to start, click again to stop. The recognised text is
  //    dropped into the input box for editing — it is NOT auto-sent, so
  //    the doctor can fix an ASR slip before committing. ────────────
  const toggleMic = async () => {
    if (recordingRef.current) {
      const handle = recorderRef.current;
      recorderRef.current = null;
      recordingRef.current = false;
      setRecording(false);
      if (!handle) return;
      setTranscribing(true);
      setMicError('');
      try {
        const blob = await handle.stop();
        const text = await sttTranscribe(blob);
        if (text) {
          setDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
          inputRef.current?.focus();
        } else {
          setMicError('没听清，请再说一遍');
        }
      } catch (err: any) {
        setMicError(err?.message ?? '识别失败');
      } finally {
        setTranscribing(false);
      }
      return;
    }
    try {
      recorderRef.current = await startWavRecording();
      recordingRef.current = true;
      setRecording(true);
      setMicError('');
      inputRef.current?.focus();
    } catch (err: any) {
      setMicError(err?.message ?? '无法打开麦克风');
    }
  };

  // Abandon the take if the panel unmounts mid-recording.
  useEffect(() => {
    return () => {
      const handle = recorderRef.current;
      if (handle) {
        recorderRef.current = null;
        recordingRef.current = false;
        void handle.stop().catch(() => undefined);
      }
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      inputRef.current?.blur();
      return;
    }
    // Don't send mid-IME-composition (Chinese/Japanese candidate window).
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const log = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_LOG);

  const statusLabel =
    status === 'loading' ? '连接中…' :
    status === 'listening' ? '聆听中…' :
    status === 'thinking' ? `${firstName} 思考中…` :
    status === 'speaking' ? `${firstName} 说话中…` :
    status === 'error' ? '语音未连接' :
    connected ? '在线' : '离线';

  const statusColor =
    status === 'speaking' ? 'var(--peach-deep)' :
    status === 'thinking' ? 'var(--butter-deep)' :
    status === 'listening' ? 'var(--mint-deep)' :
    connected ? 'var(--mint-deep)' : 'var(--ink-soft)';

  return (
    <div
      style={{
        // Bottom-RIGHT so it never covers the bottom-left mouse-look hint.
        position: 'fixed',
        right: 18,
        bottom: 18,
        width: 'min(340px, calc(100vw - 36px))',
        zIndex: 55,
        background: 'white',
        border: '3px solid var(--line)',
        borderRadius: 'var(--r-md)',
        boxShadow: '0 6px 0 var(--line), 0 14px 28px rgba(43,30,22,0.18)',
        padding: '8px 10px 10px',
        fontFamily: 'Nunito, system-ui, sans-serif',
        color: 'var(--ink)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: showLog ? 8 : 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 900 }}>
            {firstName}
            <span style={{ fontSize: 10, color: 'var(--ink-soft)', marginLeft: 5, fontWeight: 700 }}>
              问诊中
            </span>
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 9,
              letterSpacing: '0.1em',
              color: statusColor,
              textTransform: 'uppercase',
              fontWeight: 900,
              whiteSpace: 'nowrap',
              padding: '2px 7px',
              borderRadius: 'var(--r-pill)',
              background: 'var(--cream)',
              border: '2px solid var(--line)',
            }}
          >
            <span
              className={status === 'listening' || status === 'speaking' || status === 'thinking' ? 'breathe' : undefined}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: statusColor,
                display: 'inline-block',
              }}
            />
            {statusLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          title={showLog ? '收起对话记录' : '展开对话记录'}
          style={{
            border: '2px solid var(--line)',
            borderRadius: 8,
            background: 'var(--cream)',
            color: 'var(--ink-2)',
            fontSize: 11,
            fontWeight: 800,
            padding: '3px 8px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {showLog ? '收起 ↑' : '记录 ↓'}
        </button>
      </div>

      {showLog && (
        <div
          ref={logRef}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            maxHeight: 118,
            overflowY: 'auto',
            marginBottom: 8,
            paddingRight: 2,
          }}
        >
          {log.length === 0 ? (
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-soft)', padding: '2px' }}>
              直接开口说话，或在下方打字。
            </div>
          ) : (
            log.map((m, i) => {
              const mine = m.role === 'user';
              return (
                <div
                  key={i}
                  style={{
                    alignSelf: mine ? 'flex-end' : 'flex-start',
                    maxWidth: '88%',
                    background: mine ? 'var(--sky)' : 'var(--cream-2)',
                    border: '2.5px solid var(--line)',
                    borderRadius: mine ? '13px 13px 3px 13px' : '13px 13px 13px 3px',
                    padding: '6px 9px',
                    boxShadow: 'var(--plush-tiny)',
                    fontSize: 12,
                    fontWeight: 600,
                    lineHeight: 1.35,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 800,
                      color: 'var(--ink-2)',
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      marginBottom: 1,
                    }}
                  >
                    {mine ? '你' : firstName}
                  </div>
                  {m.content}
                </div>
              );
            })
          )}
          {status === 'thinking' && (
            <div
              style={{
                alignSelf: 'flex-start',
                background: 'var(--cream-2)',
                border: '2.5px solid var(--line)',
                borderRadius: '14px 14px 14px 3px',
                padding: '7px 12px',
                fontSize: 12,
                fontWeight: 800,
                color: 'var(--ink-2)',
              }}
            >
              <span className="breathe" style={{ display: 'inline-block' }}>•••</span>
            </div>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: 'flex', gap: 6, alignItems: 'center' }}
      >
        {isCrc && (
          <button
            type="button"
            onClick={() => void toggleMic()}
            disabled={!connected || busy || transcribing || lookEngaged}
            title={
              lookEngaged
                ? '退出环视后可语音输入'
                : recording
                  ? '再点一次结束，识别结果会填入输入框'
                  : '点击开始说话，再点一次结束'
            }
            className={recording ? 'breathe' : undefined}
            style={{
              flex: '0 0 auto',
              width: 38,
              height: 38,
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '2.5px solid var(--line)',
              borderRadius: 11,
              background: recording
                ? 'var(--rose)'
                : transcribing
                  ? 'var(--butter)'
                  : 'var(--cream-2)',
              boxShadow: '0 2px 0 var(--line)',
              opacity: !connected || busy || transcribing || lookEngaged ? 0.5 : 1,
              cursor: !connected || busy || transcribing || lookEngaged ? 'not-allowed' : 'pointer',
            }}
          >
            <MicIcon filled={recording} />
          </button>
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            // Typing and pointer-look would fight over the keyboard.
            if (document.pointerLockElement) document.exitPointerLock();
          }}
          onBlur={() => setFocused(false)}
          disabled={!connected}
          title={connected ? '回车发送 · 按住空格可语音输入' : undefined}
          placeholder={
            !connected
              ? '语音连接中…'
              : status === 'listening'
                ? '正在聆听…也可打字'
                : '说点什么，回车发送'
          }
          style={{
            flex: 1,
            minWidth: 0,
            border: '2.5px solid var(--line)',
            borderRadius: 11,
            padding: '8px 10px',
            fontSize: 12.5,
            fontWeight: 700,
            fontFamily: 'inherit',
            color: 'var(--ink)',
            background: focused ? 'white' : 'var(--cream-2)',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!connected || busy || !draft.trim()}
          className="btn-plush primary"
          style={{
            padding: '8px 12px',
            fontSize: 12.5,
            fontWeight: 900,
            whiteSpace: 'nowrap',
            opacity: !connected || busy || !draft.trim() ? 0.5 : 1,
            cursor: !connected || busy || !draft.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? '发送中…' : busy ? '等待回复…' : '发送'}
        </button>
      </form>

      {(micError || transcribing) && (
        <div
          style={{
            marginTop: 6,
            padding: '5px 9px',
            background: micError ? 'var(--rose)' : 'var(--cream-2)',
            border: '2.5px solid var(--line)',
            borderRadius: 9,
            fontSize: 11,
            fontWeight: 800,
            color: 'var(--ink)',
          }}
        >
          {micError ? `⚠ ${micError}` : '识别中…'}
        </div>
      )}
    </div>
  );
}

function MicIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ink)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill={filled ? 'var(--ink)' : 'none'} />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18.5v3" />
    </svg>
  );
}
