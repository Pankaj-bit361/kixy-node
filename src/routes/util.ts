import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../errors.js";

/** Express 5 forwards rejected promises to the error handler; this keeps handler types tidy. */
export function handle(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).then((body) => {
      if (body !== undefined && !res.headersSent) res.json(body);
    }, next);
  };
}

export function body(req: Request): Record<string, unknown> {
  const b: unknown = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function requireText(v: unknown, message: string): string {
  if (typeof v !== "string" || !v.trim()) throw AppError.badRequest(message);
  return v.trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route ids are UUIDs; anything else cannot exist. */
export function idParam(req: Request, name = "id"): string {
  const v = req.params[name];
  if (typeof v !== "string" || !UUID.test(v)) throw AppError.notFound();
  return v;
}

/** A file name inside a job folder: no separators, no parent references, no hidden files. */
export function safeName(name: string): boolean {
  return name.length > 0 && !/[/\\]/.test(name) && !name.includes("..") && !name.startsWith(".");
}
