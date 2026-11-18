import { randomUUID } from "node:crypto";
import { Router } from "express";
import { hashPassword, issueToken, requireUser, userOf, verifyPassword } from "../auth.js";
import type { Config } from "../config.js";
import { balance, grant, grantNow } from "../credits.js";
import { withTransaction, type Db } from "../db/pool.js";
import { AppError } from "../errors.js";
import { body, handle } from "./util.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function credentials(req: Parameters<typeof body>[0]): { email: string; password: string } {
  const b = body(req);
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";
  return { email, password };
}

export function accountRoutes(db: Db, cfg: Config): Router {
  const r = Router();
  const auth = requireUser(cfg.jwtSecret);

  r.post(
    "/auth/register",
    handle(async (req) => {
      const { email, password } = credentials(req);
      if (!EMAIL.test(email) || email.length > 254) throw AppError.badRequest("enter a valid email");
      if (password.length < 8) throw AppError.badRequest("use a password of at least 8 characters");
      const id = randomUUID();
      const hash = await hashPassword(password);
      try {
        await withTransaction(db, async (tx) => {
          await tx.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [id, email, hash]);
          await grant(tx, id, cfg.signupCredits, "welcome credits", null);
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw AppError.conflict("an account with this email already exists");
        throw e;
      }
      return { token: issueToken(cfg.jwtSecret, id, email), user: { id, email, credits: cfg.signupCredits } };
    }),
  );

  r.post(
    "/auth/login",
    handle(async (req) => {
      const { email, password } = credentials(req);
      const row = (
        await db.query<{ id: string; password_hash: string; credits: number }>(
          "SELECT id, password_hash, credits FROM users WHERE email = $1",
          [email],
        )
      ).rows[0];
      if (!row || !(await verifyPassword(password, row.password_hash))) throw AppError.badRequest("wrong email or password");
      return { token: issueToken(cfg.jwtSecret, row.id, email), user: { id: row.id, email, credits: row.credits } };
    }),
  );

  r.get(
    "/me",
    auth,
    handle(async (req) => {
      const u = userOf(req);
      const row = (await db.query<{ created_at: Date; credits: number }>("SELECT credits, created_at FROM users WHERE id = $1", [u.id])).rows[0];
      if (!row) throw AppError.unauthorized();
      return { id: u.id, email: u.email, credits: row.credits, created_at: row.created_at };
    }),
  );

  r.get(
    "/credits/ledger",
    auth,
    handle(async (req) => {
      const rows = await db.query(
        "SELECT id::text AS id, delta, reason, job_id, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 200",
        [userOf(req).id],
      );
      return rows.rows;
    }),
  );

  r.post(
    "/credits/demo-topup",
    auth,
    handle(async (req) => {
      if (!cfg.allowDemoTopup) throw AppError.badRequest("demo credits are turned off on this server");
      const u = userOf(req);
      await grantNow(db, u.id, 50, "demo top-up");
      return { credits: await balance(db, u.id) };
    }),
  );

  return r;
}
