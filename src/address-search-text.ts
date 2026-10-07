import { expand } from './expand.ts';

const common = new Set(['rua', 'avenida', 'rodovia', 'travessa', 'de', 'da', 'do', 'das', 'dos']);
const streetTypes = new Set(['rua', 'avenida', 'rodovia', 'travessa', 'alameda', 'praca', 'estrada', 'largo', 'viela']);

/** Normalizes text without changing the original address or losing numeric street names. */
export function addressTokens(text: string): string[] {
  return expand(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Avoids national searches made entirely of street types and connective words. */
export function hasSearchableWords(tokens: readonly string[]): boolean {
  return tokens.some((token) => !common.has(token));
}

/** Identifies the optional leading road type used by exact-name ranking. */
export function isAddressStreetType(token: string): boolean {
  return streetTypes.has(token);
}
