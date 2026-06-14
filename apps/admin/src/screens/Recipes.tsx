import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

type Item = { id: string; itemCode: number; name: string; size: string; price: string };
type RawMaterial = { id: string; name: string; defaultUnit: { code: string } };
type Processed = { id: string; name: string };
type Ingredient = {
  ingredientType: "RAW_MATERIAL" | "PROCESSED_PRODUCT" | "PACKAGING" | "OTHER";
  rawMaterialId?: string;
  processedProductId?: string;
  quantity: string;
  unitCode: string;
};

export function Recipes() {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<Item | null>(null);
  const [recipeByItem, setRecipeByItem] = useState<Map<string, any>>(new Map());

  useEffect(() => {
    const t = setTimeout(async () => {
      if (search.length < 2) { setItems([]); return; }
      const r = await api<{ items: Item[] }>("GET", `/items?q=${encodeURIComponent(search)}&limit=20`);
      setItems(r.items);
      // Best-effort: fetch existing recipes for these items
      const map = new Map();
      await Promise.all(r.items.map(async (it) => {
        try {
          const rec = await api<{ recipe: any }>("GET", `/catalog/recipes/by-item/${it.id}`);
          map.set(it.id, rec.recipe);
        } catch {}
      }));
      setRecipeByItem(map);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Recipes</h1>
      </div>

      <div className="card p-4 space-y-3">
        <Field label="Search menu items (by name)">
          <input className="input w-full" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. Peach, Mango, Apple…" />
        </Field>
        {items.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Code</th><th>Item</th><th>Price</th><th>Recipe</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const recipe = recipeByItem.get(it.id);
                return (
                  <tr key={it.id}>
                    <td className="font-mono text-xs">#{it.itemCode}</td>
                    <td className="font-medium">{it.name} {it.size !== "NA" && <span className="text-xs text-slate-500">({it.size})</span>}</td>
                    <td className="font-mono">{it.price}</td>
                    <td>
                      {recipe
                        ? <span className="pill bg-emerald-100 text-emerald-800">v{recipe.version} · {recipe.ingredients?.length ?? 0} ingredient(s)</span>
                        : <span className="pill bg-slate-100 text-slate-600">none</span>}
                    </td>
                    <td className="text-right">
                      <button className="btn-ghost text-xs" onClick={() => setEditing(it)}>{recipe ? "New version" : "Add recipe"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <RecipeForm
          item={editing}
          existing={recipeByItem.get(editing.id)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            // refresh recipe for this item
            try {
              const r = await api<{ recipe: any }>("GET", `/catalog/recipes/by-item/${editing.id}`);
              const m = new Map(recipeByItem);
              m.set(editing.id, r.recipe);
              setRecipeByItem(m);
            } catch {}
          }}
        />
      )}
    </div>
  );
}

function RecipeForm({ item, existing, onClose, onSaved }: { item: Item; existing: any; onClose: () => void; onSaved: () => void }) {
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [processed, setProcessed] = useState<Processed[]>([]);
  const [yieldQty, setYieldQty] = useState("1");
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    existing?.ingredients?.map((i: any) => ({
      ingredientType: i.ingredientType,
      rawMaterialId: i.rawMaterialId?.toString(),
      processedProductId: i.processedProductId?.toString(),
      quantity: i.quantity,
      unitCode: i.unit.code,
    })) ?? [{ ingredientType: "PROCESSED_PRODUCT", quantity: "", unitCode: "shoper" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ rawMaterials: RawMaterial[] }>("GET", "/raw-materials"),
      api<{ processedProducts: Processed[] }>("GET", "/catalog/processed"),
    ]).then(([r, p]) => { setRawMaterials(r.rawMaterials); setProcessed(p.processedProducts); });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", "/catalog/recipes", {
        itemId: Number(item.id),
        yieldQty: Number(yieldQty),
        ingredients: ingredients.filter((i) => i.quantity).map((i) => ({
          ingredientType: i.ingredientType,
          rawMaterialId: i.ingredientType === "RAW_MATERIAL" ? Number(i.rawMaterialId) : undefined,
          processedProductId: i.ingredientType === "PROCESSED_PRODUCT" ? Number(i.processedProductId) : undefined,
          quantity: Number(i.quantity),
          unitCode: i.unitCode,
        })),
      });
      onSaved();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Recipe — ${item.name} ${item.size !== "NA" ? `(${item.size})` : ""}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <Field label="Yield (units this recipe produces, usually 1 glass)">
          <input className="input w-full" inputMode="numeric" value={yieldQty} onChange={(e) => setYieldQty(e.target.value.replace(/[^0-9]/g, ""))} />
        </Field>

        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Ingredients</div>
            <button type="button" className="text-xs text-sjc-700 hover:underline" onClick={() => setIngredients([...ingredients, { ingredientType: "PROCESSED_PRODUCT", quantity: "", unitCode: "shoper" }])}>
              + Add ingredient
            </button>
          </div>
          {ingredients.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <select className="input col-span-3" value={row.ingredientType} onChange={(e) => updateAt(setIngredients, ingredients, idx, { ingredientType: e.target.value as any })}>
                <option value="PROCESSED_PRODUCT">Processed</option>
                <option value="RAW_MATERIAL">Raw</option>
                <option value="PACKAGING">Packaging</option>
                <option value="OTHER">Other</option>
              </select>
              {row.ingredientType === "RAW_MATERIAL" ? (
                <select className="input col-span-4" value={row.rawMaterialId ?? ""} onChange={(e) => updateAt(setIngredients, ingredients, idx, { rawMaterialId: e.target.value })}>
                  <option value="">— pick raw —</option>
                  {rawMaterials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              ) : row.ingredientType === "PROCESSED_PRODUCT" ? (
                <select className="input col-span-4" value={row.processedProductId ?? ""} onChange={(e) => updateAt(setIngredients, ingredients, idx, { processedProductId: e.target.value })}>
                  <option value="">— pick processed —</option>
                  {processed.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (
                <input className="input col-span-4" placeholder="(informational only)" disabled />
              )}
              <input className="input col-span-2 font-mono" placeholder="qty" value={row.quantity} onChange={(e) => updateAt(setIngredients, ingredients, idx, { quantity: e.target.value.replace(/[^0-9.]/g, "") })} />
              <input className="input col-span-2" placeholder="unit" value={row.unitCode} onChange={(e) => updateAt(setIngredients, ingredients, idx, { unitCode: e.target.value })} />
              <button type="button" className="col-span-1 text-slate-400 hover:text-red-600" onClick={() => setIngredients(ingredients.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </div>

        {existing && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            Saving creates <b>version {(existing.version ?? 0) + 1}</b> and deactivates v{existing.version}.
            Past sales keep using whichever version was active when they happened.
          </div>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Saving…" : "Save recipe"}</button>
        </div>
      </form>
    </Modal>
  );
}

function updateAt<T>(setter: (rows: T[]) => void, rows: T[], idx: number, patch: Partial<T>) {
  setter(rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
}
