/**
 * Minimal Google Gemini client (REST, no SDK) for the demo-app's adaptive
 * copilot. Server-only: the key never reaches the browser.
 *
 * Privacy contract: callers only ever pass numeric telemetry (mode, composite
 * score, signal counts) or the dashboard's own aggregate dataset — never text
 * the user typed. That keeps the Behaviour Agent's "numbers only" promise
 * intact even when an LLM is in the loop.
 */

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const USES_THINKING_LEVEL = /^gemini-3/.test(GEMINI_MODEL);

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;
}

export function isGeminiConfigured(): boolean {
  return Boolean(geminiApiKey());
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string };
}

export async function generateWithGemini(options: {
  system: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const baseConfig = {
    temperature: options.temperature ?? 0.6,
    maxOutputTokens: options.maxOutputTokens ?? 2048,
  };
  const request = (generationConfig: Record<string, unknown>) =>
    fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.system }] },
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
    });

  // Gemini 3.x models think before answering by default, which pushed short
  // copilot replies past the timeout. Ask for light thinking, and retry
  // without the setting if a model rejects it.
  let response = await request(
    USES_THINKING_LEVEL ? { ...baseConfig, thinkingConfig: { thinkingLevel: "low" } } : baseConfig,
  );
  if (USES_THINKING_LEVEL && response.status === 400) {
    const detail = await response.clone().text();
    if (/thinking/i.test(detail)) {
      response = await request(baseConfig);
    }
  }

  const data = (await response.json().catch(() => ({}))) as GeminiResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini request failed (${response.status}).`);
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }
  return text;
}
