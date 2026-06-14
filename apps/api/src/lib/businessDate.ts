import { prisma } from "@sjc/db";

/**
 * Return the active business date for a branch as a Date set to midnight UTC.
 *
 * Why this helper exists: every order/shift/expense/transfer creation reads
 * branch.currentBusinessDate to stamp a businessDate column. Centralising the
 * fetch keeps one definition of "the branch's today" and one place to add
 * caching later if profiling shows the per-request lookup matters.
 *
 * Throws if the branch doesn't exist — callers should pre-validate the branchId
 * with their normal route logic (404 etc.) before reaching here.
 */
export async function getBranchBusinessDate(branchId: bigint, tx?: { branch: typeof prisma.branch }): Promise<Date> {
  const client = tx ?? prisma;
  const row = await client.branch.findUnique({
    where: { id: branchId },
    select: { currentBusinessDate: true },
  });
  if (!row) throw new Error(`Branch ${branchId} not found`);
  // The column is DATE so Postgres returns it as a Date at midnight in the
  // server's timezone. Normalize to midnight UTC so reports don't drift
  // depending on the API process' TZ.
  const d = row.currentBusinessDate;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * Format a Date as YYYYMMDD for use in order numbers like B2-20260528-0001.
 * Pulls the date components in UTC so the rendered prefix matches the DATE
 * column stored in Postgres byte-for-byte.
 */
export function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
