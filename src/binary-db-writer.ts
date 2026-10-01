import { Database } from 'bun:sqlite';
import { open } from 'node:fs/promises';
import { encodeBairroRuns } from './bairro-runs.ts';
import {
  isBairroId,
  type DneBairro,
  type DneFaixaCep,
} from './bairro.ts';
import {
  alignBinaryOffset as align,
  assertPackedInteger,
  BINARY_BAIRRO_HEADER_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_MAGIC as MAGIC,
  BINARY_DATABASE_VERSION,
  BINARY_SECTION_NAMES as SECTION_NAMES,
  bitmapByteLength,
  CEP_PREFIX_OFFSETS_COUNT,
  CEP_SUFFIX_BITS,
  createPopcountTable,
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  DICTIONARY_HEADER_SIZE,
  integerByteWidth,
  MAX_UINT32,
  packedBitLength,
  SECTION_TABLE_OFFSET,
  SPARSE_RANK_ROWS,
  SPARSE_RANK_SHIFT,
  writePacked10,
  writePackedInteger,
  type BinaryHeader,
  type BinaryRegion as Region,
  type BinarySectionName as SectionName,
  type ByteWidth,
} from './binary-db-format.ts';
import { encodeLocalityRuns } from './locality-runs.ts';
import {
  integerBitWidth,
  writePackedBits,
} from './packed-bits.ts';
import { LOCALIDADE_TIPO_CODIGOS } from './schema.ts';
import {
  SQLITE_BAIRRO_FAIXAS_TABLE_NAME,
  SQLITE_BAIRROS_TABLE_NAME,
  SQLITE_CEP_TABLE_NAME,
  SQLITE_METADATA_TABLE_NAME,
} from './settings.ts';
import type {
  LoadMetadata,
  StoredDneRow,
} from './types.ts';

type BuiltDictionary = {
  bytes: Uint8Array;
  count: number;
  ids: Map<string, number>;
  idWidth: ByteWidth;
};

type BuiltDictionaries = {
  bairro: BuiltDictionary;
  bairroAbreviado: BuiltDictionary;
  complemento: BuiltDictionary;
  logradouro: BuiltDictionary;
  municipio: BuiltDictionary;
  nome: BuiltDictionary;
  uf: BuiltDictionary;
};

type RawDneRow = Omit<StoredDneRow, 'bairro'> & {
  bairro_id: number | null;
  localidade_nome: string | null;
};

type Municipality = {
  municipio: string;
  uf: string;
};

type GatheredValues = {
  complementoCount: number;
  localidadeNomeCount: number;
  municipalitiesByIbge: Map<number, Municipality>;
  nomeCount: number;
  strings: {
    bairro: Set<string>;
    bairroAbreviado: Set<string>;
    complemento: Set<string>;
    logradouro: Set<string>;
    municipio: Set<string>;
    nome: Set<string>;
    uf: Set<string>;
  };
};

type SparseSections = {
  bitmap: Uint8Array;
  ids: Uint8Array;
  ranks: Uint8Array;
};

const textEncoder = new TextEncoder();
const popcount = createPopcountTable();

/**
 * Exports the unified SQLite table to the current immutable binary format.
 * The destination is overwritten; callers should use a temporary path before publishing the completed file.
 * @param sqlitePath - Existing SQLite database using the current logical schema.
 * @param binaryPath - Destination file path.
 * @param tableName - Unified source table name; defaults to the configured CEP table.
 * @returns The number of exported CEP rows.
 * @throws {Error} If the source cannot be read, values violate the format, or the destination cannot be written.
 */
