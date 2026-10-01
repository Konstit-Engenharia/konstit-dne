import { fileURLToPath } from 'node:url';
import {
  parseBairroRuns,
  readBairroRunIndex,
  type BairroRuns,
} from './bairro-runs.ts';
import {
  isBairroId,
  type DneBairro,
  type DneFaixaCep,
} from './bairro.ts';
import {
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseError,
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseIOError,
  DneBinaryDatabaseVersionError,
} from './binary-db-errors.ts';
import {
  BINARY_BAIRRO_HEADER_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_MAGIC as MAGIC,
  BINARY_DATABASE_VERSION,
  BINARY_SECTION_NAMES as SECTION_NAMES,
  bitmapByteLength,
  CEP_PREFIX_COUNT,
  CEP_PREFIX_OFFSETS_COUNT,
  CEP_SUFFIX_BITS,
  createPopcountTable,
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  DICTIONARY_CODEC_FSST,
  DICTIONARY_CODEC_PLAIN,
  DICTIONARY_HEADER_SIZE,
  FSST_SYMBOL_TABLE_SIZE,
  hasBinaryMagic as hasMagic,
  integerByteWidth,
  maxPackedInteger,
  packedBitLength,
  readByteWidth,
  readPackedInteger as readPackedIntegerFromData,
  SECTION_TABLE_OFFSET,
  SPARSE_RANK_ROWS,
  SPARSE_RANK_SHIFT,
  type BinaryHeader,
  type BinaryRegion as Region,
  type BinarySectionName as SectionName,
  type ByteWidth,
} from './binary-db-format.ts';
import { cepToU32 } from './cep.ts';
import {
  readFsstString,
  validateFsstSymbols,
} from './fsst.ts';
import {
  findLocalityRun,
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
  type DneRow,
  type LoadMetadata,
  type UF,
} from './types.ts';

/** Error classes and discriminants used by this module's public operations. */
export {
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseError,
  type DneBinaryDatabaseErrorCode,
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseIOError,
  DneBinaryDatabaseVersionError,
} from './binary-db-errors.ts';
/** Header size and format version accepted by this reader. */
export { BINARY_DATABASE_HEADER_SIZE, BINARY_DATABASE_VERSION } from './binary-db-format.ts';
/** Neighborhood records and inclusive CEP intervals returned by this reader. */
export type { DneBairro, DneFaixaCep } from './bairro.ts';

type BinaryDictionary = {
  blockCount: number;
  blockOffsetsOffset: number;
  count: number;
  codec: number;
  idWidth: ByteWidth;
  lengthsOffset: number;
  lengthWidth: 1 | 2;
  prefixesOffset: number;
  region: Region;
  suffixDataLength: number;
  suffixDataOffset: number;
  symbolsOffset: number;
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
  originalIdWidth: ByteWidth;
  localidadeIdWidth: ByteWidth;
  recordsOffset: number;
  recordWidth: number;
};

type DecodedMunicipality = {
  codigoIbge: number;
  municipio: string;
  uf: UF;
};

const textDecoder = new TextDecoder();
const popcount = createPopcountTable();

/**
 * Checks a file's magic bytes without validating its version or contents.
 * @param path - Path to the candidate database file.
 * @returns `false` for a missing file or nonmatching signature; `true` for the DNE binary signature.
 * @throws {DneBinaryDatabaseIOError} If the file cannot be inspected or read.
 */
export async function isBinaryDatabase(path: string): Promise<boolean> {
  try {
    if (!(await Bun.file(path).exists())) {
      return false;
    }

    const prefix = new Uint8Array(await Bun.file(path).slice(0, MAGIC.length).arrayBuffer());
    return hasMagic(prefix);
  } catch (cause) {
    throw new DneBinaryDatabaseIOError(path, { cause });
  }
}

/**
 * Provides synchronous, read-only CEP lookups over a memory-mapped DNE binary database.
 *
 * Construction validates the file layout; individual records are decoded and checked on demand.
 * Keep the underlying file immutable while the reader is open. Call `close()` when finished.
 * All operational errors extend {@link DneBinaryDatabaseError}; invalid or absent CEPs return `undefined`.
 */
