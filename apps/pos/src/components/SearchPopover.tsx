import type { Item } from "../api";

export function SearchPopover({
  items, onPick,
}: {
  items: Item[];
  onPick: (item: Item) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 divide-y divide-slate-100 max-h-72 overflow-auto border rounded-lg bg-white">
      {items.map((it) => (
        <li key={it.id}>
          <button
            type="button"
            onClick={() => onPick(it)}
            className="w-full px-3 py-2 flex items-center gap-3 hover:bg-sjc-50 text-left"
          >
            <span className="font-mono text-xs text-slate-400 w-10">#{it.itemCode}</span>
            <span className="flex-1">
              <span className="font-medium">{it.name}</span>
              {it.size !== "NA" && (
                <span className="ml-2 text-xs rounded bg-slate-100 px-1 py-0.5 text-slate-600">
                  {it.size}
                </span>
              )}
            </span>
            <span className="font-mono text-sm text-slate-600">PKR {it.price}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