export async function buildBinaryDatabase(
  sqlitePath: string,
  binaryPath: string,
  tableName = SQLITE_CEP_TABLE_NAME,
) {
  assertLittleEndian();
  const db = new Database(sqlitePath, { readonly: true });

  try {
    db.run('BEGIN');
    const rowCount = readRowCount(db, tableName);
    assertUint32(rowCount, 'row count');
    if (!rowCount) {
      throw new Error('Cannot create a binary database without rows');
    }

    const bairros = db.query(`SELECT bairro_id, localidade_id, uf, nome, nome_abreviado
      FROM ${quoteIdent(SQLITE_BAIRROS_TABLE_NAME)} ORDER BY bairro_id`).all() as DneBairro[];
    const bairroIndexes = new Map(bairros.map((bairro, index) => [bairro.bairro_id, index + 1]));
    const bairroIdWidth = integerByteWidth(bairros.length);
    const gathered = gatherValues(db, tableName, bairros);
    const dictionaries = buildDictionaries(gathered);
    const municipalityEntries = [...gathered.municipalitiesByIbge.entries()]
      .sort(([left,], [right,]) => left - right);
    const municipalityCount = municipalityEntries.length;
    const municipalityIdWidth = integerByteWidth(municipalityCount);
    const municipalityIdsByIbge = new Map<number, number>();
    for (const [index, [ibge,],] of municipalityEntries.entries()) {
      municipalityIdsByIbge.set(ibge, index + 1);
    }

    const cepPrefixOffsets = new Uint32Array(CEP_PREFIX_OFFSETS_COUNT);
    const cepSuffixes = new Uint8Array(packedBitLength(rowCount, CEP_SUFFIX_BITS));
    const logradouroIdBits = integerBitWidth(dictionaries.logradouro.count);
    const logradouroIds = new Uint8Array(packedBitLength(rowCount, logradouroIdBits));
    const complementoBitmap = new Uint8Array(bitmapByteLength(rowCount));
    const complementoIds = new Uint8Array(gathered.complementoCount * dictionaries.complemento.idWidth);
    const bairroIds = new Uint8Array(rowCount * bairroIdWidth);
    const localidadeNomeBitmap = new Uint8Array(bitmapByteLength(rowCount));
    const localidadeNomeIds = new Uint8Array(gathered.localidadeNomeCount * dictionaries.bairro.idWidth);
    const municipalityIds = new Uint8Array(rowCount * municipalityIdWidth);
    const localidadeFlags = new Uint8Array(rowCount);
    const nomeBitmap = new Uint8Array(bitmapByteLength(rowCount));
    const nomeIds = new Uint8Array(gathered.nomeCount * dictionaries.nome.idWidth);

    let complementoIndex = 0;
    let nomeIndex = 0;
    let localidadeNomeIndex = 0;
    let nextPrefix = 0;
    let previousCep = -1;
    let rowIndex = 0;
    for (const row of iterateRows(db, tableName)) {
      const cep = parseCepNumber(row.cep);
      if (cep <= previousCep) {
        throw new Error('CEP rows must be unique and ordered');
      }
      previousCep = cep;

      const tipo = LOCALIDADE_TIPO_CODIGOS.indexOf(row.localidade_tipo);
      if (tipo === -1 || ![0, 1, 2, 3].includes(row.localidade_situacao)) {
        throw new Error(`Invalid locality indicators for CEP: ${row.cep}`);
      }
      localidadeFlags[rowIndex] = (tipo << 2) | row.localidade_situacao;

      const prefix = Math.floor(cep / 1_000);
      while (nextPrefix <= prefix) {
        cepPrefixOffsets[nextPrefix] = rowIndex;
        nextPrefix++;
      }
      writePacked10(cepSuffixes, rowIndex, cep % 1_000);

      writePackedBits(
        logradouroIds,
        rowIndex,
        logradouroIdBits,
        dictionaryId(dictionaries.logradouro, row.logradouro),
      );
      if (row.complemento !== null) {
        setBitmapBit(complementoBitmap, rowIndex);
        writePackedInteger(
          complementoIds,
          complementoIndex * dictionaries.complemento.idWidth,
          requiredDictionaryId(dictionaries.complemento, row.complemento, 'complemento'),
          dictionaries.complemento.idWidth,
        );
        complementoIndex++;
      }
      const bairroIndex = row.bairro_id === null ? 0 : bairroIndexes.get(row.bairro_id);
      if (bairroIndex === undefined) {
        throw new Error(`Unknown bairro_id for CEP: ${row.cep}`);
      }
      writePackedInteger(bairroIds, rowIndex * bairroIdWidth, bairroIndex, bairroIdWidth);
      if (row.localidade_nome !== null) {
        if (bairroIndex !== 0 || row.localidade_tipo === 'M') {
          throw new Error(`Invalid subordinate locality name for CEP: ${row.cep}`);
        }
        setBitmapBit(localidadeNomeBitmap, rowIndex);
        writePackedInteger(
          localidadeNomeIds,
          localidadeNomeIndex * dictionaries.bairro.idWidth,
          requiredDictionaryId(dictionaries.bairro, row.localidade_nome, 'localidade_nome'),
          dictionaries.bairro.idWidth,
        );
        localidadeNomeIndex++;
      }
      const municipalityId = municipalityIdsByIbge.get(row.municipio_cod_ibge);
      if (municipalityId === undefined) {
        throw new Error(`Missing municipality for IBGE code: ${row.municipio_cod_ibge}`);
      }
      writePackedInteger(
        municipalityIds,
        rowIndex * municipalityIdWidth,
        municipalityId,
        municipalityIdWidth,
      );
      if (row.nome !== null) {
        setBitmapBit(nomeBitmap, rowIndex);
        writePackedInteger(
          nomeIds,
          nomeIndex * dictionaries.nome.idWidth,
          requiredDictionaryId(dictionaries.nome, row.nome, 'nome'),
          dictionaries.nome.idWidth,
        );
        nomeIndex++;
      }
      rowIndex++;
    }

    if (rowIndex !== rowCount) {
      throw new Error(`SQLite row count changed while exporting: expected ${rowCount}, got ${rowIndex}`);
    }
    if (
      complementoIndex !== gathered.complementoCount || nomeIndex !== gathered.nomeCount
      || localidadeNomeIndex !== gathered.localidadeNomeCount
    ) {
      throw new Error('SQLite nullable field counts changed while exporting');
    }
    while (nextPrefix < CEP_PREFIX_OFFSETS_COUNT) {
      cepPrefixOffsets[nextPrefix] = rowCount;
      nextPrefix++;
    }

    const cepPrefixOffsetWidth = integerByteWidth(rowCount);
    const complemento = createSparseSections(complementoBitmap, complementoIds, rowCount);
    const nome = createSparseSections(nomeBitmap, nomeIds, rowCount);
    const localidadeNome = createSparseSections(localidadeNomeBitmap, localidadeNomeIds, rowCount);
    const bairroRanges = createBairroRangeSections(db, bairroIndexes);
    const metadata = textEncoder.encode(JSON.stringify(readMetadata(db)));
    const municipalities = createMunicipalitySection(municipalityEntries, dictionaries);
    const localityRuns = encodeLocalityRuns(municipalityIds, localidadeFlags, municipalityIdWidth);
    const sections: Record<SectionName, Uint8Array> = {
      bairroDictionary: dictionaries.bairro.bytes,
      bairroAbreviadoDictionary: dictionaries.bairroAbreviado.bytes,
      bairroIds: encodeBairroRuns(bairroIds, rowCount, bairroIdWidth),
      bairros: createBairroSection(bairros, dictionaries),
      bairroFaixaOffsets: bairroRanges.offsets,
      bairroFaixas: bairroRanges.ranges,
      cepPrefixOffsets: packIntegerColumn(cepPrefixOffsets, cepPrefixOffsetWidth),
      cepSuffixes,
      complementoBitmap: complemento.bitmap,
      complementoDictionary: dictionaries.complemento.bytes,
      complementoIds: complemento.ids,
      complementoRanks: complemento.ranks,
      localidadeFlags: localityRuns.flags,
      localidadeNomeBitmap: localidadeNome.bitmap,
      localidadeNomeRanks: localidadeNome.ranks,
      localidadeNomeIds: localidadeNome.ids,
      logradouroDictionary: dictionaries.logradouro.bytes,
      logradouroIds,
      metadata,
      municipalities,
      municipalityIds: localityRuns.ids,
      municipioDictionary: dictionaries.municipio.bytes,
      nomeBitmap: nome.bitmap,
      nomeDictionary: dictionaries.nome.bytes,
      nomeIds: nome.ids,
      nomeRanks: nome.ranks,
      ufDictionary: dictionaries.uf.bytes,
    };

    await writeBinaryFile(binaryPath, rowCount, municipalityCount, municipalityIdWidth, cepPrefixOffsetWidth, sections);
    db.run('COMMIT');
    return rowCount;
  } finally {
    db.close();
  }
}

