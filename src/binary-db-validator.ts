import {
  parseBairroRuns,
  type BairroRuns,
} from './bairro-runs.ts';
import { DneBinaryDatabaseFormatError } from './binary-db-errors.ts';
import {
  alignBinaryOffset,
  BINARY_BAIRRO_HEADER_SIZE,
  BINARY_DATABASE_CHECKSUM_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_MAGIC as MAGIC,
  BINARY_DATABASE_VERSION,
  BINARY_SECTION_NAMES as SECTION_NAMES,
  bitmapByteLength,
  CEP_PREFIX_COUNT,
  CEP_PREFIX_OFFSETS_COUNT,
  CEP_SUFFIX_BITS,
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  DICTIONARY_CODEC_FSST,
  DICTIONARY_CODEC_PLAIN,
  DICTIONARY_HEADER_SIZE,
  FSST_SYMBOL_COUNT,
  FSST_SYMBOL_TABLE_SIZE,
  integerByteWidth,
  maxPackedInteger,
  packedBitLength,
  readByteWidth,
  readPackedInteger,
  SECTION_TABLE_OFFSET,
  SPARSE_RANK_ROWS,
  SPARSE_RANK_SHIFT,
  type BinaryHeader,
  type BinaryRegion as Region,
  type BinarySectionName as SectionName,
  type ByteWidth,
} from './binary-db-format.ts';
import {
  parseLocalityRuns,
  type LocalityRuns,
} from './locality-runs.ts';
import {
  integerBitWidth,
  readPackedBits,
} from './packed-bits.ts';
import {
  LOCALIDADE_SITUACOES,
  LOCALIDADE_TIPOS,
} from './schema.ts';
import {
  parseUF,
  stateCodes,
} from './types.ts';

type BinaryDictionary = {
  blockCount: number;
  blockOffsetsOffset: number;
  codec: number;
  count: number;
  idWidth: ByteWidth;
  lengthWidth: 1 | 2;
  lengthsOffset: number;
  prefixesOffset: number;
  region: Region;
  suffixDataLength: number;
  suffixDataOffset: number;
  symbolsOffset: number;
  values: string[];
};

type BinaryDictionaries = {
  bairro: BinaryDictionary;
  bairroAbreviado: BinaryDictionary;
  complemento: BinaryDictionary;
  logradouro: BinaryDictionary;
  municipio: BinaryDictionary;
  nome: BinaryDictionary;
  uf: BinaryDictionary;
};

type BinaryBairros = {
  count: number;
  idWidth: ByteWidth;
  localidadeIdWidth: ByteWidth;
  originalIdWidth: ByteWidth;
  recordWidth: number;
  recordsOffset: number;
};

type BairroRunValues = {
  ids: Uint32Array;
  starts: Uint32Array;
};

type LocalityRunValues = {
  flags: Uint8Array;
  ids: Uint32Array;
  starts: Uint32Array;
};

type MunicipalityTable = {
  ufIds: Uint32Array;
};

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Validates a complete serialized v5 database before its checksum is sealed.
 *
 * The final {@link BINARY_DATABASE_CHECKSUM_SIZE} bytes are reserved for the
 * SHA-256 footer and are intentionally ignored here. The caller may pass the
 * zeroed pre-seal buffer or an already sealed buffer. All bytes before that
 * footer are checked, including the canonical section padding.
 *
 * @param bytes - Complete file bytes, including the reserved checksum footer.
 * @throws {DneBinaryDatabaseFormatError} If any header, section, index,
 * dictionary, reference, or cross-field invariant is violated.
 */
