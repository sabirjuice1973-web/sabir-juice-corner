import type { Decimal } from "@prisma/client/runtime/library";

/** Recursively turn BigInts → strings and Decimals → string-encoded numbers so JSON.stringify works. */
export function toJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object" && "toFixed" in (v as object) && typeof (v as Decimal).toFixed === "function") {
        return (v as Decimal).toString();
      }
      return v;
    }),
  );
}
