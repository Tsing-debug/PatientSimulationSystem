import type { PaletteName } from '../styles/palettes';
import type { ClinicId } from './clinic';

// ── MedKit cozy-cartoon UI state ──────────────────────────

export type Screen =
  | 'splash'
  | 'login'
  | 'onboarding'
  | 'home'
  | 'mode'
  | 'gpRoom'
  | 'library'
  | 'brief'
  | 'encounter'
  | 'endConfirm'
  | 'debrief'
  | 'history'
  | 'profile'
  | 'admin'
  | 'agenticRounds'
  | 'agentTopology';

export type AvatarStyle = 'cute' | 'portrait' | 'animal' | 'initials';
export type RoomLayout = 'side' | 'front';

export interface Tweaks {
  palette: PaletteName;
  avatarStyle: AvatarStyle;
  intensity: number;
  roomLayout: RoomLayout;
}

export interface EndConfirmChecks {
  sum: boolean;
  safe: boolean;
  ice: boolean;
}

// ── medkit types — load-bearing for the 3D scene + voice agent ──
//
// These are the shapes the imported `Polyclinic.tsx`, `FloatingVoicePanel.tsx`,
// and `voice/*` modules expect.

export type Severity = 'critical' | 'urgent' | 'stable';

export interface AnamnesisQA {
  id: string;
  question: string;
  answer: string;
  relevant: boolean;
}

export interface TestResult {
  testId: string;
  result: string;
  abnormal: boolean;
}

export interface PatientCase {
  id: string;
  name: string;
  age: number;
  gender: 'M' | 'F';
  severity: Severity;
  arrivalBlurb: string;
  chiefComplaint: string;
  vitals: {
    hr: number;
    bp: string;
    spo2: number;
    temp: number;
    rr: number;
  };
  anamnesis: AnamnesisQA[];
  testResults: TestResult[];
  correctDiagnosisId: string;
  acceptableTreatmentIds: string[];
  criticalTreatmentIds: string[];
  diagnosisOptions: string[];
  rubric?: CaseRubric;
  /** CRC study asset stem. Runtime-imported studies carry this directly so
   *  newly registered trials never require a hard-coded case-id mapping. */
  crcStudy?: string;
  /** Language selected by the administrator when this trial was initialized. */
  crcLanguage?: 'zh' | 'en';
}

// ── OSCE rubric — grades a completed encounter ────────────────────────
//
// The `medkit-attending` Managed Agent reads this rubric at debrief time and
// emits one `render_case_evaluation` tool call. Every clinical_management
// criterion's `guideline_ref` MUST resolve in `src/data/guidelines.ts` —
// the agent is instructed to drop a criterion rather than fabricate a
// citation. Cases without a `rubric` field fall back to an auto-derived
// rubric built from `correctDiagnosisId` + `criticalTreatmentIds`.

export type RubricFramework =
  | 'PLAB2'
  | 'RCGP'
  | 'NURSE'
  | 'SEGUE'
  | 'ICE'
  | 'SOCRATES'
  | 'OS-12';

export type RubricDomain =
  | 'data_gathering'
  | 'clinical_management'
  | 'interpersonal';

export interface RubricCriterion {
  /** Stable id, unique within the rubric. e.g. "dg-01", "cm-03". */
  criterion_id: string;
  /** Short label shown in the marking sheet UI. */
  label: string;
  /** Relative weight, 1–3. Drives the domain score. */
  weight: number;
  framework?: RubricFramework;
  /** Reference into the guideline registry. Format: "guideline_id:rec_id".
   *  REQUIRED for every clinical_management criterion. Optional elsewhere. */
  guideline_ref?: string;
  /** What counts as "met" — specific enough that the agent can quote the
   *  transcript or name the action that did/didn't satisfy it. */
  evidence: string;
}

export interface SafetyNetCriterion {
  required_elements: string[];
  weight: number;
  guideline_ref?: string;
}

