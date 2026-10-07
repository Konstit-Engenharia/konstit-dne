import { readFileSync } from 'node:fs';
import {
  findSearchCep,
  parseAddressSearchIndex,
  searchRowCep,
  searchRowMunicipality,
  visitSearchPosting,
  type AddressSearchIndex,
} from './address-search-index.ts';
import {
  createIndexedAddressRanker,
  findSearchTerm,
} from './address-search-rank.ts';
import {
  addressTokens,
  hasSearchableWords,
} from './address-search-text.ts';
import type { DneBinaryDatabaseReader } from './binary-db-reader.ts';
import {
  parseUF,
  type DneRow,
  type UF,
} from './types.ts';

/** Geographic constraints are intersected with any municipality inferred from a CEP in the query. */
export type AddressSearchOptions = {
  uf?: UF;
  municipioCodIbge?: number;
  /** Maximum results, from 1 to 50. Defaults to 10. */
  limit?: number;
};

/** Optional address autocomplete over an immutable binary database and its matching search index. */
export class DneAddressSearch {
  private index: AddressSearchIndex | null;
  private workspace: { candidates: Uint32Array; matches: Uint32Array; scores: Uint16Array; } | null = null;

  /** Reads an owned file buffer or copies caller bytes, then validates. The caller owns the database reader. */
  constructor(private readonly database: DneBinaryDatabaseReader, source: string | Uint8Array) {
    const bytes = typeof source === 'string' ? readFileSync(source) : new Uint8Array(source);
    this.index = parseAddressSearchIndex(bytes, database.checksum(), database.rowCount());
  }

  /** Releases the search index without closing the caller's database. Repeated calls are safe. */
  close(): void {
    this.index = null;
    this.workspace = null;
  }

  /**
   * Matches complete words and a prefix of the last word, ignoring accents and case.
   * Full CEPs in the text restrict the municipality; unknown or conflicting CEPs return [].
   * A CEP-only query returns its exact address. All explicit filters remain in force.
   * Empty queries, street-type-only queries, and invalid geographic filters return [].
   * Throws after close(), when the database is closed, or for invalid length/limit options.
   */
  searchAddresses(text: string, options: AddressSearchOptions = {}): DneRow[] {
    if (this.index === null) {
      throw new Error('Address search is closed');
    }
    this.database.checksum();
    const { limit = 10 } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || text.length > 256) {
      throw new RangeError('Address search requires limit 1..50 and at most 256 query characters');
    }
    const uf = options.uf === undefined ? undefined : parseUF(options.uf);
    let municipality = options.municipioCodIbge === undefined ? undefined : this.index.municipalityByCode.get(options.municipioCodIbge);
    if (
      (options.uf !== undefined && uf === undefined)
      || (options.municipioCodIbge !== undefined && municipality === undefined)
      || (municipality !== undefined && uf !== undefined && this.index.municipalityUfs[municipality] !== uf)
    ) {
      return [];
    }

    const ceps: string[] = [];
    const remainder = text.replace(/(?<![\p{L}\p{N}_])(?:cep\s*:?\s*)?(\d{5}-?\d{3})(?![\p{L}\p{N}_])/giu, (_match, cep: string) => {
      ceps.push(cep);
      return ' ';
    });
    const exactRows: number[] = [];
    for (const cep of ceps) {
      const row = findSearchCep(this.index, cep);
      if (row === -1) {
        return [];
      }
      const candidateMunicipality = searchRowMunicipality(this.index, row);
      if (
        (municipality !== undefined && candidateMunicipality !== municipality)
        || (uf !== undefined && this.index.municipalityUfs[candidateMunicipality] !== uf)
      ) {
        return [];
      }
      municipality = candidateMunicipality;
      if (!exactRows.includes(row)) {
        exactRows.push(row);
      }
    }
    const tokens = addressTokens(remainder);
    if (tokens.length === 0) {
      return exactRows.sort((a, b) => a - b).slice(0, limit).map((id) => this.readAddress(id));
    }
    if (!hasSearchableWords(tokens)) {
      return [];
    }

    const index = this.index;
    const ranges = tokens.map((token, position) => {
      const low = findSearchTerm(index.terms, token);
      const high = position === tokens.length - 1
        ? findSearchTerm(index.terms, `${token}\uffff`)
        : low + Number(index.terms[low] === token);
      return { low, high };
    });
    if (ranges.some(({ low, high }) => low === high)) {
      return [];
    }
    this.workspace ??= {
      candidates: new Uint32Array(Math.ceil(index.rowCount / 32)),
      matches: new Uint32Array(Math.ceil(index.rowCount / 32)),
      scores: new Uint16Array(index.fieldCount),
    };
    const { candidates, matches, scores } = this.workspace;
    for (const [position, range,] of ranges.entries()) {
      const target = position === 0 ? candidates : matches;
      target.fill(0);
      this.matchTerm(range.low, range.high, target);
      if (position > 0) {
        let any = 0;
        for (let word = 0; word < candidates.length; word++) {
          const value = (candidates[word] as number) & (matches[word] as number);
          candidates[word] = value;
          any |= value;
        }
        if (!any) {
          return [];
        }
      }
    }

    const best: { row: number; rank: number; }[] = [];
    const rankAddress = createIndexedAddressRanker(this.index, tokens, scores);
    for (let word = 0; word < candidates.length; word++) {
      let bits = candidates[word] as number;
      while (bits !== 0) {
        const id = word * 32 + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const rowMunicipality = searchRowMunicipality(this.index, id);
        if (
          (municipality !== undefined && rowMunicipality !== municipality)
          || (uf !== undefined && this.index.municipalityUfs[rowMunicipality] !== uf)
        ) {
          continue;
        }
        const rank = rankAddress(id);
        let position = 0;
        while (position < best.length && rank <= (best[position] as { rank: number; }).rank) {
          position++;
        }
        if (position < limit) {
          best.splice(position, 0, { row: id, rank });
        }
        if (best.length > limit) {
          best.pop();
        }
      }
    }
    return best.map(({ row }) => this.readAddress(row));
  }

  private readAddress(id: number): DneRow {
    return this.database.queryCep(searchRowCep(this.index as AddressSearchIndex, id)) as DneRow;
  }

  private matchTerm(low: number, high: number, matches: Uint32Array): void {
    const index = this.index as AddressSearchIndex;
    const mark = (row: number) => {
      const word = row >>> 5;
      matches[word] = (matches[word] as number) | (1 << (row & 31));
    };
    for (let id = low; id < high; id++) {
      visitSearchPosting(index, id, mark);
    }
  }
}
