import { useEffect, useId, useState } from "react";

/**
 * Circular percentage loader. None of our fetches expose real byte-level
 * progress, so the ring climbs asymptotically toward 95% (never claims
 * "done" on its own) — the caller swaps it for real content the instant
 * loading flips false, which reads as a satisfying final snap to 100%.
 *
 * Gradient runs brand red → brand yellow — the "juice fill" the shop's
 * colors already suggest — with a soft glow so it reads at a glance
 * instead of blending into the page like a plain spinner would.
 */
export function LoadingRing({ size = 88, label, showPercent = true, dark = false }: {
  size?: number;
  label?: string;
  showPercent?: boolean;
  /** Use on dark panel backgrounds (sidebars, dark stat bars) — swaps the track and percentage text for light equivalents. */
  dark?: boolean;
}) {
  const [pct, setPct] = useState(0);
  const gradId = useId();

  useEffect(() => {
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      setPct(95 * (1 - Math.exp(-(now - start) / 900)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const stroke = Math.max(3, size / 8);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const round = Math.round(pct);

  const ring = (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      {/* Soft ambient glow behind the ring — makes it read as "alive", not just a static gauge. */}
      <div
        className="absolute rounded-full animate-pulse"
        style={{ width: size * 0.85, height: size * 0.85, background: "radial-gradient(circle, rgba(220,38,38,0.16) 0%, rgba(251,191,36,0.06) 60%, transparent 75%)" }}
      />
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#dc2626" />
            <stop offset="100%" stopColor="#fbbf24" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className={dark ? "text-white/10" : "text-slate-100"} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${gradId})`} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.08s linear", filter: "drop-shadow(0 1px 4px rgba(220,38,38,0.35))" }}
        />
      </svg>
      {showPercent && size >= 40 && (
        <span className={`absolute font-extrabold tabular-nums tracking-tight ${dark ? "text-white" : "text-slate-800"}`} style={{ fontSize: size / 3.4 }}>
          {round}<span style={{ fontSize: size / 6, color: dark ? "#fde68a" : "#d97706" }}>%</span>
        </span>
      )}
    </div>
  );

  if (!label) return ring;
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10">
      {ring}
      <div className={`text-sm font-medium tracking-wide ${dark ? "text-slate-300" : "text-slate-500"}`}>{label}</div>
    </div>
  );
}
