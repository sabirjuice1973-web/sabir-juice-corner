/**
 * Sabir Juice Corner brand logo (admin app — mirror of POS BrandLogo).
 * See `apps/pos/src/components/BrandLogo.tsx` for design notes.
 */
import { useEffect, useState } from "react";

type Variant = "color" | "mono" | "solid" | "stacked";

type Props = {
  size?: number;
  variant?: Variant;
  withWordmark?: boolean;
  className?: string;
};

const ASSET_BY_VARIANT: Record<Variant, string> = {
  color: "/logo.png",
  mono: "/logo-mono.png",
  solid: "/logo-solid.png",
  stacked: "/logo-stacked.png",
};

export function BrandLogo({ size = 96, variant = "color", withWordmark = true, className = "" }: Props) {
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  useEffect(() => {
    const candidate = ASSET_BY_VARIANT[variant];
    fetch(candidate, { method: "HEAD" }).then((r) => { if (r.ok) setLogoSrc(candidate); }).catch(() => {});
  }, [variant]);

  if (logoSrc) {
    if (variant === "stacked") {
      return <img src={logoSrc} alt="Sabir Juice Corner" style={{ height: size, width: "auto", objectFit: "contain" }} className={className} />;
    }
    return <img src={logoSrc} alt="Sabir Juice Corner" width={size} height={size} className={className} style={{ objectFit: "contain" }} />;
  }

  const isMonoFallback = variant === "mono" || variant === "solid";
  const yellow = !isMonoFallback ? "#f59e0b" : "#1f2937";
  const red    = !isMonoFallback ? "#dc2626" : "#1f2937";
  const green  = !isMonoFallback ? "#16a34a" : "#374151";
  const text   = !isMonoFallback ? "#dc2626" : "#1f2937";

  return (
    <svg width={variant === "stacked" ? size * 0.8 : size} height={size} viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sabir Juice Corner logo" className={className}>
      <ellipse cx="22" cy="22" rx="9" ry="5" fill={green} transform="rotate(-30 22 22)" />
      <ellipse cx="32" cy="14" rx="7" ry="4" fill={green} transform="rotate(20 32 14)" />
      <path d="M 78 8 L 90 38 L 84 40 L 72 12 Z" fill={red} />
      <path d="M 10 28 Q 60 18 110 28 Q 105 65 100 90 Q 88 130 60 130 Q 32 130 20 90 Q 15 65 10 28 Z" fill={yellow} />
      {withWordmark && (
        <>
          <text x="60" y="78" textAnchor="middle" fontFamily="Georgia, serif" fontSize="22" fontWeight="900" fontStyle="italic" fill="#ffffff" stroke={!isMonoFallback ? "#b45309" : "#000000"} strokeWidth="1" letterSpacing="1">SABIR</text>
          <text x="60" y="96" textAnchor="middle" fontFamily="Georgia, serif" fontSize="11" fontWeight="700" fill={text} letterSpacing="2">1973</text>
        </>
      )}
      <path d="M 50 130 Q 60 142 70 130 Z" fill={yellow} />
    </svg>
  );
}
