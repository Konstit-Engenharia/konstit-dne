import { createHash } from 'node:crypto';
import { addressTokens } from './address-search-text.ts';
import {
  integerByteWidth,
  readByteWidth,
  readPackedInteger,
  writePackedInteger,
  type ByteWidth,
} from './binary-db-format.ts';
import type { DneBinaryDatabaseReader } from './binary-db-reader.ts';
import {
  ALL_UFS,
  type UF,
} from './types.ts';

const MAGIC = 'DNESRCH1';
const VERSION = 2;
const HEADER_SIZE = 80;
const DIGEST_SIZE = 32;

/** Numeric field sequences retain word positions; geography uses dense municipality IDs. */
export type AddressSearchIndex = {
  data: DataView;
  terms: string[];
  offsets: number;
  postings: Uint8Array;
  rowCount: number;
  rowMunicipalities: number;
  rowFields: number;
  fieldOffsets: number;
  fieldCount: number;
  fieldTokens: number;
  fieldWidth: ByteWidth;
  tokenWidth: ByteWidth;
  municipalityWidth: ByteWidth;
  municipalityCodes: number[];
  municipalityUfs: UF[];
  municipalityByCode: Map<number, number>;
};

/** Builds an optional, versioned search index bound to the reader's exact database snapshot. */
export function buildAddressSearchIndex(database: DneBinaryDatabaseReader): Uint8Array {
  const checksum = database.checksum();
  const rowCount = database.rowCount();
  const ceps = new Uint32Array(rowCount);
  const rowMunicipalities = new Uint32Array(rowCount);
  const rowFields = new Uint32Array(rowCount * 4);
  const municipalities: { code: number; uf: UF; }[] = [];
  const municipalityIds = new Map<number, number>();
  const terms: string[] = [];
  const termIds = new Map<string, number>();
  const lists: number[][] = [];
  const fields: number[][] = [[]];
  const fieldIds = new Map<string, number>([['', 0]]);
  const localityTokens = new Map<string, string[]>();
  const tokenizeLocality = (text: string): string[] => {
    let tokens = localityTokens.get(text);
    if (!tokens) {
      tokens = addressTokens(text);
      localityTokens.set(text, tokens);
    }
    return tokens;
  };
  let rowId = 0;
  for (const row of database.entries()) {
    ceps[rowId] = Number(row.cep);
    let municipality = municipalityIds.get(row.municipio_cod_ibge);
    if (municipality === undefined) {
      municipality = municipalities.length;
      municipalityIds.set(row.municipio_cod_ibge, municipality);
      municipalities.push({ code: row.municipio_cod_ibge, uf: row.uf });
    }
    rowMunicipalities[rowId] = municipality;
    const rowTerms = new Set<number>();
    const texts = [
      addressTokens(row.logradouro ?? ''),
      addressTokens(row.nome ?? ''),
      tokenizeLocality(row.bairro ?? ''),
      tokenizeLocality(row.municipio),
    ];
    for (const [column, words,] of texts.entries()) {
      const text = words.join(' ');
      let field = fieldIds.get(text);
      if (field === undefined) {
        field = fields.length;
        fieldIds.set(text, field);
        fields.push(words.map((word) => {
          let term = termIds.get(word);
          if (term === undefined) {
            term = terms.length;
            termIds.set(word, term);
            terms.push(word);
            lists.push([]);
          }
          return term;
        }));
      }
      rowFields[rowId * 4 + column] = field;
      for (const term of fields[field] as number[]) {
        rowTerms.add(term);
      }
    }
    for (const term of rowTerms) {
      (lists[term] as number[]).push(rowId);
    }
    rowId++;
  }

  const sorted = [...terms.keys()].sort((a, b) => (terms[a] as string) < (terms[b] as string) ? -1 : 1);
  const remap = new Uint32Array(terms.length);
  for (const [id, original,] of sorted.entries()) {
    remap[original] = id;
  }
  const lexicon = new TextEncoder().encode(JSON.stringify(sorted.map((id) => terms[id])));
  const offsets: number[] = [0];
  const chunks = sorted.map((id) => {
    const chunk = encodePosting(lists[id] as number[]);
    offsets.push((offsets[offsets.length - 1] as number) + chunk.length);
    return chunk;
  });
  const postingsLength = offsets[offsets.length - 1] as number;
  const fieldWidth = integerByteWidth(fields.length - 1);
  const tokenWidth = integerByteWidth(terms.length - 1);
  const municipalityWidth = integerByteWidth(municipalities.length - 1);
  const tokenCount = fields.reduce((sum, field) => sum + field.length, 0);
  const rowMunicipalitiesOffset = HEADER_SIZE + rowCount * 4;
  const rowFieldsOffset = rowMunicipalitiesOffset + rowCount * municipalityWidth;
  const municipalitiesOffset = rowFieldsOffset + rowCount * 4 * fieldWidth;
  const fieldOffsets = municipalitiesOffset + municipalities.length * 6;
  const fieldTokens = fieldOffsets + (fields.length + 1) * 4;
  const postingOffsets = fieldTokens + tokenCount * tokenWidth;
  const lexiconOffset = postingOffsets + offsets.length * 4;
  const bytes = new Uint8Array(lexiconOffset + lexicon.length + postingsLength + DIGEST_SIZE);
  const data = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(MAGIC));
  for (
    const [offset, value,] of [
      [8, VERSION],
      [12, rowCount],
      [16, lexicon.length],
      [20, terms.length],
      [24, postingsLength],
      [28, fields.length],
      [64, tokenCount],
      [68, municipalities.length],
    ]
  ) {
    data.setUint32(offset as number, value as number, true);
  }
  bytes.set(Buffer.from(checksum, 'hex'), 32);
  bytes.set([fieldWidth, tokenWidth, municipalityWidth], 72);
  for (let id = 0; id < rowCount; id++) {
    data.setUint32(HEADER_SIZE + id * 4, ceps[id] as number, true);
    writePackedInteger(bytes, rowMunicipalitiesOffset + id * municipalityWidth, rowMunicipalities[id] as number, municipalityWidth);
    for (let column = 0; column < 4; column++) {
      writePackedInteger(bytes, rowFieldsOffset + (id * 4 + column) * fieldWidth, rowFields[id * 4 + column] as number, fieldWidth);
    }
  }
  for (const [id, { code, uf },] of municipalities.entries()) {
    data.setUint32(municipalitiesOffset + id * 6, code, true);
    bytes.set([uf.charCodeAt(0), uf.charCodeAt(1)], municipalitiesOffset + id * 6 + 4);
  }
  let position = 0;
  for (const [id, field,] of fields.entries()) {
    data.setUint32(fieldOffsets + id * 4, position, true);
    for (const term of field) {
      writePackedInteger(bytes, fieldTokens + position++ * tokenWidth, remap[term] as number, tokenWidth);
    }
  }
  data.setUint32(fieldOffsets + fields.length * 4, position, true);
  for (const [id, offset,] of offsets.entries()) {
    data.setUint32(postingOffsets + id * 4, offset, true);
  }
  bytes.set(lexicon, lexiconOffset);
  let offset = lexiconOffset + lexicon.length;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  bytes.set(digest(bytes.subarray(0, -DIGEST_SIZE)), offset);
  parseAddressSearchIndex(bytes, checksum, rowCount);
  return bytes;
}

