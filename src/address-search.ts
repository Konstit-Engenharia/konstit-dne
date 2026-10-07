import {
  parseAddressSearchIndex,
  readPosting,
  searchRowCep,
  type AddressSearchIndex,
} from './address-search-index.ts';
import {
  addressTokens,
  createAddressRanker,
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

  /** Copies and validates index bytes. The caller retains ownership of the database reader. */
  constructor(private readonly database: DneBinaryDatabaseReader, bytes: Uint8Array) {
    this.index = parseAddressSearchIndex(new Uint8Array(bytes), database.checksum(), database.rowCount());
  }

  /** Releases the search index without closing the caller's database. Repeated calls are safe. */
  close(): void {
    this.index = null;
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
    let municipality = options.municipioCodIbge;
    if (
      (options.uf !== undefined && uf === undefined)
      || (municipality !== undefined && this.database.queryMunicipality(municipality) === undefined)
    ) {
      return [];
    }

    const ceps: string[] = [];
    const remainder = text.replace(/(?<![\p{L}\p{N}_])(?:cep\s*:?\s*)?(\d{5}-?\d{3})(?![\p{L}\p{N}_])/giu, (_match, cep: string) => {
      ceps.push(cep);
      return ' ';
    });
    const exactRows: DneRow[] = [];
    for (const cep of ceps) {
      const row = this.database.queryCep(cep);
      if (!row || (municipality !== undefined && row.municipio_cod_ibge !== municipality) || (uf !== undefined && row.uf !== uf)) {
        return [];
      }
      municipality = row.municipio_cod_ibge;
      if (!exactRows.some((existing) => existing.cep === row.cep)) {
        exactRows.push(row);
      }
    }
    const tokens = addressTokens(remainder);
    if (tokens.length === 0) {
      return exactRows.sort((a, b) => a.cep.localeCompare(b.cep)).slice(0, limit);
    }
    if (!hasSearchableWords(tokens)) {
      return [];
    }

    const lists: number[][] = [];
    if (municipality !== undefined) {
      lists.push(this.matchTerm(`#municipio:${municipality}`, false));
    }
    if (uf !== undefined) {
      lists.push(this.matchTerm(`#uf:${uf}`, false));
    }
    for (const [id, token,] of tokens.entries()) {
      lists.push(this.matchTerm(token, id === tokens.length - 1));
    }
    lists.sort((a, b) => a.length - b.length);
    let candidates = lists[0] as number[];
    for (const list of lists.slice(1)) {
      candidates = intersect(candidates, list);
      if (candidates.length === 0) {
        return [];
      }
    }

    const best: { row: DneRow; rank: number; }[] = [];
    const rankAddress = createAddressRanker(tokens);
    for (const id of candidates) {
      const row = this.database.queryCep(searchRowCep(this.index, id)) as DneRow;
      const rank = rankAddress([row.logradouro, row.nome, row.bairro, row.municipio]);
      const position = best.findIndex((candidate) => rank > candidate.rank || (rank === candidate.rank && row.cep < candidate.row.cep));
      if (position !== -1) {
        best.splice(position, 0, { row, rank });
      } else if (best.length < limit) {
        best.push({ row, rank });
      }
      if (best.length > limit) {
        best.pop();
      }
    }
    return best.map(({ row }) => row);
  }

  private matchTerm(term: string, prefix: boolean): number[] {
    const index = this.index as AddressSearchIndex;
    let low = 0;
    let high = index.terms.length;
    while (low < high) {
      const middle = low + ((high - low) >>> 1);
      if ((index.terms[middle] as string) < term) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const lists: number[][] = [];
    for (let id = low; id < index.terms.length; id++) {
      const candidate = index.terms[id] as string;
      if (prefix ? !candidate.startsWith(term) : candidate !== term) {
        break;
      }
      lists.push(readPosting(index, id));
    }
    if (lists.length === 1) {
      return lists[0] as number[];
    }
    return [...new Set(lists.flat())].sort((a, b) => a - b);
  }
}

function intersect(left: readonly number[], right: readonly number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i] as number;
    const b = right[j] as number;
    if (a < b) {
      i++;
    } else if (a > b) {
      j++;
    } else {
      result.push(a);
      i++;
      j++;
    }
  }
  return result;
}
