import type { ReactNode } from 'react';

export function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'brand'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Card({ title, hint, right, children, className = '' }: { title?: string; hint?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <h2>
          {title}
          {hint ? <span className="hint">{hint}</span> : null}
          {right ? <span style={{ marginLeft: 'auto' }}>{right}</span> : null}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Switch({ checked, onChange, title, desc }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc?: string }) {
  return (
    <label className="switch">
      <span>
        <span className="t">{title}</span>
        {desc ? <span className="d" style={{ display: 'block' }}>{desc}</span> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {help ? <span className="help">{help}</span> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Banner({ tone, children, right }: { tone: 'bad' | 'warn' | 'info'; children: ReactNode; right?: ReactNode }) {
  return (
    <div className={`banner ${tone}`}>
      <div className="grow">{children}</div>
      {right}
    </div>
  );
}
