// Pick the providers named in the config. With no API keys the server still works end to end:
// clips come from the built-in picker, images are placeholder art and storyboards have no voice.
import { openAiImages, placeholderImages, type ImageGen } from "./ai/images.js";
import { anthropicLlm, noLlm, openAiChatLlm, type Llm } from "./ai/llm.js";
import { noTts, openAiTts, type Tts } from "./ai/tts.js";
import type { Config } from "./config.js";
import type { Services } from "./pipelines/services.js";

function llmFor(cfg: Config): Llm {
  if (cfg.llmProvider === "anthropic" && cfg.anthropicApiKey) {
    return anthropicLlm({ apiKey: cfg.anthropicApiKey, baseUrl: cfg.anthropicBaseUrl, model: cfg.anthropicModel });
  }
  if (cfg.llmProvider === "openai" && cfg.openaiApiKey) {
    return openAiChatLlm({ apiKey: cfg.openaiApiKey, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiChatModel });
  }
  return noLlm;
}

function imagesFor(cfg: Config): ImageGen {
  if (cfg.imageProvider === "openai" && cfg.openaiApiKey) {
    return openAiImages({ apiKey: cfg.openaiApiKey, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiImageModel });
  }
  return placeholderImages(cfg.captionFont);
}

function ttsFor(cfg: Config): Tts {
  if (cfg.ttsProvider === "openai" && cfg.openaiApiKey) {
    return openAiTts({ apiKey: cfg.openaiApiKey, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiTtsModel, voice: cfg.openaiTtsVoice });
  }
  return noTts;
}

export function buildServices(cfg: Config): Services {
  return { llm: llmFor(cfg), images: imagesFor(cfg), tts: ttsFor(cfg), captionFont: cfg.captionFont };
}