/** Validates integrity, source identity, and every range before queries can use the index. */
export function parseAddressSearchIndex(bytes: Uint8Array, checksum: string, rowCount: number): AddressSearchIndex {
  if (bytes.length < HEADER_SIZE + DIGEST_SIZE || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('Invalid address search index header');
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.getUint32(8, true) !== VERSION) {
    throw new Error('Unsupported address search index version; rebuild the search index');
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
  const fieldCount = data.getUint32(28, true);
  const tokenCount = data.getUint32(64, true);
  const municipalityCount = data.getUint32(68, true);
  const fieldWidth = readByteWidth(data.getUint8(72), 'search field');
  const tokenWidth = readByteWidth(data.getUint8(73), 'search token');
  const municipalityWidth = readByteWidth(data.getUint8(74), 'search municipality');
  const rowMunicipalities = HEADER_SIZE + rowCount * 4;
  const rowFields = rowMunicipalities + rowCount * municipalityWidth;
  const municipalities = rowFields + rowCount * 4 * fieldWidth;
  const fieldOffsets = municipalities + municipalityCount * 6;
  const fieldTokens = fieldOffsets + (fieldCount + 1) * 4;
  const offsets = fieldTokens + tokenCount * tokenWidth;
  const lexiconOffset = offsets + (count + 1) * 4;
  const postingsOffset = lexiconOffset + lexiconLength;
  if (
    !fieldCount || !municipalityCount || data.getUint8(75) !== 0 || data.getUint32(76, true) !== 0
    || postingsOffset + postingsLength + DIGEST_SIZE !== bytes.length
  ) {
    throw new Error('Invalid address search index size');
  }
  const terms: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(lexiconOffset, postingsOffset)));
  if (
    !Array.isArray(terms) || terms.length !== count
    || terms.some((term, id) => typeof term !== 'string' || !/^[a-z0-9]+$/.test(term) || (id > 0 && terms[id - 1] >= term))
  ) {
    throw new Error('Invalid address search vocabulary');
  }
  const index: AddressSearchIndex = {
    data,
    terms,
    offsets,
    postings: bytes.subarray(postingsOffset, -DIGEST_SIZE),
    rowCount,
    rowMunicipalities,
    rowFields,
    fieldOffsets,
    fieldCount,
    fieldTokens,
    fieldWidth,
    tokenWidth,
    municipalityWidth,
    municipalityCodes: [],
    municipalityUfs: [],
    municipalityByCode: new Map(),
  };
  for (let id = 0; id < municipalityCount; id++) {
    const code = data.getUint32(municipalities + id * 6, true);
    const uf = String.fromCharCode(data.getUint8(municipalities + id * 6 + 4), data.getUint8(municipalities + id * 6 + 5)) as UF;
    if (code < 1_000_000 || code > 9_999_999 || !ALL_UFS.includes(uf) || index.municipalityByCode.has(code)) {
      throw new Error('Invalid address search municipality');
    }
    index.municipalityCodes.push(code);
    index.municipalityUfs.push(uf);
    index.municipalityByCode.set(code, id);
  }
  let previous = -1;
  for (let id = 0; id < rowCount; id++) {
    const cep = data.getUint32(HEADER_SIZE + id * 4, true);
    if (cep <= previous || cep > 99_999_999) {
      throw new Error('Invalid address search CEP');
    }
    previous = cep;
    if (searchRowMunicipality(index, id) >= municipalityCount) {
      throw new Error('Invalid address search municipality reference');
    }
    for (let column = 0; column < 4; column++) {
      if (readPackedInteger(data, rowFields + (id * 4 + column) * fieldWidth, fieldWidth) >= fieldCount) {
        throw new Error('Invalid address search field reference');
      }
    }
  }
  if (data.getUint32(fieldOffsets, true) !== 0 || data.getUint32(fieldOffsets + fieldCount * 4, true) !== tokenCount) {
    throw new Error('Invalid address search field offsets');
  }
  for (let id = 0; id < fieldCount; id++) {
    const start = data.getUint32(fieldOffsets + id * 4, true);
    const end = data.getUint32(fieldOffsets + (id + 1) * 4, true);
    if (end < start || end > tokenCount) {
      throw new Error('Invalid address search field range');
    }
  }
  for (let id = 0; id < tokenCount; id++) {
    if (readPackedInteger(data, fieldTokens + id * tokenWidth, tokenWidth) >= count) {
      throw new Error('Invalid address search field token');
    }
  }
  if (data.getUint32(offsets, true) !== 0 || data.getUint32(offsets + count * 4, true) !== postingsLength) {
    throw new Error('Invalid address search posting offsets');
  }
  for (let id = 0; id < count; id++) {
    visitSearchPosting(index, id);
  }
  return index;
}