export function validateBinaryDatabaseBytes(bytes: Uint8Array): void {
  try {
    if (!(bytes instanceof Uint8Array)) {
      throw new DneBinaryDatabaseFormatError('Binary database bytes must be a Uint8Array');
    }
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = readHeader(data);
    validateHeader(bytes, header);
    const dictionaries = readDictionaries(bytes, data, header);
    validateUfDictionary(dictionaries.uf);
    const bairros = readNeighborhoods(bytes, data, header, dictionaries);
    const municipalityTable = validateMunicipalities(data, header, dictionaries);
    const sparse = validateSparseColumns(bytes, data, header, dictionaries);
    const bairroRuns = parseBairroRuns(
      data,
      header.sections.bairroIds,
      header.rowCount,
      bairros.idWidth,
      bairros.count,
    );
    const localityRuns = parseLocalityRuns(
      data,
      header.sections.municipalityIds,
      header.rowCount,
      header.municipalityIdWidth,
    );
    validateRunSections(data, header, bairroRuns, localityRuns);
    validateNeighborhoodRanges(data, header, bairros);
    validateCepColumns(bytes, data, header);
    validateLogradouroIds(bytes, data, header, dictionaries.logradouro);
    validateRows(
      data,
      header,
      dictionaries,
      bairros,
      bairroRuns,
      localityRuns,
      sparse,
      municipalityTable,
    );
    validateMetadata(bytes, header.sections.metadata);
  } catch (error) {
    if (error instanceof DneBinaryDatabaseFormatError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DneBinaryDatabaseFormatError(`Unable to validate binary database: ${message}`, { cause: error });
  }
}

function readHeader(data: DataView): BinaryHeader {
  if (data.byteLength < BINARY_DATABASE_HEADER_SIZE + BINARY_DATABASE_CHECKSUM_SIZE) {
    throw new DneBinaryDatabaseFormatError('Binary database header is truncated');
  }
  for (let index = 0; index < MAGIC.length; index++) {
    if (data.getUint8(index) !== MAGIC[index]) {
      throw new DneBinaryDatabaseFormatError('Invalid binary database magic');
    }
  }
  if (data.getUint16(8, true) !== BINARY_DATABASE_VERSION) {
    throw new DneBinaryDatabaseFormatError('Unsupported binary database version');
  }
  if (data.getUint16(10, true) !== BINARY_DATABASE_HEADER_SIZE) {
    throw new DneBinaryDatabaseFormatError('Unsupported binary database header size');
  }
  if (data.getUint8(22) !== SPARSE_RANK_SHIFT || data.getUint8(23) !== DICTIONARY_BLOCK_SHIFT) {
    throw new DneBinaryDatabaseFormatError('Unsupported binary database block layout');
  }
  if (data.getUint16(24, true) !== SECTION_NAMES.length) {
    throw new DneBinaryDatabaseFormatError('Unsupported binary database section table');
  }

  const sections = {} as Record<SectionName, Region>;
  for (const [index, name,] of SECTION_NAMES.entries()) {
    const offset = SECTION_TABLE_OFFSET + index * 8;
    sections[name] = {
      length: data.getUint32(offset + 4, true),
      offset: data.getUint32(offset, true),
    };
  }
  return {
    cepPrefixOffsetWidth: readByteWidth(data.getUint8(20), 'CEP prefix offset'),
    fileSize: data.getUint32(16, true),
    municipalityCount: data.getUint32(28, true),
    municipalityIdWidth: readByteWidth(data.getUint8(21), 'municipality id'),
    rowCount: data.getUint32(12, true),
    sections,
  };
}

function validateHeader(bytes: Uint8Array, header: BinaryHeader) {
  const payloadEnd = bytes.byteLength - BINARY_DATABASE_CHECKSUM_SIZE;
  if (header.fileSize !== bytes.byteLength) {
    throw new DneBinaryDatabaseFormatError(
      `Binary database size mismatch: header=${header.fileSize}, actual=${bytes.byteLength}`,
    );
  }
  if (payloadEnd < BINARY_DATABASE_HEADER_SIZE || payloadEnd % 8 !== 0) {
    throw new DneBinaryDatabaseFormatError('Binary database payload has an invalid alignment');
  }
  if (!header.rowCount || !header.municipalityCount) {
    throw new DneBinaryDatabaseFormatError('Binary database must contain rows and municipalities');
  }
  if (header.rowCount > maxPackedInteger(header.cepPrefixOffsetWidth)) {
    throw new DneBinaryDatabaseFormatError('Binary row count does not fit the CEP prefix offset width');
  }
  if (header.municipalityCount > maxPackedInteger(header.municipalityIdWidth)) {
    throw new DneBinaryDatabaseFormatError('Binary municipality count does not fit its id width');
  }
  if (
    header.cepPrefixOffsetWidth !== integerByteWidth(header.rowCount)
    || header.municipalityIdWidth !== integerByteWidth(header.municipalityCount)
  ) {
    throw new DneBinaryDatabaseFormatError('Binary database uses a noncanonical integer width');
  }
  validateZeroRange(bytes, 26, 28, 'binary header reserved bytes');
  validateZeroRange(bytes, 248, BINARY_DATABASE_HEADER_SIZE, 'binary header reserved bytes');

  let previousEnd = BINARY_DATABASE_HEADER_SIZE;
  for (const name of SECTION_NAMES) {
    const region = header.sections[name];
    validateRegion(payloadEnd, region, name);
    if (region.offset % 8 !== 0 || region.offset < previousEnd) {
      throw new DneBinaryDatabaseFormatError(`Binary section is out of order or unaligned: ${name}`);
    }
    validateZeroRange(bytes, previousEnd, region.offset, `${name} section padding`);
    previousEnd = region.offset + region.length;
  }
  validateZeroRange(bytes, previousEnd, payloadEnd, 'final binary section padding');
  if (alignBinaryOffset(previousEnd) !== payloadEnd) {
    throw new DneBinaryDatabaseFormatError('Binary database footer is not after aligned section data');
  }

  assertRegionLength(
    header.sections.cepPrefixOffsets,
    CEP_PREFIX_OFFSETS_COUNT * header.cepPrefixOffsetWidth,
    'CEP prefix directory',
  );
  assertRegionLength(
    header.sections.cepSuffixes,
    packedBitLength(header.rowCount, CEP_SUFFIX_BITS),
    'CEP suffix column',
  );
  for (const name of ['complementoBitmap', 'nomeBitmap', 'localidadeNomeBitmap'] as const) {
    assertRegionLength(header.sections[name], bitmapByteLength(header.rowCount), 'nullable bitmap');
  }
  const expectedRankLength = (Math.ceil(header.rowCount / SPARSE_RANK_ROWS) + 1) * 4;
  for (const name of ['complementoRanks', 'nomeRanks', 'localidadeNomeRanks'] as const) {
    assertRegionLength(header.sections[name], expectedRankLength, 'sparse rank index');
  }
}

function readDictionaries(bytes: Uint8Array, data: DataView, header: BinaryHeader): BinaryDictionaries {
  return {
    bairro: readDictionary(bytes, data, header.sections.bairroDictionary, 'bairro', false),
    bairroAbreviado: readDictionary(bytes, data, header.sections.bairroAbreviadoDictionary, 'bairro abbreviation', false),
    complemento: readDictionary(bytes, data, header.sections.complementoDictionary, 'complemento', false),
    logradouro: readDictionary(bytes, data, header.sections.logradouroDictionary, 'logradouro', true),
    municipio: readDictionary(bytes, data, header.sections.municipioDictionary, 'municipio', false),
    nome: readDictionary(bytes, data, header.sections.nomeDictionary, 'nome', false),
    uf: readDictionary(bytes, data, header.sections.ufDictionary, 'uf', false),
  };
}

function validateUfDictionary(dictionary: BinaryDictionary) {
  for (const [index, value,] of dictionary.values.entries()) {
    requireCanonicalUf(value, index);
  }
}

function requireCanonicalUf(value: string, index: number) {
  let parsed: ReturnType<typeof parseUF>;
  try {
    parsed = parseUF(value);
  } catch (cause) {
    throw new DneBinaryDatabaseFormatError(`Invalid binary UF dictionary entry: ${index}`, { cause });
  }
  if (value !== parsed) {
    throw new DneBinaryDatabaseFormatError(`Binary UF dictionary entry is not canonical: ${index}`);
  }
  return parsed;
}

function readDictionary(
  bytes: Uint8Array,
  data: DataView,
  region: Region,
  name: string,
  allowFsst: boolean,
): BinaryDictionary {
  if (region.length < DICTIONARY_HEADER_SIZE) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary is truncated`);
  }
  const count = data.getUint32(region.offset, true);
  const blockCount = data.getUint32(region.offset + 4, true);
  const blockOffsetsRelative = data.getUint32(region.offset + 8, true);
  const lengthsRelative = data.getUint32(region.offset + 12, true);
  const prefixesRelative = data.getUint32(region.offset + 16, true);
  const suffixDataRelative = data.getUint32(region.offset + 20, true);
  const suffixDataLength = data.getUint32(region.offset + 24, true);
  const idWidth = readByteWidth(data.getUint8(region.offset + 28), `${name} dictionary id`);
  const codec = data.getUint8(region.offset + 30);
  const encodedWidth = data.getUint8(region.offset + 31);
  if (
    (codec !== DICTIONARY_CODEC_PLAIN && (codec !== DICTIONARY_CODEC_FSST || !allowFsst))
    || (codec === DICTIONARY_CODEC_PLAIN ? encodedWidth !== 0 : encodedWidth !== 1 && encodedWidth !== 2)
  ) {
    throw new DneBinaryDatabaseFormatError(`Unsupported binary ${name} dictionary codec or length width`);
  }
  if (data.getUint8(region.offset + 29) !== DICTIONARY_BLOCK_SHIFT) {
    throw new DneBinaryDatabaseFormatError(`Unsupported binary ${name} dictionary block size`);
  }
  const expectedBlockCount = Math.ceil(count / DICTIONARY_BLOCK_SIZE);
  if (blockCount !== expectedBlockCount || count > maxPackedInteger(idWidth)) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has an invalid count or id width`);
  }
  const lengthWidth = encodedWidth === 2 ? 2 : 1;
  const symbolTableSize = codec === DICTIONARY_CODEC_FSST ? FSST_SYMBOL_TABLE_SIZE : 0;
  if (
    blockOffsetsRelative !== DICTIONARY_HEADER_SIZE
    || lengthsRelative !== blockOffsetsRelative + blockCount * 4
    || prefixesRelative !== lengthsRelative + count * lengthWidth
    || suffixDataRelative !== prefixesRelative + count + symbolTableSize
    || suffixDataRelative > region.length
    || suffixDataLength !== region.length - suffixDataRelative
    || idWidth !== integerByteWidth(count)
  ) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has an invalid layout`);
  }

  const dictionary: BinaryDictionary = {
    blockCount,
    blockOffsetsOffset: region.offset + blockOffsetsRelative,
    codec,
    count,
    idWidth,
    lengthWidth,
    lengthsOffset: region.offset + lengthsRelative,
    prefixesOffset: region.offset + prefixesRelative,
    region,
    suffixDataLength,
    suffixDataOffset: region.offset + suffixDataRelative,
    symbolsOffset: region.offset + prefixesRelative + count,
    values: [],
  };
  validateDictionaryBlocks(bytes, data, dictionary, name);
  dictionary.values = decodeDictionary(bytes, data, dictionary, name);
  return dictionary;
}

function validateDictionaryBlocks(
  bytes: Uint8Array,
  data: DataView,
  dictionary: BinaryDictionary,
  name: string,
) {
  if (dictionary.blockCount && data.getUint32(dictionary.blockOffsetsOffset, true) !== 0) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has an invalid first block offset`);
  }
  let previous = 0;
  for (let block = 0; block < dictionary.blockCount; block++) {
    const offset = data.getUint32(dictionary.blockOffsetsOffset + block * 4, true);
    if (offset < previous || offset > dictionary.suffixDataLength) {
      throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has invalid block offsets`);
    }
    previous = offset;
  }
  if (dictionary.codec === DICTIONARY_CODEC_FSST) {
    for (let code = 0; code < FSST_SYMBOL_COUNT; code++) {
      const length = bytes[dictionary.symbolsOffset + code] ?? 0;
      if (length > 8) {
        throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} FSST symbol length`);
      }
      const slot = dictionary.symbolsOffset + FSST_SYMBOL_COUNT + code * 8;
      validateZeroRange(bytes, slot + length, slot + 8, `binary ${name} FSST symbol padding`);
    }
  }
  if (dictionary.blockCount === 0 && dictionary.suffixDataLength !== 0) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has unexpected payload`);
  }
}

function decodeDictionary(
  bytes: Uint8Array,
  data: DataView,
  dictionary: BinaryDictionary,
  name: string,
): string[] {
  const values: string[] = [];
  const retainValues = name === 'bairro' || name === 'municipio' || name === 'uf';
  let previousValue: string | undefined;
  for (let block = 0; block < dictionary.blockCount; block++) {
    const blockStart = block * DICTIONARY_BLOCK_SIZE;
    const blockEndIndex = Math.min(dictionary.count, blockStart + DICTIONARY_BLOCK_SIZE);
    const relative = data.getUint32(dictionary.blockOffsetsOffset + block * 4, true);
    const nextRelative = block + 1 < dictionary.blockCount
      ? data.getUint32(dictionary.blockOffsetsOffset + (block + 1) * 4, true)
      : dictionary.suffixDataLength;
    let cursor = dictionary.suffixDataOffset + relative;
    const blockEnd = dictionary.suffixDataOffset + nextRelative;
    let blockPrevious: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for (let index = blockStart; index < blockEndIndex; index++) {
      const prefix = bytes[dictionary.prefixesOffset + index] ?? 0;
      if ((index === blockStart && prefix !== 0) || prefix > blockPrevious.byteLength) {
        throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} dictionary prefix: ${index}`);
      }
      let current: Uint8Array<ArrayBufferLike>;
      if (dictionary.codec === DICTIONARY_CODEC_PLAIN) {
        const length = bytes[dictionary.lengthsOffset + index] ?? 0;
        if (prefix > length) {
          throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} dictionary length: ${index}`);
        }
        const suffixLength = length - prefix;
        if (cursor < dictionary.suffixDataOffset || cursor + suffixLength > blockEnd) {
          throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} dictionary suffix: ${index}`);
        }
        current = new Uint8Array(length);
        current.set(blockPrevious.subarray(0, prefix));
        current.set(bytes.subarray(cursor, cursor + suffixLength), prefix);
        cursor += suffixLength;
      } else {
        const compressedLength = dictionary.lengthWidth === 1
          ? bytes[dictionary.lengthsOffset + index] ?? 0
          : data.getUint16(dictionary.lengthsOffset + index * 2, true);
        if (cursor < dictionary.suffixDataOffset || cursor + compressedLength > blockEnd) {
          throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} FSST suffix: ${index}`);
        }
        if (compressedLength > 510) {
          throw new DneBinaryDatabaseFormatError(`Binary ${name} FSST suffix is too long: ${index}`);
        }
        current = decodeFsstValue(bytes, dictionary, cursor, compressedLength, blockPrevious, prefix, name, index);
        cursor += compressedLength;
      }
      let value: string;
      try {
        value = textDecoder.decode(current);
      } catch (cause) {
        throw new DneBinaryDatabaseFormatError(`Invalid UTF-8 in binary ${name} dictionary entry: ${index}`, { cause });
      }
      if (previousValue !== undefined && previousValue >= value) {
        throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary is not strictly sorted: ${index}`);
      }
      if (retainValues) {
        values.push(value);
      }
      previousValue = value;
      blockPrevious = current;
    }
    if (cursor !== blockEnd) {
      throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary block length mismatch`);
    }
    // Keep this assignment explicit: the first entry of the next block is
    // front-coded from an empty value, while the last entry is still useful
    // for the next block's diagnostic context.
  }
  return values;
}

function decodeFsstValue(
  bytes: Uint8Array,
  dictionary: BinaryDictionary,
  offset: number,
  compressedLength: number,
  previous: Uint8Array<ArrayBufferLike>,
  prefix: number,
  name: string,
  index: number,
): Uint8Array<ArrayBufferLike> {
  const output: Uint8Array<ArrayBufferLike> = new Uint8Array(255);
  output.set(previous.subarray(0, prefix));
  let outputLength = prefix;
  let cursor = offset;
  const end = offset + compressedLength;
  while (cursor < end) {
    const code = bytes[cursor++] ?? 0;
    if (code === 255) {
      if (cursor >= end || outputLength >= 255) {
        throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} FSST escape: ${index}`);
      }
      output[outputLength++] = bytes[cursor++] ?? 0;
      continue;
    }
    const length = bytes[dictionary.symbolsOffset + code] ?? 0;
    if (!length || length > 8 || outputLength + length > 255) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} FSST symbol: ${index}`);
    }
    const symbolOffset = dictionary.symbolsOffset + FSST_SYMBOL_COUNT + code * 8;
    output.set(bytes.subarray(symbolOffset, symbolOffset + length), outputLength);
    outputLength += length;
  }
  return output.slice(0, outputLength);
}

function readNeighborhoods(
  bytes: Uint8Array,
  data: DataView,
  header: BinaryHeader,
  dictionaries: BinaryDictionaries,
): BinaryBairros {
  const region = header.sections.bairros;
  if (region.length < BINARY_BAIRRO_HEADER_SIZE) {
    throw new DneBinaryDatabaseFormatError('Binary neighborhood table is truncated');
  }
  const count = data.getUint32(region.offset, true);
  const originalIdWidth = readByteWidth(data.getUint8(region.offset + 4), 'original neighborhood id');
  const localidadeIdWidth = readByteWidth(data.getUint8(region.offset + 5), 'original locality id');
  const recordWidth = originalIdWidth + localidadeIdWidth + dictionaries.bairro.idWidth
    + dictionaries.bairroAbreviado.idWidth + dictionaries.uf.idWidth;
  assertRegionLength(region, BINARY_BAIRRO_HEADER_SIZE + count * recordWidth, 'neighborhood table');
  validateZeroRange(bytes, region.offset + 6, region.offset + BINARY_BAIRRO_HEADER_SIZE, 'neighborhood table reserved bytes');
  const recordsOffset = region.offset + BINARY_BAIRRO_HEADER_SIZE;
  let previousId = 0;
  let maxId = 0;
  let maxLocalidadeId = 0;
  for (let index = 0; index < count; index++) {
    let offset = recordsOffset + index * recordWidth;
    const id = readPackedInteger(data, offset, originalIdWidth);
    offset += originalIdWidth;
    const localityId = readPackedInteger(data, offset, localidadeIdWidth);
    offset += localidadeIdWidth;
    const nameId = readPackedInteger(data, offset, dictionaries.bairro.idWidth);
    offset += dictionaries.bairro.idWidth;
    const abbreviationId = readPackedInteger(data, offset, dictionaries.bairroAbreviado.idWidth);
    offset += dictionaries.bairroAbreviado.idWidth;
    const ufId = readPackedInteger(data, offset, dictionaries.uf.idWidth);
    if (
      id <= previousId || localityId === 0 || nameId === 0 || nameId > dictionaries.bairro.count
      || abbreviationId > dictionaries.bairroAbreviado.count || ufId === 0 || ufId > dictionaries.uf.count
    ) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary neighborhood record: ${index}`);
    }
    if (!dictionaries.bairro.values[nameId - 1]) {
      throw new DneBinaryDatabaseFormatError(`Binary neighborhood has an empty name: ${index}`);
    }
    requireCanonicalUf(dictionaries.uf.values[ufId - 1] ?? '', index);
    previousId = id;
    maxId = Math.max(maxId, id);
    maxLocalidadeId = Math.max(maxLocalidadeId, localityId);
  }
  if (originalIdWidth !== integerByteWidth(maxId) || localidadeIdWidth !== integerByteWidth(maxLocalidadeId)) {
    throw new DneBinaryDatabaseFormatError('Binary neighborhood table uses a noncanonical integer width');
  }
  return {
    count,
    idWidth: integerByteWidth(count),
    localidadeIdWidth,
    originalIdWidth,
    recordWidth,
    recordsOffset,
  };
}

