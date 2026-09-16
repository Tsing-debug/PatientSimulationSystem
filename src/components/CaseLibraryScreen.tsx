import { useMemo, useState } from 'react';
import { DoodleScatter, PatientFace, TopBar } from './primitives';
import { CASES, CONDITION_COLORS, type Case } from '../data/cases';
import { store, useStore, useTweaks } from '../game/store';

interface CaseCardProps {
  c: Case;
  delay?: number;
  avatarStyle: ReturnType<typeof useTweaks>['avatarStyle'];
}

function CaseCard({ c, delay = 0, avatarStyle }: CaseCardProps) {
  const bg = CONDITION_COLORS[c.cond] ?? 'var(--butter)';
  return (
    <div
      className="tap popin"
      onClick={() => store.selectCase(c.id)}
      style={{ animationDelay: `${delay}s`, position: 'relative' }}
    >
      <div
        style={{
          position: 'absolute',
          top: -10,
          left: 18,
          zIndex: 2,
          background: bg,
          border: '3px solid var(--line)',
          borderRadius: '10px 10px 0 0',
          padding: '4px 14px',
          fontWeight: 800,
          fontSize: 12,
          boxShadow: '0 -2px 0 var(--line)',
        }}
      >
        {c.cond}
      </div>

      <div
        className="plush"
        style={{
          padding: 14,
          opacity: c.attempted ? 0.92 : 1,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {c.attempted && c.score && (
          <div
            style={{
              position: 'absolute',
              top: 14,
              right: -28,
              transform: 'rotate(38deg)',
              background: 'var(--mint-deep)',
              color: 'white',
              border: '2.5px solid var(--line)',
              padding: '2px 36px',
              fontWeight: 900,
              fontSize: 11,
              boxShadow: '0 2px 0 var(--line)',
            }}
          >
            {c.score}
          </div>
        )}

        <div
          style={{
            background: bg,
            borderRadius: 14,
            border: '3px solid var(--line)',
            height: 140,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            marginBottom: 10,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <DoodleScatter
            items={[
              { kind: 'sparkle', x: 12, y: 10, size: 18, color: '#fff' },
              { kind: 'sparkle', x: '80%', y: 14, size: 14, color: '#fff' },
            ]}
          />
          <div style={{ marginBottom: -8 }} className="floaty">
            <PatientFace
              name={c.name}
              style={avatarStyle}
              skin={c.skin}
              hair={c.hair}
              size={120}
              mood={c.mood}
              accessory={c.accessory}
            />
          </div>
        </div>

        <div style={{ fontWeight: 900, fontSize: 16, lineHeight: 1.15 }}>{c.name}</div>
        <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--ink-2)', marginBottom: 6 }}>
          {c.age} · {c.sex}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink)', minHeight: 36, lineHeight: 1.3, fontWeight: 600 }}>
          "{c.complaint}"
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
          {c.tags.slice(0, 2).map((t) => (
            <span key={t} className="chip" style={{ fontSize: 11, padding: '3px 9px' }}>
              {t}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, fontWeight: 800, color: 'var(--ink-2)' }}>📖 {c.guideline}</div>
      </div>
    </div>
  );
}

type IndicationFilter = string | 'all' | 'red-flag';

const INDICATION_ICON = '🧬';

function rosterOrder(id: string, seed: number): number {
  let value = Math.floor(seed * 0x7fffffff) ^ id.length;
  for (let i = 0; i < id.length; i++) value = Math.imul(value ^ id.charCodeAt(i), 16777619);
  return value >>> 0;
}

export function CaseLibraryScreen() {
  const tweaks = useTweaks();
  const dialogueBackend = useStore((s) => s.dialogueBackend);
  const [rosterSeed, setRosterSeed] = useState(() => Math.random());
  const [filter, setFilter] = useState<IndicationFilter>('all');

  // CRC 主轨只展示已与入组前研究资产绑定的角色；普通门诊病例属于旧轨。
  const availableCases = useMemo(
    () => (dialogueBackend === 'crc' ? CASES.filter((c) => c.id === 'ct-001') : CASES),
    [dialogueBackend],
  );

  // Group by the trial/project assigned by the admin catalogue. Diagnosis is
  // displayed on each card but must not create extra patient groups.
  const grouped = useMemo(() => {
    const map = new Map<string, Case[]>();
    for (const c of availableCases) {
      const list = map.get(c.trial) ?? [];
      list.push(c);
      map.set(c.trial, list);
    }
    // Stable for this render, randomised again on every library entry or
    // explicit regenerate click.
    for (const list of map.values()) {
      list.sort((a, b) => rosterOrder(a.id, rosterSeed) - rosterOrder(b.id, rosterSeed));
    }
    return map;
    // A fresh roster order is generated every time this screen mounts.
  }, [availableCases, rosterSeed]);

  // Apply the active filter to the grouped data so we can render it as
  // sections without having to re-group inside the JSX.
  const visibleGroups = useMemo<Array<[string, Case[]]>>(() => {
    if (filter === 'red-flag') {
      const out: Array<[string, Case[]]> = [];
      for (const [trial, list] of grouped) {
        const reds = list.filter((c) => c.tags.some((t) => t.toLowerCase().includes('red flag')));
        if (reds.length) out.push([trial, reds]);
      }
      return out;
    }
    if (filter === 'all') {
      return Array.from(grouped.entries()).filter(([, list]) => list.length > 0);
    }
    const list = grouped.get(filter) ?? [];
    return list.length ? [[filter, list]] : [];
  }, [grouped, filter]);

  const totalVisible = visibleGroups.reduce((n, [, list]) => n + list.length, 0);

  const shuffle = () => {
    setRosterSeed(Math.random());
    const pool = visibleGroups.flatMap(([, list]) => list);
    const fallback = pool.length > 0 ? pool : availableCases;
    if (fallback.length === 0) return;
    const pick = fallback[Math.floor(Math.random() * fallback.length)];
    store.selectCase(pick.id);
  };

  const trialChips: Array<{ id: IndicationFilter; label: string; icon?: string }> = [
    { id: 'all', label: '全部试验项目', icon: '🌈' },
    { id: 'red-flag', label: '仅看红旗病例', icon: '🚩' },
    ...Array.from(grouped.keys()).map((trial) => ({
      id: trial,
      label: trial,
      icon: INDICATION_ICON,
    })),
  ];

  return (
    <div className="screen" style={{ background: 'var(--cream)' }}>
      <TopBar here={2} steps={['综合门诊', '全科', '病例']} />

      {/* Header row: back button + title + shuffle */}
      <div
        style={{
          padding: '22px 28px 0',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            type="button"
            className="btn-plush ghost"
            style={{ fontSize: 14, padding: '10px 18px' }}
            onClick={() => store.setScreen('gpRoom')}
            title="返回全科诊室"
          >
            ← 返回
          </button>
          <div>
            <h1 style={{ fontSize: 36, marginBottom: 4 }}>选择一位患者</h1>
            <div style={{ fontWeight: 600, color: 'var(--ink-2)', fontSize: 14 }}>
              患者按后台试验项目分组 —— 诊断仅作为病例信息展示。
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn-plush mint"
          style={{ fontSize: 16, padding: '12px 22px', whiteSpace: 'nowrap' }}
          onClick={shuffle}
        >
          🔀 随机重新生成 / Regenerate ({totalVisible})
        </button>
      </div>

      {/* Clinic filter chip row */}
      <div
        style={{
          padding: '18px 28px 6px',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {trialChips.map((chip) => (
          <span
            key={chip.id}
            className={`chip ${filter === chip.id ? 'butter' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setFilter(chip.id)}
          >
            {chip.icon ? `${chip.icon} ` : ''}
            {chip.label}
          </span>
        ))}
      </div>

      {/* Grouped sections */}
      <div style={{ padding: '18px 28px 28px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {visibleGroups.map(([trial, list]) => (
          <section key={trial}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                marginBottom: 14,
                paddingBottom: 8,
                borderBottom: '3px dashed rgba(43,30,22,0.18)',
              }}
            >
              <span style={{ fontSize: 22 }}>{INDICATION_ICON}</span>
              <h2 style={{ fontSize: 22, margin: 0, letterSpacing: '-0.01em' }}>
                {trial}
              </h2>
              <span className="chip" style={{ fontSize: 11, marginLeft: 6 }}>
                {list.length} 例
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 18,
              }}
            >
              {list.map((c, i) => (
                <CaseCard key={c.id} c={c} delay={(i % 8) * 0.04} avatarStyle={tweaks.avatarStyle} />
              ))}
            </div>
          </section>
        ))}

        {visibleGroups.length === 0 && (
          <div
            className="plush"
            style={{ padding: 24, textAlign: 'center', color: 'var(--ink-2)', fontWeight: 700 }}
          >
            没有符合该筛选条件的病例 —— 换一个标签试试。
          </div>
        )}
      </div>
    </div>
  );
}
