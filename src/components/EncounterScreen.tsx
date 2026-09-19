import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { PerspectiveCamera } from 'three';
import {
  Polyclinic,
  POLYCLINIC_COLLIDERS,
  DOCTOR_CHAIR_POS,
  PATIENT_CHAIR_POS,
} from './three/Polyclinic';
import { Player } from './three/Player';
import { useActiveInteractable, interactionBus } from './three/interactions';
import {
  store,
  useGameState,
  POLYCLINIC_BED_INDEX,
} from '../game/store';
import {
  getExistingConversation,
  disposePatientConversation,
} from '../voice/conversationStore';
import { TopBar } from './primitives';
import { ExamineOverlay } from './ExamineOverlay';
import { DockedVoicePanel } from './DockedVoicePanel';
import { DoctorComposer } from './DoctorComposer';

/** Adaptive FOV: keeps the horizontal FOV near 82° regardless of viewport
 *  aspect, plus a hold-Z (or scroll wheel) "lean in" zoom. */
function AdaptiveCameraFov() {
  const { camera, size } = useThree();
  const zoomedRef = useRef(false);
  const baseFovRef = useRef(55);
  const targetFovRef = useRef(55);

  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const targetHFov = (82 * Math.PI) / 180;
    const vFovRad = 2 * Math.atan(Math.tan(targetHFov / 2) / aspect);
    const baseFovDeg = Math.max(42, Math.min(68, (vFovRad * 180) / Math.PI));
    baseFovRef.current = baseFovDeg;
    targetFovRef.current = zoomedRef.current ? baseFovDeg * 0.4 : baseFovDeg;
  }, [size.width, size.height]);

  const zoomLevelRef = useRef(0);
  const applyZoom = () => {
    const z = zoomLevelRef.current;
    const base = baseFovRef.current;
    const min = base * 0.4;
    targetFovRef.current = base + (min - base) * z;
  };
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!document.pointerLockElement) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      zoomLevelRef.current = Math.max(0, Math.min(1, zoomLevelRef.current + dir * 0.15));
      zoomedRef.current = zoomLevelRef.current > 0;
      applyZoom();
    };
    const isZoomKey = (e: KeyboardEvent) => e.key === 'z' || e.key === 'Z';
    const onDown = (e: KeyboardEvent) => {
      if (!isZoomKey(e) || !document.pointerLockElement) return;
      zoomLevelRef.current = 1;
      zoomedRef.current = true;
      applyZoom();
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isZoomKey(e)) return;
      zoomLevelRef.current = 0;
      zoomedRef.current = false;
      applyZoom();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  useFrame(() => {
    const cam = camera as PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    const target = targetFovRef.current;
    const diff = target - cam.fov;
    if (Math.abs(diff) < 0.05) {
      if (cam.fov !== target) {
        cam.fov = target;
        cam.updateProjectionMatrix();
      }
      return;
    }
    cam.fov += diff * 0.22;
    cam.updateProjectionMatrix();
  });

  return null;
}

function Loader() {
  return (
    <Html center>
      <div
        style={{
          fontFamily: 'Nunito, sans-serif',
          fontWeight: 800,
          color: 'var(--peach-deep)',
          background: 'white',
          padding: '8px 14px',
          border: '3px solid var(--line)',
          borderRadius: 'var(--r-pill)',
          boxShadow: 'var(--plush-tiny)',
          fontSize: 13,
          letterSpacing: '0.05em',
        }}
      >
        正在加载入组沟通诊室…
      </div>
    </Html>
  );
}

function Crosshair() {
  const active = useActiveInteractable();
  const hot = !!active;
  const size = hot ? 14 : 6;
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: hot ? 'transparent' : 'rgba(255,248,236,0.85)',
        border: hot ? '2.5px solid var(--peach-deep)' : 'none',
        boxShadow: hot
          ? '0 0 12px rgba(255,142,92,0.55), 0 0 0 1px rgba(43,30,22,0.3)'
          : '0 0 0 1px rgba(43,30,22,0.4)',
        pointerEvents: 'none',
        transition: 'width 0.12s, height 0.12s, margin 0.12s, border 0.12s, box-shadow 0.12s',
      }}
    />
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        background: 'var(--cream)',
        padding: '2px 8px',
        borderRadius: 6,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
        border: '2px solid var(--line)',
        boxShadow: '0 2px 0 var(--line)',
        margin: '0 2px',
        color: 'var(--ink)',
      }}
    >
      {children}
    </span>
  );
}

