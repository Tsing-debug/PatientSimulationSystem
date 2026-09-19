import type { FaceAccessory, FaceMood } from '../components/primitives';
import type { PatientCase } from '../game/types';
import type { ClinicId } from '../game/clinic';
import { CLINIC_LABELS } from '../game/clinic';
import { POLYCLINIC_CASES, POLYCLINIC_DIAGNOSIS_LABELS } from './polyclinicPatients';

/** Cute-cartoon face descriptor for the case library. Derived deterministically
 *  from the underlying `PatientCase` so the same patient always renders the
 *  same face across screens. */
export interface Case {
  id: string;
  name: string;
  age: number;
  sex: 'M' | 'F';
  complaint: string;
  tags: string[];
  guideline: string;
  skin: string;
  hair: string;
  mood: FaceMood;
  cond: string;
  attempted?: boolean;
  score?: string;
  accessory?: FaceAccessory;
  /** The clinic / specialty this patient belongs to, so the library can filter
   *  by specialty as well as by condition. */
  clinic: ClinicId;
  /** Trial/project that owns this participant. This is the library grouping key. */
  trial: string;
}

export interface ReadyStudy {
  patient_card_deleted?: boolean;
  stem: string;
  label: string;
  description?: string;
  tags?: string[];
  ready: boolean;
  opening?: Record<string, unknown>;
  personal_seed?: number | null;
}

// Trial ownership is deliberately explicit and separate from diagnosis.
// Keep these labels aligned with the CRC study catalogue: the student roster
// exposes one initialized patient for each ready trial.
export const TRIAL_LABELS = {
  phloroglucinol: '间苯三酚口崩片（生物等效性试验）',
  bCell: 'B 细胞恶性肿瘤（治疗意愿沟通）',
  nonHodgkin: '非霍奇金淋巴瘤（Ib/Ⅱ期试验）',
  chronicRhino: '慢性鼻窦炎伴鼻息肉（III 期试验）',
} as const;

const TRIAL_BY_CASE_ID: Record<string, string> = {
  'ct-001': TRIAL_LABELS.phloroglucinol,
  'im-001': TRIAL_LABELS.bCell,
  'im-002': TRIAL_LABELS.nonHodgkin,
  'card-001': TRIAL_LABELS.chronicRhino,
};

// ── deterministic palette pickers ─────────────────────────────────────
//
// We derive the cartoon face from `id + age + gender` so faces stay stable
// across reloads (no random Math.random() at module init).

const SKIN_TONES = [
  '#FFE0BD', // pale cream
  '#FFD8B5', // light peach
  '#FFD0B0', // warm beige
  '#E8B68F', // tan
  '#D89B6E', // medium
  '#B47148', // deep tan
  '#7B4F2E', // brown
  '#4A2E1C', // dark brown
];