export class DneBinaryDatabaseReader {
  private bairroCache: (string | undefined)[];
  private data: DataView | null;
  private decodeScratch = new Uint8Array(0xff);
  private dictionaries: BinaryDictionaries;
  private bairros: BinaryBairros;
  private bairroRuns: BairroRuns;
  private localityRuns: LocalityRuns;
  private logradouroIdBits: number;
  private header: BinaryHeader;
  private mapped: Uint8Array<ArrayBuffer> | null;
  private metadataValue: LoadMetadata;
  private municipalityCache: (DecodedMunicipality | undefined)[];

  /**
   * Opens and validates a binary database using Bun's memory-mapping API.
   * @param databasePath - Optional path to an existing binary database. Defaults to `data/dne.bin` inside this package.
   * @throws {DneBinaryDatabaseIOError} If the file cannot be mapped.
   * @throws {DneBinaryDatabaseVersionError} If the declared format version is unsupported.
   * @throws {DneBinaryDatabaseFormatError} If the header, layout, dictionaries, or metadata are invalid.
   */
  constructor(databasePath = fileURLToPath(new URL('../data/dne.bin', import.meta.url))) {
    let mapped: Uint8Array<ArrayBuffer>;
    try {
      mapped = Bun.mmap(databasePath, { shared: false });
    } catch (cause) {
      throw new DneBinaryDatabaseIOError(databasePath, { cause });
    }
    try {
      const data = new DataView(mapped.buffer, mapped.byteOffset, mapped.byteLength);
      const header = readHeader(data);
      validateHeader(data, header);
      const dictionaries = readDictionaries(data, header);
      const bairros = readNeighborhoods(data, header, dictionaries);
      const { bairroRuns, localityRuns } = validateLayout(data, header, dictionaries, bairros);
      const metadata = parseMetadata(mapped, header.sections.metadata);

      this.mapped = mapped;
      this.data = data;
      this.header = header;
      this.dictionaries = dictionaries;
      this.bairros = bairros;
      this.bairroRuns = bairroRuns;
      this.localityRuns = localityRuns;
      this.logradouroIdBits = integerBitWidth(dictionaries.logradouro.count);
      this.metadataValue = metadata;
      this.bairroCache = Array.from({ length: dictionaries.bairro.count + 1 });
      this.municipalityCache = Array.from({ length: header.municipalityCount + 1 });
    } catch (error) {
      this.mapped = null;
      this.data = null;
      if (error instanceof DneBinaryDatabaseError) {
        throw error;
      }
      throw new DneBinaryDatabaseFormatError('Unable to decode binary database', { cause: error });
    }
  }

  /**
   * Releases this reader's references to the mapping and decoded caches.
   * Repeated calls are safe. Bun controls when the mapping is reclaimed; this method does not
   * guarantee immediate unmapping. Metadata and row count remain available after closing.
   */
  close(): void {
    this.bairroCache = [];
    this.data = null;
    this.mapped = null;
    this.municipalityCache = [];
  }

  /**
   * Returns the load metadata parsed when the reader was constructed.
   * @returns The cached metadata object, which callers should treat as read-only. Available after `close()`.
   */
  metadata(): LoadMetadata {
    return this.metadataValue;
  }

  /**
   * Looks up a CEP and decodes its address, including the originating locality indicators.
   * @param cep - Eight ASCII digits or the form `NNNNN-NNN`; surrounding whitespace is not accepted.
   * @returns An address with an eight-digit CEP, or `undefined` when the input is invalid or absent from the database.
   * @throws {DneBinaryDatabaseClosedError} If called after `close()`, including for invalid CEP input.
   * @throws {DneBinaryDatabaseFormatError} If the lookup encounters invalid indexes or record data.
   */
  queryCep(cep: string): DneRow | undefined {
    return this.readSafely(() => {
      const index = this.findCepIndex(cep);
      return index === -1 ? undefined : this.readRow(index, cep.replace('-', ''));
    });
  }

  /**
   * Reads a neighborhood by its original DNE identifier, independent of duplicate names.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns The neighborhood, or undefined for an invalid or unknown identifier.
   * @throws {DneBinaryDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneBinaryDatabaseFormatError} If an index, record, or string cannot be decoded.
   */
  queryNeighborhood(neighborhoodId: number): DneBairro | undefined {
    return this.readSafely(() => {
      const index = this.findNeighborhoodIndex(neighborhoodId);
      return index === 0 ? undefined : this.readNeighborhood(index);
    });
  }

