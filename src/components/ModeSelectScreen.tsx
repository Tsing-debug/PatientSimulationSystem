import { Doodle, TopBar } from './primitives';
import { store } from '../game/store';

interface DoorProps {
  label: string;
  sub: string;
  color: string;
  doorColor: string;
  available?: boolean;
  locked?: boolean;
  tags?: string[];
  onOpen?: () => void;
}

function Door({ label, sub, color, doorColor, available, locked, tags = [], onOpen }: DoorProps) {
  return (
    <div
      className={available ? 'tap' : ''}
      onClick={available ? onOpen : undefined}
      style={{
        width: 240,
        position: 'relative',
        filter: locked ? 'grayscale(0.4) brightness(0.96)' : 'none',
      }}
    >
      <div
        style={{
          background: color,
          border: '4px solid var(--line)',
          borderRadius: '32px 32px 6px 6px',
          padding: 14,
          boxShadow: 'var(--plush)',
        }}
      >
        <div
          style={{
            position: 'relative',
            height: 320,
            background: doorColor,
            border: '4px solid var(--line)',
            borderRadius: '24px 24px 4px 4px',
            padding: 16,
          }}
        >
          <div
            style={{
              background: 'linear-gradient(180deg, #DFF1FF 0%, #B6DFFE 100%)',
              border: '4px solid var(--line)',
              borderRadius: 18,
              height: 110,
              marginBottom: 16,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(135deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 50%)',
              }}
            />
            {available && (
              <div
                style={{ position: 'absolute', bottom: 4, left: 0, right: 0, textAlign: 'center', fontSize: 28 }}
                className="floaty"
              >
                <Doodle kind="cross" size={36} color="#F47A92" />
              </div>
            )}
            {locked && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  style={{
                    background: 'white',
                    border: '3px solid var(--line)',
                    borderRadius: '50%',
                    width: 50,
                    height: 50,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: 'var(--plush-tiny)',
                  }}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24">
                    <path
                      d="M 6 11 V 8 a 6 6 0 0 1 12 0 v 3"
                      stroke="var(--line)"
                      strokeWidth="3"
                      fill="none"
                      strokeLinecap="round"
                    />
                    <rect
                      x="4"
                      y="11"
                      width="16"
                      height="11"
                      rx="3"
                      fill="var(--butter)"
                      stroke="var(--line)"
                      strokeWidth="3"
                    />
                  </svg>
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              background: 'white',
              border: '4px solid var(--line)',
              borderRadius: 14,
              padding: '10px 12px',
              textAlign: 'center',
              boxShadow: 'var(--plush-tiny)',
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 18, color: 'var(--ink)' }}>{label}</div>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>{sub}</div>
          </div>

        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
        {tags.map((t, i) => (
          <span key={i} className={`chip ${available ? 'mint' : ''}`}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Plant({ flip = false }: { flip?: boolean }) {
  return (
    <svg width="80" height="100" viewBox="0 0 80 100" style={{ transform: flip ? 'scaleX(-1)' : 'none' }}>
      <path d="M 40 70 Q 30 40 16 28" stroke="var(--line)" strokeWidth="3" fill="none" />
      <path d="M 40 70 Q 50 44 64 32" stroke="var(--line)" strokeWidth="3" fill="none" />
      <ellipse cx="18" cy="26" rx="14" ry="9" fill="#5FCFA0" stroke="var(--line)" strokeWidth="3" transform="rotate(-30 18 26)" />
      <ellipse cx="62" cy="32" rx="14" ry="9" fill="#A8E5C8" stroke="var(--line)" strokeWidth="3" transform="rotate(30 62 32)" />
      <ellipse cx="40" cy="14" rx="14" ry="10" fill="#5FCFA0" stroke="var(--line)" strokeWidth="3" />
      <path d="M 22 70 L 58 70 L 54 96 H 26 Z" fill="#FFB68A" stroke="var(--line)" strokeWidth="3.5" />
      <ellipse cx="40" cy="70" rx="18" ry="5" fill="#3A2417" />
    </svg>
  );
}

export function ModeSelectScreen() {
  return (
    <div className="screen" style={{ background: 'var(--cream)' }}>
      <TopBar here={0} showProfile />

      <div style={{ position: 'relative', height: 'calc(100vh - 67px)' }}>
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          viewBox="0 0 1200 700"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern id="floortile" x="0" y="0" width="80" height="80" patternUnits="userSpaceOnUse">
              <rect width="80" height="80" fill="#FFE8C9" />
              <path d="M 0 80 L 80 0" stroke="#F4D5A8" strokeWidth="2" />
            </pattern>
          </defs>
          <rect x="0" y="0" width="1200" height="380" fill="#FFF2DC" />
          <rect x="0" y="370" width="1200" height="14" fill="#E8C892" stroke="var(--line)" strokeWidth="3" />
          <path
            d="M 0 700 L 1200 700 L 900 384 L 300 384 Z"
            fill="url(#floortile)"
            stroke="var(--line)"
            strokeWidth="4"
          />
          <line x1="600" y1="384" x2="0" y2="700" stroke="#D7B07A" strokeWidth="2" strokeDasharray="6 8" />
          <line x1="600" y1="384" x2="1200" y2="700" stroke="#D7B07A" strokeWidth="2" strokeDasharray="6 8" />
        </svg>

        <div
          style={{
            position: 'absolute',
            top: 130,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: 44,
            padding: '0 60px',
          }}
        >
          <Door
            label="试药前 / 受试者沟通"
            sub="主轨 · 选择患者角色卡进入入组沟通诊室"
            color="var(--mint)"
            doorColor="#5FCFA0"
            available
            tags={['核心场景', '角色卡选择', '知情同意·入排标准·风险与顾虑']}
            onOpen={() => {
              store.setDialogueBackend('crc');
              store.setScreen('library');
            }}
          />
          <Door
            label="旧项目 · ER / 全科"
            sub="原始 3D 诊室漫游 · 候诊区下一位患者"
            color="var(--sky)"
            doorColor="#5AB7F2"
            available
            tags={['原项目', '自由漫游', '全部病例可选']}
            onOpen={() => {
              store.setDialogueBackend('livekit');
              store.setScreen('gpRoom');
            }}
          />
          <Door
            label="更多试验场景"
            sub="糖尿病II期、抗凝III期、肿瘤I期..."
            color="var(--rose)"
            doorColor="#F47A92"
            locked
            tags={['开发中', '不同环境']}
          />
          <Door
            label="自定义受试者"
            sub="导入自家方案与受试者画像"
            color="var(--butter)"
            doorColor="#FFD86B"
            locked
            tags={['规划中']}
          />
        </div>

        <div style={{ position: 'absolute', bottom: 30, left: 60 }} className="wobble">
          <Doodle kind="pill" size={70} />
        </div>
        <div style={{ position: 'absolute', bottom: 60, right: 80 }} className="floaty">
          <Doodle kind="stetho" size={64} color="var(--mint)" />
        </div>

        <div style={{ position: 'absolute', bottom: 24, left: 200 }}>
          <Plant />
        </div>
        <div style={{ position: 'absolute', bottom: 24, right: 220 }}>
          <Plant flip />
        </div>
      </div>
    </div>
  );
}
