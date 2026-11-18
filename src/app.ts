import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { ASPECTS } from "./ai/images.js";
import { STYLES } from "./ai/styles.js";
import type { Config } from "./config.js";
import { PRICE } from "./credits.js";
import type { Db } from "./db/pool.js";
import { AppError, errorMessage } from "./errors.js";
import type { JobQueue, Logger } from "./jobs.js";
import { CAPTION_STYLES } from "./media/captions.js";
import { CROP_MODES } from "./media/framing.js";
import type { Services } from "./pipelines/services.js";
import { accountRoutes } from "./routes/account.js";
import { createRoutes } from "./routes/create.js";
import { jobRoutes } from "./routes/jobs.js";

export interface AppDeps {
  cfg: Config;
  db: Db;
  queue: JobQueue;
  services: Services;
  log?: Logger;
}

function cors(origin: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!origin) return next();
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, range");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "content-range, content-length, accept-ranges");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function createApp({ cfg, db, queue, services, log }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(cfg.corsOrigin));
  app.use(express.json({ limit: `${cfg.maxBodyMb}mb` }));

  const api = express.Router();
  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  api.get("/config", (_req, res) => {
    res.json({
      providers: { llm: services.llm.name, images: services.images.name, voice: services.tts.name },
      styles: STYLES,
      caption_styles: CAPTION_STYLES,
      crop_modes: CROP_MODES,
      aspects: ASPECTS,
      transcript_formats: ["words", "srt", "vtt"],
      pricing: {
        clip_per_minute: PRICE.clipPerMinute,
        storyboard: PRICE.storyboard,
        image: PRICE.image,
        coloring_page: PRICE.coloringPage,
      },
      signup_credits: cfg.signupCredits,
    });
  });
  api.use(accountRoutes(db, cfg));
  api.use(createRoutes(cfg, queue));
  api.use(jobRoutes(db, cfg, queue));
  app.use("/api", api);

  app.use((_req, _res, next) => next(AppError.notFound()));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
      return;
    }
    const status = (err as { status?: number; type?: string }).status;
    if (status === 413) {
      res.status(413).json({ error: "too_large", message: `requests are limited to ${cfg.maxBodyMb} MB` });
      return;
    }
    if (status === 400 && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "bad_request", message: "the request body is not valid JSON" });
      return;
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: "bad_request", message: errorMessage(err) });
      return;
    }
    log?.error(`request failed: ${errorMessage(err)}`);
    res.status(500).json({ error: "internal", message: "something went wrong" });
  };
  app.use(onError);
  return app;
}
