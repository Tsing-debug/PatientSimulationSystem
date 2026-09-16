import { Conversation, type ConversationListeners } from './conversation';
import { buildPersona, buildInitialLine, isPediatric, parentGenderFor } from './patientPersona';
import type { PatientCase } from '../game/types';
import { store as gameStore } from '../game/store';
import { resolveCrcStudy } from './crcClient';

let sharedCtx: AudioContext | null = null;

export function ensureAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (sharedCtx.state === 'suspended') {
    // Best-effort resume. Must be called from a user gesture for this to
    // succeed — callers in the Walk-view panel are wired that way.
    sharedCtx.resume().catch(() => undefined);
  }
  return sharedCtx;
}

/** Cached conversation, keyed by bedIndex. `caseId` is carried alongside so
 *  we can detect when a bed (or the polyclinic sentinel -10) receives a
 *  different patient — in that case the old conversation is disposed and a
 *  fresh one is built for the new persona. Without this, the polyclinic's
 *  single sentinel bedIndex caused new patients to inherit the previous
 *  patient's name, history, and voice. */
interface CachedConversation {
  conv: Conversation;
  caseId: string;
}

const cache = new Map<number, CachedConversation>();

/** Peek at an existing conversation without creating one. */
export function getExistingConversation(bedIndex: number): Conversation | null {
  return cache.get(bedIndex)?.conv ?? null;
}

export function getOrCreatePatientConversation(
  bedIndex: number,
  patientCase: PatientCase,
  listeners: ConversationListeners
): Conversation {
  const existing = cache.get(bedIndex);
  if (existing && existing.caseId === patientCase.id) {
    existing.conv.setListeners(listeners);
    return existing.conv;
  }
  if (existing) {
    // A different patient now occupies this slot — tear down the old
    // conversation so the new persona isn't poisoned by prior history.
    existing.conv.dispose();
    cache.delete(bedIndex);
  }
  // The polyclinic uses sentinel bedIndex -10; everything else is ER.
  const setting: 'polyclinic' | 'er' = bedIndex === -10 ? 'polyclinic' : 'er';
  const ctx = ensureAudioContext();
  // Speaker gender mirrors the rule in voiceForPatient (now retired):
  // pediatric → parent's gender, adult → patient's gender.
  const speakerGender: 'M' | 'F' = isPediatric(patientCase)
    ? parentGenderFor(patientCase)
    : patientCase.gender;
  const dialogueBackend = gameStore.getState().dialogueBackend ?? 'livekit';
  const conv = new Conversation(ctx, listeners, {
    systemPrompt: buildPersona(patientCase, setting),
    initialMessage: buildInitialLine(patientCase),
    voiceGender: speakerGender,
    caseId: patientCase.id,
    // Persist per-patient history so refreshing the page or walking away
    // and back doesn't wipe the conversation — the patient remembers you.
    // CRC sessions always mint a fresh server session in init(), so we still
    // namespace the key but wipe it on CRC init.
    storageKey: `conv_history_${patientCase.id}`,
    backend: dialogueBackend,
    crcStudy: resolveCrcStudy(patientCase.id),
  });
  cache.set(bedIndex, { conv, caseId: patientCase.id });
  return conv;
}

export function disposePatientConversation(bedIndex: number) {
  const entry = cache.get(bedIndex);
  if (entry) {
    entry.conv.dispose();
    cache.delete(bedIndex);
  }
}

/**
 * Start a genuinely fresh conversation for a patient. This is used when the
 * trainee explicitly chooses a case from the library: the old in-memory
 * conversation and its persisted transcript must not leak into the new
 * encounter's persona or opening line.
 */
export function resetPatientConversation(bedIndex: number, caseId?: string) {
  disposePatientConversation(bedIndex);
  if (typeof window === 'undefined' || !caseId) return;
  try {
    window.localStorage.removeItem(`conv_history_${caseId}`);
  } catch {
    // localStorage may be blocked — the in-memory conversation is still reset.
  }
}

export function clearAllPatientConversations() {
  for (const entry of cache.values()) entry.conv.dispose();
  cache.clear();
  if (sharedCtx) {
    try { sharedCtx.close(); } catch { /* noop */ }
    sharedCtx = null;
  }
}

/** Wipe ALL persisted patient chat history from localStorage so that on the
 *  next shift, every patient starts a fresh conversation (no "the doctor
 *  asked me this last shift" memory). Pairs with `clearAllPatientConversations`
 *  to fully reset the voice layer between shifts. */
export function clearAllConversationStorage() {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('conv_history_')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // localStorage may be blocked — non-fatal
  }
}
