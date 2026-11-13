import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';

export default function ConfirmModal({
  isOpen,
  title = 'Confirm',
  description = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm = () => {},
  onCancel = () => {},
}) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement;
    const toFocus = confirmRef.current || cancelRef.current;
    toFocus?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter' && document.activeElement !== cancelRef.current) {
        e.preventDefault();
        onConfirm();
      }
      if (e.key === 'Tab') {
        // very small focus trap between confirm and cancel
        const focusable = [confirmRef.current, cancelRef.current].filter(Boolean);
        if (focusable.length === 0) return;
        const idx = focusable.indexOf(document.activeElement);
        if (e.shiftKey) {
          const next = focusable[(idx - 1 + focusable.length) % focusable.length];
          next?.focus();
          e.preventDefault();
        } else {
          const next = focusable[(idx + 1) % focusable.length];
          next?.focus();
          e.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      try { previouslyFocused.current?.focus(); } catch {}
    };
  }, [isOpen, onCancel, onConfirm]);

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dc-confirm-title"
      aria-describedby="dc-confirm-desc"
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', padding: 20, zIndex: 1100 }}
    >
      <div
        className="rounded-xl p-6"
        style={{
          width: 520,
          maxWidth: 'calc(100% - 32px)',
          background: 'var(--dc-surface-1)',
          border: '1px solid var(--dc-border)',
          boxShadow: 'var(--dc-shadow-card)',
        }}
      >
        <h3 id="dc-confirm-title" className="text-lg font-semibold" style={{ color: 'var(--dc-text-primary)', margin: 0 }}>
          {title}
        </h3>
        {description ? (
          <p id="dc-confirm-desc" className="text-sm mt-2" style={{ color: 'var(--dc-text-muted)', margin: 0 }}>
            {description}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-md px-4 py-2"
            style={{
              background: 'transparent',
              border: '1px solid var(--dc-border)',
              color: 'var(--dc-text-secondary)',
            }}
          >
            {cancelLabel}
          </button>

          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="rounded-md px-4 py-2"
            style={{
              background: danger ? 'var(--dc-red)' : 'var(--dc-brand)',
              color: 'var(--dc-text-inverse)',
              border: '1px solid rgba(0,0,0,0)',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