function validateMunicipalities(
  data: DataView,
  header: BinaryHeader,
  dictionaries: BinaryDictionaries,
): MunicipalityTable {
  const recordWidth = 3 + dictionaries.municipio.idWidth + dictionaries.uf.idWidth;
  const region = header.sections.municipalities;
  assertRegionLength(region, header.municipalityCount * recordWidth, 'municipalities');
  const ufIds = new Uint32Array(header.municipalityCount + 1);
  let previousCode = 0;
  for (let index = 0; index < header.municipalityCount; index++) {
    const offset = region.offset + index * recordWidth;
    const code = readPackedInteger(data, offset, 3);
    const municipioId = readPackedInteger(data, offset + 3, dictionaries.municipio.idWidth);
    const ufId = readPackedInteger(data, offset + 3 + dictionaries.municipio.idWidth, dictionaries.uf.idWidth);
    if (code < 1_000_000 || code > 9_999_999 || code <= previousCode) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary IBGE municipality code: ${code}`);
    }
    if (municipioId === 0 || municipioId > dictionaries.municipio.count || ufId === 0 || ufId > dictionaries.uf.count) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary municipality record: ${index}`);
    }
    if (!dictionaries.municipio.values[municipioId - 1]) {
      throw new DneBinaryDatabaseFormatError(`Binary municipality has an empty name: ${index}`);
    }
    const uf = requireCanonicalUf(dictionaries.uf.values[ufId - 1] ?? '', index);
    if (Math.floor(code / 100_000) !== stateCodes[uf]) {
      throw new DneBinaryDatabaseFormatError(`IBGE municipality code does not match UF: ${code} (${uf}, ${stateCodes[uf]})`);
    }
    ufIds[index + 1] = ufId;
    previousCode = code;
  }
  return { ufIds };
}

