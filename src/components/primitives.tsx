import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { store } from '../game/store';

// ─── PATIENT FACE ───────────────────────────────────────────
// style: 'cute' | 'portrait' | 'animal' | 'initials'

export type FaceMood = 'neutral' | 'happy' | 'sad' | 'sick' | 'worried';
export type FaceStyle = 'cute' | 'portrait' | 'animal' | 'initials';
export type FaceAccessory = 'thermometer' | 'bandage';

interface PatientFaceProps {
  name?: string;
  style?: FaceStyle;
  skin?: string;
  hair?: string;
  size?: number;
  mood?: FaceMood;
  accessory?: FaceAccessory;
}

export function PatientFace({
  name = 'Aisha',
  style = 'cute',
  skin = '#FFD8B5',
  hair = '#3B2A1F',
  size = 120,
  mood = 'neutral',
  accessory,
}: PatientFaceProps) {
  if (style === 'initials') {
    const initials = name.split(' ').map((s) => s[0]).slice(0, 2).join('');
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: hair,
          color: 'white',
          fontWeight: 900,
          fontSize: size * 0.36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'var(--stroke-thick) solid var(--line)',
          boxShadow: 'var(--plush-sm)',
        }}
      >
        {initials}
      </div>
    );
  }
  if (style === 'animal') return <AnimalFace size={size} />;
  if (style === 'portrait') return <PortraitFace size={size} skin={skin} hair={hair} />;
  return <CuteFace size={size} skin={skin} hair={hair} mood={mood} accessory={accessory} />;
}

interface CuteFaceProps {
  size?: number;
  skin?: string;
  hair?: string;
  mood?: FaceMood;
  accessory?: FaceAccessory;
}

export function CuteFace({
  size = 120,
  skin = '#FFD8B5',
  hair = '#3B2A1F',
  mood = 'neutral',
  accessory,
}: CuteFaceProps) {
  const stroke = 'var(--line)';
  const mouthByMood: Record<FaceMood, ReactNode> = {
    neutral: <path d="M 80 132 Q 100 142 120 132" stroke={stroke} strokeWidth="4" fill="none" strokeLinecap="round" />,
    happy: <path d="M 78 128 Q 100 150 122 128" stroke={stroke} strokeWidth="4" fill="none" strokeLinecap="round" />,
    sad: <path d="M 78 138 Q 100 124 122 138" stroke={stroke} strokeWidth="4" fill="none" strokeLinecap="round" />,
    sick: <path d="M 80 134 Q 90 128 100 134 T 120 134" stroke={stroke} strokeWidth="4" fill="none" strokeLinecap="round" />,
    worried: <path d="M 82 134 Q 100 130 118 134" stroke={stroke} strokeWidth="4" fill="none" strokeLinecap="round" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 200 200">
      <ellipse cx="100" cy="86" rx="74" ry="78" fill={hair} />
      <circle cx="100" cy="104" r="62" fill={skin} stroke={stroke} strokeWidth="4" />
      <path d="M 42 78 Q 60 38 100 40 Q 140 38 158 78 Q 130 60 100 64 Q 70 60 42 78 Z" fill={hair} />
      <ellipse cx="74" cy="118" rx="9" ry="6" fill="#FF9DAA" opacity="0.7" />
      <ellipse cx="126" cy="118" rx="9" ry="6" fill="#FF9DAA" opacity="0.7" />
      <g className="blink" style={{ transformOrigin: '100px 105px' }}>
        <circle cx="82" cy="105" r="5" fill={stroke} />
        <circle cx="118" cy="105" r="5" fill={stroke} />
      </g>
      {mouthByMood[mood] ?? mouthByMood.neutral}
      {accessory === 'thermometer' && (
        <g>
          <rect x="118" y="128" width="34" height="8" rx="4" fill="white" stroke={stroke} strokeWidth="3" transform="rotate(-15 130 132)" />
          <circle cx="120" cy="135" r="6" fill="#F47A92" stroke={stroke} strokeWidth="3" />
        </g>
      )}
      {accessory === 'bandage' && (
        <g transform="translate(100 78) rotate(-12)">
          <rect x="-22" y="-7" width="44" height="14" rx="6" fill="#FFD3A8" stroke={stroke} strokeWidth="3" />
          <circle cx="-10" cy="0" r="1.6" fill={stroke} />
          <circle cx="0" cy="0" r="1.6" fill={stroke} />
          <circle cx="10" cy="0" r="1.6" fill={stroke} />
        </g>
      )}
    </svg>
  );
}