export interface CaseRubric {
  data_gathering: RubricCriterion[];
  clinical_management: RubricCriterion[];
  interpersonal: RubricCriterion[];
  safety_netting?: SafetyNetCriterion;
  /** "borderline-regression" = holistic global rating in addition to the
   *  weighted sum. Always set; reserved for future strict scoring modes. */
  global_rating: 'borderline-regression';
}

// ── Catalogue types (tests, treatments, diagnoses) — used by data/* ──

export interface Test {
  id: string;
  name: string;
  category: 'lab' | 'imaging' | 'bedside';
  turnaroundSec: number;
}

export interface Treatment {
  id: string;
  name: string;
  category: 'medication' | 'procedure' | 'disposition';
}

export interface Diagnosis {
  id: string;
  name: string;
}

export type PatientStatus =
  | 'waiting'
  | 'in-bed'
  | 'examining'
  | 'awaiting-results'
  | 'ready-to-diagnose'
  | 'treating'
  | 'discharged'
  | 'deceased';

export interface ActivePatient {
  case: PatientCase;
  bedIndex: number;
  status: PatientStatus;
  askedQuestionIds: string[];
  orderedTestIds: string[];
  testOrderedAt: Record<string, number>;
  completedTestIds: string[];
  givenTreatmentIds: string[];
  submittedDiagnosisId: string | null;
  arrivedAt: number;
  deadlineMs: number;
  prescriptions?: Array<{
    medicationId: string;
    dose: string;
    duration: string;
    prescribedAt: number;
  }>;
}

export interface PolyclinicSlice {
  clinic: ClinicId;
  patient: ActivePatient | null;
}

export type DialogueBackend = 'crc' | 'livekit';

export interface CrcEvaluationDimension {
  category: string;
  dimension: string;
  score: number;
  passed: boolean;
  evidence?: string;
  suggestion?: string;
}

export interface CrcEvaluationReport {
  overall_score: number;
  passed: boolean;
  summary: string;
  dimensions: CrcEvaluationDimension[];
  principles: Record<string, string>;
  strengths: string[];
  improvements: string[];
}

// ── Combined game state ──
export interface GameState {
  screen: Screen;
  tweaks: Tweaks;
  onboardingStep: number;
  endConfirm: EndConfirmChecks;
  selectedCaseId: string;
  hasOnboarded: boolean;
  /**
   * Which dialogue stack powers the encounter:
   * - `crc` — Door A「试药前」→ front/server.py (火山 ASR/TTS + PatientTurn)
   * - `livekit` — Door B「旧项目」→ medkit /voice/token worker
   */
  dialogueBackend: DialogueBackend;
  /** Polyclinic 3D scene needs this slice. Shape consumed by `Polyclinic`
   *  and `FloatingVoicePanel`. */
  polyclinic: PolyclinicSlice;
  /** Snapshot of the most recently completed encounter, taken at the moment
   *  the patient walks out (see `Store.finishPolyclinicCase`). DebriefScreen
   *  reads this so the grading agent still has the full action log even
   *  though `polyclinic.patient` has been cleared for the walk-out animation. */
  lastEncounter: ActivePatient | null;
  /** When set, DebriefScreen renders the saved evaluation with this id from
   *  `evalHistory` storage instead of running the agent against a live
   *  encounter. Cleared when the user navigates away. */
  viewedEvalHistoryId: string | null;
  /** 登录用户与令牌（游客为 'guest' + role: 'guest'）。 */
  authUser: import('./auth').AuthUser | null;
  authToken: string | null;
  /** 当前用户能力画像（来自 /api/training/profile），登录后拉取。 */
  skillProfile: import('./auth').SkillProfile | null;
  /** 下一轮训练目标（来自能力画像推荐），随会话注入患者扮演提示。 */
  trainingFocus: string;
  /** CRC 入组前沟通结束后，由 /evaluate 返回的专项评估报告。 */
  crcEvaluation: CrcEvaluationReport | null;
  crcEvaluationStatus: 'idle' | 'loading' | 'ready' | 'error';
  crcEvaluationError: string | null;
  /** Increments when ready studies are merged into the runtime case roster. */
  caseCatalogRevision: number;
}