type SparseValues = { localidadeNome: Uint32Array; };

function validateSparseColumns(
  bytes: Uint8Array,
  data: DataView,
  header: BinaryHeader,
  dictionaries: BinaryDictionaries,
): SparseValues {
  const localidadeNome = new Uint32Array(header.rowCount);
  for (
    const [name, dictionary, values,] of [
      ['complemento', dictionaries.complemento, undefined],
      ['nome', dictionaries.nome, undefined],
      ['localidadeNome', dictionaries.bairro, localidadeNome],
    ] as const
  ) {
    validateSparseColumn(
      bytes,
      data,
      header.rowCount,
      header.sections[`${name}Bitmap`],
      header.sections[`${name}Ranks`],
      header.sections[`${name}Ids`],
      dictionary.idWidth,
      dictionary.count,
      name,
      values,
    );
  }
  return { localidadeNome };
}

function validateSparseColumn(
  bytes: Uint8Array,
  data: DataView,
  rowCount: number,
  bitmap: Region,
  ranks: Region,
  ids: Region,
  idWidth: ByteWidth,
  dictionaryCount: number,
  name: string,
  values?: Uint32Array,
): void {
  if (ids.length % idWidth !== 0) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} sparse ids have an invalid length`);
  }
  const blockCount = Math.ceil(rowCount / SPARSE_RANK_ROWS);
  let dense = 0;
  for (let block = 0; block < blockCount; block++) {
    const expected = dense;
    const rank = data.getUint32(ranks.offset + block * 4, true);
    if (rank !== expected) {
      throw new DneBinaryDatabaseFormatError(`Binary ${name} sparse rank mismatch: ${block}`);
    }
    const start = block * SPARSE_RANK_ROWS;
    const end = Math.min(rowCount, start + SPARSE_RANK_ROWS);
    for (let row = start; row < end; row++) {
      const bit = bytes[bitmap.offset + (row >>> 3)] ?? 0;
      if ((bit & (1 << (row & 7))) === 0) {
        continue;
      }
      if (dense >= ids.length / idWidth) {
        throw new DneBinaryDatabaseFormatError(`Binary ${name} sparse id index is outside the column`);
      }
      const value = readPackedInteger(data, ids.offset + dense * idWidth, idWidth);
      if (value === 0 || value > dictionaryCount) {
        throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} sparse id: ${value}`);
      }
      if (values) {
        values[row] = value;
      }
      dense++;
    }
  }
  const finalRank = data.getUint32(ranks.offset + blockCount * 4, true);
  if (finalRank !== dense || ids.length !== dense * idWidth) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} sparse column has an invalid final rank`);
  }
  validateBitmapPadding(bytes, bitmap, rowCount, name);
}

function validateRunSections(
  data: DataView,
  header: BinaryHeader,
  bairroRuns: BairroRuns,
  localityRuns: LocalityRuns,
) {
  assertRegionLength(header.sections.localidadeFlags, localityRuns.count, 'locality indicators');
  validateBairroRunPadding(data, bairroRuns);
  validateLocalityRunValues(data, header.sections.localidadeFlags, header, localityRuns);
}

function validateBairroRunPadding(data: DataView, runs: BairroRuns) {
  const usedLowBits = runs.runCount * runs.lowBits;
  if (usedLowBits % 8 !== 0 && (data.getUint8(runs.lowOffset + Math.floor(usedLowBits / 8)) & (0xff << (usedLowBits & 7))) !== 0) {
    throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run low-bit padding');
  }
}

function validateLocalityRunValues(
  data: DataView,
  flagsRegion: Region,
  header: BinaryHeader,
  runs: LocalityRuns,
) {
  let previousId = -1;
  let previousFlags = -1;
  for (let index = 0; index < runs.count; index++) {
    const id = readPackedInteger(data, runs.idsOffset + index * header.municipalityIdWidth, header.municipalityIdWidth);
    const flags = data.getUint8(flagsRegion.offset + index);
    if (
      id === 0 || id > header.municipalityCount
      || (flags & 3) >= LOCALIDADE_SITUACOES.length
      || (flags >>> 2) >= LOCALIDADE_TIPOS.length
      || (id === previousId && flags === previousFlags)
    ) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary locality run: ${index}`);
    }
    previousId = id;
    previousFlags = flags;
  }
}

