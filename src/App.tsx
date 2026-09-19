import { useEffect } from 'react';
import { store, useGameState, useScreen, useTweaks } from './game/store';
import { syncPatientInitializations } from './game/patientInitializationSync';
import { applyIntensity, applyPalette } from './styles/palettes';
import { SplashScreen } from './components/SplashScreen';
import { LoginScreen } from './components/LoginScreen';
import { OnboardingScreen } from './components/OnboardingScreen';
import { RoleHomeScreen } from './components/RoleHomeScreen';
import { ModeSelectScreen } from './components/ModeSelectScreen';
import { GPRoomScreen } from './components/GPRoomScreen';
import { CaseLibraryScreen } from './components/CaseLibraryScreen';
import { BriefScreen } from './components/BriefScreen';
import { EncounterScreen } from './components/EncounterScreen';
import { EndConfirmScreen } from './components/EndConfirmScreen';
import { DebriefScreen } from './components/DebriefScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { AdminScreen } from './components/AdminScreen';
import { AgenticRoundsScreen } from './components/AgenticRoundsScreen';
import { AgentTopologyScreen } from './components/AgentTopologyScreen';
import { BackgroundMusic } from './components/BackgroundMusic';

export default function App() {
  const screen = useScreen();
  const tweaks = useTweaks();
  const { authUser, authToken } = useGameState();
  useEffect(() => {
    const onExpired = () => store.logout();
    window.addEventListener('auth-expired', onExpired);
    return () => window.removeEventListener('auth-expired', onExpired);
  }, []);

  useEffect(() => {
    applyPalette(tweaks.palette);
  }, [tweaks.palette]);

  useEffect(() => {
    applyIntensity(tweaks.intensity);
  }, [tweaks.intensity]);

  useEffect(() => {
    if (!authToken || !authUser || !['student', 'staff', 'admin'].includes(authUser.role)) return;
    let active = true;
    let syncing = false;
    const sync = () => {
      if (syncing) return;
      syncing = true;
      void syncPatientInitializations(authUser.username).catch((error) => {
        if (active) console.warn('Patient initialization sync failed:', error);
      }).finally(() => { syncing = false; });
    };
    sync();
    const interval = window.setInterval(sync, 3_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') sync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authToken, authUser?.role, authUser?.username, screen]);

  // Minimal path-based route: /agentic-rounds boots straight into the
  // architecture page so the demo can deep-link to it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path === '/agentic-rounds') {
      store.setScreen('agenticRounds');
    } else if (path === '/agent-topology') {
      store.setScreen('agentTopology');
    }
  }, []);

  return (
    <div className="app">
      {screen === 'splash' && <SplashScreen />}
      {screen === 'login' && <LoginScreen />}
      {screen === 'onboarding' && <OnboardingScreen />}
      {screen === 'home' && <RoleHomeScreen />}
      {screen === 'mode' && <ModeSelectScreen />}
      {screen === 'gpRoom' && <GPRoomScreen />}
      {screen === 'library' && <CaseLibraryScreen />}
      {screen === 'brief' && <BriefScreen />}
      {screen === 'encounter' && <EncounterScreen />}
      {screen === 'endConfirm' && <EndConfirmScreen />}
      {screen === 'debrief' && <DebriefScreen />}
      {screen === 'history' && <HistoryScreen />}
      {screen === 'profile' && <ProfileScreen />}
      {screen === 'admin' && <AdminScreen />}
      {screen === 'agenticRounds' && <AgenticRoundsScreen />}
      {screen === 'agentTopology' && <AgentTopologyScreen />}
      <BackgroundMusic />
    </div>
  );
}
