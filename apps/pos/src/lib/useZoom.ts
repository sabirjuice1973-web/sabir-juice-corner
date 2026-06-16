import { useState } from "react";

const STEP = 0.1;
const MIN  = 0.5;
const MAX  = 1.5;

export function useZoom(storageKey: string) {
  const [zoom, setZoom] = useState<number>(() => {
    try { return Number(localStorage.getItem(storageKey) ?? "1") || 1; }
    catch { return 1; }
  });
  const [savedZoom, setSavedZoom] = useState(zoom);

  const dirty = zoom !== savedZoom;
  const pct   = Math.round(zoom * 100);

  function zoomIn()  { setZoom((z) => Math.min(MAX, Math.round((z + STEP) * 10) / 10)); }
  function zoomOut() { setZoom((z) => Math.max(MIN, Math.round((z - STEP) * 10) / 10)); }
  function save()    { localStorage.setItem(storageKey, String(zoom)); setSavedZoom(zoom); }

  return { zoom, pct, zoomIn, zoomOut, save, dirty };
}
