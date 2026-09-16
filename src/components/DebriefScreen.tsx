import { useEffect, useMemo, useRef, useState } from 'react';
import { Doodle, TopBar } from './primitives';
import { store, useGameState } from '../game/store';
import { getPatientCase } from '../data/cases';
import { TESTS } from '../data/tests';
import { TREATMENTS } from '../data/treatments';
import { getRecommendation } from '../data/guidelines';
import { useAttendingDebrief } from '../agents/useAttendingDebrief';
import { buildDebriefRequest, summariseRequest } from '../agents/debriefRequest';
import { saveEvalHistory, getEvalHistory, type EvalHistoryEntry } from '../data/evalHistory';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../data/polyclinicPatients';
import type {
  CaseEvaluationInput,
  CriterionResult,
  DomainScore,
  VerdictBand,
} from '../agents/customTools';
import type { ActivePatient, PatientCase } from '../game/types';

// ── verdict / colour mapping ───────────────────────────────────────

const GLOBAL_HEADLINE: Record<VerdictBand, string> = {
  excellent: '优秀 — 顶尖表现',
  good: '良好 — 稳健表现',
  satisfactory: '合格 — 表现不错',
  borderline: '勉强合格 — 值得重练',
  'clear-fail': '明显不合格 — 重新来过',
};

const GLOBAL_BG: Record<VerdictBand, string> = {
  excellent: 'var(--mint)',
  good: 'var(--mint)',
  satisfactory: 'var(--butter)',
  borderline: 'var(--peach)',
  'clear-fail': 'var(--rose)',
};

const GLOBAL_DEEP: Record<VerdictBand, string> = {
  excellent: 'var(--mint-deep)',
  good: 'var(--mint-deep)',
  satisfactory: 'var(--butter-deep)',
  borderline: 'var(--peach-deep)',
  'clear-fail': 'var(--rose-deep)',
};

const RING_COLOR: Record<VerdictBand, string> = {
  excellent: 'var(--mint-deep)',
  good: 'var(--mint-deep)',
  satisfactory: 'var(--butter-deep)',
  borderline: 'var(--peach-deep)',
  'clear-fail': 'var(--rose-deep)',
};

// ── DomainRing — adapted to take real data + verdict ──────────────

interface DomainRingProps {
  label: string;
  score: DomainScore;
}

