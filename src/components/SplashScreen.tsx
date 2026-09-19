import { useEffect } from 'react';
import { Doodle, DoodleScatter } from './primitives';
import { store } from '../game/store';

export function SplashScreen() {
  // Click anywhere or hit space → onboarding (first run) or home (returning).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        store.beginFromSplash();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="screen bg-peach-soft"
      onClick={() => store.beginFromSplash()}
      style={{ position: 'relative', cursor: 'pointer' }}
    >
      <DoodleScatter
        items={[
          { kind: 'cloud', x: 60, y: 70, size: 100, color: '#fff' },
          { kind: 'cloud', x: 720, y: 110, size: 130, color: '#fff' },
          { kind: 'cloud', x: 920, y: 60, size: 90, color: '#fff' },
          { kind: 'sparkle', x: 180, y: 200, size: 32, color: '#FFD86B' },
          { kind: 'sparkle', x: 880, y: 240, size: 28, color: '#fff' },
          { kind: 'star', x: 90, y: 480, size: 38, color: '#FFD86B', anim: 'wobble' },
          { kind: 'pill', x: 800, y: 500, size: 70, anim: 'wobble' },
          { kind: 'heart', x: 130, y: 600, size: 40, color: '#F47A92' },
        ]}
      />

      {/* Sun */}
      <div
        style={{ position: 'absolute', top: 38, left: '50%', transform: 'translateX(-50%)' }}
        className="floaty"
      >
        <svg width="120" height="120" viewBox="0 0 120 120">
          <g>
            {Array.from({ length: 12 }).map((_, i) => (
              <rect
                key={i}
                x="58"
                y="6"
                width="4"
                height="14"
                rx="2"
                fill="#F5B73D"
                stroke="var(--line)"
                strokeWidth="2.5"
                transform={`rotate(${i * 30} 60 60)`}
              />
            ))}
          </g>
          <circle cx="60" cy="60" r="32" fill="#FFD86B" stroke="var(--line)" strokeWidth="4" />
          <circle cx="50" cy="58" r="2.5" fill="var(--line)" />
          <circle cx="70" cy="58" r="2.5" fill="var(--line)" />
          <path d="M 50 68 Q 60 76 70 68" stroke="var(--line)" strokeWidth="3" fill="none" strokeLinecap="round" />
        </svg>
      </div>

      {/* Center stage */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 32,
        }}
      >
        <div className="popin" style={{ animationDelay: '.05s' }}>
          <div
            style={{
              fontFamily: 'Nunito',
              fontWeight: 900,
              fontSize: 116,
              lineHeight: 1,
              letterSpacing: '-0.03em',
              color: 'var(--cream)',
              WebkitTextStroke: '5px var(--line)',
              paintOrder: 'stroke fill',
              textShadow: '0 8px 0 var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            mRNA
            <span style={{ color: 'var(--peach)' }}>patientSIM</span>
            <span className="wobble" style={{ display: 'inline-block', marginLeft: 8, marginBottom: 30 }}>
              <Doodle kind="cross" size={86} color="#F47A92" />
            </span>
          </div>
        </div>

<div
           className="popin"
           style={{
             animationDelay: '.15s',
             fontSize: 24,
             fontWeight: 700,
             color: 'var(--ink)',
             background: 'white',
             padding: '10px 22px',
             border: '3px solid var(--line)',
             borderRadius: 'var(--r-pill)',
             boxShadow: 'var(--plush-tiny)',
           }}
         >
           临床试验受试者沟通训练模拟器 —— 在真实受试者面前犯错前，先在这里练熟。
         </div>

        <div className="popin breathe" style={{ animationDelay: '.3s', marginTop: 24 }}>
          <button
            type="button"
            className="btn-plush primary"
            style={{ fontSize: 22, padding: '18px 38px' }}
            onClick={(e) => {
              e.stopPropagation();
              store.beginFromSplash();
            }}
          >
            ▸ 点击开始
          </button>
        </div>

        <div
          className="popin"
          style={{
            animationDelay: '.45s',
            fontSize: 13,
            color: 'var(--ink-2)',
            fontWeight: 700,
            marginTop: 8,
          }}
        >
          按{' '}
          <span
            style={{
              background: 'white',
              padding: '2px 10px',
              border: '2.5px solid var(--line)',
              borderRadius: 8,
              boxShadow: '0 2px 0 var(--line)',
            }}
          >
            空格
          </span>{' '}
          继续
        </div>
      </div>

      {/* Foreground hill */}
      <svg
        style={{ position: 'absolute', bottom: -2, left: 0, width: '100%' }}
        viewBox="0 0 1200 120"
        preserveAspectRatio="none"
      >
        <path
          d="M 0 60 Q 300 0 600 50 T 1200 50 V 120 H 0 Z"
          fill="#A8E5C8"
          stroke="var(--line)"
          strokeWidth="4"
        />
      </svg>
    </div>
  );
}
