/**
 * 前端认证层：登录状态持久化 + 带令牌的 API 请求。
 *
 * 令牌保存在 localStorage（键 crc.authToken / crc.authUser），
 * 所有 /api/* 请求经 apiFetch 自动附带 Authorization: Bearer。
 */

export type Role = 'admin' | 'staff' | 'student' | 'guest';

export interface AuthUser {
  username: string;
  display_name: string;
  role: Role;
  created_at?: string;
  disabled?: boolean;
}

const TOKEN_KEY = 'crc.authToken';
const USER_KEY = 'crc.authUser';

export function getStoredToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (!parsed || typeof parsed.username !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistAuth(token: string, user: AuthUser): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* private mode etc. — non-fatal */
  }
}

export function clearAuth(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

/** 统一 /api 请求：自动附加令牌、解析 JSON、抛出带中文信息的错误。 */
export async function apiFetch<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event('auth-expired'));
    }
    const detail = data?.detail ?? data?.message;
    const msg =
      typeof detail === 'string' ? detail : detail != null ? JSON.stringify(detail) : `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export interface SkillProfile {
  dimension_scores: Record<string, number>;
  weaknesses: Array<{ dimension: string; score: number }>;
  strengths: Array<{ dimension: string; score: number }>;
  total_sessions: number;
  avg_score: number | null;
  pass_rate: number | null;
  study: string | null;
  label: string;
  reason: string;
  training_goal: string;
  is_repeat: boolean;
}

export interface TrainingRecord {
  id: string;
  username: string;
  study: string;
  session_id: string;
  overall_score: number | null;
  passed: boolean;
  summary: string;
  dimensions: Array<{ category: string; dimension: string; score: number; passed: boolean; evidence?: string; suggestion?: string }>;
  strengths: string[];
  improvements: string[];
  training_focus: string;
  created_at: string;
}

export async function authLogin(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function authRegister(
  username: string,
  password: string,
  displayName?: string,
): Promise<{ token: string; user: AuthUser }> {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, display_name: displayName || undefined }),
  });
}

export async function authLogout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* token may already be invalid — local clear still applies */
  }
  clearAuth();
}

export async function fetchProfile(): Promise<SkillProfile> {
  return apiFetch('/api/training/profile');
}

export async function fetchMyRecords(): Promise<TrainingRecord[]> {
  const data = await apiFetch<{ records: TrainingRecord[] }>('/api/training/records');
  return data?.records ?? [];
}

export async function submitTrainingRecord(
  body: Partial<TrainingRecord>,
): Promise<{ record: TrainingRecord; profile: SkillProfile }> {
  return apiFetch('/api/training/records', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