function DomainRing({ label, score }: DomainRingProps) {
  const pct = score.max > 0 ? score.raw / score.max : 0;
  const r = 32;
  const c = 2 * Math.PI * r;
  const color = RING_COLOR[score.verdict];
  const qualitative =
    score.verdict === 'excellent' || score.verdict === 'good' ? '达标' :
    score.verdict === 'satisfactory' ? '尚可' :
    '需加强';
  return (
    <div
      style={{
        background: 'white',
        border: '3px solid var(--line)',
        borderRadius: 16,
        padding: 14,
        boxShadow: 'var(--plush-tiny)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--cream)" strokeWidth="10" />
        <circle
          cx="42"
          cy="42"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform="rotate(-90 42 42)"
        />
        <text
          x="42"
          y="48"
          textAnchor="middle"
          fontFamily="Nunito"
          fontWeight="900"
          fontSize="16"
          fill="var(--ink)"
        >
          {formatScore(score.raw)}/{score.max}
        </text>
      </svg>
      <div>
        <div style={{ fontWeight: 900, fontSize: 14, lineHeight: 1.1 }}>{label}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', marginTop: 2 }}>
          {qualitative}
        </div>
      </div>
    </div>
  );
}

function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── Criterion — adapted to take CriterionResult + resolved cite ────

interface Cite {
  title: string;
  rec: string;
  loE: string;
  url?: string;
}

interface CriterionProps {
  status: CriterionResult['verdict'];
  text: string;
  evidence: string;
  cite?: Cite;
}

const CRITERION_STYLES: Record<
  CriterionProps['status'],
  { icon: string; color: string; label: string; iconColor: string }
> = {
  met: { icon: '\u2713', color: 'var(--mint)', label: '达标', iconColor: 'var(--mint-deep)' },
  'partially-met': { icon: '~', color: 'var(--butter)', label: '部分', iconColor: 'var(--butter-deep)' },
  missed: { icon: '\u00D7', color: 'var(--rose)', label: '未达成', iconColor: 'var(--rose-deep)' },
};

function Criterion({ status, text, evidence, cite }: CriterionProps) {
  const styles = CRITERION_STYLES[status];
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: 12,
        background: '#FFFCF3',
        border: '2.5px solid var(--line)',
        borderRadius: 14,
        boxShadow: '0 2px 0 var(--line)',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: styles.color,
          border: '2.5px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 900,
          fontSize: 20,
          color: styles.iconColor,
          flexShrink: 0,
        }}
      >
        {styles.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 900,
              padding: '2px 8px',
              borderRadius: 6,
              background: styles.color,
              border: '2px solid var(--line)',
            }}
          >
            {styles.label}
          </span>
          <span style={{ fontWeight: 800, fontSize: 14 }}>{text}</span>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', fontStyle: 'italic' }}>
          {evidence}
        </div>
        {cite && (
          <div
            style={{
              marginTop: 8,
              background: 'var(--cream-2)',
              border: '2.5px dashed var(--line)',
              borderRadius: 10,
              padding: '8px 10px',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--ink)' }}>
              {'\uD83D\uDCD6 '}{cite.title}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{cite.rec}</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--mint-deep)', marginTop: 4 }}>
              {cite.loE}
              {cite.url && (
                <>
                  {' \u00B7 '}
                  <a href={cite.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink-2)' }}>
                    打开
                  </a>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildCite(guidelineRef: string | null | undefined): Cite | undefined {
  if (!guidelineRef) return undefined;
  const r = getRecommendation(guidelineRef);
  if (!r) return undefined;
  const tags: string[] = [];
  if (r.rec.recClass) tags.push(`Class ${r.rec.recClass}`);
  if (r.rec.lev) tags.push(`LoE ${r.rec.lev}`);
  if (r.rec.gradeStrength) {
    tags.push(
      r.rec.gradeCertainty
        ? `${r.rec.gradeStrength} \u00B7 ${r.rec.gradeCertainty}`
        : r.rec.gradeStrength,
    );
  }
  return {
    title: `${r.guideline.body} ${r.guideline.year} \u00B7 ${r.guideline.title.split(/[\u2014:(]/)[0].trim()}`,
    rec: r.rec.text,
    loE: tags.length > 0 ? tags.join(' \u00B7 ') : `${r.guideline.body} ${r.guideline.year}`,
    url: r.guideline.url,
  };
}

// ── Action chips — derived from the encounter ─────────────────────

function ActionChips({ patient, c }: { patient: ActivePatient; c: PatientCase }) {
  const testById = new Map(TESTS.map((t) => [t.id, t]));
  const treatmentById = new Map(TREATMENTS.map((t) => [t.id, t]));
  const chips: Array<{ key: string; label: string; tone: 'butter' | 'peach' | 'mint' | 'sky' | 'plain' }> = [];
  for (const tid of patient.orderedTestIds) {
    const name = testById.get(tid)?.name ?? tid;
    chips.push({ key: `test-${tid}`, label: `\uD83E\uDDEA ${name}`, tone: 'butter' });
  }
  for (const tid of patient.givenTreatmentIds) {
    const name = treatmentById.get(tid)?.name ?? tid;
    const tone = c.criticalTreatmentIds.includes(tid) ? 'mint' : 'peach';
    const icon = treatmentById.get(tid)?.category === 'medication' ? '\uD83D\uDC8A' :
      treatmentById.get(tid)?.category === 'disposition' ? '\u2197' : '\uD83E\uDE7A';
    chips.push({ key: `tx-${tid}`, label: `${icon} ${name}`, tone });
  }
  for (const p of patient.prescriptions ?? []) {
    chips.push({
      key: `rx-${p.medicationId}`,
      label: `\uD83D\uDC8A ${p.medicationId} ${p.dose} ${p.duration}`,
      tone: 'peach',
    });
  }
  if (chips.length === 0) {
    chips.push({ key: 'none', label: '问诊过程中未作任何处置', tone: 'plain' });
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {chips.map((c) => (
        <span key={c.key} className={c.tone === 'plain' ? 'chip' : `chip ${c.tone}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

// ── Status banners (loading, error, empty) ─────────────────────────

function StatusBanner({
  title,
  body,
  bg,
}: {
  title: string;
  body: string;
  bg: string;
}) {
  return (
    <div
      className="plush-lg popin"
      style={{
        background: bg,
        padding: 24,
        position: 'relative',
        marginBottom: 22,
        transform: 'rotate(-0.4deg)',
      }}
    >
      <div style={{ position: 'absolute', top: -14, left: 24 }} className="chip butter">
        主考医师
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <div className="floaty">
          <div
            className="plush"
            style={{
              width: 110,
              height: 110,
              background: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Doodle kind="star" size={86} color="#FFD86B" />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 32, lineHeight: 1.05, margin: '4px 0 8px' }}>{title}</h1>
          <div style={{ fontSize: 15, lineHeight: 1.5, fontWeight: 600, color: 'var(--ink)' }}>
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Live grading progress — animated step-by-step banner ───────────

const GRADING_STEPS = [
  '回放你与受试者的对话',
  '核查你在入组前沟通中提出的问题',
  '检查研究目的、流程、风险和权利是否说明充分',
  '核对病史、近期用药与入排标准相关信息',
  '检查受试者顾虑与理解确认是否得到回应',
  '将你的沟通策略与GCP/ICH指南进行对照',
  '为信息采集、临床处理与医患沟通三项评分',
  '为每条细则撰写个性化反馈',
];

function GradingProgress({ partialNarration }: { partialNarration: string }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (partialNarration.length > 0) return; // stop ticking once narration arrives
    const id = window.setInterval(() => {
      setStep((s) => Math.min(s + 1, GRADING_STEPS.length - 1));
    }, 1400);
    return () => window.clearInterval(id);
  }, [partialNarration.length > 0]);

  // Once narration arrives, dump it into the banner instead of the steps.
  if (partialNarration.length > 0) {
    return (
      <StatusBanner
        title={'主考医师正在评分\u2026'}
        body={truncate(partialNarration, 320)}
        bg="var(--sky)"
      />
    );
  }

  return (
    <div
      className="plush-lg popin"
      style={{
        background: 'var(--sky)',
        padding: 24,
        position: 'relative',
        marginBottom: 22,
        transform: 'rotate(-0.4deg)',
      }}
    >
      <div style={{ position: 'absolute', top: -14, left: 24 }} className="chip butter">
        主考医师
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <div className="floaty">
          <div
            className="plush"
            style={{
              width: 110,
              height: 110,
              background: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Doodle kind="star" size={86} color="#FFD86B" />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 32, lineHeight: 1.05, margin: '4px 0 12px' }}>
            主考医师正在评分{'\u2026'}
          </h1>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {GRADING_STEPS.map((label, i) => {
              const state = i < step ? 'done' : i === step ? 'active' : 'pending';
              const icon =
                state === 'done' ? (
                  '✓'
                ) : state === 'active' ? (
                  <span
                    aria-label="loading"
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      border: '2px solid rgba(43,30,22,0.25)',
                      borderTopColor: 'var(--ink)',
                      animation: 'gr-spin 0.7s linear infinite',
                    }}
                  />
                ) : (
                  '○'
                );
              const opacity = state === 'pending' ? 0.4 : 1;
              const fontWeight = state === 'active' ? 800 : 700;
              const bg = state === 'done' ? 'rgba(255,255,255,0.55)' : state === 'active' ? 'white' : 'transparent';
              return (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 14,
                    fontWeight,
                    color: 'var(--ink)',
                    opacity,
                    background: bg,
                    border: state === 'pending' ? '2px dashed rgba(43,30,22,0.18)' : '2.5px solid var(--line)',
                    borderRadius: 10,
                    padding: '6px 10px',
                    transition: 'opacity 0.3s, background 0.3s',
                  }}
                >
                  <span
                    className={state === 'active' ? 'breathe' : ''}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: state === 'done' ? 'var(--mint)' : state === 'active' ? 'var(--butter)' : 'var(--cream)',
                      border: '2px solid var(--line)',
                      fontSize: 13,
                      fontWeight: 900,
                    }}
                  >
                    {icon}
                  </span>
                  <span>{label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── DebriefScreen ──────────────────────────────────────────────────

export function DebriefScreen() {
  const state = useGameState();

  // Review-mode: when viewedEvalHistoryId is set, render a saved evaluation
  // from localStorage instead of running the agent against a fresh request.
  const reviewed = useMemo<EvalHistoryEntry | null>(() => {
    return state.viewedEvalHistoryId ? getEvalHistory(state.viewedEvalHistoryId) : null;
  }, [state.viewedEvalHistoryId]);

  // Prefer the snapshot captured by `finishPolyclinicCase` — by the time we
  // mount, the live patient slot has been cleared so the 3D scene can play
  // the walk-out animation. Fall back to a still-seated patient (rare:
  // the screen was opened directly without ending the encounter).
  const patient = reviewed?.patientSnapshot ?? state.lastEncounter ?? state.polyclinic.patient;
  const c = useMemo<PatientCase | null>(() => {
    return patient?.case ?? (state.selectedCaseId ? getPatientCase(state.selectedCaseId) : null) ?? null;
  }, [patient, state.selectedCaseId]);

  // In review mode, skip the agent — we already have the evaluation.
  const debriefRequest = useMemo(() => {
    if (reviewed) return null;
    if (!c || !patient) return null;
    return buildDebriefRequest(c, patient);
  }, [reviewed, c, patient]);

  const live = useAttendingDebrief(debriefRequest);
  const status = reviewed ? ('got-evaluation' as const) : live.status;
  const evaluation = reviewed?.evaluation ?? live.evaluation;
  const error = live.error;
  const partialNarration = live.partialNarration;

  // Persist the evaluation the FIRST time it arrives in this session.
  const savedRef = useRef(false);
  useEffect(() => {
    if (reviewed) return;
    if (savedRef.current) return;
    if (!evaluation || !patient || !c) return;
    savedRef.current = true;
    const dxId = patient.submittedDiagnosisId ?? c.correctDiagnosisId;
    saveEvalHistory({
      caseId: c.id,
      caseName: c.name,
      caseAge: c.age,
      caseGender: c.gender,
      diagnosisLabel: POLYCLINIC_DIAGNOSIS_LABELS[dxId] ?? dxId,
      verdict: evaluation.global_rating,
      evaluation,
      patientSnapshot: patient,
    });
  }, [evaluation, patient, c, reviewed]);

  // Clear review mode when the user navigates away from this screen.
  useEffect(() => {
    return () => {
      if (state.viewedEvalHistoryId) store.clearViewedEval();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="screen paper" style={{ overflowY: 'auto' }}>
      <TopBar here={5} steps={['综合门诊', '全科', '病例', '简报', '问诊', '复盘']} />

      <div style={{ padding: '28px 36px 60px', maxWidth: 1080, margin: '0 auto' }}>
        {!c || !patient ? (
          <StatusBanner
            title="没有可复盘的活跃病例"
            body="本次问诊已被清除。请从病例库中选择一个新病例重新开始。"
            bg="var(--cream-2)"
          />
        ) : status === 'starting' || status === 'idle' ? (
          <StatusBanner
            title={'正在准备你的复盘\u2026'}
            body={`正在打包本次问诊与评分细则（${summarise(debriefRequest)}）。主考医师马上开始评分。`}
            bg="var(--sky)"
          />
        ) : status === 'streaming' && !evaluation ? (
          <GradingProgress partialNarration={partialNarration} />
        ) : status === 'error' ? (
          <StatusBanner
            title={'无法生成你的复盘'}
            body={error ?? '未知错误。本次问诊已保存 —— 请从首页重试。'}
            bg="var(--rose)"
          />
        ) : evaluation ? (
          <EvaluationBody evaluation={evaluation} patient={patient} c={c} />
        ) : (
          <StatusBanner
            title="尚无评分结果"
            body={'主考医师尚未产出结果。若持续如此，请重新进行本次问诊。'}
            bg="var(--cream-2)"
          />
        )}

        <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
          <button
            type="button"
            className="btn-plush ghost"
            style={{ flex: 1 }}
            onClick={() => store.setScreen('mode')}
          >
            {'\u2190 返回综合门诊'}
          </button>
          <button
            type="button"
            className="btn-plush primary"
            style={{ flex: 1.6 }}
            onClick={() => store.setScreen('library')}
          >
            {'下一个病例 \u2192'}
          </button>
        </div>
      </div>
    </div>
  );
}

function summarise(req: ReturnType<typeof buildDebriefRequest> | null): string {
  if (!req) return 'no data';
  const s = summariseRequest(req);
  return `${s.criterion_count} 条细则 \u00B7 ${s.guideline_count} 部指南${s.guideline_count === 1 ? '' : ''} \u00B7 ${s.rec_count} 条建议`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '\u2026';
}

// ── EvaluationBody — renders the full cozy debrief from real data ──

interface BodyProps {
  evaluation: CaseEvaluationInput;
  patient: ActivePatient;
  c: PatientCase;
}

function EvaluationBody({ evaluation, patient, c }: BodyProps) {
  const verdict = evaluation.global_rating;
  const dgItems = evaluation.criteria.filter((x) => x.domain === 'data_gathering');
  const cmItems = evaluation.criteria.filter((x) => x.domain === 'clinical_management');
  const ipItems = evaluation.criteria.filter((x) => x.domain === 'interpersonal');
  const rubric = c.rubric;
  const labelByCriterionId = new Map<string, string>();
  if (rubric) {
    for (const cr of rubric.data_gathering) labelByCriterionId.set(cr.criterion_id, cr.label);
    for (const cr of rubric.clinical_management) labelByCriterionId.set(cr.criterion_id, cr.label);
    for (const cr of rubric.interpersonal) labelByCriterionId.set(cr.criterion_id, cr.label);
  }
  const elapsedSec = patient.arrivedAt ? Math.round((Date.now() - patient.arrivedAt) / 1000) : 0;
  const elapsedLabel = `${Math.floor(elapsedSec / 60)} min ${elapsedSec % 60} sec`;

  return (
    <>
      {evaluation.safety_breach && (
        <div
          className="plush-lg popin"
          style={{
            background: 'var(--rose)',
            padding: 18,
            marginBottom: 18,
            border: '3px solid var(--line)',
          }}
        >
          <div className="chip" style={{ background: 'white', marginBottom: 8 }}>
            {'\u26A0 安全违规'}
          </div>
          <div style={{ fontWeight: 800, fontSize: 16, lineHeight: 1.4 }}>
            {evaluation.safety_breach.what}
          </div>
          {evaluation.safety_breach.guideline_ref && (() => {
            const cite = buildCite(evaluation.safety_breach.guideline_ref);
            return cite ? (
              <div
                style={{
                  marginTop: 10,
                  background: 'white',
                  border: '2.5px dashed var(--line)',
                  borderRadius: 10,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 900 }}>{'\uD83D\uDCD6 '}{cite.title}</div>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{cite.rec}</div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--mint-deep)', marginTop: 4 }}>
                  {cite.loE}
                </div>
              </div>
            ) : null;
          })()}
        </div>
      )}

      <div
        className="plush-lg popin"
        style={{
          background: GLOBAL_BG[verdict],
          padding: 24,
          position: 'relative',
          marginBottom: 22,
          transform: 'rotate(-0.4deg)',
        }}
      >
        <div style={{ position: 'absolute', top: -14, left: 24 }} className="chip butter">
          你的评级
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <div className="floaty">
            <div
              className="plush"
              style={{
                width: 110,
                height: 110,
                background: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Doodle kind="star" size={86} color="#FFD86B" />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: 'var(--ink-2)',
                textTransform: 'uppercase',
                letterSpacing: '.06em',
              }}
            >
              总评
            </div>
            <h1 style={{ fontSize: 38, lineHeight: 1.05, margin: '4px 0 8px' }}>
              {GLOBAL_HEADLINE[verdict].split(' \u2014 ')[0]}{' '}
              <span style={{ fontSize: 22, color: GLOBAL_DEEP[verdict] }}>
                {' \u00B7 ' + (GLOBAL_HEADLINE[verdict].split(' \u2014 ')[1] ?? '')}
              </span>
            </h1>
            <div style={{ fontSize: 15, lineHeight: 1.55, fontWeight: 600, color: 'var(--ink)' }}>
              {evaluation.narrative}
            </div>
          </div>
        </div>
      </div>

      <div className="plush" style={{ padding: 18, marginBottom: 22 }}>
        <SectionLabel>领域得分</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <DomainRing label="信息采集" score={evaluation.domain_scores.data_gathering} />
          <DomainRing label="临床处理" score={evaluation.domain_scores.clinical_management} />
          <DomainRing label="医患沟通" score={evaluation.domain_scores.interpersonal} />
        </div>
      </div>

      {(dgItems.length + cmItems.length + ipItems.length) > 0 && (
        <div className="plush" style={{ padding: 18, marginBottom: 22 }}>
          <SectionLabel>逐条细则</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {dgItems.length > 0 && (
              <CriterionGroup title="信息采集" items={dgItems} labelMap={labelByCriterionId} />
            )}
            {cmItems.length > 0 && (
              <CriterionGroup title="临床处理" items={cmItems} labelMap={labelByCriterionId} />
            )}
            {ipItems.length > 0 && (
              <CriterionGroup title="医患沟通" items={ipItems} labelMap={labelByCriterionId} />
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 22 }}>
        {evaluation.highlights.length > 0 && (
          <div className="plush" style={{ background: 'var(--mint)', padding: 16 }}>
            <div className="chip" style={{ background: 'white', marginBottom: 10 }}>
              {'\u2713 亮点'}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 700, fontSize: 14, lineHeight: 1.6 }}>
              {evaluation.highlights.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>
        )}
        {evaluation.improvements.length > 0 && (
          <div className="plush" style={{ background: 'var(--peach)', padding: 16 }}>
            <div className="chip" style={{ background: 'white', marginBottom: 10 }}>
              {'\u2191 下次改进'}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 700, fontSize: 14, lineHeight: 1.6 }}>
              {evaluation.improvements.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="plush" style={{ padding: 16, marginBottom: 22 }}>
        <SectionLabel>你的处置</SectionLabel>
        <ActionChips patient={patient} c={c} />
      </div>

      <div
        className="plush"
        style={{
          padding: 16,
          marginBottom: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ fontWeight: 900, fontSize: 16 }}>问诊过程</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>
            {`${elapsedLabel} \u00B7 ${patient.askedQuestionIds.length} 个病史问题 \u00B7 ${patient.orderedTestIds.length} 项检查 \u00B7 ${patient.givenTreatmentIds.length} 项处置`}
          </div>
        </div>
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontWeight: 800,
        fontSize: 11,
        color: 'var(--ink-2)',
        letterSpacing: '.06em',
        textTransform: 'uppercase',
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function CriterionGroup({
  title,
  items,
  labelMap,
}: {
  title: string;
  items: CriterionResult[];
  labelMap: Map<string, string>;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 900,
          color: 'var(--ink-2)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((cr) => {
          const label = labelMap.get(cr.criterion_id) ?? cr.criterion_id;
          const cite = buildCite(cr.guideline_ref);
          return (
            <Criterion
              key={cr.criterion_id}
              status={cr.verdict}
              text={label}
              evidence={cr.evidence}
              cite={cite}
            />
          );
        })}
      </div>
    </div>
  );
}
