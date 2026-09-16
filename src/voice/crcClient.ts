/** Thin client for CRC dialogue APIs (front/server.py on :8790, proxied as /api). */

import { playBase64Mp3, stopCrcAudio } from './audioPlayers';

export { playBase64Mp3, stopCrcAudio };

export interface CrcSessionPayload {
  session_id: string;
  study: string;
  patient_line: string;
  ended: boolean;
  end_reason?: string;
  action?: string;
  evaluation?: unknown;
  messages?: Array<{ role: string; content: string }>;
  crc_text?: string;
  audio_base64?: string;
  audio_format?: string;
  tts_error?: string;
  tts_emotion?: string;
  tts_emotion_scale?: number;
  detail?: unknown;
}

async function parseJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errMsg(data: any, status: number): string {
  const d = data?.detail ?? data?.message;
  if (typeof d === 'string') return d;
  if (d != null) return JSON.stringify(d);
  return `CRC API ${status}`;
}

export async function crcCreateSession(opts: {
  study: string;
  randomPersona?: boolean;
  focus?: string;
  openingLine?: string;
}): Promise<CrcSessionPayload> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      study: opts.study,
      random_persona: Boolean(opts.randomPersona),
      focus: opts.focus || undefined,
      opening_line: opts.openingLine || undefined,
    }),
  });
  const data = await parseJson(res);
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return data as CrcSessionPayload;
}

export async function crcReply(
  sessionId: string,
  message: string,
): Promise<CrcSessionPayload> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const data = await parseJson(res);
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return data as CrcSessionPayload;
}

/** Push-to-talk: upload WAV → CRC ASR + PatientTurn + TTS. */
export async function crcVoiceTurn(
  sessionId: string,
  audio: Blob,
  filename = 'speech.wav',
): Promise<CrcSessionPayload> {
  const form = new FormData();
  form.append('audio', audio, filename);
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/voice/turn`,
    { method: 'POST', body: form },
  );
  const data = await parseJson(res);
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return data as CrcSessionPayload;
}

export async function crcTts(
  text: string,
  opts?: {
    sessionId?: string | null;
    emotion?: string | null;
    emotionScale?: number | null;
  },
): Promise<{
  audio_base64: string;
  format: string;
  tts_emotion?: string;
  tts_emotion_scale?: number;
}> {
  const body: Record<string, unknown> = { text };
  if (opts?.sessionId) body.session_id = opts.sessionId;
  if (opts?.emotion) body.emotion = opts.emotion;
  if (opts?.emotionScale != null) body.emotion_scale = opts.emotionScale;
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseJson(res);
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return data as {
    audio_base64: string;
    format: string;
    tts_emotion?: string;
    tts_emotion_scale?: number;
  };
}

export async function crcListStudies(): Promise<Array<{ stem: string; ready: boolean }>> {
  const res = await fetch('/api/studies');
  const data = await parseJson(res);
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return (data?.studies ?? []) as Array<{ stem: string; ready: boolean }>;
}

/** Map medkit case ids → CRC study stems (opening/background artifacts). */
const CASE_TO_STUDY: Record<string, string> = {
  'ct-001': 'Phloroglucinol Orally Disintegrating Tablets',
};

export const DEFAULT_CRC_STUDY = 'Chronic rhinosinusitis with nasal polyps';

export function resolveCrcStudy(caseId: string): string {
  return CASE_TO_STUDY[caseId] || DEFAULT_CRC_STUDY;
}
