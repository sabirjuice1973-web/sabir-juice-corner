# Brand assets — drop your logo files here

The POS app looks for these files at runtime and shows them in place of the inline SVG fallback:

| File              | Used by                                                 |
|-------------------|---------------------------------------------------------|
| `logo.png`        | Full-colour logo — login screen hero, header, receipts  |
| `logo-mono.png`   | Black-and-white logo — for monochrome receipt printing  |
| `wordmark.png`    | Just the "SABIR 1973" wordmark (optional)               |
| `icon-192.png`    | PWA app icon (192×192) — Android home screen            |
| `icon-512.png`    | PWA app icon (512×512) — splash screen                  |
| `favicon.ico`     | Browser tab icon (32×32 inside an .ico)                 |

## To install your branding

1. Save the colour logo screenshot you shared as `logo.png` in **this directory** (`apps/pos/public/`).
2. Save the black-and-white version as `logo-mono.png` in the same directory.
3. For the PWA icons: export `logo.png` at 192×192 and 512×512 with a transparent background.
4. Reload the POS in your browser — `Ctrl+Shift+R` to bypass cache. The logo replaces the SVG fallback automatically.

## Same files also belong in admin

Mirror the same files into `apps/admin/public/` so the admin app uses your real artwork too.

## Acceptable formats

PNG (preferred), JPG, or SVG all work. Transparent background is best for header use.
