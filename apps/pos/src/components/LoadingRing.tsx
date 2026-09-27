import { useEffect, useState } from "react";

/**
 * Circular percentage loader. None of our fetches expose real byte-level
 * progress, so the ring climbs asymptotically toward 95% (never claims
 * "done" on its own) — the caller swaps it for real content the instant
 * loading flips false, which reads as a satisfying final snap to 100%.
 */
export function LoadingRing({ size = 40, label, showPercent = true }: {
  size?: number;
  label?: string;
  showPercent?: boolean;
}) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      setPct(95 * (1 - Math.exp(-(now - start) / 700)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const stroke = Math.max(2, size / 12);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);

  const ring = (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-slate-200" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke}
          strokeLinecap="round" className="text-accent-600" strokeDasharray={c} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.08s linear" }}
        />
      </svg>
      {showPercent && size >= 28 && (
        <span className="absolute font-bold text-slate-600 tabular-nums" style={{ fontSize: Math.max(8, size / 4) }}>
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );

  if (!label) return ring;
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6">
      {ring}
      <div className="text-slate-400 text-sm">{label}</div>
    </div>
  );
}
