import { useMemo } from "react";
import { displayItemName, type BoxOrder } from "../pos/posState";

/**
 * "All Orders" aggregation column — runs the full height of the screen on the
 * extreme left of both the POS and the Kitchen screens.
 *
 * Purpose: at a glance, a cashier or kitchen worker can see exactly how many
 * glasses of each item still need to be prepared, summed across every
 * undelivered order in every box.
 *
 * Rules:
 *   • Only UNDELIVERED orders contribute (deliveredAt == null).
 *   • One row per distinct item — same item across multiple orders is summed.
 *     "Mango Medium" appearing in 3 orders with qty 2 + 3 + 5 → one row, qty 10.
 *   • Mixes ("Lychee Juice+Plum Medium") count as their own item — the panel
 *     does not split a mix into its two component fruits because the kitchen
 *     prepares them as one drink.
 *   • Rows sorted by qty descending so the biggest demand is at the top.
 *   • Footer shows total undelivered glasses + total undelivered orders.
 *
 * Layout: fixed-width column that scrolls vertically when the menu has more
 * rows than will fit on one screen.
 */

type Props = {
  boxes: BoxOrder[][];
  // Optional class extensions so the POS and Kitchen variants can tweak chrome
  // (e.g. different header background, larger font on kitchen).
  className?: string;
  largeFont?: boolean;   // Kitchen screen uses larger type for visibility from across the room
};

export function AllOrdersPanel({ boxes, className = "", largeFont = false }: Props) {
  const { rows, totalGlasses, totalOrders } = useMemo(() => {
    // Aggregate undelivered lines. Key by full display name (which already
    // includes the size word for single items) — this naturally keeps
    // "Mango Medium" and "Mango Jumbo" as separate rows even though the
    // underlying `name` is just "Mango" for both.
    const acc = new Map<string, { displayName: string; baseName: string; qty: number }>();
    let undeliveredOrderCount = 0;
    for (const box of boxes) {
      for (const order of box) {
        if (order.deliveredAt) continue;
        undeliveredOrderCount++;
        for (const li of order.lines) {
          const displayName = displayItemName(li.name, li.size);
          const slot = acc.get(displayName) ?? { displayName, baseName: li.name, qty: 0 };
          slot.qty += li.qty;
          acc.set(displayName, slot);
        }
      }
    }
    // Compute total glasses per base name so Medium + Jumbo of the same fruit
    // are sorted together — e.g. "Mango Jumbo 5, Mango Medium 3" appear
    // consecutively, ordered by the group's combined total (8), not individually.
    const groupTotal = new Map<string, number>();
    for (const { baseName, qty } of acc.values()) {
      groupTotal.set(baseName, (groupTotal.get(baseName) ?? 0) + qty);
    }
    const rows = [...acc.values()].sort((a, b) => {
      const gDiff = (groupTotal.get(b.baseName) ?? 0) - (groupTotal.get(a.baseName) ?? 0);
      return gDiff !== 0 ? gDiff : b.qty - a.qty;
    });
    const totalGlasses = rows.reduce((s, r) => s + r.qty, 0);
    return { rows, totalGlasses, totalOrders: undeliveredOrderCount };
  }, [boxes]);

  const qtyText = (n: number) => Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/\.?0+$/, "");
  const fontSize = largeFont ? "text-base" : "text-sm";
  const badgeClass = largeFont
    ? "inline-flex items-center justify-center rounded-full bg-red-600 text-white font-bold leading-none px-1 text-[15px] h-6 min-w-[24px]"
    : "inline-flex items-center justify-center rounded-full bg-red-600 text-white font-bold leading-none px-1 text-[14px] h-[22px] min-w-[22px]";

  return (
    <aside className={`flex flex-col bg-white border-r-2 border-slate-300 ${className}`}>
      <div className="px-3 py-1.5" style={{ background: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)", borderBottom: "2px solid #26d0ce" }}>
        <div className="font-bold tracking-wide" style={{ color: "#ffffff" }}>All Orders</div>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "#a5f3fc" }}>Undelivered totals</div>
      </div>

      <ul className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {rows.length === 0 ? (
          <li className="text-center text-slate-300 text-xs py-6 px-2">No undelivered orders.</li>
        ) : rows.map((r) => (
          <li
            key={r.displayName}
            className={`px-3 py-1.5 flex items-center gap-2 ${fontSize}`}
            title={`${qtyText(r.qty)} × ${r.displayName}`}
          >
            <span className={badgeClass}>{qtyText(r.qty)}</span>
            <span className="flex-1 truncate font-medium text-slate-900">{r.displayName}</span>
          </li>
        ))}
      </ul>

      <div className="border-t-2 border-slate-300 bg-slate-50 px-3 py-2 text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-slate-600">Glasses to make</span>
          <span className="font-mono font-bold text-slate-900">{qtyText(totalGlasses)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-600">Pending orders</span>
          <span className="font-mono font-bold text-slate-900">{totalOrders}</span>
        </div>
      </div>
    </aside>
  );
}
