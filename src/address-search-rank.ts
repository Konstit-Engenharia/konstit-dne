import type { AddressSearchIndex } from './address-search-index.ts';
import {
  hasSearchableWords,
  isAddressStreetType,
} from './address-search-text.ts';
import { readPackedInteger } from './binary-db-format.ts';

/** Finds a word boundary in the sorted ASCII vocabulary. */
export function findSearchTerm(terms: readonly string[], term: string): number {
  let low = 0;
  let high = terms.length;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if ((terms[middle] as string) < term) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Ranks numeric fields and word positions; no address strings are decoded. */
export function createIndexedAddressRanker(index: AddressSearchIndex, query: readonly string[]): (row: number) => number {
  const words = query.map((word) => {
    const low = findSearchTerm(index.terms, word);
    return {
      exact: index.terms[low] === word ? low : -1,
      low,
      high: findSearchTerm(index.terms, `${word}\uffff`),
      significant: hasSearchableWords([word]),
    };
  });
  const cache = new Map<number, { quality: number; exactWords: number; }>();
  return (row) => {
    let rank = 0;
    for (let column = 0; column < 4; column++) {
      const field = readPackedInteger(index.data, index.rowFields + (row * 4 + column) * index.fieldWidth, index.fieldWidth);
      let score = cache.get(field);
      if (!score) {
        const start = index.data.getUint32(index.fieldOffsets + field * 4, true);
        const end = index.data.getUint32(index.fieldOffsets + (field + 1) * 4, true);
        const tokens: number[] = [];
        for (let position = start; position < end; position++) {
          tokens.push(readPackedInteger(index.data, index.fieldTokens + position * index.tokenWidth, index.tokenWidth));
        }
        const exactWords = words.filter((word) => word.significant && tokens.includes(word.exact)).length;
        let quality = 0;
        for (let position = 0; position <= tokens.length - words.length; position++) {
          const phrase = words.every((word, id) => {
            const token = tokens[position + id] as number;
            return id === words.length - 1 ? token >= word.low && token < word.high : token === word.exact;
          });
          if (phrase) {
            quality = 20_000;
            const wholeName = tokens.length === words.length || (position === 1 && tokens.length === words.length + 1
              && isAddressStreetType(index.terms[tokens[0] as number] as string));
            if (wholeName && words.every((word, id) => tokens[position + id] === word.exact)) {
              quality = 30_000;
              break;
            }
          }
        }
        score = { quality, exactWords };
        cache.set(field, score);
      }
      const weight = 4 - column;
      rank = Math.max(rank, score.quality ? score.quality + weight * 100 + score.exactWords : score.exactWords * weight);
    }
    return rank;
  };
}