function gatherValues(db: Database, tableName: string, bairros: DneBairro[]): GatheredValues {
  const gathered: GatheredValues = {
    complementoCount: 0,
    localidadeNomeCount: 0,
    municipalitiesByIbge: new Map(),
    nomeCount: 0,
    strings: {
      bairro: new Set(),
      bairroAbreviado: new Set(),
      complemento: new Set(),
      logradouro: new Set(),
      municipio: new Set(),
      nome: new Set(),
      uf: new Set(),
    },
  };

  for (const bairro of bairros) {
    if (!isBairroId(bairro.bairro_id) || !isBairroId(bairro.localidade_id) || !bairro.nome || !bairro.uf) {
      throw new Error(`Invalid neighborhood: ${bairro.bairro_id}`);
    }
    gathered.strings.bairro.add(bairro.nome);
    addNullable(gathered.strings.bairroAbreviado, bairro.nome_abreviado);
    gathered.strings.uf.add(bairro.uf);
  }

  for (const row of iterateRows(db, tableName)) {
    addNullable(gathered.strings.logradouro, row.logradouro);
    addNullable(gathered.strings.complemento, row.complemento);
    addNullable(gathered.strings.bairro, row.localidade_nome);
    gathered.strings.municipio.add(row.municipio);
    gathered.strings.uf.add(row.uf);
    addNullable(gathered.strings.nome, row.nome);
    if (row.complemento !== null) {
      gathered.complementoCount++;
    }
    if (row.nome !== null) {
      gathered.nomeCount++;
    }
    if (row.localidade_nome !== null) {
      gathered.localidadeNomeCount++;
    }

    assertPackedInteger(row.municipio_cod_ibge, 3, 'municipio_cod_ibge');
    const existing = gathered.municipalitiesByIbge.get(row.municipio_cod_ibge);
    if (existing && (existing.municipio !== row.municipio || existing.uf !== row.uf)) {
      throw new Error(`IBGE code maps to multiple municipalities: ${row.municipio_cod_ibge}`);
    }
    gathered.municipalitiesByIbge.set(row.municipio_cod_ibge, {
      municipio: row.municipio,
      uf: row.uf,
    });
  }
  return gathered;
}