function validateNeighborhoodRanges(data: DataView, header: BinaryHeader, bairros: BinaryBairros) {
  const { bairroFaixaOffsets: offsets, bairroFaixas: ranges } = header.sections;
  assertRegionLength(offsets, (bairros.count + 1) * 4, 'neighborhood range offsets');
  if (ranges.length % 8 !== 0 || data.getUint32(offsets.offset, true) !== 0) {
    throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood range layout');
  }
  const count = ranges.length / 8;
  let start = 0;
  for (let index = 0; index < bairros.count; index++) {
    const end = data.getUint32(offsets.offset + (index + 1) * 4, true);
    if (end < start || end > count) {
      throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood range offsets');
    }
    let previousInitial = -1;
    let previousFinal = -1;
    for (let row = start; row < end; row++) {
      const initial = data.getUint32(ranges.offset + row * 8, true);
      const final = data.getUint32(ranges.offset + row * 8 + 4, true);
      if (
        initial > final || final > 99_999_999 || initial < previousInitial
        || (initial === previousInitial && final <= previousFinal)
      ) {
        throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood CEP range');
      }
      previousInitial = initial;
      previousFinal = final;
    }
    start = end;
  }
  if (start !== count) {
    throw new DneBinaryDatabaseFormatError('Unreferenced binary neighborhood CEP ranges');
  }
}

