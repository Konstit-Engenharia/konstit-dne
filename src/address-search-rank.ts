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
export function createIndexedAddressRanker(
  index: AddressSearchIndex,
  query: readonly string[],
  cache: Uint16Array = new Uint16Array(index.fieldCount),
): (row: number) => number {
  const words = query.map((word) => {
    const low = findSearchTerm(index.terms, word);
    return {
      exact: index.terms[low] === word ? low : -1,
      low,
      high: findSearchTerm(index.terms, `${word}\uffff`),
      significant: hasSearchableWords([word]),
    };
  });
  // Scores are at most 30,128 for the public 256-character query limit. Zero means uncached.
  cache.fill(0);
  return (row) => {
    let rank = 0;
    for (let column = 0; column < 4; column++) {
      const field = readPackedInteger(index.data, index.rowFields + (row * 4 + column) * index.fieldWidth, index.fieldWidth);
      let score = cache[field] as number;
      if (!score) {
        const start = index.data.getUint32(index.fieldOffsets + field * 4, true);
        const end = index.data.getUint32(index.fieldOffsets + (field + 1) * 4, true);
        let exactWords = 0;
        for (const word of words) {
          if (!word.significant) {
            continue;
          }
          for (let position = start; position < end; position++) {
            if (fieldToken(index, position) === word.exact) {
              exactWords++;
              break;
            }
          }
        }
        let quality = 0;
        for (let position = start; position <= end - words.length; position++) {
          let phrase = true;
          let exact = true;
          for (let id = 0; id < words.length; id++) {
            const word = words[id] as (typeof words)[number];
            const token = fieldToken(index, position + id);
            exact &&= token === word.exact;
            if (id === words.length - 1 ? token < word.low || token >= word.high : token !== word.exact) {
              phrase = false;
              break;
            }
          }
          if (phrase) {
            quality = 20_000;
            const wholeName = end - start === words.length || (position === start + 1 && end - start === words.length + 1
              && isAddressStreetType(index.terms[fieldToken(index, start)] as string));
            if (wholeName && exact) {
              quality = 30_000;
              break;
            }
          }
        }
        score = quality + exactWords + 1;
        cache[field] = score;
      }
      score--;
      const quality = score >= 30_000 ? 30_000 : score >= 20_000 ? 20_000 : 0;
      const exactWords = score - quality;
      const weight = 4 - column;
      rank = Math.max(rank, quality ? quality + weight * 100 + exactWords : exactWords * weight);
    }
    return rank;
  };
}

function fieldToken(index: AddressSearchIndex, position: number): number {
  return readPackedInteger(index.data, index.fieldTokens + position * index.tokenWidth, index.tokenWidth);
}