  /**
   * Resolves the actual neighborhood of a CEP, preserving the distinction from districts and villages.
   * @param cep - Eight ASCII digits or `NNNNN-NNN`.
   * @returns The neighborhood, or undefined for an invalid, unknown, or neighborhood-free CEP.
   * @throws {DneBinaryDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneBinaryDatabaseFormatError} If the CEP or neighborhood data is invalid.
   */
  queryNeighborhoodByCep(cep: string): DneBairro | undefined {
    return this.readSafely(() => {
      const row = this.findCepIndex(cep);
      if (row === -1) {
        return undefined;
      }
      const index = this.readNeighborhoodIndex(row);
      return index === 0 ? undefined : this.readNeighborhood(index);
    });
  }

  /**
   * Reads a neighborhood's original inclusive CEP intervals without merging gaps.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns Intervals sorted by lower and upper bounds, or an empty array for an invalid, unknown, or rangeless neighborhood.
   * @throws {DneBinaryDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneBinaryDatabaseFormatError} If the interval directory or bounds are invalid.
   */
  queryNeighborhoodCepRanges(neighborhoodId: number): DneFaixaCep[] {
    return this.readSafely(() => {
      const index = this.findNeighborhoodIndex(neighborhoodId);
      if (index === 0) {
        return [];
      }
      const { bairroFaixaOffsets: offsets, bairroFaixas: ranges } = this.header.sections;
      const start = this.readUint32(offsets.offset + (index - 1) * 4);
      const end = this.readUint32(offsets.offset + index * 4);
      if (start > end || end > ranges.length / 8) {
        throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood range offsets');
      }
      const result: DneFaixaCep[] = [];
      for (let row = start; row < end; row++) {
        const initial = this.readUint32(ranges.offset + row * 8);
        const final = this.readUint32(ranges.offset + row * 8 + 4);
        if (initial > final || final > 99_999_999) {
          throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood CEP range');
        }
        result.push({ cep_inicial: String(initial).padStart(8, '0'), cep_final: String(final).padStart(8, '0') });
      }
      return result;
    });
  }

  /**
   * Returns the number of CEP records declared by the validated header.
   * @returns The row count recorded at construction; available after `close()`.
   */
  rowCount(): number {
    return this.header.rowCount;
  }

  private readSafely<T>(read: () => T): T {
    try {
      this.requireData();
      return read();
    } catch (error) {
      if (error instanceof DneBinaryDatabaseError) {
        throw error;
      }
      throw new DneBinaryDatabaseFormatError('Unable to decode binary database record', { cause: error });
    }
  }

