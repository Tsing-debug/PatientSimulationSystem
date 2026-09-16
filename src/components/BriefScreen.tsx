import { DoodleScatter, PatientFace, TopBar } from './primitives';
import { getCase, getPatientCase } from '../data/cases';
import { store, useStore, useTweaks } from '../game/store';

interface VitalCard {
  label: string;
  value: string;
  unit: string;
  color: string;
  icon: string;
}

function buildVitals(p?: { hr: number; bp: string; spo2: number; temp: number; rr: number }): VitalCard[] {
  return [
    { label: 'HR', value: String(p?.hr ?? 88), unit: 'bpm', color: 'var(--rose)', icon: '❤' },
    { label: 'BP', value: p?.bp ?? '120/80', unit: 'mmHg', color: 'var(--peach)', icon: '⌥' },
    { label: 'RR', value: String(p?.rr ?? 16), unit: '/min', color: 'var(--sky)', icon: '~' },
    { label: 'SpO₂', value: String(p?.spo2 ?? 98), unit: '%', color: 'var(--mint)', icon: '○' },
    { label: 'Temp', value: (p?.temp ?? 36.7).toFixed(1), unit: '°C', color: 'var(--butter)', icon: '☼' },
  ];
}

export function BriefScreen() {
  const tweaks = useTweaks();
  const caseId = useStore((s) => s.selectedCaseId);
  const c = getCase(caseId);
  const patient = getPatientCase(caseId);
  const VITALS = buildVitals(patient?.vitals);
  const chiefComplaint = patient?.chiefComplaint ?? c.complaint;
  const arrivalBlurb = patient?.arrivalBlurb ?? '受试者状态平稳。';

  return (
    <div className="screen paper" style={{ position: 'relative' }}>
      <TopBar here={3} steps={['试验项目', c.trial, '入组前沟通', '沟通简报']} />

      <DoodleScatter
        items={[
          { kind: 'sparkle', x: 60, y: 100, size: 24, color: '#FFD86B' },
          { kind: 'sparkle', x: '92%', y: 130, size: 22, color: '#5AB7F2' },
          { kind: 'star', x: 40, y: 380, size: 30, color: '#FFD86B', anim: 'wobble' },
        ]}
      />

      <div
        style={{
          padding: '28px 36px',
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr',
          gap: 28,
          minHeight: 'calc(100vh - 67px)',
        }}
      >
        {/* LEFT: clipboard */}
        <div
          className="plush-lg"
          style={{ background: '#FFFCF3', padding: 24, position: 'relative', transform: 'rotate(-1deg)' }}
        >
          <div style={{ position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)' }}>
            <svg width="120" height="46" viewBox="0 0 120 46">
              <rect x="20" y="6" width="80" height="34" rx="8" fill="#C9C9CF" stroke="var(--line)" strokeWidth="3.5" />
              <rect x="34" y="14" width="52" height="18" rx="4" fill="#9C9CA3" stroke="var(--line)" strokeWidth="3" />
            </svg>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 10,
              marginBottom: 16,
            }}
          >
            <span className="chip butter">入组前沟通简报</span>
            <span className="chip">受试者编号：{c.id.toUpperCase()}</span>
          </div>

          <h1 style={{ fontSize: 32, lineHeight: 1.1, marginBottom: 4 }}>{c.name}</h1>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink-2)', marginBottom: 16 }}>
            {c.age} 岁 · {c.sex === 'F' ? '女' : '男'} · 潜在受试者 · 尚未正式筛选
          </div>

          <div
            style={{
              background: 'white',
              border: '3px solid var(--line)',
              borderRadius: 'var(--r-md)',
              padding: 14,
              marginBottom: 14,
              boxShadow: 'var(--plush-tiny)',
            }}
          >
            <div
              style={{
                fontWeight: 800,
                fontSize: 11,
                color: 'var(--ink-2)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                marginBottom: 4,
              }}
            >
              受试者主诉
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.35 }}>
              {`"${chiefComplaint}"`}
            </div>
          </div>

          <div
            style={{
              background: 'white',
              border: '3px solid var(--line)',
              borderRadius: 'var(--r-md)',
              padding: 12,
              marginBottom: 14,
              boxShadow: 'var(--plush-tiny)',
            }}
          >
            <div
              style={{
                fontWeight: 800,
                fontSize: 11,
                color: 'var(--ink-2)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              受试者情况
            </div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{arrivalBlurb}</div>
          </div>

          <div
            style={{
              background: 'var(--butter)',
              border: '3px solid var(--line)',
              borderRadius: 'var(--r-md)',
              padding: 14,
              boxShadow: 'var(--plush-tiny)',
            }}
          >
            <div
              style={{
                fontWeight: 800,
                fontSize: 11,
                color: 'var(--ink)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              本次沟通任务
            </div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, fontWeight: 700, lineHeight: 1.5 }}>
              <li>用通俗语言说明研究目的、设计、给药与采血安排</li>
              <li>说明参加完全自愿、可以拒绝或随时退出，不作疗效承诺</li>
              <li>了解既往病史、过敏史、近期用药及既往试验和献血情况</li>
              <li>解释主要入排标准、饮食限制、避孕要求和潜在风险</li>
              <li>回应时间、费用、补贴、隐私和家属商量等顾虑，并确认理解</li>
            </ol>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div
            className="plush"
            style={{ background: 'var(--rose)', padding: 14, position: 'relative', transform: 'rotate(1.2deg)' }}
          >
            <div
              style={{
                background: 'white',
                borderRadius: 16,
                border: '3px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: 14,
              }}
            >
              <div className="floaty">
                <PatientFace style={tweaks.avatarStyle} skin={c.skin} hair={c.hair} size={110} mood={c.mood} accessory={c.accessory} />
              </div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>{c.name}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 700 }}>入组咨询室 · 候诊中</div>
                <div style={{ marginTop: 6 }} className="chip mint">
                  稳定受试者 · 标准化演员
                </div>
              </div>
            </div>
          </div>

          <div className="plush" style={{ padding: 14 }}>
            <div
              style={{
                fontWeight: 800,
                fontSize: 11,
                color: 'var(--ink-2)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              入组基线生命体征
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              {VITALS.map((v) => (
                <div
                  key={v.label}
                  style={{
                    background: v.color,
                    border: '3px solid var(--line)',
                    borderRadius: 12,
                    padding: '8px 4px',
                    textAlign: 'center',
                    boxShadow: 'var(--plush-tiny)',
                  }}
                >
                  <div style={{ fontSize: 18 }}>{v.icon}</div>
                  <div style={{ fontWeight: 900, fontSize: 16, lineHeight: 1 }}>{v.value}</div>
                  <div style={{ fontSize: 10, fontWeight: 700 }}>
                    {v.label} <span style={{ opacity: 0.6 }}>{v.unit}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            className="plush"
            style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <div>
              <div
                style={{
                  fontWeight: 800,
                  fontSize: 11,
                  color: 'var(--ink-2)',
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                }}
              >
                预计沟通时长
              </div>
              <div style={{ fontSize: 28, fontWeight: 900, color: 'var(--peach-deep)' }}>12-15 分钟</div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: 8,
                    height: 30,
                    borderRadius: 4,
                    background: 'var(--mint)',
                    border: '2.5px solid var(--line)',
                  }}
                />
              ))}
            </div>
          </div>

          <button
            type="button"
            className="btn-plush primary breathe"
            style={{ fontSize: 22, padding: '18px 0' }}
            onClick={() => store.setScreen('encounter')}
          >
            ✊ 叫号：{c.name}{c.sex === 'F' ? '女士' : '先生'}，请进入组咨询室
          </button>
        </div>
      </div>
    </div>
  );
}
