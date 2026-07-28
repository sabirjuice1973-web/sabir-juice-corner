/**
 * Printer icon as inline SVG instead of the 🖨 emoji — the emoji renders as a
 * tiny, faint monochrome glyph on Windows/Chrome (no color emoji font in that
 * context), making print buttons hard to spot. This renders crisply at any
 * size and inherits the button's text color via currentColor.
 */
export function PrinterIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}
