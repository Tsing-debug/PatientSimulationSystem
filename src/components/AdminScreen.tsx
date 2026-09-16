import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from './primitives';
import { store, useGameState } from '../game/store';
import { apiFetch, type AuthUser } from '../game/auth';

type Tab = 'users' | 'stats' | 'studies';

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  staff: '工作人员',
  student: '学生',
};

const SUPPORTED_UPLOAD_EXTENSIONS = ['.json', '.doc', '.docx', '.pdf', '.html', '.htm', '.md', '.markdown', '.txt'];

interface AdminStats {
  total_users: number;
  by_role: Record<string, number>;
  total_records: number;
  avg_score: number | null;
  pass_rate: number | null;
  by_study: Record<string, number>;
}

interface StudyItem {
  stem: string;
  label: string;
  description?: string;
  difficulty?: number;
  focus_dimensions?: string[];
  tags?: string[];
}

interface UserRow extends AuthUser {
  disabled: boolean;
  created_at: string;
}

/** 上传 → 抽取后的审阅草稿（import 接口返回）。 */
interface ImportReview {
  draft_id: string;
  filename: string;
  method: 'llm' | 'json';
  warnings: string[];
  cde: Record<string, unknown>;
}

export function AdminScreen() {
  const { authUser, tweaks } = useGameState();
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [catalog, setCatalog] = useState<StudyItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // —— 上传 CDE 临床试验 → 新增疾病类型（审阅登记）——
  const [review, setReview] = useState<ImportReview | null>(null);
  const [saving, setSaving] = useState(false);
  const [stemText, setStemText] = useState('');
  const [labelText, setLabelText] = useState('');
  const [descText, setDescText] = useState('');
  const [diffVal, setDiffVal] = useState(1);
  const [dimsText, setDimsText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [generateAssets, setGenerateAssets] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadUsers = useCallback(async () => {
    try {
      const data = await apiFetch<{ users: UserRow[] }>('/api/admin/users');
      setUsers(data?.users ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const data = await apiFetch<AdminStats>('/api/admin/stats');
      setStats(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadStudies = useCallback(async () => {
    try {
      const data = await apiFetch<{ catalog: StudyItem[] }>('/api/admin/studies');
      setCatalog(data?.catalog ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (tab === 'users') loadUsers();
    else if (tab === 'stats') loadStats();
    else loadStudies();
  }, [tab, loadUsers, loadStats, loadStudies]);

  // —— 上传 CDE 临床试验 → 新增疾病类型 ——
  const splitList = (text: string): string[] =>
    text
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleImportFile = async (file: File): Promise<void> => {
    setError('');
    setNotice('');
    const dot = file.name.lastIndexOf('.');
    const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(extension)) {
      setError(`不支持 ${extension || '无扩展名'} 文件。请上传 DOC、DOCX、PDF、HTML、JSON、Markdown 或 TXT。`);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setError('文件过大，单个文件不能超过 25 MB。');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await apiFetch<
        ImportReview & {
          stem?: string;
          label?: string;
          description?: string;
          difficulty?: number;
          focus_dimensions?: string[];
          tags?: string[];
        }
      >('/api/admin/studies/import', { method: 'POST', body: fd });
      setReview({
        draft_id: data.draft_id,
        filename: data.filename,
        method: data.method === 'json' ? 'json' : 'llm',
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        cde: (data.cde as Record<string, unknown>) ?? {},
      });
      setStemText(data.stem ?? '');
      setLabelText(data.label ?? '');
      setDescText(data.description ?? '');
      setDiffVal(typeof data.difficulty === 'number' ? data.difficulty : 1);
      setDimsText((data.focus_dimensions ?? []).join('、'));
      setTagsText((data.tags ?? []).join('、'));
      setJsonText(JSON.stringify(data.cde ?? {}, null, 2));
      setNotice(`✅ ${file.name} 解析完成，请在弹窗中审阅并确认登记。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const confirmRegister = async (): Promise<void> => {
    if (!review) return;
    setError('');
    let cde: Record<string, unknown>;
    try {
      cde = JSON.parse(jsonText) as Record<string, unknown>;
      if (!cde || typeof cde !== 'object' || Array.isArray(cde)) throw new Error('需为 JSON 对象');
    } catch (err) {
      setError(`CDE JSON 格式有误：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setSaving(true);
    try {
      const data = await apiFetch<{
        ok?: boolean;
        study?: StudyItem;
        generating?: boolean;
        hint?: string;
      }>('/api/admin/studies', {
        method: 'POST',
        body: JSON.stringify({
          draft_id: review.draft_id,
          stem: stemText.trim(),
          label: labelText.trim(),
          description: descText.trim(),
          difficulty: diffVal,
          focus_dimensions: splitList(dimsText),
          tags: splitList(tagsText),
          cde,
          generate_assets: generateAssets,
        }),
      });
      const label = data.study?.label || labelText.trim() || stemText.trim();
      setNotice(
        `✅ 已新增疾病类型「${label}」。` +
          (data.generating
            ? '训练资产（研究背景 / 顾虑池 / 开场状态）正在后台生成，约 1~2 分钟，稍后刷新目录即可供训练。'
            : ''),
      );
      setReview(null);
      await loadStudies();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 非管理员进入时提示无权访问
  if (authUser?.role !== 'admin') {
    return (
      <div className="screen" style={{ background: 'var(--cream)' }}>
        <TopBar here={0} steps={['主页', '管理后台']} />
        <div style={{ padding: 48, maxWidth: 640, margin: '0 auto' }}>
          <div className="plush-lg" style={{ padding: 24 }}>
            <div style={{ fontWeight: 900, fontSize: 20 }}>无权访问管理后台</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)', marginTop: 6 }}>
              仅管理员可以管理用户与病例。当前角色：{ROLE_LABEL[authUser?.role ?? ''] ?? authUser?.role}
            </div>
            <button
              type="button"
              className="btn-plush ghost"
              style={{ fontSize: 13, padding: '9px 14px', marginTop: 14 }}
              onClick={() => store.setScreen('home')}
            >
              ← 返回主页
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen" style={{ background: 'var(--cream)' }}>
      <TopBar here={0} steps={['主页', '管理后台']} />
      <div style={{ padding: '28px 36px', maxWidth: 980, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
          <h1 style={{ fontSize: 32 }}>管理后台</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <label className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              初始化难度 / Initial difficulty
              <select
                value={tweaks.intensity}
                onChange={(event) => store.setIntensity(Number(event.target.value))}
                style={{ border: '2px solid var(--line)', borderRadius: 8, padding: '3px 6px', fontWeight: 800 }}
              >
                <option value={1}>1 · 简单 / Easy</option>
                <option value={2}>2 · 标准 / Standard</option>
                <option value={3}>3 · 困难 / Hard</option>
              </select>
            </label>
            <button
              type="button"
              className="btn-plush primary"
              style={{ fontSize: 13, padding: '9px 14px' }}
              onClick={() => {
                store.resetAllPatients();
                setNotice('✅ 已初始化全部患者：清空旧对话、人设和首句；病例目录已保留 5 位患者。');
              }}
            >
              ↻ 一键初始化全部患者
            </button>
            <button
              type="button"
              className="btn-plush ghost"
              style={{ fontSize: 13, padding: '9px 14px' }}
              onClick={() => store.setScreen('home')}
            >
              ← 返回主页
            </button>
          </div>
        </div>

        {/* 页签 */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            background: 'var(--cream-2)',
            border: '3px solid var(--line)',
            borderRadius: 999,
            padding: 5,
            marginBottom: 20,
            width: 'fit-content',
          }}
        >
          {(
            [
              ['users', '用户管理'],
              ['stats', '训练统计'],
              ['studies', '病例目录'],
            ] as Array<[Tab, string]>
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              className={tab === t ? 'btn-plush primary' : ''}
              style={{
                fontSize: 14,
                padding: '9px 18px',
                borderRadius: 999,
                background: tab === t ? undefined : 'transparent',
                boxShadow: tab === t ? undefined : 'none',
              }}
              onClick={() => {
                setTab(t);
                setError('');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: '#B3261E',
              background: '#FFEDEA',
              border: '2px solid #F2B8B5',
              borderRadius: 10,
              padding: '8px 12px',
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}

        {tab === 'users' && (
          <div className="plush-lg" style={{ padding: 20 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 800 }}>用户列表（{users.length}）</div>
              <button
                type="button"
                className="btn-plush ghost"
                style={{ fontSize: 12, padding: '7px 12px' }}
                onClick={() => {
                  setBusy(true);
                  loadUsers().finally(() => setBusy(false));
                }}
              >
                {busy ? '刷新中…' : '刷新'}
              </button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--ink-2)', fontSize: 12 }}>
                  <th style={{ padding: '6px 8px' }}>用户名</th>
                  <th style={{ padding: '6px 8px' }}>昵称</th>
                  <th style={{ padding: '6px 8px' }}>角色</th>
                  <th style={{ padding: '6px 8px' }}>注册时间</th>
                  <th style={{ padding: '6px 8px' }}>状态</th>
                  <th style={{ padding: '6px 8px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username} style={{ borderTop: '2px solid var(--cream-2)' }}>
                    <td style={{ padding: '8px', fontWeight: 800 }}>{u.username}</td>
                    <td style={{ padding: '8px' }}>{u.display_name}</td>
                    <td style={{ padding: '8px' }}>
                      <select
                        value={u.role}
                        disabled={u.username === 'admin' || u.username === authUser?.username}
                        style={{
                          font: 'inherit',
                          fontWeight: 700,
                          border: '2.5px solid var(--line)',
                          borderRadius: 8,
                          padding: '4px 8px',
                          background: 'white',
                        }}
                        onChange={async (e) => {
                          try {
                            await apiFetch(`/api/admin/users/${encodeURIComponent(u.username)}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ role: e.target.value }),
                            });
                            await loadUsers();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err));
                          }
                        }}
                      >
                        {Object.entries(ROLE_LABEL).map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: '8px', color: 'var(--ink-2)' }}>{u.created_at?.slice(0, 10)}</td>
                    <td style={{ padding: '8px' }}>
                      <span className="chip" style={{ background: u.disabled ? 'var(--cream-2)' : 'var(--mint)' }}>
                        {u.disabled ? '已停用' : '正常'}
                      </span>
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                      {u.username !== 'admin' && u.username !== authUser?.username && (
                        <>
                          <button
                            type="button"
                            className="btn-plush ghost"
                            style={{ fontSize: 11, padding: '5px 9px', marginRight: 6 }}
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/users/${encodeURIComponent(u.username)}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ disabled: !u.disabled }),
                                });
                                await loadUsers();
                              } catch (err) {
                                setError(err instanceof Error ? err.message : String(err));
                              }
                            }}
                          >
                            {u.disabled ? '启用' : '停用'}
                          </button>
                          <button
                            type="button"
                            className="btn-plush ghost"
                            style={{ fontSize: 11, padding: '5px 9px', color: '#B3261E' }}
                            onClick={async () => {
                              if (!window.confirm(`确定删除用户「${u.username}」？该操作不可恢复。`)) return;
                              try {
                                await apiFetch(`/api/admin/users/${encodeURIComponent(u.username)}`, {
                                  method: 'DELETE',
                                });
                                await loadUsers();
                              } catch (err) {
                                setError(err instanceof Error ? err.message : String(err));
                              }
                            }}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginTop: 12 }}>
              提示：新注册用户默认角色为「学生」，可在上表调整为「工作人员」或「管理员」。
            </div>
          </div>
        )}

        {tab === 'stats' && (
          <div className="plush-lg" style={{ padding: 20 }}>
            {!stats ? (
              <div style={{ fontWeight: 800 }}>暂无统计数据</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
                  <div className="plush" style={{ padding: 14 }}>
                    <div style={{ fontWeight: 900, fontSize: 28 }}>{stats.total_users}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>注册用户</div>
                  </div>
                  <div className="plush" style={{ padding: 14 }}>
                    <div style={{ fontWeight: 900, fontSize: 28 }}>{stats.total_records}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>训练次数</div>
                  </div>
                  <div className="plush" style={{ padding: 14 }}>
                    <div style={{ fontWeight: 900, fontSize: 28 }}>{stats.avg_score ?? '—'}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>平均分</div>
                  </div>
                  <div className="plush" style={{ padding: 14 }}>
                    <div style={{ fontWeight: 900, fontSize: 28 }}>{stats.pass_rate ?? '—'}%</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>通过率</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>角色分布</div>
                    {Object.entries(stats.by_role ?? {}).map(([role, count]) => (
                      <div key={role} style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                        {ROLE_LABEL[role] ?? role}：{count}
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>病例训练分布</div>
                    {Object.entries(stats.by_study ?? {}).length === 0 ? (
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>暂无</div>
                    ) : (
                      Object.entries(stats.by_study).map(([study, count]) => (
                        <div key={study} style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                          {study}：{count} 次
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'studies' && (
          <div className="plush-lg" style={{ padding: 20 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 800 }}>病例目录（{catalog.length}）</div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.doc,.docx,.pdf,.html,.htm,.md,.markdown,.txt"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImportFile(f);
                }}
              />
            </div>
            <div
              role="button"
              tabIndex={0}
              aria-disabled={busy || !!review}
              onClick={() => {
                if (!busy && !review) fileInputRef.current?.click();
              }}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && !busy && !review) {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!busy && !review) setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = busy || review ? 'none' : 'copy';
                if (!busy && !review) setDragActive(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                if (busy || review) return;
                const file = event.dataTransfer.files?.[0];
                if (file) void handleImportFile(file);
              }}
              style={{
                border: `2px dashed ${dragActive ? 'var(--teal)' : 'rgba(30, 52, 58, 0.24)'}`,
                borderRadius: 16,
                padding: '22px 18px',
                marginBottom: 14,
                textAlign: 'center',
                cursor: busy || review ? 'not-allowed' : 'pointer',
                background: dragActive ? 'rgba(40, 138, 132, 0.10)' : 'rgba(255, 255, 255, 0.52)',
                opacity: busy || review ? 0.58 : 1,
                transition: 'border-color 150ms ease, background 150ms ease, opacity 150ms ease',
              }}
            >
              <div style={{ fontSize: 26, marginBottom: 5 }}>📤</div>
              <div style={{ fontWeight: 900, fontSize: 15 }}>
                {busy ? '正在解析文件…' : dragActive ? '松开即可上传' : '拖拽临床试验文件到这里，或点击选择'}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginTop: 6 }}>
                支持 DOC、DOCX、PDF、HTML、JSON、Markdown、TXT，最大 25 MB
              </div>
            </div>
            {notice && (
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: '#14532D',
                  background: '#ECFDF5',
                  border: '2px solid #A7F3D0',
                  borderRadius: 10,
                  padding: '8px 12px',
                  marginBottom: 12,
                }}
              >
                {notice}
              </div>
            )}
            {catalog.length === 0 ? (
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>
                暂无病例目录。点击右上角「上传 CDE 临床试验」即可新增一种疾病类型的训练病例。
              </div>
            ) : (
              catalog.map((s) => (
                <div key={s.stem} className="plush" style={{ padding: 14, marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{s.label}</div>
                    {s.difficulty != null && (
                      <span className="chip butter">难度 {s.difficulty}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginTop: 4 }}>
                    {s.stem}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginTop: 4 }}>
                      {s.description}
                    </div>
                  )}
                  {(s.focus_dimensions ?? []).length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--ink-2)' }}>训练维度：</span>
                      {(s.focus_dimensions ?? []).map((d) => (
                        <span key={d} className="chip mint">{d}</span>
                      ))}
                    </div>
                  )}
                  {(s.tags ?? []).length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 7 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--ink-2)' }}>场景标签：</span>
                      {(s.tags ?? []).map((t) => (
                        <span key={t} className="chip">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            <div
              className="plush"
              style={{
                padding: 14,
                marginTop: 12,
                background: 'var(--cream-2)',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--ink-2)',
              }}
            >
              📤 支持 docx / pdf / html / md / txt / json：结构化 JSON 直接登记，其余格式由 LLM 抽取成
              CDE 登记结构；确认后写入病例目录，可同时后台生成训练资产（研究背景 / 顾虑池 / 开场状态）。
              每个 CDE 临床试验对应一种适应症（疾病类型）的训练病例。
            </div>
          </div>
        )}

        {/* —— 上传审阅 / 确认登记弹窗 —— */}
        {review && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="study-review-title"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(43, 30, 22, 0.45)',
              zIndex: 50,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              padding: '36px 16px',
              overflowY: 'auto',
            }}
            onClick={() => {
              if (!saving) setReview(null);
            }}
          >
            <div
              className="plush-lg"
              style={{ width: 'min(780px, 100%)', padding: 22 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div id="study-review-title" style={{ fontWeight: 900, fontSize: 20, marginBottom: 4 }}>
                审阅登记 · 新增疾病类型
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 12 }}>
                文件：{review.filename} · 来源：
                {review.method === 'llm'
                  ? 'LLM 抽取（请核对关键字段与入排标准）'
                  : '结构化 JSON（可直接登记）'}
              </div>

              {(review.warnings ?? []).length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {(review.warnings ?? []).map((w) => (
                    <div
                      key={w}
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#92400E',
                        background: '#FFFBEB',
                        border: '2px solid #FDE68A',
                        borderRadius: 8,
                        padding: '6px 10px',
                        marginBottom: 6,
                      }}
                    >
                      ⚠️ {w}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 800, display: 'block' }}>
                  病例键名 stem（英文短键，作存盘文件名）
                  <input
                    value={stemText}
                    onChange={(e) => setStemText(e.target.value)}
                    style={inputStyle}
                    placeholder="e.g. Hypertension (phase III)"
                  />
                </label>
                <label style={{ fontSize: 12, fontWeight: 800, display: 'block' }}>
                  展示名称（疾病（期别））
                  <input
                    value={labelText}
                    onChange={(e) => setLabelText(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </div>
              <label style={{ fontSize: 12, fontWeight: 800, display: 'block', marginBottom: 12 }}>
                病例简介（适合练什么）
                <textarea
                  value={descText}
                  onChange={(e) => setDescText(e.target.value)}
                  rows={2}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  marginBottom: 12,
                  flexWrap: 'wrap',
                }}
              >
                <label style={{ fontSize: 12, fontWeight: 800 }}>
                  难度
                  <select
                    value={diffVal}
                    onChange={(e) => setDiffVal(Number(e.target.value) || 1)}
                    style={{ ...inputStyle, width: 84, marginLeft: 6 }}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={generateAssets}
                    onChange={(e) => setGenerateAssets(e.target.checked)}
                  />
                  登记后后台生成训练资产（研究背景 / 顾虑池 / 开场状态）
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 800, display: 'block' }}>
                  训练维度（、分隔）
                  <input
                    value={dimsText}
                    onChange={(e) => setDimsText(e.target.value)}
                    style={inputStyle}
                    placeholder="信息传递、知情同意、耐心程度"
                  />
                </label>
                <label style={{ fontSize: 12, fontWeight: 800, display: 'block' }}>
                  标签（、分隔）
                  <input
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    style={inputStyle}
                    placeholder="首次入组、安慰剂"
                  />
                </label>
              </div>
              <details style={{ marginBottom: 16 }}>
                <summary
                  style={{ fontSize: 12, fontWeight: 800, cursor: 'pointer', color: 'var(--ink-2)' }}
                >
                  CDE 结构化 JSON（抽取结果，可展开编辑）
                </summary>
                <textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  rows={12}
                  spellCheck={false}
                  style={{
                    ...inputStyle,
                    fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
                    fontSize: 12,
                    marginTop: 8,
                  }}
                />
              </details>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-plush ghost"
                  style={{ fontSize: 13, padding: '10px 16px' }}
                  disabled={saving}
                  onClick={() => setReview(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn-plush primary"
                  style={{ fontSize: 13, padding: '10px 18px' }}
                  disabled={saving || !stemText.trim()}
                  onClick={() => void confirmRegister()}
                >
                  {saving ? '登记中…' : '✔ 确认登记'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 4,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  border: '2.5px solid var(--line)',
  borderRadius: 8,
  padding: '6px 10px',
  background: 'white',
  color: 'var(--ink)',
};