function buildDictionaries(gathered: GatheredValues): BuiltDictionaries {
  return {
    bairro: buildDictionary(gathered.strings.bairro),
    bairroAbreviado: buildDictionary(gathered.strings.bairroAbreviado),
    complemento: buildDictionary(gathered.strings.complemento),
    logradouro: buildDictionary(gathered.strings.logradouro),
    municipio: buildDictionary(gathered.strings.municipio),
    nome: buildDictionary(gathered.strings.nome),
    uf: buildDictionary(gathered.strings.uf),
  };
}

function buildDictionary(uniqueValues: Set<string>): BuiltDictionary {
  const values = [...uniqueValues].sort();
  const count = values.length;
  const blockCount = Math.ceil(count / DICTIONARY_BLOCK_SIZE);
  const blockOffsets = new Uint32Array(blockCount);
  const lengths = new Uint8Array(count);
  const prefixes = new Uint8Array(count);
  const ids = new Map<string, number>();
  let previous = new Uint8Array();
  let suffixDataLength = 0;

  for (const [index, value,] of values.entries()) {
    const encoded = textEncoder.encode(value);
    if (encoded.byteLength > 0xff) {
      throw new Error(`Binary string exceeds 255 UTF-8 bytes: ${value}`);
    }
    const prefixLength = index % DICTIONARY_BLOCK_SIZE === 0
      ? 0
      : commonPrefixLength(previous, encoded);
    if (index % DICTIONARY_BLOCK_SIZE === 0) {
      blockOffsets[index >>> DICTIONARY_BLOCK_SHIFT] = suffixDataLength;
    }
    lengths[index] = encoded.byteLength;
    prefixes[index] = prefixLength;
    suffixDataLength += encoded.byteLength - prefixLength;
    assertUint32(suffixDataLength, 'dictionary suffix data length');
    ids.set(value, index + 1);
    previous = encoded;
  }

  const blockOffsetsOffset = DICTIONARY_HEADER_SIZE;
  const lengthsOffset = blockOffsetsOffset + blockOffsets.byteLength;
  const prefixesOffset = lengthsOffset + lengths.byteLength;
  const suffixDataOffset = prefixesOffset + prefixes.byteLength;
  const bytes = new Uint8Array(suffixDataOffset + suffixDataLength);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, count, true);
  data.setUint32(4, blockCount, true);
  data.setUint32(8, blockOffsetsOffset, true);
  data.setUint32(12, lengthsOffset, true);
  data.setUint32(16, prefixesOffset, true);
  data.setUint32(20, suffixDataOffset, true);
  data.setUint32(24, suffixDataLength, true);
  data.setUint8(28, integerByteWidth(count));
  data.setUint8(29, DICTIONARY_BLOCK_SHIFT);
  bytes.set(asBytes(blockOffsets), blockOffsetsOffset);
  bytes.set(lengths, lengthsOffset);
  bytes.set(prefixes, prefixesOffset);

  let suffixOffset = suffixDataOffset;
  for (const [index, value,] of values.entries()) {
    const encoded = textEncoder.encode(value);
    const prefixLength = prefixes[index] ?? 0;
    bytes.set(encoded.subarray(prefixLength), suffixOffset);
    suffixOffset += encoded.byteLength - prefixLength;
  }

  return {
    bytes,
    count,
    ids,
    idWidth: integerByteWidth(count),
  };
}

