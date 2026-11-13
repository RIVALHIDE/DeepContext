import React from 'react';

const BRAND = '#00C9B1';
const GLOW  = '#00F5D4';
const DIM   = 'rgba(0, 201, 177, 0.18)';

export default function SonarGlyph({ state = 'idle', size = 40, className = '' }) {
  const r    = size / 2;
  const cx   = r;
  const cy   = r;
  const core = size * 0.13;
  const arc1 = size * 0.24;
  const arc2 = size * 0.36;
  const arc3 = size * 0.46;

  const isThinking   = state === 'thinking';
  const isGenerating = state === 'generating';
  const isActive     = isThinking || isGenerating;

  const stateClass = isGenerating
    ? 'dc-sonar--generating'
    : isThinking
      ? 'dc-sonar--thinking'
      : '';

  return (
    <>
      <style>{`
        @keyframes dc-pulse-1 { 0%,100% { opacity:.85; r:${arc1}px; } 50% { opacity:.40; r:${arc1*1.12}px; } }
        @keyframes dc-pulse-2 { 0%,100% { opacity:.55; r:${arc2}px; } 50% { opacity:.20; r:${arc2*1.10}px; } }
        @keyframes dc-pulse-3 { 0%,100% { opacity:.30; r:${arc3}px; } 50% { opacity:.08; r:${arc3*1.08}px; } }
        @keyframes dc-sonar-ping { 0% { opacity:.9; r:${core}px; } 60% { opacity:.4; r:${arc3*0.85}px; } 100% { opacity:0; r:${arc3}px; } }
        @keyframes dc-core-breathe { 0%,100% { opacity:1; r:${core}px; } 50% { opacity:.6; r:${core*0.8}px; } }
        @keyframes dc-core-ping    { 0%,100% { opacity:1; r:${core}px; } 40% { opacity:.5; r:${core*0.7}px; } }

        .dc-sonar--thinking .dc-arc-1 { animation: dc-pulse-1 2.2s ease-in-out infinite; }
        .dc-sonar--thinking .dc-arc-2 { animation: dc-pulse-2 2.2s ease-in-out .3s infinite; }
        .dc-sonar--thinking .dc-core  { animation: dc-core-breathe 2.2s ease-in-out infinite; }

        .dc-sonar--generating .dc-arc-1 { animation: dc-pulse-1 1.4s ease-in-out infinite; }
        .dc-sonar--generating .dc-arc-2 { animation: dc-pulse-2 1.4s ease-in-out .22s infinite; }
        .dc-sonar--generating .dc-arc-3 { animation: dc-pulse-3 1.4s ease-in-out .44s infinite; }
        .dc-sonar--generating .dc-ping  { animation: dc-sonar-ping 1.4s ease-out infinite; }
        .dc-sonar--generating .dc-core  { animation: dc-core-ping 1.4s ease-in-out infinite; }
      `}</style>

      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        fill="none" className={`${stateClass} ${className}`}
        style={{ flexShrink: 0 }} aria-hidden="true"
      >
        {isActive && <circle cx={cx} cy={cy} r={r} fill={DIM} />}

        {isGenerating && (
          <circle className="dc-arc-3" cx={cx} cy={cy} r={arc3}
            stroke={BRAND} strokeWidth={size * 0.025} opacity={0.28} />
        )}

        <circle className="dc-arc-2" cx={cx} cy={cy} r={arc2}
          stroke={BRAND} strokeWidth={size * 0.03} opacity={isActive ? 0.5 : 0.22} />

        <circle className="dc-arc-1" cx={cx} cy={cy} r={arc1}
          stroke={BRAND} strokeWidth={size * 0.04} opacity={isActive ? 0.75 : 0.45} />

        {isGenerating && (
          <circle className="dc-ping" cx={cx} cy={cy} r={core} fill={GLOW} opacity={0} />
        )}

        <circle
          className="dc-core" cx={cx} cy={cy} r={core}
          fill={isActive ? GLOW : BRAND}
          style={{ filter: isActive ? `drop-shadow(0 0 ${size * 0.12}px ${GLOW})` : 'none' }}
        />

        <path
          d={`M ${cx} ${cy - arc2 * 0.9} A ${arc2 * 0.9} ${arc2 * 0.9} 0 0 1 ${cx} ${cy + arc2 * 0.9}`}
          stroke={GLOW} strokeWidth={size * 0.045} strokeLinecap="round"
          opacity={isActive ? 0.6 : 0.35} fill="none"
        />
      </svg>
    </>
  );
}
