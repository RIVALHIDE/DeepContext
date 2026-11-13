export default function ThinkingIndicator() {
  return (
    <div className="flex items-start gap-3 py-1">
      <div
        className="rounded-2xl rounded-tl-sm px-4 py-3 text-sm flex items-center"
        style={{
          background: 'var(--dc-surface-1)',
          border: '1px solid var(--dc-border)',
          color: 'var(--dc-text-secondary)',
          maxWidth: '70%',
        }}
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: 9999,
                background: 'var(--dc-text-muted)',
                display: 'inline-block',
                animation: `dc-typing-dot 1.2s ease-in-out ${i * 0.18}s infinite`,
              }}
            />
          ))}
        </div>
      <style>{`
        @keyframes dc-typing-dot {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
      </div>
    </div>
  );
}