function validateCepColumns(bytes: Uint8Array, data: DataView, header: BinaryHeader) {
  const region = header.sections.cepPrefixOffsets;
  const offsets = new Uint32Array(CEP_PREFIX_OFFSETS_COUNT);
  let previous = 0;
  for (let prefix = 0; prefix < CEP_PREFIX_OFFSETS_COUNT; prefix++) {
    const value = readPackedInteger(data, region.offset + prefix * header.cepPrefixOffsetWidth, header.cepPrefixOffsetWidth);
    if (value < previous || value > header.rowCount) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary CEP prefix boundary: ${prefix}`);
    }
    offsets[prefix] = value;
    previous = value;
  }
  if (offsets[0] !== 0 || offsets[CEP_PREFIX_COUNT] !== header.rowCount) {
    throw new DneBinaryDatabaseFormatError('Binary CEP prefix directory has invalid boundaries');
  }
  for (let prefix = 0; prefix < CEP_PREFIX_COUNT; prefix++) {
    const start = offsets[prefix] ?? 0;
    const end = offsets[prefix + 1] ?? 0;
    let previousSuffix = -1;
    for (let row = start; row < end; row++) {
      const suffix = readPacked10(bytes, header.sections.cepSuffixes.offset, row);
      if (suffix > 999 || suffix <= previousSuffix) {
        throw new DneBinaryDatabaseFormatError(`Binary CEP suffixes are not strictly ordered: ${row}`);
      }
      previousSuffix = suffix;
    }
  }
  const suffixBits = header.rowCount * CEP_SUFFIX_BITS;
  if (suffixBits % 8 !== 0) {
    const last = bytes[header.sections.cepSuffixes.offset + header.sections.cepSuffixes.length - 1] ?? 0;
    if ((last & (0xff << (suffixBits & 7))) !== 0) {
      throw new DneBinaryDatabaseFormatError('Invalid binary CEP suffix padding');
    }
  }
}

function validateLogradouroIds(bytes: Uint8Array, data: DataView, header: BinaryHeader, dictionary: BinaryDictionary) {
  const region = header.sections.logradouroIds;
  const width = integerBitWidth(dictionary.count);
  assertRegionLength(region, packedBitLength(header.rowCount, width), 'logradouro ids');
  for (let row = 0; row < header.rowCount; row++) {
    const id = readPackedBits(data, region.offset, row, width);
    if (id > dictionary.count) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary logradouro id: ${id}`);
    }
  }
  const usedBits = header.rowCount * width;
  if (usedBits % 8 !== 0) {
    const last = bytes[region.offset + region.length - 1] ?? 0;
    if ((last & (0xff << (usedBits & 7))) !== 0) {
      throw new DneBinaryDatabaseFormatError('Invalid binary logradouro id padding');
    }
  }
}