const HAIR_TONES = [
  '#1F1410', // black
  '#2B1810', // dark brown
  '#3B2A1F', // brown
  '#5A3A22', // chestnut
  '#A8855E', // light brown
  '#D9B380', // dirty blonde
  '#E5DACE', // grey
  '#9F9F9F', // silver
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickSkin(p: PatientCase): string {
  return SKIN_TONES[hash(p.id + 'skin') % SKIN_TONES.length];
}

function pickHair(p: PatientCase): string {
  // Older patients lean grey/silver.
  if (p.age >= 65) return HAIR_TONES[6 + (hash(p.id) % 2)];
  return HAIR_TONES[hash(p.id + 'hair') % 6];
}

function pickMood(p: PatientCase): FaceMood {
  if (p.severity === 'critical') return 'sad';
  if (p.severity === 'urgent') return 'sick';
  // Mild anxiety hint based on chief complaint keywords.
  const cc = p.chiefComplaint.toLowerCase();
  if (/(pain|chest|headache|bleed)/.test(cc)) return 'worried';
  if (/(fever|cough|nausea|vomit|sore)/.test(cc)) return 'sick';
  return 'neutral';
}

function diagLabel(id: string): string {
  return POLYCLINIC_DIAGNOSIS_LABELS[id] ?? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function tagsFor(p: PatientCase, clinic: ClinicId): string[] {
  const out: string[] = [];
  if (p.severity === 'critical') out.push('red flag');
  else if (p.severity === 'urgent') out.push('urgent');
  out.push(CLINIC_LABELS[clinic].toLowerCase());
  return out;
}

function toCase(p: PatientCase, clinic: ClinicId): Case {
  return {
    id: p.id,
    name: p.name,
    age: p.age,
    sex: p.gender,
    complaint: p.chiefComplaint,
    tags: tagsFor(p, clinic),
    guideline: '综合门诊',
    skin: pickSkin(p),
    hair: pickHair(p),
    mood: pickMood(p),
    cond: diagLabel(p.correctDiagnosisId),
    clinic,
    trial: TRIAL_BY_CASE_ID[p.id] ?? '未配置试验项目',
  };
}

// ── Build the library deterministically from POLYCLINIC_CASES ────────

const BY_ID = new Map<string, { p: PatientCase; clinic: ClinicId }>();
const ALL_CASES_RAW: Case[] = [];

for (const [clinic, list] of Object.entries(POLYCLINIC_CASES) as Array<[ClinicId, PatientCase[]]>) {
  if (clinic === 'all-specialties') continue; // skip the synthetic mixed bucket
  for (const p of list) {
    if (BY_ID.has(p.id)) continue;
    BY_ID.set(p.id, { p, clinic });
    ALL_CASES_RAW.push(toCase(p, clinic));
  }
}

export const CASES: Case[] = ALL_CASES_RAW;

function dynamicCaseId(stem: string): string {
  return `crc-study-${hash(stem).toString(36)}`;
}

/** Merge backend-ready CRC studies into the live roster. The exported CASES
 *  array is intentionally mutated in place because the store and screens all
 *  share this catalogue instance. Returns the ids newly added this run. */
export function registerReadyStudies(
  studies: ReadyStudy[],
  languages: Record<string, string> = {},
): string[] {
  const added: string[] = [];
  const wanted = new Set(studies.filter(s => s.ready && !s.patient_card_deleted).map(s => dynamicCaseId(s.stem)));
  for (let i = CASES.length - 1; i >= 0; i--) {
    const id = CASES[i].id;
    if (id.startsWith('crc-study-') && !wanted.has(id)) {
      CASES.splice(i, 1);
      BY_ID.delete(id);
      added.push(id);
    }
  }
  for (const study of studies) {
    if (study.patient_card_deleted) {
      const removedId = dynamicCaseId(study.stem);
      const index = CASES.findIndex((card) => card.id === removedId);
      if (index >= 0) {
        CASES.splice(index, 1);
        BY_ID.delete(removedId);
        added.push(removedId); // Notify subscribers of catalogue removals too.
      }
      continue;
    }
    if (!study.ready || !study.stem.trim()) continue;
    const id = dynamicCaseId(study.stem);
    const personalSeed = Number.isFinite(Number(study.personal_seed))
      ? Number(study.personal_seed)
      : null;
    const opening = study.opening && typeof study.opening === 'object' ? study.opening : {};
    const profile = opening['患者画像'] && typeof opening['患者画像'] === 'object'
      ? opening['患者画像'] as Record<string, unknown>
      : {};
    const chineseOpening = typeof opening['患者台词'] === 'string'
      ? opening['患者台词']
      : '您好，我想先详细了解一下这个试验。';
    const language: 'zh' | 'en' = languages[study.label || study.stem] === 'en' ? 'en' : 'zh';
    const personalOpenings = language === 'en'
      ? [
          'Hello. Could you explain what I would need to do in this trial?',
          'Before I decide, I would like to understand the risks and time commitment.',
          'I have a few questions about screening and whether I can withdraw later.',
        ]
      : [
          '您好，我想先弄清楚参加这个试验具体需要做什么。',
          '我决定之前，想详细了解风险和时间安排。',
          '我对筛选流程和以后能不能退出还有一些疑问。',
        ];
    const openingLine = personalSeed != null
      ? personalOpenings[Math.abs(personalSeed) % personalOpenings.length]
      : language === 'en'
        ? 'Hello. I would like to understand this clinical trial before I decide whether to take part.'
        : chineseOpening;
    const ageValue = Number(profile['年龄']);
    const age = personalSeed != null
      ? 20 + Math.abs(personalSeed % 41)
      : Number.isFinite(ageValue) && ageValue > 0 ? Math.round(ageValue) : 35;
    const gender: 'M' | 'F' = hash(`${study.stem}-${personalSeed ?? 'global'}-gender`) % 2 === 0 ? 'F' : 'M';
    const existing = BY_ID.get(id)?.p;
    if (existing) {
      const card = CASES.find((item) => item.id === id);
      const tags = Array.isArray(study.tags) ? study.tags.map(String) : [];
      const condition = study.description?.trim() || study.label;
      if (existing.crcLanguage !== language || existing.chiefComplaint !== openingLine ||
          existing.age !== age || existing.gender !== gender ||
          card?.trial !== study.label || card?.cond !== condition || JSON.stringify(card?.tags) !== JSON.stringify(tags)) {
        added.push(id);
      }
      existing.crcLanguage = language;
      existing.chiefComplaint = openingLine;
      existing.arrivalBlurb = openingLine;
      existing.age = age;
      existing.gender = gender;
      if (card) Object.assign(card, {
        complaint: openingLine,
        age,
        sex: gender,
        trial: study.label || study.stem,
        cond: condition,
        tags,
        skin: pickSkin(existing),
        hair: pickHair(existing),
      });
      continue;
    }
    const patient: PatientCase = {
      id,
      name: '标准化受试者',
      age,
      gender,
      severity: 'stable',
      arrivalBlurb: openingLine,
      chiefComplaint: openingLine,
      vitals: { hr: 76, bp: '118/76', spo2: 98, temp: 36.6, rr: 16 },
      anamnesis: [],
      testResults: [],
      correctDiagnosisId: study.stem,
      acceptableTreatmentIds: [],
      criticalTreatmentIds: [],
      diagnosisOptions: [study.stem],
      crcStudy: study.stem,
      crcLanguage: language,
    };
    const clinic: ClinicId = 'internal-medicine';
    BY_ID.set(id, { p: patient, clinic });
    CASES.push({
      ...toCase(patient, clinic),
      complaint: openingLine,
      cond: study.description?.trim() || study.label,
      tags: Array.isArray(study.tags) ? study.tags.map(String) : [],
      guideline: 'CRC 入组前沟通',
      trial: study.label || study.stem,
    });
    added.push(id);
  }
  // Existing built-in CRC patients also honour the persisted per-trial choice.
  for (const card of CASES) {
    const patient = BY_ID.get(card.id)?.p;
    if (!patient || !(card.trial in languages)) continue;
    patient.crcLanguage = languages[card.trial] === 'en' ? 'en' : 'zh';
  }
  return added;
}

/** 目录中所有不同的病种标签，外加几个固定的筛选标签（'全部'、'仅看红旗病例'）。 */
const conditionSet = new Set(CASES.map((c) => c.cond));
export const CONDITION_FILTERS: string[] = ['全部', ...Array.from(conditionSet).slice(0, 8), '仅看红旗病例'];

/** Stable colour per condition for chips and ribbons — picks from the
 *  cozy-cartoon palette using a hash. */
const PALETTE_VARS = ['var(--rose)', 'var(--peach)', 'var(--mint)', 'var(--sky)', 'var(--butter)'];
function colourFor(label: string): string {
  return PALETTE_VARS[hash(label) % PALETTE_VARS.length];
}
export const CONDITION_COLORS: Record<string, string> = Object.fromEntries(
  Array.from(conditionSet).map((c) => [c, colourFor(c)]),
);

/** Lookup by id — used by every screen that needs the current case. */
export function getCase(id: string): Case {
  const found = CASES.find((c) => c.id === id);
  if (found) return found;
  return CASES[0];
}

/** Look up the underlying medical PatientCase (anamnesis, vitals,
 *  diagnosis options, test results, etc.) — used by the encounter /
 *  brief / debrief screens that need more than the cartoon face. */
export function getPatientCase(id: string): PatientCase | undefined {
  return BY_ID.get(id)?.p;
}

/** Which clinic does this case belong to? */
export function getCaseClinic(id: string): ClinicId | undefined {
  return BY_ID.get(id)?.clinic;
}
