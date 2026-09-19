import { useState, useMemo } from 'react';
import { Doodle, DoodleScatter, PatientFace, TopBar } from './primitives';
import { CASES, getCase } from '../data/cases';
import { CLINIC_IDS, CLINIC_LABELS, type ClinicId } from '../game/clinic';
import { store, useGameState, useTweaks } from '../game/store';

const CLINIC_ICON: Record<ClinicId, string> = {
  'all-specialties': '🌈',
  'internal-medicine': '🩺',
  cardiology: '❤️',
  neurology: '🧠',
  neurosurgery: '🧠',
  dermatology: '🌿',
  endocrinology: '🍯',
  gastroenterology: '🍽️',
  pulmonology: '🫁',
  nephrology: '💧',
  rheumatology: '🦴',
  hematology: '🩸',
  oncology: '🎗️',
  'infectious-disease': '🦠',
  'allergy-immunology': '🌼',
  psychiatry: '💭',
  obgyn: '🌷',
  urology: '💧',
  ophthalmology: '👁️',
  ent: '👂',
  orthopedics: '🦴',
  pmr: '🏃',
  pediatrics: '🧸',
  'general-surgery': '🔪',
  'cardiothoracic-vascular-surgery': '🫀',
};

export function GPRoomScreen() {
  const tweaks = useTweaks();
  const state = useGameState();
  const activeClinic = state.polyclinic.clinic;
  const [pickerOpen, setPickerOpen] = useState(false);
  const roster = useMemo(() => state.dialogueBackend === 'crc'
    ? CASES.filter(c => c.id.startsWith('crc-study-')) : CASES,
    [state.dialogueBackend, state.caseCatalogRevision]);

  // Cases from the active clinic — that's what "Accept the next patient"
  // will walk through. 'all-specialties' pulls from every roster.
  const clinicCases = useMemo(() => {
    if (activeClinic === 'all-specialties' || state.dialogueBackend === 'crc') return roster;
    return roster.filter((c) => c.clinic === activeClinic);
  }, [activeClinic, roster, state.dialogueBackend]);

  const totalAll = roster.length;
  const queueAhead = clinicCases.length;
  const nextId = store.pickNextCaseId() ?? clinicCases[0]?.id;
  const next = nextId ? getCase(nextId) : null;

  // Only show clinics that actually have at least one case in the
  // catalogue, plus the synthetic "all" option at the top.
  const availableClinics = useMemo(() => {
    return CLINIC_IDS.filter(
      (id) => id === 'all-specialties' || roster.some((c) => c.clinic === id),
    );
  }, [roster]);

  return (
    <div className="screen" style={{ background: 'var(--cream)', position: 'relative' }}>
      <TopBar here={1} steps={['综合门诊', '全科']} />

      <DoodleScatter
        items={[
          { kind: 'sparkle', x: 60, y: 100, size: 22, color: '#FFD86B' },
          { kind: 'sparkle', x: '88%', y: 130, size: 20, color: '#5AB7F2' },
          { kind: 'star', x: 80, y: 560, size: 28, color: '#FFD86B', anim: 'wobble' },
          { kind: 'pill', x: '86%', y: 580, size: 60, anim: 'wobble' },
        ]}
      />

      <div style={{ padding: '36px 36px 12px', textAlign: 'center' }}>
        <span className="chip butter" style={{ marginBottom: 12 }}>
          🏥 全科门诊
        </span>
        <h1 style={{ fontSize: 42, lineHeight: 1.05, marginTop: 12 }}>你想从哪开始？</h1>
        <div
          style={{
            fontSize: 16,
            color: 'var(--ink-2)',
            fontWeight: 600,
            marginTop: 8,
            maxWidth: 620,
            margin: '8px auto 0',
          }}
        >
          选择一家门诊，候诊区里的下一位患者就会径直走进诊室。也可以浏览病例档案夹。
        </div>
      </div>

      {/* Clinic picker — collapsible */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '12px 36px 4px' }}>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="btn-plush ghost"
          style={{
            width: '100%',
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 15,
            fontWeight: 800,
            background: 'white',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: 'var(--ink-2)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              专科
            </span>
            <span>
              {CLINIC_ICON[activeClinic]} {CLINIC_LABELS[activeClinic]}
            </span>
          </span>
          <span style={{ fontWeight: 800, color: 'var(--ink-2)' }}>{pickerOpen ? '▴' : '▾'}</span>
        </button>

        {pickerOpen && (
          <div
            className="plush"
            style={{
              marginTop: 8,
              padding: 12,
              background: 'white',
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {availableClinics.map((id) => {
              const isActive = activeClinic === id;
              return (
                <span
                  key={id}
                  className={`chip ${isActive ? 'butter' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    store.setPolyclinicClinic(id);
                    setPickerOpen(false);
                  }}
                >
                  {CLINIC_ICON[id]} {CLINIC_LABELS[id]}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 28,
          padding: '20px 36px 40px',
          maxWidth: 1080,
          margin: '0 auto',
        }}
      >
        {/* LEFT — accept next patient (clinic-aware) */}
        <div
          className={`tap plush-lg popin ${next ? 'breathe' : ''}`}
          onClick={() => next && store.acceptNextPatient()}
          style={{
            background: 'var(--mint)',
            padding: 32,
            position: 'relative',
            transform: 'rotate(-0.8deg)',
            animationDelay: '.05s',
            opacity: next ? 1 : 0.55,
            cursor: next ? 'pointer' : 'not-allowed',
          }}
        >
          <div style={{ position: 'absolute', top: -14, left: 24 }} className="chip rose">
            01 · 接诊
          </div>
          <div className="floaty" style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <div
              className="plush"
              style={{
                width: 160,
                height: 160,
                background: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {next ? (
                <PatientFace
                  style={tweaks.avatarStyle}
                  skin={next.skin}
                  hair={next.hair}
                  size={130}
                  mood={next.mood}
                  accessory={next.accessory}
                />
              ) : (
                <span style={{ fontSize: 42 }}>{CLINIC_ICON[activeClinic]}</span>
              )}
              <span
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                }}
              >
                <Doodle kind="sparkle" size={22} color="#FFD86B" />
              </span>
            </div>
          </div>
          <h2 style={{ fontSize: 28, lineHeight: 1.1, textAlign: 'center', marginBottom: 8 }}>
            接诊下一位患者
          </h2>
          <div
            style={{
              fontSize: 14,
              color: 'var(--ink-2)',
              fontWeight: 600,
              textAlign: 'center',
              marginBottom: 16,
              minHeight: 42,
            }}
          >
            {next
              ? `${next.name} 即将进入 —— 直接进入问诊。`
              : `${CLINIC_LABELS[activeClinic]} 暂无排队的病例。`}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            {next && (
              <>
                <span className="chip" style={{ background: 'white' }}>
                  {next.name.split(' ')[0]} · {next.age}
                </span>
                <span className="chip rose">{next.cond}</span>
              </>
            )}
            <span className="chip butter">
              {CLINIC_ICON[activeClinic]} {queueAhead} in {CLINIC_LABELS[activeClinic]}
            </span>
          </div>
        </div>

        {/* RIGHT — browse charts */}
        <div
          className="tap plush-lg popin"
          onClick={() => store.setScreen('library')}
          style={{
            background: 'var(--sky)',
            padding: 32,
            position: 'relative',
            transform: 'rotate(0.8deg)',
            animationDelay: '.15s',
          }}
        >
          <div style={{ position: 'absolute', top: -14, left: 24 }} className="chip butter">
            02 · 浏览
          </div>
          <div className="floaty" style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <div
              className="plush"
              style={{
                width: 160,
                height: 160,
                background: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ChartFolder />
            </div>
          </div>
          <h2 style={{ fontSize: 28, lineHeight: 1.1, textAlign: 'center', marginBottom: 8 }}>
            从病历夹中选择
          </h2>
          <div
            style={{
              fontSize: 14,
              color: 'var(--ink-2)',
              fontWeight: 600,
              textAlign: 'center',
              marginBottom: 16,
              minHeight: 42,
            }}
          >
            打开病例档案夹，可按专科或红旗病例筛选，已完成的病例带有完成标记。
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip" style={{ background: 'white' }}>
              📁 {totalAll} 例
            </span>
            <span className="chip butter">可筛选</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 36 }}>
        <button
          type="button"
          className="btn-plush ghost"
          style={{ fontSize: 14, padding: '10px 18px' }}
          onClick={() => store.setScreen('mode')}
        >
          ← 返回走廊
        </button>
      </div>
    </div>
  );
}

function ChartFolder() {
  const stroke = 'var(--line)';
  return (
    <svg width="120" height="120" viewBox="0 0 120 120">
      <rect x="14" y="22" width="92" height="14" rx="4" fill="#FFD86B" stroke={stroke} strokeWidth="3.5" />
      <rect x="10" y="30" width="100" height="78" rx="10" fill="#FFB68A" stroke={stroke} strokeWidth="4" />
      <rect x="20" y="42" width="80" height="60" rx="6" fill="white" stroke={stroke} strokeWidth="3" />
      <line x1="30" y1="56" x2="86" y2="56" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
      <line x1="30" y1="68" x2="78" y2="68" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
      <line x1="30" y1="80" x2="70" y2="80" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
      <circle cx="92" cy="84" r="9" fill="#F47A92" stroke={stroke} strokeWidth="3" />
      <text x="92" y="88" textAnchor="middle" fontFamily="Nunito" fontWeight="900" fontSize="11" fill="white">
        +
      </text>
    </svg>
  );
}