function validateRows(
  data: DataView,
  header: BinaryHeader,
  dictionaries: BinaryDictionaries,
  bairros: BinaryBairros,
  bairroRuns: BairroRuns,
  localityRuns: LocalityRuns,
  sparse: SparseValues,
  municipalityTable: MunicipalityTable,
) {
  const bairroRunValues = decodeBairroRuns(data, bairroRuns);
  const localityRunValues = decodeLocalityRuns(data, header, localityRuns);
  let bairroRun = 0;
  let localityRun = 0;
  for (let row = 0; row < header.rowCount; row++) {
    while (bairroRun + 1 < bairroRunValues.starts.length && (bairroRunValues.starts[bairroRun + 1] ?? 0) <= row) {
      bairroRun++;
    }
    while (localityRun + 1 < localityRunValues.starts.length && (localityRunValues.starts[localityRun + 1] ?? 0) <= row) {
      localityRun++;
    }
    const bairroIndex = bairroRunValues.ids[bairroRun] ?? 0;
    const municipalityId = localityRunValues.ids[localityRun] ?? 0;
    const flags = localityRunValues.flags[localityRun] ?? 0;
    const tipo = flags >>> 2;
    const localidadeNomeId = sparse.localidadeNome[row] ?? 0;
    if (localidadeNomeId !== 0 && (bairroIndex !== 0 || tipo === 0)) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary subordinate locality name: ${row}`);
    }
    if (bairroIndex !== 0) {
      const bairroUfId = readNeighborhoodUfId(data, bairros, dictionaries, bairroIndex);
      if (bairroUfId !== municipalityTable.ufIds[municipalityId]) {
        throw new DneBinaryDatabaseFormatError(`Neighborhood and municipality UFs differ: ${row}`);
      }
    }
  }
}

function readNeighborhoodUfId(
  data: DataView,
  bairros: BinaryBairros,
  dictionaries: BinaryDictionaries,
  index: number,
) {
  const offset = bairros.recordsOffset + (index - 1) * bairros.recordWidth
    + bairros.originalIdWidth + bairros.localidadeIdWidth
    + dictionaries.bairro.idWidth + dictionaries.bairroAbreviado.idWidth;
  return readPackedInteger(data, offset, dictionaries.uf.idWidth);
}

function decodeBairroRuns(data: DataView, runs: BairroRuns): BairroRunValues {
  const starts = new Uint32Array(runs.runCount);
  const ids = new Uint32Array(runs.runCount);
  const lowBase = 2 ** runs.lowBits;
  let zeros = 0;
  let run = 0;
  for (let bit = 0; bit < runs.highBitCount; bit++) {
    const one = (data.getUint8(runs.highOffset + (bit >>> 3)) & (1 << (bit & 7))) !== 0;
    if (!one) {
      zeros++;
      continue;
    }
    const low = readBits(data, runs.lowOffset, run * runs.lowBits, runs.lowBits);
    starts[run] = zeros * lowBase + low;
    ids[run] = readPackedInteger(data, runs.idsOffset + run * runs.idWidth, runs.idWidth);
    run++;
  }
  return { ids, starts };
}

function decodeLocalityRuns(data: DataView, header: BinaryHeader, runs: LocalityRuns): LocalityRunValues {
  const starts = new Uint32Array(runs.count);
  const ids = new Uint32Array(runs.count);
  const flags = new Uint8Array(runs.count);
  for (let index = 0; index < runs.count; index++) {
    starts[index] = data.getUint32(runs.startsOffset + index * 4, true);
    ids[index] = readPackedInteger(data, runs.idsOffset + index * header.municipalityIdWidth, header.municipalityIdWidth);
    flags[index] = data.getUint8(header.sections.localidadeFlags.offset + index);
  }
  return { flags, ids, starts };
}

function validateMetadata(bytes: Uint8Array, region: Region) {
  const metadata = bytes.subarray(region.offset, region.offset + region.length);
  if (metadata[0] === 0xef && metadata[1] === 0xbb && metadata[2] === 0xbf) {
    throw new DneBinaryDatabaseFormatError('Binary database metadata must not contain a UTF-8 BOM');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(metadata));
  } catch (cause) {
    throw new DneBinaryDatabaseFormatError('Binary database metadata is invalid JSON or UTF-8', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DneBinaryDatabaseFormatError('Binary database metadata must be an object');
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string') {
      throw new DneBinaryDatabaseFormatError('Binary database metadata values must be strings');
    }
  }
}

function validateRegion(fileLength: number, region: Region, name: string) {
  if (
    region.offset < BINARY_DATABASE_HEADER_SIZE
    || region.offset > fileLength
    || region.length > fileLength - region.offset
  ) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} region is outside the payload`);
  }
}

