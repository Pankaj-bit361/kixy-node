// Passwords (scrypt) and signed session tokens (JWT, HS256), with only node:crypto.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** `scrypt$N$r$p$salt$hash`, salt and hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface Claims {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

const TOKEN_DAYS = 14;

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function sign(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function issueToken(secret: string, userId: string, email: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const claims: Claims = { sub: userId, email, iat, exp: iat + TOKEN_DAYS * 86400 };
  const head = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  return `${head}.${b64url(sign(secret, head))}`;
}

export function readToken(secret: string, token: string, now = Date.now()): Claims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return undefined;
    const given = Buffer.from(s, "base64url");
    const want = sign(secret, `${h}.${p}`);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Claims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number" || claims.exp * 1000 <= now) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

export interface AuthUser {
  id: string;
  email: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

/** Reads `Authorization: Bearer <token>`, or `?token=` so plain links and `<img src>` work. */
export function requireUser(secret: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.get("authorization");
    const fromHeader = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const fromQuery = typeof req.query.token === "string" ? req.query.token : undefined;
    const claims = readToken(secret, fromHeader ?? fromQuery ?? "");
    if (!claims) return next(AppError.unauthorized());
    req.user = { id: claims.sub, email: claims.email };
    next();
  };
}

/** The signed-in user of a request that went through `requireUser`. */
export function userOf(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