export function PortraitFace({ size = 120, skin = '#FFD8B5', hair = '#3B2A1F' }: { size?: number; skin?: string; hair?: string }) {
  const stroke = 'var(--line)';
  return (
    <svg width={size} height={size} viewBox="0 0 200 200">
      <rect x="10" y="10" width="180" height="180" rx="20" fill="#FFF1DA" stroke={stroke} strokeWidth="4" />
      <circle cx="100" cy="160" r="60" fill={hair} />
      <ellipse cx="100" cy="100" rx="46" ry="54" fill={skin} stroke={stroke} strokeWidth="3" />
      <path d="M 56 86 Q 70 50 100 50 Q 130 50 144 86 Q 132 76 100 74 Q 68 76 56 86" fill={hair} />
      <circle cx="86" cy="102" r="3" fill={stroke} />
      <circle cx="114" cy="102" r="3" fill={stroke} />
      <path d="M 90 130 Q 100 138 110 130" stroke={stroke} strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function AnimalFace({ size = 120 }: { size?: number }) {
  const stroke = 'var(--line)';
  return (
    <svg width={size} height={size} viewBox="0 0 200 200">
      <circle cx="62" cy="68" r="22" fill="#C58F5E" stroke={stroke} strokeWidth="3" />
      <circle cx="138" cy="68" r="22" fill="#C58F5E" stroke={stroke} strokeWidth="3" />
      <circle cx="62" cy="68" r="10" fill="#9C6B43" />
      <circle cx="138" cy="68" r="10" fill="#9C6B43" />
      <circle cx="100" cy="108" r="68" fill="#D9A574" stroke={stroke} strokeWidth="4" />
      <ellipse cx="100" cy="120" rx="34" ry="26" fill="#FFE6CC" />
      <circle cx="80" cy="100" r="5" fill={stroke} />
      <circle cx="120" cy="100" r="5" fill={stroke} />
      <ellipse cx="100" cy="118" rx="8" ry="6" fill={stroke} />
      <path d="M 100 124 Q 100 134 92 134" stroke={stroke} strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M 100 124 Q 100 134 108 134" stroke={stroke} strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ─── DOODLES ─────────────────────────────────
export type DoodleKind =
  | 'pill'
  | 'cross'
  | 'heart'
  | 'bandage'
  | 'stetho'
  | 'star'
  | 'sparkle'
  | 'cloud'
  | 'leaf';

interface DoodleProps {
  kind: DoodleKind;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export function Doodle({ kind, size = 50, color, style }: DoodleProps) {
  const stroke = 'var(--line)';
  const defaultColors: Record<DoodleKind, string> = {
    pill: '#FFB68A',
    cross: '#F47A92',
    heart: '#F47A92',
    bandage: '#FFE0BD',
    stetho: '#5FCFA0',
    star: '#FFD86B',
    sparkle: '#5AB7F2',
    cloud: '#FFFFFF',
    leaf: '#A8E5C8',
  };
  const c = color ?? defaultColors[kind];
  switch (kind) {
    case 'pill':
      return (
        <svg width={size} height={size * 0.55} viewBox="0 0 100 55" style={style}>
          <rect x="3" y="3" width="94" height="49" rx="24" fill={c} stroke={stroke} strokeWidth="3.5" />
          <line x1="50" y1="3" x2="50" y2="52" stroke={stroke} strokeWidth="3.5" />
          <rect x="3" y="3" width="48" height="49" rx="24" fill="#FFD86B" />
          <line x1="50" y1="3" x2="50" y2="52" stroke={stroke} strokeWidth="3.5" />
          <rect x="3" y="3" width="94" height="49" rx="24" fill="none" stroke={stroke} strokeWidth="3.5" />
        </svg>
      );
    case 'cross':
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
          <path
            d="M 38 8 H 62 Q 70 8 70 16 V 38 H 92 Q 100 38 100 46 V 62 Q 100 70 92 70 H 70 V 92 Q 70 100 62 100 H 38 Q 30 100 30 92 V 70 H 8 Q 0 70 0 62 V 46 Q 0 38 8 38 H 30 V 16 Q 30 8 38 8 Z"
            transform="translate(0 -3)"
            fill={c}
            stroke={stroke}
            strokeWidth="4"
          />
        </svg>
      );
    case 'heart':
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
          <path
            d="M 50 88 C 14 64 8 38 26 26 C 38 18 50 26 50 38 C 50 26 62 18 74 26 C 92 38 86 64 50 88 Z"
            fill={c}
            stroke={stroke}
            strokeWidth="4"
          />
        </svg>
      );
    case 'bandage':
      return (
        <svg width={size} height={size * 0.5} viewBox="0 0 100 50" style={style}>
          <rect x="4" y="4" width="92" height="42" rx="14" fill={c} stroke={stroke} strokeWidth="3.5" transform="rotate(-8 50 25)" />
          <g transform="rotate(-8 50 25)">
            <circle cx="32" cy="25" r="2" fill={stroke} />
            <circle cx="46" cy="25" r="2" fill={stroke} />
            <circle cx="60" cy="25" r="2" fill={stroke} />
            <circle cx="38" cy="18" r="2" fill={stroke} />
            <circle cx="54" cy="18" r="2" fill={stroke} />
          </g>
        </svg>
      );
    case 'stetho':
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
          <path d="M 25 20 V 50 Q 25 70 50 70 Q 75 70 75 50 V 20" fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round" />
          <path d="M 50 70 V 80" stroke={stroke} strokeWidth="5" />
          <circle cx="50" cy="86" r="10" fill={c} stroke={stroke} strokeWidth="4" />
          <circle cx="25" cy="20" r="6" fill="white" stroke={stroke} strokeWidth="4" />
          <circle cx="75" cy="20" r="6" fill="white" stroke={stroke} strokeWidth="4" />
        </svg>
      );
    case 'star':
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
          <path
            d="M 50 8 L 62 38 L 92 42 L 70 62 L 76 92 L 50 76 L 24 92 L 30 62 L 8 42 L 38 38 Z"
            fill={c}
            stroke={stroke}
            strokeWidth="4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'sparkle':
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
          <path
            d="M 50 6 L 56 44 L 94 50 L 56 56 L 50 94 L 44 56 L 6 50 L 44 44 Z"
            fill={c}
            stroke={stroke}
            strokeWidth="3.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'cloud':
      return (
        <svg width={size} height={size * 0.66} viewBox="0 0 100 66" style={style}>
          <path
            d="M 22 50 Q 4 50 4 36 Q 4 22 20 22 Q 22 8 38 8 Q 52 8 56 20 Q 78 14 86 30 Q 96 30 96 42 Q 96 56 80 56 H 28 Q 22 56 22 50 Z"
            fill={c}
            stroke={stroke}
            strokeWidth="4"
          />
        </svg>
      );
    case 'leaf':
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
          <path d="M 12 88 Q 20 28 88 12 Q 76 76 12 88 Z" fill={c} stroke={stroke} strokeWidth="4" />
          <path d="M 22 78 Q 50 50 80 30" fill="none" stroke={stroke} strokeWidth="3" />
        </svg>
      );
    default:
      return null;
  }
}

// ─── BREADCRUMB ──────────────────────────────
import type { Screen } from '../game/types';

const LABEL_TO_SCREEN: Record<string, Screen> = {
  '综合门诊': 'mode',
  '全科': 'gpRoom',
  '病例': 'library',
  '简报': 'brief',
  '问诊': 'encounter',
  '收尾': 'endConfirm',
  '复盘': 'debrief',
  '主页': 'home',
  '训练记录': 'history',
  '智能体拓扑': 'agentTopology',
};

interface BreadcrumbProps {
  steps: string[];
  here: number;
}

export function Breadcrumb({ steps, here }: BreadcrumbProps) {
  return (
    <div className="breadcrumb">
      {steps.map((s, i) => {
        const target = LABEL_TO_SCREEN[s];
        const isHere = i === here;
        const clickable = !isHere && !!target;
        return (
          <Fragment key={i}>
            {isHere ? (
              <span className="here">{s}</span>
            ) : (
              <span
                onClick={clickable ? () => store.setScreen(target) : undefined}
                style={{
                  cursor: clickable ? 'pointer' : 'default',
                  textDecoration: clickable ? 'underline' : 'none',
                  textDecorationStyle: 'dotted',
                  textUnderlineOffset: 3,
                }}
              >
                {s}
              </span>
            )}
            {i < steps.length - 1 && <span className="sep">›</span>}
          </Fragment>
        );
      })}
    </div>
  );
}

// ─── TOP BAR ─────────────────────────────────
interface TopBarProps {
  here?: number;
  steps?: string[];
  showProfile?: boolean;
}

export function TopBar({
  here = 0,
  steps = ['综合门诊'],
  showProfile = true,
}: TopBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 22px',
        borderBottom: '3px solid var(--line)',
        background: 'white',
      }}
    >
      <span
        className="tap"
        onClick={() => store.setScreen('splash')}
        title="返回首页"
        style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}
      >
        <Wordmark size={28} />
      </span>
      <Breadcrumb steps={steps} here={here} />
      {showProfile ? (
        <div
          className="tap"
          onClick={() => store.setScreen('home')}
          title="打开个人主页"
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
        >
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink-2)' }}>Bedirhan</span>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'var(--mint)',
              border: '3px solid var(--line)',
              boxShadow: '0 2px 0 var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 900,
              fontSize: 14,
            }}
          >
            B
          </div>
        </div>
      ) : (
        <div style={{ width: 80 }} />
      )}
    </div>
  );
}