function createMunicipalitySection(
  entries: [number, Municipality][],
  dictionaries: BuiltDictionaries,
) {
  const recordWidth = 3 + dictionaries.municipio.idWidth + dictionaries.uf.idWidth;
  const bytes = new Uint8Array(entries.length * recordWidth);
  for (const [index, [ibge, municipality,],] of entries.entries()) {
    const offset = index * recordWidth;
    writePackedInteger(bytes, offset, ibge, 3);
    writePackedInteger(
      bytes,
      offset + 3,
      requiredDictionaryId(dictionaries.municipio, municipality.municipio, 'municipio'),
      dictionaries.municipio.idWidth,
    );
    writePackedInteger(
      bytes,
      offset + 3 + dictionaries.municipio.idWidth,
      requiredDictionaryId(dictionaries.uf, municipality.uf, 'uf'),
      dictionaries.uf.idWidth,
    );
  }
  return bytes;
}

function createSparseSections(bitmap: Uint8Array, ids: Uint8Array, rowCount: number): SparseSections {
  const blockCount = Math.ceil(rowCount / SPARSE_RANK_ROWS);
  const ranks = new Uint32Array(blockCount + 1);
  let rank = 0;
  for (let block = 0; block < blockCount; block++) {
    ranks[block] = rank;
    const start = block * (SPARSE_RANK_ROWS >>> 3);
    const end = Math.min(start + (SPARSE_RANK_ROWS >>> 3), bitmap.byteLength);
    for (let index = start; index < end; index++) {
      rank += popcount[bitmap[index] ?? 0] ?? 0;
    }
  }
  ranks[blockCount] = rank;
  return { bitmap, ids, ranks: asBytes(ranks) };
}

