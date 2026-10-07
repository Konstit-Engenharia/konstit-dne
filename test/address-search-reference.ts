import { addressTokens } from '../src/address-search-text.ts';

const common = new Set(['rua', 'avenida', 'rodovia', 'travessa', 'de', 'da', 'do', 'das', 'dos']);
const streetTypes = new Set(['rua', 'avenida', 'rodovia', 'travessa', 'alameda', 'praca', 'estrada', 'largo', 'viela']);

/** Text ranking from 970fd5c, retained as an independent oracle for the numeric index. */
export function createAddressRanker(query: readonly string[]): (fields: readonly (string | null)[]) => number {
  const phrase = query.join(' ');
  const cache = new Map<string, { quality: number; exactWords: number; }>();
  return (fields) => {
    let rank = 0;
    for (const [index, field,] of fields.entries()) {
      const text = field ?? '';
      let score = cache.get(text);
      if (!score) {
        const tokens = addressTokens(text);
        const normalized = tokens.join(' ');
        const name = streetTypes.has(tokens[0] ?? '') ? tokens.slice(1).join(' ') : normalized;
        score = {
          quality: normalized === phrase || name === phrase ? 30_000 : (` ${normalized}`.includes(` ${phrase}`) ? 20_000 : 0),
          exactWords: query.filter((token) => !common.has(token) && tokens.includes(token)).length,
        };
        cache.set(text, score);
      }
      const weight = fields.length - index;
      rank = Math.max(rank, score.quality ? score.quality + weight * 100 + score.exactWords : score.exactWords * weight);
    }
    return rank;
  };
}