// ─── WORDMARK ────────────────────────────────
interface WordmarkProps {
  size?: number;
  dark?: boolean;
}

export function Wordmark({ size = 36, dark = false }: WordmarkProps) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'Nunito',
        fontWeight: 900,
        fontSize: size,
        color: dark ? 'white' : 'var(--ink)',
        letterSpacing: '-0.02em',
      }}
    >
      <span style={{ position: 'relative', display: 'inline-block' }}>
        patient
        <span
          style={{
            color: 'var(--peach-deep)',
            textShadow: dark ? 'none' : '0 2px 0 var(--line)',
            WebkitTextStroke: dark ? '0' : '2px var(--line)',
            paintOrder: 'stroke fill',
          }}
        >
          SIM
        </span>
        <span
          style={{
            position: 'absolute',
            right: -size * 0.42,
            top: size * 0.05,
            width: size * 0.34,
            height: size * 0.34,
            display: 'inline-block',
          }}
        >
          <Doodle kind="cross" size={size * 0.34} color="#F47A92" />
        </span>
      </span>
    </div>
  );
}

// ─── DOODLE SCATTER ──────────────────────────
export interface DoodleScatterItem {
  kind: DoodleKind;
  x: number | string;
  y: number | string;
  size?: number;
  color?: string;
  rot?: number;
  opacity?: number;
  anim?: 'floaty' | 'wobble' | 'drift' | 'breathe';
}