function createBairroSection(bairros: DneBairro[], dictionaries: BuiltDictionaries) {
  const originalIdWidth = integerByteWidth(bairros.at(-1)?.bairro_id ?? 0);
  const localidadeIdWidth = integerByteWidth(bairros.reduce((max, bairro) => Math.max(max, bairro.localidade_id), 0));
  const recordWidth = originalIdWidth + localidadeIdWidth + dictionaries.bairro.idWidth
    + dictionaries.bairroAbreviado.idWidth + dictionaries.uf.idWidth;
  const bytes = new Uint8Array(BINARY_BAIRRO_HEADER_SIZE + bairros.length * recordWidth);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, bairros.length, true);
  data.setUint8(4, originalIdWidth);
  data.setUint8(5, localidadeIdWidth);
  for (const [index, bairro,] of bairros.entries()) {
    let offset = BINARY_BAIRRO_HEADER_SIZE + index * recordWidth;
    writePackedInteger(bytes, offset, bairro.bairro_id, originalIdWidth);
    offset += originalIdWidth;
    writePackedInteger(bytes, offset, bairro.localidade_id, localidadeIdWidth);
    offset += localidadeIdWidth;
    writePackedInteger(bytes, offset, requiredDictionaryId(dictionaries.bairro, bairro.nome, 'bairro'), dictionaries.bairro.idWidth);
    offset += dictionaries.bairro.idWidth;
    writePackedInteger(
      bytes,
      offset,
      dictionaryId(dictionaries.bairroAbreviado, bairro.nome_abreviado),
      dictionaries.bairroAbreviado.idWidth,
    );
    offset += dictionaries.bairroAbreviado.idWidth;
    writePackedInteger(bytes, offset, requiredDictionaryId(dictionaries.uf, bairro.uf, 'uf'), dictionaries.uf.idWidth);
  }
  return bytes;
}

function createBairroRangeSections(db: Database, bairroIndexes: Map<number, number>) {
  const rows = db.query(`SELECT bairro_id, cep_inicial, cep_final FROM ${quoteIdent(SQLITE_BAIRRO_FAIXAS_TABLE_NAME)}
    ORDER BY bairro_id, cep_inicial, cep_final`).all() as (DneFaixaCep & { bairro_id: number; })[];
  const offsets = new Uint32Array(bairroIndexes.size + 1);
  const ranges = new Uint8Array(rows.length * 8);
  const data = new DataView(ranges.buffer);
  let nextBairro = 0;
  let previous: typeof rows[number] | undefined;
  for (const [index, row,] of rows.entries()) {
    const bairroIndex = bairroIndexes.get(row.bairro_id);
    if (bairroIndex === undefined) {
      throw new Error(`Unknown neighborhood in CEP range: ${row.bairro_id}`);
    }
    const start = parseCepNumber(row.cep_inicial);
    const end = parseCepNumber(row.cep_final);
    if (start > end) {
      throw new Error(`Reversed neighborhood CEP range: ${row.bairro_id}`);
    }
    if (previous?.bairro_id === row.bairro_id && previous.cep_inicial === row.cep_inicial && previous.cep_final === row.cep_final) {
      throw new Error(`Duplicate neighborhood CEP range: ${row.bairro_id}`);
    }
    while (nextBairro < bairroIndex) {
      offsets[nextBairro++] = index;
    }
    data.setUint32(index * 8, start, true);
    data.setUint32(index * 8 + 4, end, true);
    previous = row;
  }
  while (nextBairro < offsets.length) {
    offsets[nextBairro++] = rows.length;
  }
  return { offsets: asBytes(offsets), ranges };
}

async function writeBinaryFile(
  path: string,
  rowCount: number,
  municipalityCount: number,
  municipalityIdWidth: 1 | 2 | 3 | 4,
  cepPrefixOffsetWidth: 1 | 2 | 3 | 4,
  sectionData: Record<SectionName, Uint8Array>,
) {
  const sections = {} as Record<SectionName, Region>;
  let cursor = BINARY_DATABASE_HEADER_SIZE;
  for (const name of SECTION_NAMES) {
    cursor = align(cursor);
    sections[name] = { length: sectionData[name].byteLength, offset: cursor };
    cursor += sectionData[name].byteLength;
  }
  const fileSize = align(cursor);
  assertUint32(fileSize, 'file size');
  const header = createHeader({
    cepPrefixOffsetWidth,
    fileSize,
    municipalityCount,
    municipalityIdWidth,
    rowCount,
    sections,
  });

  const file = await open(path, 'w');
  try {
    await writeBytes(file, header);
    let position = header.byteLength;
    for (const name of SECTION_NAMES) {
      const region = sections[name];
      await writePadding(file, region.offset - position);
      await writeBytes(file, sectionData[name]);
      position = region.offset + region.length;
    }
    await writePadding(file, fileSize - position);
  } finally {
    await file.close();
  }
}