/** Visits an ordered posting without materializing it, checking delta and range invariants. */
export function visitSearchPosting(index: AddressSearchIndex, id: number, visit?: (row: number) => void): void {
  let offset = index.data.getUint32(index.offsets + id * 4, true);
  const end = index.data.getUint32(index.offsets + (id + 1) * 4, true);
  if (end <= offset || end > index.postings.length) {
    throw new Error('Invalid address search posting range');
  }
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
    visit?.(row);
    previous = row;
  }
}

/** Resolves an index row ID to the eight-digit CEP used by the database reader. */
export function searchRowCep(index: AddressSearchIndex, id: number): string {
  return String(index.data.getUint32(HEADER_SIZE + id * 4, true)).padStart(8, '0');
}

/** Reads geographic membership directly, without enumerating any geographic posting list. */
export function searchRowMunicipality(index: AddressSearchIndex, id: number): number {
  return readPackedInteger(index.data, index.rowMunicipalities + id * index.municipalityWidth, index.municipalityWidth);
}

/** Finds a CEP anchor using the search index, without decoding an address. */
export function findSearchCep(index: AddressSearchIndex, cep: string): number {
  const wanted = Number(cep.replace('-', ''));
  let low = 0;
  let high = index.rowCount;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if (index.data.getUint32(HEADER_SIZE + middle * 4, true) < wanted) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < index.rowCount && index.data.getUint32(HEADER_SIZE + low * 4, true) === wanted ? low : -1;
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
  return new Uint8Array(bytes);
}

function digest(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}
