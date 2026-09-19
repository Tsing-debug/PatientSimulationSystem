/**
 * Exactly two audio channels for the product:
 *   1. hospital BGM  — looping lobby / ambient
 *   2. patient TTS   — spoken patient lines (CRC Volc)
 *
 * Never spawn ad-hoc `new Audio()` for these roles elsewhere.
 */

const BGM_VOLUME = 0.18;
const BGM_DUCKED = 0.04;

let bgm: HTMLAudioElement | null = null;
let patient: HTMLAudioElement | null = null;
let patientGen = 0;
let bgmWanted = false; // user+screen want BGM playing
let patientSpeaking = false;

function ensureBgm(): HTMLAudioElement {
  if (!bgm) {
    bgm = new Audio('/medkit.mp3');
    bgm.loop = true;
    bgm.preload = 'auto';
    bgm.volume = BGM_VOLUME;
  }
  return bgm;
}

function applyBgmVolume() {
  if (!bgm) return;
  bgm.volume = patientSpeaking ? BGM_DUCKED : BGM_VOLUME;
}

/** Lobby / non-encounter: play or pause hospital loop. */
export function setHospitalBgmDesired(play: boolean) {
  bgmWanted = play;
  const a = ensureBgm();
  applyBgmVolume();
  if (play) {
    void a.play().catch(() => undefined);
  } else {
    a.pause();
  }
}

export function isHospitalBgmDesired(): boolean {
  return bgmWanted;
}

export function stopPatientAudio() {
  patientGen += 1;
  patientSpeaking = false;
  applyBgmVolume();
  if (!patient) {
    if (bgmWanted && bgm) void bgm.play().catch(() => undefined);
    return;
  }
  try {
    patient.pause();
    patient.removeAttribute('src');
    patient.load();
  } catch {
    /* noop */
  }
  patient = null;
  // Restore BGM if lobby wants it
  if (bgmWanted && bgm) {
    applyBgmVolume();
    void bgm.play().catch(() => undefined);
  }
}

/** Replace any current patient clip with this mp3 (base64). Ducks BGM while playing. */
export function playPatientBase64Mp3(b64: string): HTMLAudioElement | null {
  if (!b64) return null;
  stopPatientAudio();
  const gen = patientGen;
  const audio = new Audio(`data:audio/mpeg;base64,${b64}`);
  patient = audio;
  patientSpeaking = true;
  applyBgmVolume();
  // Keep BGM running ducked if it was on; if paused for encounter, leave paused.

  const clear = () => {
    if (gen !== patientGen) return;
    if (patient === audio) patient = null;
    patientSpeaking = false;
    applyBgmVolume();
    if (bgmWanted && bgm) void bgm.play().catch(() => undefined);
  };

  audio.onended = clear;
  audio.onerror = clear;
  void audio.play().catch(clear);
  return audio;
}

/** Back-compat aliases used by CRC client. */
export const stopCrcAudio = stopPatientAudio;
export const playBase64Mp3 = playPatientBase64Mp3;

// Vite replaces this module during development. Detached Audio elements keep
// playing unless explicitly stopped, leaving the new toggle unable to mute them.
const hot = (import.meta as ImportMeta & {
  hot?: { dispose: (callback: () => void) => void };
}).hot;
hot?.dispose(() => {
  bgmWanted = false;
  if (bgm) {
    bgm.pause();
    bgm.removeAttribute('src');
    bgm.load();
    bgm = null;
  }
  stopPatientAudio();
});
