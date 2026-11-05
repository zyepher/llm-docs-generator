/**
 * Shared text metrics for recorded output metadata.
 *
 * Token estimates written into a manifest are recomputed by verification, so
 * every writer and checker must call this same function. The estimate is
 * deliberately a crude characters/divisor budgeting hint, not a real
 * tokenizer; changing the formula would change every recorded value, so it is
 * part of the on-disk contract.
 */
export const DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN = 4;

/**
 * Estimate token count as ceil(characters / divisor). The divisor is sanitized
 * (non-finite falls back to the default, otherwise floored and clamped to at
 * least 1), so a caller passing an unchecked option still gets a stable value.
 */
export function estimateTokenCount(
  content: string,
  estimatedCharactersPerToken: number = DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN
): number {
  const divisor = Number.isFinite(estimatedCharactersPerToken)
    ? Math.max(1, Math.floor(estimatedCharactersPerToken))
    : DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN;

  return Math.ceil(content.length / divisor);
}