export function EncounterScreen() {
  const state = useGameState();
  const patient = state.polyclinic.patient;

  // Voice is on the moment the encounter mounts — the FloatingVoicePanel
  // calls `getOrCreatePatientConversation()` which kicks off LiveKit
  // connection + mic. We never gate behind a "Begin consultation" button.
  const [voiceActive, setVoiceActive] = useState(true);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [lookMode, setLookMode] = useState(false);
  const [examineOpen, setExamineOpen] = useState(false);

  // If the user navigated straight here without a patient set, drop the
  // current selectedCaseId in. Without this the scene shows an empty room.
  useEffect(() => {
    if (!patient) store.loadPolyclinicPatient(state.selectedCaseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release pointer lock on unmount (e.g. navigating away mid-session).
  useEffect(() => {
    return () => {
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, []);

  // Track pointer-lock state so the bottom hint can swap copy AND so we
  // can hard-cancel any lock that engages while Examine is open. The
  // examineOpen ref is read inside a stable listener (closing over the
  // value via a ref keeps the listener stable across re-renders).
  const examineOpenRef = useRef(false);
  examineOpenRef.current = examineOpen;
  useEffect(() => {
    const onChange = () => {
      const locked = !!document.pointerLockElement;
      setPointerLocked(locked);
      if (locked && examineOpenRef.current) {
        // Examine owns the screen — never let the 3D controls steal the
        // cursor. Release immediately.
        document.exitPointerLock();
      }
    };
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  // When Examine is opened, force-exit any active pointer lock so the
  // modal can't be undermined by a stray scene click.
  useEffect(() => {
    if (!examineOpen) return;
    if (document.pointerLockElement) document.exitPointerLock();
    setLookMode(false);
    interactionBus.setActive(null);
  }, [examineOpen]);

  // Entering look mode: mount PointerLockControls then request lock on canvas.
  // Leaving: release lock.
  useEffect(() => {
    if (examineOpen) return;
    if (!lookMode) {
      if (document.pointerLockElement) document.exitPointerLock();
      return;
    }
    const id = window.setTimeout(() => {
      const canvas = document.querySelector('canvas');
      if (canvas && !document.pointerLockElement) {
        canvas.requestPointerLock?.().catch?.(() => undefined);
      }
    }, 50);
    return () => window.clearTimeout(id);
  }, [lookMode, examineOpen]);

  // Esc while looking: exit look mode (browser also exits pointer lock).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!lookMode && !document.pointerLockElement) return;
      setLookMode(false);
      if (document.pointerLockElement) document.exitPointerLock();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lookMode]);

  // If the user hits Esc and the browser drops lock, leave look mode too.
  const wasLockedRef = useRef(false);
  useEffect(() => {
    if (pointerLocked) {
      wasLockedRef.current = true;
      return;
    }
    if (wasLockedRef.current && lookMode) {
      wasLockedRef.current = false;
      setLookMode(false);
    }
  }, [pointerLocked, lookMode]);

  // Global T — toggle voice off / on. Works whether or not pointer-lock
  // is engaged; mirrors the in-scene Player handler that requires lock.
  // T while voice is on disposes the conversation (mic + TTS go quiet).
  // T while voice is off re-enables it — the patient picks back up where
  // they left off because the conversationStore caches by bedIndex.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 't' && e.key !== 'T') return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (examineOpen) return;
      e.preventDefault();
      setVoiceActive((prev) => {
        const next = !prev;
        if (prev && !next) disposePatientConversation(POLYCLINIC_BED_INDEX);
        return next;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [examineOpen]);

  // Global E-to-examine — works whether or not pointer-lock is engaged.
  // The Player.tsx handler requires lock; this one fills the gap so the
  // keyboard shortcut works the same as the on-screen Examine button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'e' && e.key !== 'E') return;
      // Don't fire while typing into an input/textarea (defensive — there
      // aren't any today, but this guards against future text fields).
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (examineOpen) return;
      e.preventDefault();
      setExamineOpen(true);
      setLookMode(false);
      if (document.pointerLockElement) document.exitPointerLock();
      interactionBus.setActive(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [examineOpen]);

  // Dispose conversation when the patient changes / leaves.
  const currentPatientCaseId = patient?.case.id ?? null;
  useEffect(() => {
    return () => {
      disposePatientConversation(POLYCLINIC_BED_INDEX);
    };
  }, [currentPatientCaseId]);

  // Re-arm the voice panel automatically whenever a fresh patient is
  // loaded (e.g. after End consultation → Next patient flow).
  useEffect(() => {
    if (patient) setVoiceActive(true);
    else setVoiceActive(false);
  }, [currentPatientCaseId, patient]);

  // Look-around is OFF by default so UI buttons (按住说话 etc.) stay clickable.
  // Double-click the scene to enter/exit look mode.

  const openExamine = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    setLookMode(false);
    interactionBus.setActive(null);
    setExamineOpen(true);
  };

  const toggleLookMode = () => {
    if (examineOpen) return;
    setLookMode((prev) => {
      if (prev) {
        if (document.pointerLockElement) document.exitPointerLock();
        return false;
      }
      return true;
    });
  };

  const handleInteract = (kind: 'desk' | 'bed' | 'triage', bedIndex?: number) => {
    // E (examine) on the patient — open the cozy examine overlay so the
    // doctor can take a history, order tests, read results, and submit a
    // diagnosis. The voice agent keeps running underneath so the patient
    // can still answer questions verbally.
    if (kind === 'bed' && bedIndex === POLYCLINIC_BED_INDEX) {
      openExamine();
    }
  };

  const handleTalk = (bedIndex: number | null) => {
    if (bedIndex === POLYCLINIC_BED_INDEX) {
      setVoiceActive((prev) => {
        const next = !prev;
        if (prev && !next) disposePatientConversation(POLYCLINIC_BED_INDEX);
        return next;
      });
    } else if (bedIndex === null) {
      setVoiceActive((prev) => {
        if (prev) disposePatientConversation(POLYCLINIC_BED_INDEX);
        return false;
      });
    }
  };

  const endConsultation = async () => {
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (conv) {
      try {
        await conv.sayFarewell();
      } catch {
        /* network/voice failure — proceed anyway */
      }
    }
    if (document.pointerLockElement) document.exitPointerLock();
    interactionBus.setActive(null);
    store.finishPolyclinicCase();
    disposePatientConversation(POLYCLINIC_BED_INDEX);
    store.setScreen('endConfirm');
  };

  const SEATED_HEIGHT = 1.45;
  const playerSpawn = useMemo<[number, number, number]>(
    () => [DOCTOR_CHAIR_POS[0], SEATED_HEIGHT, DOCTOR_CHAIR_POS[2]],
    [],
  );
  const doctorLookAt = useMemo<[number, number, number]>(
    () => [PATIENT_CHAIR_POS[0], 1.3, PATIENT_CHAIR_POS[2]],
    [],
  );

  return (
    <div className="screen" style={{ background: 'var(--cream)', position: 'relative' }}>
      <TopBar here={4} steps={['试验项目', 'CTR20263575', '入组前沟通', '简报', '沟通进行中']} />

      <div
        style={{
          position: 'relative',
          height: 'calc(100vh - 67px)',
          overflow: 'hidden',
          // Hard-block any click bleeding into the 3D scene while the
          // examine modal owns the screen. PointerLockControls is gated
          // behind lookMode AND this — defence in depth.
          pointerEvents: examineOpen ? 'none' : undefined,
        }}
      >
        <Canvas
          shadows
          camera={{ position: playerSpawn, fov: 55 }}
          style={{ background: 'linear-gradient(#f0ebe1, #e3dac7)' }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            toggleLookMode();
          }}
        >
          <AdaptiveCameraFov />
          <Suspense fallback={<Loader />}>
            <Polyclinic
              voiceActive={voiceActive && !examineOpen}
              onCloseVoice={() => setVoiceActive(false)}
            />
            <Player
              spawn={playerSpawn}
              colliders={POLYCLINIC_COLLIDERS}
              onInteract={handleInteract}
              onTalk={handleTalk}
              height={SEATED_HEIGHT}
              locked
              lookAt={doctorLookAt}
              enableLook={lookMode && !examineOpen}
            />
          </Suspense>
        </Canvas>

        {pointerLocked && <Crosshair />}

        {/* Action buttons — bottom-left now; the bottom-right corner belongs
            to the doctor composer dock. */}
        <div
          style={{
            position: 'absolute',
            bottom: 18,
            left: 18,
            zIndex: 6,
            display: 'flex',
            gap: 10,
          }}
          data-no-look
        >
          <button
            type="button"
            className="btn-plush ghost"
            onClick={(e) => {
              e.stopPropagation();
              endConsultation();
            }}
            style={{ fontSize: 14, padding: '12px 18px' }}
          >
            结束沟通 →
          </button>
        </div>

        {/* Hint chip — non-blocking. Sits above the action button.
            Adapts to whether mouse-look is engaged. */}
        <div
          style={{
            position: 'absolute',
            bottom: 70,
            left: 18,
            zIndex: 6,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            background: 'white',
            border: '2.5px solid var(--line)',
            borderRadius: 'var(--r-pill)',
            padding: '6px 14px',
            boxShadow: 'var(--plush-tiny)',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--ink-2)',
            pointerEvents: 'none',
          }}
        >
          {lookMode || pointerLocked ? (
            <>
              环视中 · 移动鼠标转向 · <Kbd>双击</Kbd> 或 <Kbd>Esc</Kbd> 退出 · <Kbd>E</Kbd> 资料 · <Kbd>T</Kbd> 静音
            </>
          ) : (
            <>
              <span
                className={voiceActive ? 'dot breathe' : 'dot'}
                style={{ background: voiceActive ? 'var(--peach-deep)' : 'var(--ink-soft)' }}
              />
              {voiceActive ? '可点击按钮 / 按住说话' : '语音已静音'} · <Kbd>双击</Kbd> 进入环视 · <Kbd>E</Kbd> 资料 · <Kbd>T</Kbd> 静音
            </>
          )}
        </div>
      </div>

      {examineOpen && patient && (
        <>
          <DockedVoicePanel
            patientName={patient.case.name}
            patientLabel={`${patient.case.age}${patient.case.gender}`}
          />
          <ExamineOverlay
            onClose={() => setExamineOpen(false)}
            onDispatch={async () => {
              // 1. Close the modal so the patient's farewell bubble is
              //    visible while the audio plays.
              setExamineOpen(false);

              // 2. sayFarewell now polls until the agent's TTS actually
              //    finishes (RPC into voice worker → session.say → wait
              //    for status to leave 'speaking'). No extra padding here.
              const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
              if (conv) {
                try {
                  await conv.sayFarewell();
                } catch {
                  /* network/voice failure — keep going */
                }
              }

              // 3. Tear down THIS patient's conversation + clear the bed.
              if (document.pointerLockElement) document.exitPointerLock();
              interactionBus.setActive(null);
              store.finishPolyclinicCase();
              disposePatientConversation(POLYCLINIC_BED_INDEX);

              // 5. Auto-load the next patient from the active clinic.
              //    FloatingVoicePanel re-keys on patient.case.id and
              //    fires the new patient's greeting automatically.
              const nextId = store.pickNextCaseId();
              if (nextId) {
                store.acceptNextPatient(nextId);
              } else {
                store.setScreen('endConfirm');
              }
            }}
          />
        </>
      )}

      {/* First-person composer — the doctor's own speech surface. Hidden
          while the Examine overlay is open (its 对话 tab owns typing then). */}
      {!examineOpen && voiceActive && patient && (
        <DoctorComposer
          patientName={patient.case.name}
          lookEngaged={lookMode || pointerLocked}
        />
      )}
    </div>
  );
}
