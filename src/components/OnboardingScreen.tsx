import type { ReactNode } from 'react';
import { Doodle, DoodleScatter } from './primitives';
import { store, useStore } from '../game/store';

interface Card {
  bg: string;
  title: string;
  body: string;
  icon: ReactNode;
  tag: string;
}

const CARDS: Card[] = [
  {
    bg: 'var(--peach)',
    title: '这是什么。',
    body:
      '这是一个临床试验入组前沟通训练模拟器。你将面对尚未签署知情同意、尚未进入筛选的标准化受试者，练习研究介绍、知情同意、入排标准核实、风险说明、顾虑回应和理解确认。每位受试者都有完整的试验背景与决策偏好。',
    icon: <Doodle kind="stetho" size={140} color="var(--mint)" />,
    tag: '01 · 认识模拟器',
  },
  {
    bg: 'var(--mint)',
    title: '它如何运作。',
    body:
      '选择一个试验项目后，潜在受试者进入入组咨询室。你通过语音或文字解释研究并了解其病史、近期用药、既往试验经历和主要顾虑。结束后，系统按 GCP/ICH 与 NURSE/SEGUE/ICE 沟通框架复盘。每例约 12-15 分钟。',
    icon: <Doodle kind="cross" size={140} color="#F47A92" />,
    tag: '02 · 训练循环',
  },
  {
    bg: 'var(--sky)',
    title: '适用人群。',
    body:
      '面向临床研究协调员（CRC）、研究护士、研究医生及相关培训人员。这是一个沟通技能培训模拟器，而非临床决策工具，绝不可用于指导真实试验操作。',
    icon: <Doodle kind="heart" size={140} color="#F47A92" />,
    tag: '03 · 安全须知',
  },
];

export function OnboardingScreen() {
  const step = useStore((s) => s.onboardingStep);
  const card = CARDS[step];

  return (
    <div className="screen bg-cream-2" style={{ position: 'relative' }}>
      <DoodleScatter
        items={[
          { kind: 'sparkle', x: 60, y: 70, size: 28, color: '#FFD86B' },
          { kind: 'sparkle', x: '85%', y: 130, size: 24, color: '#5AB7F2' },
          { kind: 'star', x: 80, y: 580, size: 32, color: '#FFD86B', anim: 'wobble' },
          { kind: 'pill', x: '88%', y: 600, size: 60, anim: 'wobble' },
        ]}
      />

      <div
        style={{
          position: 'absolute',
          top: 38,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 8,
          zIndex: 5,
        }}
      >
        {CARDS.map((_, i) => (
          <div
            key={i}
            style={{
              width: i === step ? 32 : 12,
              height: 12,
              borderRadius: 8,
              background: i === step ? 'var(--peach-deep)' : 'white',
              border: '2.5px solid var(--line)',
              boxShadow: '0 2px 0 var(--line)',
              transition: 'width 200ms cubic-bezier(.5,1.7,.4,1)',
            }}
          />
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 60,
        }}
      >
        <div
          className="plush-lg popin"
          key={step}
          style={{ width: 720, padding: 40, background: card.bg, position: 'relative', transform: 'rotate(-1deg)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <div className="floaty" style={{ flexShrink: 0 }}>
              <div
                className="plush"
                style={{
                  width: 200,
                  height: 200,
                  background: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {card.icon}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="chip" style={{ background: 'white', marginBottom: 16 }}>
                {card.tag}
              </div>
              <h1 style={{ fontSize: 44, lineHeight: 1.05, marginBottom: 14, color: 'var(--ink)' }}>{card.title}</h1>
              <div style={{ fontSize: 17, lineHeight: 1.5, fontWeight: 600, color: 'var(--ink)' }}>{card.body}</div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 36,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <button
          type="button"
          className="btn-plush ghost"
          style={{ visibility: step === 0 ? 'hidden' : 'visible' }}
          onClick={() => store.setOnboardingStep(step - 1)}
        >
          ← 上一步
        </button>
        {step < CARDS.length - 1 ? (
          <button type="button" className="btn-plush primary" onClick={() => store.setOnboardingStep(step + 1)}>
            下一步 →
          </button>
        ) : (
          <button
            type="button"
            className="btn-plush primary breathe"
            style={{ fontSize: 20 }}
            onClick={() => store.finishOnboarding()}
          >
            进入应用 →
          </button>
        )}
      </div>
    </div>
  );
}
