import SonarGlyph from './SonarGlyph';

export default function LogoLockup({ state = 'idle', size = 34 }) {
  return (
    <div className="flex items-center gap-3 select-none">
      <SonarGlyph state={state} size={size} />
      <div className="flex flex-col leading-none">
        <span
          className="font-bold tracking-tight text-sm"
          style={{ color: 'var(--dc-text-primary)', letterSpacing: '-0.02em' }}
        >
          DeepContext
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.16em] font-medium mt-0.5"
          style={{ color: 'var(--dc-brand)', opacity: 0.8 }}
        >
          Knowledge Engine
        </span>
      </div>
    </div>
  );
}