function assertRegionLength(region: Region, expected: number, name: string) {
  if (region.length !== expected) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} region has an invalid length`);
  }
}

function validateZeroRange(bytes: Uint8Array, start: number, end: number, name: string) {
  for (let index = start; index < end; index++) {
    if ((bytes[index] ?? 0) !== 0) {
      throw new DneBinaryDatabaseFormatError(`Invalid ${name}`);
    }
  }
}

function validateBitmapPadding(bytes: Uint8Array, region: Region, rowCount: number, name: string) {
  if (rowCount % 8 !== 0) {
    const last = bytes[region.offset + region.length - 1] ?? 0;
    if ((last & (0xff << (rowCount & 7))) !== 0) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary ${name} bitmap padding`);
    }
  }
}

function readPacked10(bytes: Uint8Array, offset: number, index: number) {
  const bit = index * CEP_SUFFIX_BITS;
  const byte = offset + Math.floor(bit / 8);
  const shift = bit & 7;
  const value = (bytes[byte] ?? 0) | ((bytes[byte + 1] ?? 0) << 8) | ((bytes[byte + 2] ?? 0) << 16);
  return (value >>> shift) & 0x3ff;
}

function readBits(data: DataView, byteOffset: number, bitOffset: number, count: number) {
  let value = 0;
  for (let bit = 0; bit < count; bit++) {
    const position = bitOffset + bit;
    if (data.getUint8(byteOffset + (position >>> 3)) & (1 << (position & 7))) {
      value += 2 ** bit;
    }
  }
  return value;
}
