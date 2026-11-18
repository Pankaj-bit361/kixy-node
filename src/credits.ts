import { AppError } from "./errors.js";
import { withTransaction, type Db, type Queryable } from "./db/pool.js";

/** What each kind of work costs, in one place so the API can show it. */
export const PRICE = {
  /** Clip finder: per started minute of source video, minimum 1. */
  clipPerMinute: 1,
  storyboard: 5,
  image: 1,
  coloringPage: 1,
} as const;

export function clipCost(durationS: number): number {
  return Math.max(1, Math.ceil(durationS / 60)) * PRICE.clipPerMinute;
}

/** Take credits inside the caller's transaction; fails without touching the balance if there aren't enough. */
export async function charge(tx: Queryable, userId: string, amount: number, reason: string, jobId: string | null): Promise<void> {
  if (amount <= 0) return;
  const res = await tx.query("UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1", [amount, userId]);
  if (res.rowCount === 0) {
    const have = await balance(tx, userId);
    throw AppError.noCredits(amount, have);
  }
  await tx.query("INSERT INTO credit_ledger (user_id, delta, reason, job_id) VALUES ($1, $2, $3, $4)", [userId, -amount, reason, jobId]);
}

/** Add credits inside the caller's transaction. */
export async function grant(tx: Queryable, userId: string, amount: number, reason: string, jobId: string | null): Promise<void> {
  if (amount <= 0) return;
  await tx.query("UPDATE users SET credits = credits + $1 WHERE id = $2", [amount, userId]);
  await tx.query("INSERT INTO credit_ledger (user_id, delta, reason, job_id) VALUES ($1, $2, $3, $4)", [userId, amount, reason, jobId]);
}

export async function grantNow(db: Db, userId: string, amount: number, reason: string): Promise<void> {
  await withTransaction(db, (tx) => grant(tx, userId, amount, reason, null));
}

export async function balance(db: Queryable, userId: string): Promise<number> {
  const r = await db.query<{ credits: number }>("SELECT credits FROM users WHERE id = $1", [userId]);
  return r.rows[0]?.credits ?? 0;
}
