import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

//Global Initialization...
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  fontFamily: 'inherit',
});

function MermaidDiagram({ code, title }) {
    const [svg, setSvg] = useState('');
    const [error, setError] = useState(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [scale, setScale] = useState(1);
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
  
    // Use refs for drag tracking — avoids re-renders during mouse move
    const isDragging = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
  
    useEffect(() => {
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      mermaid.render(id, code)
        .then(({ svg: rawSvg }) => {
          const responsive = rawSvg
            .replace(/width="[^"]*"/, 'width="100%"')
            .replace(/height="[^"]*"/, 'height="100%"');
          setSvg(responsive);
        })
        .catch(() => setError('Could not render diagram.'));
    }, [code]);
  
    const closeFullscreen = () => {
      setFullscreen(false);
      setScale(1);
      setPanOffset({ x: 0, y: 0 });
      setDragging(false);
      isDragging.current = false;
    };
  
    const handleMouseDown = (e) => {
      // Only trigger on left click
      if (e.button !== 0) return;
      isDragging.current = true;
      setDragging(true);
      lastMouse.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    };
  
    const handleMouseMove = (e) => {
      if (!isDragging.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      setPanOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    };
  
    const handleMouseUp = () => {
      isDragging.current = false;
      setDragging(false);
    };
  
    if (error) return <p className="text-xs" style={{ color: 'var(--dc-red)' }}>{error}</p>;
  
    return (
      <>
        {/* Inline preview */}
        <div
          className="relative group cursor-pointer overflow-hidden rounded-lg p-2"
          onClick={() => setFullscreen(true)}
          style={{ border: '1px solid var(--dc-border)', background: 'var(--dc-surface-2)' }}
        >
          <div
            className="custom-scrollbar pointer-events-none max-h-[420px] w-full overflow-auto"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <div className="absolute inset-0 rounded-lg transition flex items-center justify-center opacity-0 group-hover:opacity-100" style={{ background: 'rgba(0,0,0,0)' }}>
            <span className="text-xs px-2 py-1 rounded" style={{ color: 'var(--dc-text-primary)', background: 'rgba(0,0,0,0.6)' }}>
              Click to expand
            </span>
          </div>
        </div>
  
        {/* Fullscreen modal */}
        {fullscreen && (
          <div
            className="fixed inset-0 z-50 flex flex-col"
            onClick={closeFullscreen}
            style={{ background: 'rgba(0,0,0,0.9)' }}
          >
            {/* Top bar */}
            <div
              className="flex items-center justify-between px-6 py-3 shrink-0"
              onClick={(e) => e.stopPropagation()}
              style={{ borderBottom: '1px solid var(--dc-border)' }}
            >
              <p className="text-xs font-medium" style={{ color: 'var(--dc-text-muted)' }}>{title}</p>
  
              {/* Zoom controls */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setScale(s => Math.max(0.5, +(s - 0.25).toFixed(2)))}
                  className="w-7 h-7 rounded text-sm font-bold transition flex items-center justify-center"
                  style={{ background: 'var(--dc-surface-2)', color: 'var(--dc-text-primary)' }}
                >−</button>
                <span className="text-xs w-10 text-center" style={{ color: 'var(--dc-text-muted)' }}>
                  {Math.round(scale * 100)}%
                </span>
                <button
                  onClick={() => setScale(s => Math.min(3, +(s + 0.25).toFixed(2)))}
                  className="w-7 h-7 rounded text-sm font-bold transition flex items-center justify-center"
                  style={{ background: 'var(--dc-surface-2)', color: 'var(--dc-text-primary)' }}
                >+</button>
                <button
                  onClick={() => { setScale(1); setPanOffset({ x: 0, y: 0 }); }}
                  className="text-xs px-2 py-1 rounded ml-1"
                  style={{ color: 'var(--dc-text-muted)', background: 'var(--dc-surface-2)' }}
                >Reset</button>
              </div>
  
              <button
                onClick={closeFullscreen}
                className="text-lg font-bold leading-none transition"
                style={{ color: 'var(--dc-text-muted)' }}
              >✕</button>
            </div>
  
            {/* Diagram area — pan + zoom */}
            <div
              className="flex-1 overflow-hidden flex items-start justify-center p-8"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={(e) => {
                e.preventDefault();
                setScale(s => {
                  const next = s - e.deltaY * 0.001;
                  return Math.min(3, Math.max(0.5, +next.toFixed(2)));
                });
              }}
              style={{
                cursor: dragging ? 'grabbing' : 'grab',
              }}
            >
              <div
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${scale})`,
                  transformOrigin: 'top center',
                  transition: dragging ? 'none' : 'transform 0.15s ease',
                  width: '100%',
                  userSelect: 'none',
                }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
  
            {/* Hint bar */}
            <div className="text-center pb-3 shrink-0">
              <span className="text-[11px]" style={{ color: 'var(--dc-text-muted)' }}>
                Drag to pan · Scroll to zoom · Click outside to close
              </span>
            </div>
          </div>
        )}
      </>
    );
  }


function PlantUMLDiagram({ imageUrl, code, title }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div
        className="relative group cursor-pointer overflow-hidden rounded-lg p-2"
        onClick={() => setFullscreen(true)}
        style={{ border: '1px solid var(--dc-border)', background: 'var(--dc-surface-2)' }}
      >
        <img
          src={imageUrl}
          alt={title}
          className="custom-scrollbar max-h-[420px] w-full overflow-auto rounded-lg object-contain"
          style={{ border: '1px solid var(--dc-border)', background: 'transparent' }}
          onError={(e) => { e.target.style.display = 'none'; }}
        />
        <div className="absolute inset-0 rounded-lg transition flex items-center justify-center opacity-0 group-hover:opacity-100" style={{ background: 'rgba(0,0,0,0)' }}>
          <span className="text-xs px-2 py-1 rounded" style={{ color: 'var(--dc-text-primary)', background: 'rgba(0,0,0,0.6)' }}>Click to expand</span>
        </div>
      </div>
      <button onClick={copyCode} className="mt-1 text-[10px] transition" style={{ color: 'var(--dc-text-muted)' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--dc-text-primary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--dc-text-muted)'}>
        {copied ? '✓ Copied' : 'Copy PlantUML code'}
      </button>

      {fullscreen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             onClick={() => setFullscreen(false)}
             style={{ background: 'rgba(0,0,0,0.8)' }}>
          <div className="relative max-w-5xl max-h-full overflow-auto rounded-xl p-4"
               onClick={e => e.stopPropagation()}
               style={{ background: 'var(--dc-surface-1)' }}>
            <button onClick={() => setFullscreen(false)}
                    className="absolute top-2 right-2 text-lg"
                    style={{ color: 'var(--dc-text-muted)' }}>✕</button>
            <p className="text-xs mb-2 font-medium" style={{ color: 'var(--dc-text-muted)' }}>{title}</p>
            <img src={imageUrl} alt={title} className="max-w-full" />
          </div>
        </div>
      )}
    </>
  );
}

export default function DiagramRenderer({ diagrams = [] }) {
  if (!diagrams || diagrams.length === 0) return null;

  return (
    <div className="mt-4 space-y-4">
      {diagrams.map((diagram, i) => (
          <div key={i} className="rounded-xl p-3" style={{ border: '1px solid var(--dc-border)', background: 'var(--dc-surface-1)' }}>
          <p className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--dc-text-muted)' }}>
            {diagram.type === 'plantuml' ? 'PlantUML Diagram' : 'Mermaid Diagram'} — {diagram.title}
          </p>
          {diagram.type === 'plantuml' ? (
            <PlantUMLDiagram
              imageUrl={diagram.imageUrl}
              code={diagram.code}
              title={diagram.title}
            />
          ) : (
            <MermaidDiagram code={diagram.code} title={diagram.title} />
          )}
        </div>
      ))}
    </div>
  );
}