  private findCepIndex(cep: string): number {
    const wanted = cepToU32(cep);
    if (Number.isNaN(wanted)) {
      return -1;
    }

    const prefix = Math.floor(wanted / 1_000);
    const suffix = wanted % 1_000;
    const prefixRegion = this.header.sections.cepPrefixOffsets;
    const width = this.header.cepPrefixOffsetWidth;
    let low = this.readPackedInteger(prefixRegion.offset + prefix * width, width);
    const prefixEnd = this.readPackedInteger(prefixRegion.offset + (prefix + 1) * width, width);
    let high = prefixEnd;
    if (low > prefixEnd || prefixEnd > this.header.rowCount) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary CEP prefix range: ${prefix}`);
    }

    while (low < high) {
      const middle = low + ((high - low) >>> 1);
      const current = this.readPacked10(middle);
      if (current < suffix) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    if (low >= prefixEnd || this.readPacked10(low) !== suffix) {
      return -1;
    }
    return low;
  }

  private findNeighborhoodIndex(neighborhoodId: number): number {
    if (!isBairroId(neighborhoodId)) {
      return 0;
    }
    let low = 0;
    let high = this.bairros.count;
    while (low < high) {
      const middle = low + ((high - low) >>> 1);
      const id = this.readPackedInteger(this.bairros.recordsOffset + middle * this.bairros.recordWidth, this.bairros.originalIdWidth);
      if (id < neighborhoodId) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low === this.bairros.count) {
      return 0;
    }
    const id = this.readPackedInteger(this.bairros.recordsOffset + low * this.bairros.recordWidth, this.bairros.originalIdWidth);
    return id === neighborhoodId ? low + 1 : 0;
  }

  private readNeighborhoodIndex(row: number): number {
    const index = readBairroRunIndex(this.requireData(), this.bairroRuns, row);
    if (index > this.bairros.count) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary neighborhood index: ${index}`);
    }
    return index;
  }

  private readNeighborhood(index: number): DneBairro {
    const { originalIdWidth, localidadeIdWidth, recordsOffset, recordWidth } = this.bairros;
    let offset = recordsOffset + (index - 1) * recordWidth;
    const bairro_id = this.readPackedInteger(offset, originalIdWidth);
    offset += originalIdWidth;
    const localidade_id = this.readPackedInteger(offset, localidadeIdWidth);
    offset += localidadeIdWidth;
    const nome = this.readRequiredDictionaryString(
      this.dictionaries.bairro,
      this.readPackedInteger(offset, this.dictionaries.bairro.idWidth),
      'bairro',
    );
    offset += this.dictionaries.bairro.idWidth;
    const nome_abreviado = this.readDictionaryString(
      this.dictionaries.bairroAbreviado,
      this.readPackedInteger(offset, this.dictionaries.bairroAbreviado.idWidth),
    );
    offset += this.dictionaries.bairroAbreviado.idWidth;
    const uf = parseUF(
      this.readRequiredDictionaryString(this.dictionaries.uf, this.readPackedInteger(offset, this.dictionaries.uf.idWidth), 'uf'),
    );
    return { bairro_id, localidade_id, nome, nome_abreviado, uf };
  }

  private readRow(index: number, cep: string): DneRow {
    const sections = this.header.sections;
    const run = findLocalityRun(this.requireData(), this.localityRuns, index);
    const municipalityId = this.readPackedInteger(
      this.localityRuns.idsOffset + run * this.header.municipalityIdWidth,
      this.header.municipalityIdWidth,
    );
    if (municipalityId === 0 || municipalityId > this.header.municipalityCount) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary municipality id: ${municipalityId}`);
    }
    const municipality = this.readMunicipality(municipalityId);
    const flags = this.requireData().getUint8(sections.localidadeFlags.offset + run);
    const situacao = LOCALIDADE_SITUACOES[flags & 3];
    const tipo = LOCALIDADE_TIPOS[flags >>> 2];
    if (situacao === undefined || tipo === undefined) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary locality indicators: ${flags}`);
    }
    const bairroIndex = this.readNeighborhoodIndex(index);
    const localidadeNomeId = this.readSparseId(
      sections.localidadeNomeBitmap,
      sections.localidadeNomeRanks,
      sections.localidadeNomeIds,
      index,
      this.dictionaries.bairro.idWidth,
    );
    if (localidadeNomeId !== 0 && (bairroIndex !== 0 || tipo === 'municipio')) {
      throw new DneBinaryDatabaseFormatError('Invalid binary subordinate locality name');
    }
    const bairroNameId = bairroIndex === 0
      ? localidadeNomeId
      : this.readPackedInteger(
        this.bairros.recordsOffset + (bairroIndex - 1) * this.bairros.recordWidth
          + this.bairros.originalIdWidth + this.bairros.localidadeIdWidth,
        this.dictionaries.bairro.idWidth,
      );
    if (bairroIndex !== 0 && bairroNameId === 0) {
      throw new DneBinaryDatabaseFormatError('Null binary neighborhood name');
    }

    return {
      bairro: this.readCachedDictionaryString(
        this.dictionaries.bairro,
        bairroNameId,
        this.bairroCache,
      ),
      cep,
      complemento: this.readDictionaryString(
        this.dictionaries.complemento,
        this.readSparseId(
          sections.complementoBitmap,
          sections.complementoRanks,
          sections.complementoIds,
          index,
          this.dictionaries.complemento.idWidth,
        ),
      ),
      localidade_situacao: situacao,
      localidade_tipo: tipo,
      logradouro: this.readDictionaryString(
        this.dictionaries.logradouro,
        readPackedBits(
          this.requireData(),
          sections.logradouroIds.offset,
          index,
          this.logradouroIdBits,
        ),
      ),
      municipio: municipality.municipio,
      municipio_cod_ibge: municipality.codigoIbge,
      nome: this.readDictionaryString(
        this.dictionaries.nome,
        this.readSparseId(
          sections.nomeBitmap,
          sections.nomeRanks,
          sections.nomeIds,
          index,
          this.dictionaries.nome.idWidth,
        ),
      ),
      uf: municipality.uf,
    };
  }

  private readMunicipality(id: number) {
    const cached = this.municipalityCache[id];
    if (cached) {
      return cached;
    }
    const recordWidth = 3 + this.dictionaries.municipio.idWidth + this.dictionaries.uf.idWidth;
    const offset = this.header.sections.municipalities.offset + (id - 1) * recordWidth;
    const municipioId = this.readPackedInteger(offset + 3, this.dictionaries.municipio.idWidth);
    const ufId = this.readPackedInteger(
      offset + 3 + this.dictionaries.municipio.idWidth,
      this.dictionaries.uf.idWidth,
    );
    const municipality = {
      codigoIbge: this.readPackedInteger(offset, 3),
      municipio: this.readRequiredDictionaryString(this.dictionaries.municipio, municipioId, 'municipio'),
      uf: parseUF(this.readRequiredDictionaryString(this.dictionaries.uf, ufId, 'uf')),
    };
    this.municipalityCache[id] = municipality;
    return municipality;
  }

  private readSparseId(
    bitmap: Region,
    ranks: Region,
    ids: Region,
    rowIndex: number,
    idWidth: 1 | 2 | 3 | 4,
  ) {
    const mapped = this.requireMapped();
    const bitmapByteIndex = rowIndex >>> 3;
    const bitmapByte = mapped[bitmap.offset + bitmapByteIndex] ?? 0;
    const bitIndex = rowIndex & 7;
    if ((bitmapByte & (1 << bitIndex)) === 0) {
      return 0;
    }

    const rankBlock = rowIndex >>> SPARSE_RANK_SHIFT;
    let denseIndex = this.readUint32(ranks.offset + rankBlock * 4);
    const blockByteOffset = rankBlock * (SPARSE_RANK_ROWS >>> 3);
    for (let offset = blockByteOffset; offset < bitmapByteIndex; offset++) {
      denseIndex += popcount[mapped[bitmap.offset + offset] ?? 0] ?? 0;
    }
    denseIndex += popcount[bitmapByte & ((1 << bitIndex) - 1)] ?? 0;
    if ((denseIndex + 1) * idWidth > ids.length) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary sparse id index: ${denseIndex}`);
    }
    return this.readPackedInteger(ids.offset + denseIndex * idWidth, idWidth);
  }

  private readDictionaryString(dictionary: BinaryDictionary, id: number) {
    if (id === 0) {
      return null;
    }
    if (id > dictionary.count) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary string id: ${id}`);
    }

    const mapped = this.requireMapped();
    if (dictionary.codec === DICTIONARY_CODEC_FSST) {
      return readFsstString(mapped, this.requireData(), dictionary, id);
    }
    const index = id - 1;
    const block = index >>> DICTIONARY_BLOCK_SHIFT;
    const blockStart = block << DICTIONARY_BLOCK_SHIFT;
    const relativeOffset = this.readUint32(dictionary.blockOffsetsOffset + block * 4);
    if (relativeOffset > dictionary.suffixDataLength) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary string block offset: ${relativeOffset}`);
    }
    let cursor = dictionary.suffixDataOffset + relativeOffset;
    const decoded = this.decodeScratch;
    let previousLength = 0;

    for (let currentIndex = blockStart; currentIndex <= index; currentIndex++) {
      const length = mapped[dictionary.lengthsOffset + currentIndex] ?? 0;
      const prefixLength = mapped[dictionary.prefixesOffset + currentIndex] ?? 0;
      if ((currentIndex === blockStart && prefixLength !== 0) || prefixLength > previousLength || prefixLength > length) {
        throw new DneBinaryDatabaseFormatError(`Invalid binary front-coded string: ${id}`);
      }
      const suffixLength = length - prefixLength;
      if (cursor < dictionary.suffixDataOffset || cursor + suffixLength > dictionary.suffixDataOffset + dictionary.suffixDataLength) {
        throw new DneBinaryDatabaseFormatError(`Invalid binary string suffix: ${id}`);
      }
      decoded.set(mapped.subarray(cursor, cursor + suffixLength), prefixLength);
      cursor += suffixLength;
      previousLength = length;
    }

    return textDecoder.decode(decoded.subarray(0, previousLength));
  }

  private readCachedDictionaryString(
    dictionary: BinaryDictionary,
    id: number,
    cache: (string | undefined)[],
  ) {
    if (id === 0) {
      return null;
    }
    const cached = cache[id];
    if (cached !== undefined) {
      return cached;
    }
    const value = this.readDictionaryString(dictionary, id);
    if (value !== null) {
      cache[id] = value;
    }
    return value;
  }

  private readRequiredDictionaryString(dictionary: BinaryDictionary, id: number, field: string) {
    const value = this.readDictionaryString(dictionary, id);
    if (value === null) {
      throw new DneBinaryDatabaseFormatError(`Binary database has a null required field: ${field}`);
    }
    return value;
  }

  private readPacked10(index: number) {
    const mapped = this.requireMapped();
    const region = this.header.sections.cepSuffixes;
    const bitOffset = index * CEP_SUFFIX_BITS;
    const byteIndex = bitOffset >>> 3;
    const shift = bitOffset & 7;
    const absoluteOffset = region.offset + byteIndex;
    const value = (mapped[absoluteOffset] ?? 0)
      | ((mapped[absoluteOffset + 1] ?? 0) << 8)
      | ((mapped[absoluteOffset + 2] ?? 0) << 16);
    return (value >>> shift) & 0x3ff;
  }

  private readPackedInteger(offset: number, width: 1 | 2 | 3 | 4) {
    return readPackedIntegerFromData(this.requireData(), offset, width);
  }

  private readUint32(offset: number) {
    return this.requireData().getUint32(offset, true);
  }

  private requireData() {
    if (!this.data) {
      throw new DneBinaryDatabaseClosedError();
    }
    return this.data;
  }

  private requireMapped() {
    if (!this.mapped) {
      throw new DneBinaryDatabaseClosedError();
    }
    return this.mapped;
  }
}

/**
 * Opens a binary database, reads its load metadata, and closes the temporary reader.
 * @param path - Path to an existing binary database file.
 * @returns Metadata parsed from the file at open time.
 * @throws {DneBinaryDatabaseIOError} If the file cannot be mapped.
 * @throws {DneBinaryDatabaseVersionError} If the binary version is unsupported.
 * @throws {DneBinaryDatabaseFormatError} If the file layout or metadata are invalid.
 */
export async function readBinaryDatabaseMetadata(path: string): Promise<LoadMetadata> {
  const reader = new DneBinaryDatabaseReader(path);
  try {
    return reader.metadata();
  } finally {
    reader.close();
  }
}

function readHeader(data: DataView): BinaryHeader {
  if (data.byteLength < BINARY_DATABASE_HEADER_SIZE) {
    throw new DneBinaryDatabaseFormatError('Binary database header is truncated');
  }
  for (let index = 0; index < MAGIC.length; index++) {
    if (data.getUint8(index) !== MAGIC[index]) {
      throw new DneBinaryDatabaseFormatError('Invalid binary database magic');
    }
  }
  const version = data.getUint16(8, true);
  if (version !== BINARY_DATABASE_VERSION) {
    throw new DneBinaryDatabaseVersionError(version, BINARY_DATABASE_VERSION);
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

function validateHeader(data: DataView, header: BinaryHeader) {
  if (header.fileSize !== data.byteLength) {
    throw new DneBinaryDatabaseFormatError(`Binary database size mismatch: header=${header.fileSize}, actual=${data.byteLength}`);
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

  let previousEnd = BINARY_DATABASE_HEADER_SIZE;
  for (const name of SECTION_NAMES) {
    const region = header.sections[name];
    validateRegion(data.byteLength, region, name);
    if (region.offset < previousEnd) {
      throw new DneBinaryDatabaseFormatError(`Binary section is out of order or overlaps: ${name}`);
    }
    previousEnd = region.offset + region.length;
  }
  if (header.sections.cepPrefixOffsets.length !== CEP_PREFIX_OFFSETS_COUNT * header.cepPrefixOffsetWidth) {
    throw new DneBinaryDatabaseFormatError('Binary CEP prefix directory has an invalid length');
  }
  if (header.sections.cepSuffixes.length !== packedBitLength(header.rowCount, CEP_SUFFIX_BITS)) {
    throw new DneBinaryDatabaseFormatError('Binary CEP suffix column has an invalid length');
  }
  if (
    header.sections.complementoBitmap.length !== bitmapByteLength(header.rowCount)
    || header.sections.nomeBitmap.length !== bitmapByteLength(header.rowCount)
    || header.sections.localidadeNomeBitmap.length !== bitmapByteLength(header.rowCount)
  ) {
    throw new DneBinaryDatabaseFormatError('Binary nullable bitmap has an invalid length');
  }
  const expectedRankLength = (Math.ceil(header.rowCount / SPARSE_RANK_ROWS) + 1) * 4;
  if (
    header.sections.complementoRanks.length !== expectedRankLength
    || header.sections.nomeRanks.length !== expectedRankLength
    || header.sections.localidadeNomeRanks.length !== expectedRankLength
  ) {
    throw new DneBinaryDatabaseFormatError('Binary sparse rank index has an invalid length');
  }
}

function readDictionaries(data: DataView, header: BinaryHeader): BinaryDictionaries {
  return {
    bairro: readDictionary(data, header.sections.bairroDictionary, 'bairro'),
    bairroAbreviado: readDictionary(data, header.sections.bairroAbreviadoDictionary, 'bairro abbreviation'),
    complemento: readDictionary(data, header.sections.complementoDictionary, 'complemento'),
    logradouro: readDictionary(data, header.sections.logradouroDictionary, 'logradouro', true),
    municipio: readDictionary(data, header.sections.municipioDictionary, 'municipio'),
    nome: readDictionary(data, header.sections.nomeDictionary, 'nome'),
    uf: readDictionary(data, header.sections.ufDictionary, 'uf'),
  };
}

function readDictionary(data: DataView, region: Region, name: string, allowFsst = false): BinaryDictionary {
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
  const lengthWidth = encodedWidth === 2 ? 2 : 1;
  const symbolTableSize = codec === DICTIONARY_CODEC_FSST ? FSST_SYMBOL_TABLE_SIZE : 0;
  if (data.getUint8(region.offset + 29) !== DICTIONARY_BLOCK_SHIFT) {
    throw new DneBinaryDatabaseFormatError(`Unsupported binary ${name} dictionary block size`);
  }
  if (blockCount !== Math.ceil(count / DICTIONARY_BLOCK_SIZE)) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has an invalid block count`);
  }
  if (count > maxPackedInteger(idWidth)) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary does not fit its id width`);
  }
  if (
    blockOffsetsRelative !== DICTIONARY_HEADER_SIZE
    || lengthsRelative !== blockOffsetsRelative + blockCount * 4
    || prefixesRelative !== lengthsRelative + count * lengthWidth
    || suffixDataRelative !== prefixesRelative + count + symbolTableSize
    || suffixDataRelative > region.length
    || suffixDataLength !== region.length - suffixDataRelative
  ) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has an invalid layout`);
  }

  const dictionary = {
    blockCount,
    blockOffsetsOffset: region.offset + blockOffsetsRelative,
    count,
    codec,
    idWidth,
    lengthsOffset: region.offset + lengthsRelative,
    lengthWidth,
    prefixesOffset: region.offset + prefixesRelative,
    region,
    suffixDataLength,
    suffixDataOffset: region.offset + suffixDataRelative,
    symbolsOffset: region.offset + prefixesRelative + count,
  } satisfies BinaryDictionary;
  if (blockCount && data.getUint32(dictionary.blockOffsetsOffset, true) !== 0) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has an invalid first block offset`);
  }
  if (codec === DICTIONARY_CODEC_FSST) {
    if (!count && suffixDataLength !== 0) {
      throw new DneBinaryDatabaseFormatError(`Binary ${name} dictionary has unexpected payload`);
    }
    validateFsstSymbols(data, dictionary.symbolsOffset);
  }
  return dictionary;
}

function readNeighborhoods(data: DataView, header: BinaryHeader, dictionaries: BinaryDictionaries): BinaryBairros {
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
  const recordsOffset = region.offset + BINARY_BAIRRO_HEADER_SIZE;
  let previousId = 0;
  for (let index = 0; index < count; index++) {
    let offset = recordsOffset + index * recordWidth;
    const id = readPackedIntegerFromData(data, offset, originalIdWidth);
    offset += originalIdWidth;
    const localityId = readPackedIntegerFromData(data, offset, localidadeIdWidth);
    offset += localidadeIdWidth;
    const nameId = readPackedIntegerFromData(data, offset, dictionaries.bairro.idWidth);
    offset += dictionaries.bairro.idWidth;
    const abbreviationId = readPackedIntegerFromData(data, offset, dictionaries.bairroAbreviado.idWidth);
    offset += dictionaries.bairroAbreviado.idWidth;
    const ufId = readPackedIntegerFromData(data, offset, dictionaries.uf.idWidth);
    if (
      id <= previousId || localityId === 0 || nameId === 0 || nameId > dictionaries.bairro.count
      || abbreviationId > dictionaries.bairroAbreviado.count || ufId === 0 || ufId > dictionaries.uf.count
    ) {
      throw new DneBinaryDatabaseFormatError(`Invalid binary neighborhood record: ${index}`);
    }
    previousId = id;
  }
  return { count, idWidth: integerByteWidth(count), originalIdWidth, localidadeIdWidth, recordsOffset, recordWidth };
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

function validateLayout(data: DataView, header: BinaryHeader, dictionaries: BinaryDictionaries, bairros: BinaryBairros) {
  const sections = header.sections;
  const localityRuns = parseLocalityRuns(data, sections.municipalityIds, header.rowCount, header.municipalityIdWidth);
  assertRegionLength(sections.localidadeFlags, localityRuns.count, 'locality indicators');
  assertRegionLength(
    sections.logradouroIds,
    packedBitLength(header.rowCount, integerBitWidth(dictionaries.logradouro.count)),
    'logradouro ids',
  );
  const bairroRuns = parseBairroRuns(data, sections.bairroIds, header.rowCount, bairros.idWidth, bairros.count);
  const municipalityRecordWidth = 3 + dictionaries.municipio.idWidth + dictionaries.uf.idWidth;
  assertRegionLength(
    sections.municipalities,
    header.municipalityCount * municipalityRecordWidth,
    'municipalities',
  );
  validateSparseLayout(data, sections.complementoRanks, sections.complementoIds, dictionaries.complemento.idWidth, 'complemento');
  validateSparseLayout(data, sections.nomeRanks, sections.nomeIds, dictionaries.nome.idWidth, 'nome');
  validateSparseLayout(data, sections.localidadeNomeRanks, sections.localidadeNomeIds, dictionaries.bairro.idWidth, 'localidade_nome');
  validateNeighborhoodRanges(data, header, bairros);

  const firstPrefix = readPackedIntegerFromData(data, sections.cepPrefixOffsets.offset, header.cepPrefixOffsetWidth);
  const lastPrefix = readPackedIntegerFromData(
    data,
    sections.cepPrefixOffsets.offset + CEP_PREFIX_COUNT * header.cepPrefixOffsetWidth,
    header.cepPrefixOffsetWidth,
  );
  if (firstPrefix !== 0 || lastPrefix !== header.rowCount) {
    throw new DneBinaryDatabaseFormatError('Binary CEP prefix directory has invalid boundaries');
  }
  return { bairroRuns, localityRuns };
}

function validateSparseLayout(
  data: DataView,
  ranks: Region,
  ids: Region,
  idWidth: 1 | 2 | 3 | 4,
  name: string,
) {
  const denseCount = data.getUint32(ranks.offset + ranks.length - 4, true);
  if (ids.length !== denseCount * idWidth) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} sparse ids have an invalid length`);
  }
}

function parseMetadata(mapped: Uint8Array<ArrayBuffer>, region: Region): LoadMetadata {
  const text = textDecoder.decode(mapped.subarray(region.offset, region.offset + region.length));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new DneBinaryDatabaseFormatError('Binary database metadata is invalid JSON', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DneBinaryDatabaseFormatError('Binary database metadata must be an object');
  }
  return parsed as LoadMetadata;
}

function validateRegion(fileLength: number, region: Region, name: string) {
  if (
    region.offset < BINARY_DATABASE_HEADER_SIZE
    || region.offset > fileLength
    || region.length > fileLength - region.offset
  ) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} region is outside the file`);
  }
}

function assertRegionLength(region: Region, expected: number, name: string) {
  if (region.length !== expected) {
    throw new DneBinaryDatabaseFormatError(`Binary ${name} region has an invalid length`);
  }
}