export function DoodleScatter({ items }: { items: DoodleScatterItem[] }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {items.map((it, i) => (
        <div
          key={i}
          className={it.anim ?? 'floaty'}
          style={{
            position: 'absolute',
            left: it.x,
            top: it.y,
            transform: `rotate(${it.rot ?? 0}deg)`,
            opacity: it.opacity ?? 1,
            animationDelay: `${(i * 0.4) % 3}s`,
          }}
        >
          <Doodle kind={it.kind} size={it.size ?? 40} color={it.color} />
        </div>
      ))}
    </div>
  );
}

// ─── SPEECH BUBBLE ───────────────────────────
export function SpeechBubble({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'white',
        border: '3.5px solid var(--line)',
        borderRadius: 'var(--r-md)',
        padding: '10px 14px',
        fontWeight: 700,
        fontSize: 13,
        lineHeight: 1.35,
        boxShadow: 'var(--plush-sm)',
      }}
    >
      {children}
      <svg style={{ position: 'absolute', left: -16, top: 30 }} width="20" height="22" viewBox="0 0 20 22">
        <path d="M 20 4 L 2 12 L 20 18 Z" fill="white" stroke="var(--line)" strokeWidth="3.5" strokeLinejoin="round" />
        <line x1="20" y1="4" x2="20" y2="18" stroke="white" strokeWidth="4" />
      </svg>
    </div>
  );
}
