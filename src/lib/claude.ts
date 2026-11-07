import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/** Shared Claude client (translation, teaching scripts). */

export function canUseClaude(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;
export const anthropic = () => (client ??= new Anthropic());

/** Models that accept server-side `fallbacks: "default"` (not Haiku). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/**
 * Request fields that let the API retry a declined request on another model
 * (spread into `beta.messages.create`); nothing for models that don't support it.
 */
export const fallbackParams = (model: string) =>
  FALLBACK_MODELS.has(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};

/** Input/output tokens across every attempt (with fallbacks, top-level usage covers only the one that answered). */
export function tokenTotals(usage: Anthropic.Beta.BetaUsage): { input: number; output: number } {
  const attempts = usage.iterations?.length ? usage.iterations : [usage];
  let input = 0;
  let output = 0;
  for (const a of attempts) {
    input += a.input_tokens;
    output += a.output_tokens;
  }
  return { input, output };
}
