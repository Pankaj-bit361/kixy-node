import path from "node:path";

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  dataDir: string;
  jwtSecret: string;
  signupCredits: number;
  allowDemoTopup: boolean;
  workerConcurrency: number;
  maxBodyMb: number;
  corsOrigin?: string;
  captionFont: string;

  llmProvider: "anthropic" | "openai" | "none";
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicModel: string;

  openaiApiKey?: string;
  openaiBaseUrl: string;
  openaiChatModel: string;
  imageProvider: "openai" | "placeholder";
  openaiImageModel: string;
  ttsProvider: "openai" | "none";
  openaiTtsModel: string;
  openaiTtsVoice: string;
}

export const DEV_JWT_SECRET = "dev-only-change-me";

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key]?.trim();
  return v ? v : fallback;
}

function opt(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function int(env: Env, key: string, fallback: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Read settings from the environment. Providers default to whichever API keys are present. */
export function loadConfig(env: Env = process.env): Config {
  const anthropicApiKey = opt(env, "ANTHROPIC_API_KEY");
  const openaiApiKey = opt(env, "OPENAI_API_KEY");
  const llmDefault = anthropicApiKey ? "anthropic" : openaiApiKey ? "openai" : "none";
  return {
    host: str(env, "HOST", "0.0.0.0"),
    port: int(env, "PORT", 8080),
    databaseUrl: str(env, "DATABASE_URL", "postgres://postgres@127.0.0.1:5432/kixy"),
    dataDir: path.resolve(str(env, "DATA_DIR", "data")),
    jwtSecret: str(env, "JWT_SECRET", DEV_JWT_SECRET),
    signupCredits: int(env, "SIGNUP_CREDITS", 60),
    allowDemoTopup: bool(env, "ALLOW_DEMO_TOPUP", true),
    workerConcurrency: Math.max(1, int(env, "WORKER_CONCURRENCY", 2)),
    maxBodyMb: Math.max(1, int(env, "MAX_BODY_MB", 25)),
    corsOrigin: opt(env, "CORS_ORIGIN"),
    captionFont: str(env, "CAPTION_FONT", "Inter"),

    llmProvider: oneOf(str(env, "LLM_PROVIDER", llmDefault), ["anthropic", "openai", "none"] as const, "none"),
    anthropicApiKey,
    anthropicBaseUrl: opt(env, "ANTHROPIC_BASE_URL"),
    anthropicModel: str(env, "ANTHROPIC_MODEL", "claude-sonnet-5-5"),

    openaiApiKey,
    openaiBaseUrl: str(env, "OPENAI_BASE_URL", "https://api.openai.com/v1"),
    openaiChatModel: str(env, "OPENAI_CHAT_MODEL", "gpt-4o-mini"),
    imageProvider: oneOf(str(env, "IMAGE_PROVIDER", openaiApiKey ? "openai" : "placeholder"), ["openai", "placeholder"] as const, "placeholder"),
    openaiImageModel: str(env, "OPENAI_IMAGE_MODEL", "gpt-image-1"),
    ttsProvider: oneOf(str(env, "TTS_PROVIDER", openaiApiKey ? "openai" : "none"), ["openai", "none"] as const, "none"),
    openaiTtsModel: str(env, "OPENAI_TTS_MODEL", "tts-1"),
    openaiTtsVoice: str(env, "OPENAI_TTS_VOICE", "alloy"),
  };
}
