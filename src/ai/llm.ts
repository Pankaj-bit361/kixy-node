// A language model that answers with JSON matching a schema: Claude through the Anthropic SDK,
// any OpenAI-compatible chat API, or none.
import Anthropic from "@anthropic-ai/sdk";

export type JsonSchema = Record<string, unknown>;

export interface Llm {
  readonly name: string;
  readonly available: boolean;
  /** `schema` is a JSON Schema whose root is an object. */
  json(system: string, user: string, schema: JsonSchema): Promise<unknown>;
}

export const noLlm: Llm = {
  name: "none",
  available: false,
  json: () => Promise.reject(new Error("no language model configured")),
};

/** Parse JSON even if it is wrapped in prose or a code fence. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[{[]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start < 0 || end < start) throw new Error("no JSON in model output");
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      throw new Error("model output was not valid JSON");
    }
  }
}

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export function anthropicRequest(model: string, system: string, user: string, schema: JsonSchema): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
  };
}

/** The text of a finished Claude reply, or an error that says why there is none. */
export function anthropicText(msg: Anthropic.Message): string {
  if (msg.stop_reason === "refusal") {
    throw new Error(`the model declined this request (${msg.stop_details?.category ?? "no category"})`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("the model ran out of output tokens");
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export function anthropicLlm(opts: AnthropicOptions): Llm {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  return {
    name: "anthropic",
    available: true,
    async json(system, user, schema) {
      const msg = await client.messages.create(anthropicRequest(opts.model, system, user, schema));
      return parseJsonLoose(anthropicText(msg));
    },
  };
}

export interface OpenAiChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function openAiChatLlm(opts: OpenAiChatOptions, fetchFn: typeof fetch = fetch): Llm {
  return {
    name: "openai",
    available: true,
    async json(system, user, schema) {
      const res = await fetchFn(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${system}\n\nReply with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
            { role: "user", content: user },
          ],
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(`chat API returned ${res.status}: ${body?.error?.message ?? ""}`);
      return parseJsonLoose(body?.choices?.[0]?.message?.content ?? "");
    },
  };
}
