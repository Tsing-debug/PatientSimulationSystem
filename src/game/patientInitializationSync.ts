import { CASES, registerReadyStudies, type ReadyStudy } from '../data/cases';
import { apiFetch } from './auth';
import { store } from './store';

interface InitializationState {
  studies: ReadyStudy[];
  versions: Record<string, number>;
  languages?: Record<string, string>;
  updated_at?: string;
}

const STORAGE_PREFIX = 'crc.patientInitializationVersions.';

function readVersions(username: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${username}`);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeVersions(username: string, versions: Record<string, number>): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${username}`, JSON.stringify(versions));
  } catch {
    // Private browsing can block storage. The next sync will safely reset again.
  }
}

export async function syncPatientInitializations(username: string): Promise<string[]> {
  // Refresh the ready-study catalogue before applying reset versions. This
  // makes a newly registered/generated study a real selectable patient first,
  // so the same initialization request can reset and reveal it immediately.
  const state = await apiFetch<InitializationState>('/api/patient-catalog');
  if (store.getState().authUser?.username !== username) return [];
  const activeCaseIdBeforeSync = store.getState().polyclinic.patient?.case.id ?? store.getState().selectedCaseId;
  const addedCaseIds = registerReadyStudies(state.studies, state.languages ?? {});
  if (activeCaseIdBeforeSync.startsWith('crc-study-') && !CASES.some(c => c.id === activeCaseIdBeforeSync)) {
    store.clearPolyclinicPatient();
    store.setScreen('library');
  }
  if (addedCaseIds.length > 0) store.refreshCaseCatalog();
  const previous = readVersions(username);
  const changedTrials = Object.entries(state.versions ?? {})
    .filter(([trial, version]) => Number(version) > Number(previous[trial] ?? 0))
    .map(([trial]) => trial);

  if (changedTrials.length > 0) {
    const activeCaseId = store.getState().polyclinic.patient?.case.id;
    const activeTrial = CASES.find((patient) => patient.id === activeCaseId)?.trial;
    store.resetPatientsByTrials(changedTrials);
    if (activeTrial && changedTrials.includes(activeTrial)) {
      store.setScreen('library');
    }
  }
  writeVersions(username, state.versions ?? {});
  return changedTrials;
}
