import { useState } from "react";
import { printPriceSlips } from "../pos/receipt";

/**
 * Price Slip — replaces the old cut-paper-and-tape method for updating a
 * printed menu card's price. Type the new rate(s), print, scissor along
 * each box's black border, paste over the old price field.
 *
 * Cells are grouped in rows of 4 because that's what fits across an 80mm
 * thermal roll at roughly the size of a menu card's price field. "+ Add
 * row" appends another 4 empty cells for updating several items at once;
 * empty cells are simply skipped on print, so a partial last row is fine.
 */
const CELLS_PER_ROW = 4;

export function PriceSlipModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<string[][]>([Array(CELLS_PER_ROW).fill("")]);
  const [error, setError] = useState<string | null>(null);

  function setCell(rowIdx: number, cellIdx: number, value: string) {
    const cleaned = value.replace(/[^0-9.]/g, "");
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      next[rowIdx][cellIdx] = cleaned;
      return next;
    });
  }

  function addRow() {
    setRows((prev) => [...prev, Array(CELLS_PER_ROW).fill("")]);
  }

  function handlePrint() {
    const prices = rows.flat()
      .map((v) => parseFloat(v))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length === 0) {
      setError("Enter at least one price");
      return;
    }
    setError(null);
    printPriceSlips(prices);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold">Price Slip</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Type the new rate(s), print, then cut along each box's border and paste it over the old price on the menu card.
        </p>

        <div className="space-y-2 mb-3">
          {rows.map((row, rowIdx) => (
            <div key={rowIdx} className="grid grid-cols-4 gap-2">
              {row.map((value, cellIdx) => (
                <input
                  key={cellIdx}
                  type="number" min="0" step="any"
                  autoFocus={rowIdx === 0 && cellIdx === 0}
                  className="input w-full text-center font-mono text-lg py-2"
                  placeholder="0"
                  value={value}
                  onChange={(e) => setCell(rowIdx, cellIdx, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handlePrint(); }}
                />
              ))}
            </div>
          ))}
        </div>

        <button type="button" onClick={addRow} className="btn-secondary text-xs w-full mb-3">
          + Add row (4 more)
        </button>

        {error && <div className="text-sm text-red-600 mb-3">{error}</div>}

        <button onClick={handlePrint} className="btn-primary w-full">
          Print Slips
        </button>
      </div>
    </div>
  );
}
