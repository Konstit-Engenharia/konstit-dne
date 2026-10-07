import { createHash } from 'node:crypto';
import { addressTokens } from './address-search-text.ts';
import type { DneBinaryDatabaseReader } from './binary-db-reader.ts';

const MAGIC = 'DNESRCH1';
const VERSION = 1;
const HEADER_SIZE = 64;
const DIGEST_SIZE = 32;

/** Validated search index; postings are delta-encoded row IDs in CEP order. */
export type AddressSearchIndex = {
  data: DataView;
  terms: string[];
  offsets: number;
  postings: Uint8Array;
  rowCount: number;
};

/** Builds an optional, versioned search index bound to the reader's exact database snapshot. */
export function buildAddressSearchIndex(database: DneBinaryDatabaseReader): Uint8Array {
  const checksum = database.checksum();
  const ceps: number[] = [];
  const lists = new Map<string, number[]>();
  const localityTokens = new Map<string, string[]>();
  const tokenizeLocality = (text: string): string[] => {
    let tokens = localityTokens.get(text);
    if (!tokens) {
      tokens = addressTokens(text);
      localityTokens.set(text, tokens);
    }
    return tokens;
  };
  for (const row of database.entries()) {
    const id = ceps.length;
    ceps.push(Number(row.cep));
    const terms = new Set([
      ...addressTokens(row.logradouro ?? ''),
      ...addressTokens(row.nome ?? ''),
      ...tokenizeLocality(row.bairro ?? ''),
      ...tokenizeLocality(row.municipio),
      `#uf:${row.uf}`,
      `#municipio:${row.municipio_cod_ibge}`,
    ]);
    for (const term of terms) {
      let list = lists.get(term);
      if (!list) {
        list = [];
        lists.set(term, list);
      }
      list.push(id);
    }
  }

  const terms = [...lists.keys()].sort();
  const lexicon = new TextEncoder().encode(JSON.stringify(terms));
  const offsets: number[] = [0];
  const chunks: Uint8Array[] = [];
  for (const term of terms) {
    const chunk = encodePosting(lists.get(term) as number[]);
    chunks.push(chunk);
    offsets.push((offsets[offsets.length - 1] as number) + chunk.length);
  }
  const postingsLength = offsets[offsets.length - 1] as number;
  const lexiconOffset = HEADER_SIZE + ceps.length * 4 + offsets.length * 4;
  const bytes = new Uint8Array(lexiconOffset + lexicon.length + postingsLength + DIGEST_SIZE);
  const data = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(MAGIC));
  data.setUint32(8, VERSION, true);
  data.setUint32(12, ceps.length, true);
  data.setUint32(16, lexicon.length, true);
  data.setUint32(20, terms.length, true);
  data.setUint32(24, postingsLength, true);
  bytes.set(Buffer.from(checksum, 'hex'), 32);
  for (const [id, cep,] of ceps.entries()) {
    data.setUint32(HEADER_SIZE + id * 4, cep, true);
  }
  for (const [id, offset,] of offsets.entries()) {
    data.setUint32(HEADER_SIZE + ceps.length * 4 + id * 4, offset, true);
  }
  bytes.set(lexicon, lexiconOffset);
  let offset = lexiconOffset + lexicon.length;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  bytes.set(digest(bytes.subarray(0, -DIGEST_SIZE)), offset);
  parseAddressSearchIndex(bytes, checksum, database.rowCount());
  return bytes;
}

/** Validates integrity, source identity, and every range before queries can use the index. */
export function parseAddressSearchIndex(bytes: Uint8Array, checksum: string, rowCount: number): AddressSearchIndex {
  if (bytes.length < HEADER_SIZE + DIGEST_SIZE || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('Invalid address search index header');
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.getUint32(8, true) !== VERSION) {
    throw new Error('Unsupported address search index version');
  }
  if (!digest(bytes.subarray(0, -DIGEST_SIZE)).equals(bytes.subarray(-DIGEST_SIZE))) {
    throw new Error('Invalid address search index checksum');
  }
  if (Buffer.from(bytes.subarray(32, 64)).toString('hex') !== checksum || data.getUint32(12, true) !== rowCount) {
    throw new Error('Address search index belongs to a different database');
  }
  const lexiconLength = data.getUint32(16, true);
  const count = data.getUint32(20, true);
  const postingsLength = data.getUint32(24, true);
  const offsets = HEADER_SIZE + rowCount * 4;
  const lexiconOffset = offsets + (count + 1) * 4;
  const postingsOffset = lexiconOffset + lexiconLength;
  if (data.getUint32(28, true) !== 0 || postingsOffset + postingsLength + DIGEST_SIZE !== bytes.length) {
    throw new Error('Invalid address search index size');
  }
  const terms: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(lexiconOffset, postingsOffset)));
  if (
    !Array.isArray(terms) || terms.length !== count
    || terms.some((term, id) => typeof term !== 'string' || !term || (id > 0 && terms[id - 1] >= term))
  ) {
    throw new Error('Invalid address search vocabulary');
  }
  const index: AddressSearchIndex = { data, terms, offsets, postings: bytes.subarray(postingsOffset, -DIGEST_SIZE), rowCount };
  let previous = -1;
  for (let id = 0; id < rowCount; id++) {
    const cep = data.getUint32(HEADER_SIZE + id * 4, true);
    if (cep <= previous || cep > 99_999_999) {
      throw new Error('Invalid address search CEP');
    }
    previous = cep;
  }
  if (data.getUint32(offsets, true) !== 0 || data.getUint32(offsets + count * 4, true) !== postingsLength) {
    throw new Error('Invalid address search posting offsets');
  }
  for (let id = 0; id < count; id++) {
    readPosting(index, id, false);
  }
  return index;
}

/** Decodes one ordered posting list, checking delta and range invariants. */
export function readPosting(index: AddressSearchIndex, id: number, collect = true): number[] {
  let offset = index.data.getUint32(index.offsets + id * 4, true);
  const end = index.data.getUint32(index.offsets + (id + 1) * 4, true);
  if (end <= offset || end > index.postings.length) {
    throw new Error('Invalid address search posting range');
  }
  const result: number[] = [];
  let previous = -1;
  while (offset < end) {
    let delta = 0;
    let factor = 1;
    let byte: number;
    do {
      if (offset >= end || factor > 2 ** 28) {
        throw new Error('Invalid address search posting encoding');
      }
      byte = index.postings[offset++] as number;
      delta += (byte & 127) * factor;
      factor *= 128;
    } while (byte & 128);
    const row = previous + delta;
    if (delta === 0 || row >= index.rowCount) {
      throw new Error('Invalid address search posting row');
    }
    if (collect) {
      result.push(row);
    }
    previous = row;
  }
  return result;
}

/** Resolves an index row ID to the eight-digit CEP used by the database reader. */
export function searchRowCep(index: AddressSearchIndex, id: number): string {
  return String(index.data.getUint32(HEADER_SIZE + id * 4, true)).padStart(8, '0');
}

function encodePosting(rows: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  let previous = -1;
  for (const row of rows) {
    let delta = row - previous;
    while (delta >= 128) {
      bytes.push((delta % 128) | 128);
      delta = Math.floor(delta / 128);
    }
    bytes.push(delta);
    previous = row;
  }
  return Uint8Array.from(bytes);
}

function digest(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}
