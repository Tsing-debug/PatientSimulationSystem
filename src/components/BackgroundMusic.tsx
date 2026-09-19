import { useEffect, useRef, useState } from 'react';
import { useScreen } from '../game/store';
import { setHospitalBgmDesired } from '../voice/audioPlayers';

const MUTED_KEY = 'medkit:music-muted';

function readMuted(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(v: boolean) {
  try {
    window.localStorage.setItem(MUTED_KEY, v ? '1' : '0');
  } catch {
    /* private mode — non-fatal */
  }
}

export function BackgroundMusic() {
  const screen = useScreen();
  const [userMuted, setUserMuted] = useState<boolean>(readMuted);

  // Lobby = anywhere outside an active encounter.
  const inSession = screen === 'encounter';
  const shouldPlay = !userMuted && !inSession;

  // Drive the singleton hospital player (never create a second Audio here).
  useEffect(() => {
    setHospitalBgmDesired(shouldPlay);
  }, [shouldPlay]);

  // First user gesture unblocks autoplay.
  const shouldPlayRef = useRef(shouldPlay);
  useEffect(() => {
    shouldPlayRef.current = shouldPlay;
  }, [shouldPlay]);

  useEffect(() => {
    const onGesture = () => {
      if (shouldPlayRef.current) setHospitalBgmDesired(true);
    };
    window.addEventListener('pointerdown', onGesture);
    window.addEventListener('keydown', onGesture);
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, []);

  // On leave app / unmount — pause BGM desired
  useEffect(() => {
    return () => setHospitalBgmDesired(false);
  }, []);

  const toggle = () => {
    const next = !userMuted;
    // Start inside the trusted click, not a later React effect (autoplay).
    shouldPlayRef.current = !next && !inSession;
    setHospitalBgmDesired(shouldPlayRef.current);
    setUserMuted(next);
    writeMuted(next);
  };

  if (screen === 'splash') return null;

  const off = userMuted || inSession;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={inSession}
      aria-pressed={!off}
      title={
        userMuted
          ? '音乐已静音 — 点击开启'
          : inSession
            ? '问诊进行中，医院背景乐已暂停'
            : '医院背景乐播放中 — 点击静音'
      }
      aria-label={inSession ? '问诊中背景音乐已暂停' : userMuted ? '开启音乐' : '静音音乐'}
      style={{
        position: 'fixed',
        top: 18,
        right: 156,
        zIndex: 1000,
        width: 36,
        height: 36,
        borderRadius: '50%',
        border: '3px solid var(--line)',
        background: off ? 'var(--cream)' : 'var(--butter)',
        boxShadow: '0 2px 0 var(--line)',
        cursor: 'pointer',
        fontSize: 16,
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        opacity: inSession && !userMuted ? 0.8 : 1,
      }}
    >
      <span aria-hidden style={{ lineHeight: 1 }}>{off ? '🔇' : '🎵'}</span>
    </button>
  );
}