function createHeader(values: BinaryHeader) {
  const header = new Uint8Array(BINARY_DATABASE_HEADER_SIZE);
  header.set(MAGIC, 0);
  const data = new DataView(header.buffer);
  data.setUint16(8, BINARY_DATABASE_VERSION, true);
  data.setUint16(10, BINARY_DATABASE_HEADER_SIZE, true);
  data.setUint32(12, values.rowCount, true);
  data.setUint32(16, values.fileSize, true);
  data.setUint8(20, values.cepPrefixOffsetWidth);
  data.setUint8(21, values.municipalityIdWidth);
  data.setUint8(22, SPARSE_RANK_SHIFT);
  data.setUint8(23, DICTIONARY_BLOCK_SHIFT);
  data.setUint16(24, SECTION_NAMES.length, true);
  data.setUint32(28, values.municipalityCount, true);
  for (const [index, name,] of SECTION_NAMES.entries()) {
    const region = values.sections[name];
    const offset = SECTION_TABLE_OFFSET + index * 8;
    data.setUint32(offset, region.offset, true);
    data.setUint32(offset + 4, region.length, true);
  }
  return header;
}

function readRowCount(db: Database, tableName: string) {
  const row = db.query(`SELECT count(*) AS count FROM ${quoteIdent(tableName)}`).get() as { count: number; };
  return row.count;
}

function* iterateRows(db: Database, tableName: string): Generator<RawDneRow> {
  const statement = db.query(`
    SELECT cep, logradouro, complemento, bairro_id, localidade_nome, municipio, municipio_cod_ibge, uf, nome, localidade_situacao, localidade_tipo
    FROM ${quoteIdent(tableName)}
    ORDER BY cep
  `);
  try {
    for (const value of statement.iterate()) {
      yield value as RawDneRow;
    }
  } finally {
    statement.finalize();
  }
}

function readMetadata(db: Database): LoadMetadata {
  const hasTable = db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(
    SQLITE_METADATA_TABLE_NAME,
  );
  if (!hasTable) {
    return {};
  }
  const rows = db.query(`SELECT key, value FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`).all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function dictionaryId(dictionary: BuiltDictionary, value: string | null) {
  return value === null ? 0 : requiredDictionaryId(dictionary, value, 'string');
}

function requiredDictionaryId(dictionary: BuiltDictionary, value: string, field: string) {
  const id = dictionary.ids.get(value);
  if (id === undefined) {
    throw new Error(`Missing binary ${field} dictionary value: ${value}`);
  }
  return id;
}

function addNullable(values: Set<string>, value: string | null) {
  if (value !== null) {
    values.add(value);
  }
}

function commonPrefixLength(left: Uint8Array, right: Uint8Array) {
  const limit = Math.min(left.byteLength, right.byteLength);
  let length = 0;
  while (length < limit && left[length] === right[length]) {
    length++;
  }
  return length;
}

function setBitmapBit(bitmap: Uint8Array, index: number) {
  const byteIndex = index >>> 3;
  bitmap[byteIndex] = (bitmap[byteIndex] ?? 0) | (1 << (index & 7));
}

function packIntegerColumn(values: Uint32Array, width: 1 | 2 | 3 | 4) {
  const bytes = new Uint8Array(values.length * width);
  for (let index = 0; index < values.length; index++) {
    writePackedInteger(bytes, index * width, values[index] ?? 0, width);
  }
  return bytes;
}

function parseCepNumber(value: string) {
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`Invalid CEP in SQLite database: ${value}`);
  }
  return Number(value);
}

function assertLittleEndian() {
  const probe = new Uint16Array([1]);
  if (new Uint8Array(probe.buffer)[0] !== 1) {
    throw new Error('Binary database generation requires a little-endian platform');
  }
}

function assertUint32(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error(`Binary ${name} exceeds the uint32 limit: ${value}`);
  }
}

function asBytes(value: Uint8Array | Uint32Array) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

async function writeBytes(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array) {
  await file.write(bytes);
}

async function writePadding(file: Awaited<ReturnType<typeof open>>, length: number) {
  if (length > 0) {
    await file.write(new Uint8Array(length));
  }
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
