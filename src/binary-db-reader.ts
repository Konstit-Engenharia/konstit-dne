import { fileURLToPath } from 'node:url';
import {
  readBairroRunIndex,
  readBairroRunsLayout,
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
  BINARY_DATABASE_CHECKSUM_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_MAGIC as MAGIC,
  BINARY_DATABASE_VERSION,
  BINARY_SECTION_NAMES as SECTION_NAMES,
  CEP_SUFFIX_BITS,
  createPopcountTable,
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_CODEC_FSST,
  hasBinaryMagic as hasMagic,
  integerByteWidth,
  readPackedInteger as readPackedIntegerFromData,
  SECTION_TABLE_OFFSET,
  SPARSE_RANK_ROWS,
  SPARSE_RANK_SHIFT,
  type BinaryHeader,
  type BinaryRegion as Region,
  type BinarySectionName as SectionName,
  type ByteWidth,
} from './binary-db-format.ts';
import { verifyBinaryDatabaseChecksum } from './binary-db-integrity.ts';
import { cepToU32 } from './cep.ts';
import { readTrustedFsstString } from './fsst.ts';
import {
  findLocalityRun,
  readLocalityRunsLayout,
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
import type {
  DneRow,
  LoadMetadata,
  UF,
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
 * Construction verifies the header and SHA-256 of bytes validated by a trusted generator.
 * Queries decode directly using the invariants guaranteed at generation.
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
  private readonly metadataValue: Readonly<LoadMetadata>;
  private municipalityCache: (DecodedMunicipality | undefined)[];

  /**
   * Opens and verifies a binary database using Bun's memory-mapping API.
   * @param databasePath - Optional path to an existing binary database. Defaults to `data/dne.bin` inside this package.
   * @throws {DneBinaryDatabaseIOError} If the file cannot be mapped.
   * @throws {DneBinaryDatabaseVersionError} If the declared format version is unsupported.
   * @throws {DneBinaryDatabaseFormatError} If the minimum header, file size, or SHA-256 checksum is invalid.
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
      verifyHeader(data);
      verifyBinaryDatabaseChecksum(mapped);
      const header = readHeader(data);
      const dictionaries = readDictionaries(data, header);
      const bairros = readNeighborhoods(data, header, dictionaries);
      const bairroRuns = readBairroRunsLayout(data, header.sections.bairroIds, header.rowCount, bairros.idWidth);
      const localityRuns = readLocalityRunsLayout(data, header.sections.municipalityIds, header.rowCount);
      const metadata = parseMetadata(mapped, header.sections.metadata);

      this.mapped = mapped;
      this.data = data;
      this.header = header;
      this.dictionaries = dictionaries;
      this.bairros = bairros;
      this.bairroRuns = bairroRuns;
      this.localityRuns = localityRuns;
      this.logradouroIdBits = integerBitWidth(dictionaries.logradouro.count);
      this.metadataValue = Object.freeze(metadata);
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
   * @returns The cached, frozen metadata object. Available after `close()`.
   */
  metadata(): Readonly<LoadMetadata> {
    return this.metadataValue;
  }

  /**
   * Looks up a CEP and decodes its address, including the originating locality indicators.
   * @param cep - Eight ASCII digits or the form `NNNNN-NNN`; surrounding whitespace is not accepted.
   * @returns An address with an eight-digit CEP, or `undefined` when the input is invalid or absent from the database.
   * @throws {DneBinaryDatabaseClosedError} If called after `close()`, including for invalid CEP input.
   */
  queryCep(cep: string): DneRow | undefined {
    this.assertOpen();
    const index = this.findCepIndex(cep);
    return index === -1 ? undefined : this.readRow(index, cep.replace('-', ''));
  }

  /**
   * Reads a neighborhood by its original DNE identifier, independent of duplicate names.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns The neighborhood, or undefined for an invalid or unknown identifier.
   * @throws {DneBinaryDatabaseClosedError} If the reader is closed, including for invalid input.
   */
  queryNeighborhood(neighborhoodId: number): DneBairro | undefined {
    this.assertOpen();
    const index = this.findNeighborhoodIndex(neighborhoodId);
    return index === 0 ? undefined : this.readNeighborhood(index);
  }

  /**
   * Resolves the actual neighborhood of a CEP, preserving the distinction from districts and villages.
   * @param cep - Eight ASCII digits or `NNNNN-NNN`.
   * @returns The neighborhood, or undefined for an invalid, unknown, or neighborhood-free CEP.
   * @throws {DneBinaryDatabaseClosedError} If the reader is closed, including for invalid input.
   */
  queryNeighborhoodByCep(cep: string): DneBairro | undefined {
    this.assertOpen();
    const row = this.findCepIndex(cep);
    if (row === -1) {
      return undefined;
    }
    const index = this.readNeighborhoodIndex(row);
    return index === 0 ? undefined : this.readNeighborhood(index);
  }

  /**
   * Reads a neighborhood's original inclusive CEP intervals without merging gaps.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns Intervals sorted by lower and upper bounds, or an empty array for an invalid, unknown, or rangeless neighborhood.
   * @throws {DneBinaryDatabaseClosedError} If the reader is closed, including for invalid input.
   */
  queryNeighborhoodCepRanges(neighborhoodId: number): DneFaixaCep[] {
    this.assertOpen();
    const index = this.findNeighborhoodIndex(neighborhoodId);
    if (index === 0) {
      return [];
    }
    const { bairroFaixaOffsets: offsets, bairroFaixas: ranges } = this.header.sections;
    const start = this.readUint32(offsets.offset + (index - 1) * 4);
    const end = this.readUint32(offsets.offset + index * 4);
    const result: DneFaixaCep[] = [];
    for (let row = start; row < end; row++) {
      const initial = this.readUint32(ranges.offset + row * 8);
      const final = this.readUint32(ranges.offset + row * 8 + 4);
      result.push({ cep_inicial: String(initial).padStart(8, '0'), cep_final: String(final).padStart(8, '0') });
    }
    return result;
  }

  /**
   * Returns the number of CEP records declared by the validated header.
   * @returns The row count recorded at construction; available after `close()`.
   */
  rowCount(): number {
    return this.header.rowCount;
  }

  private assertOpen(): void {
    if (this.data === null) {
      throw new DneBinaryDatabaseClosedError();
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
    return readBairroRunIndex(this.data as DataView, this.bairroRuns, row);
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
    );
    offset += this.dictionaries.bairro.idWidth;
    const nome_abreviado = this.readDictionaryString(
      this.dictionaries.bairroAbreviado,
      this.readPackedInteger(offset, this.dictionaries.bairroAbreviado.idWidth),
    );
    offset += this.dictionaries.bairroAbreviado.idWidth;
    const uf = this.readRequiredDictionaryString(
      this.dictionaries.uf,
      this.readPackedInteger(offset, this.dictionaries.uf.idWidth),
    ) as UF;
    return { bairro_id, localidade_id, nome, nome_abreviado, uf };
  }

  private readRow(index: number, cep: string): DneRow {
    const sections = this.header.sections;
    const run = findLocalityRun(this.data as DataView, this.localityRuns, index);
    const municipalityId = this.readPackedInteger(
      this.localityRuns.idsOffset + run * this.header.municipalityIdWidth,
      this.header.municipalityIdWidth,
    );
    const municipality = this.readMunicipality(municipalityId);
    const flags = (this.data as DataView).getUint8(sections.localidadeFlags.offset + run);
    const situacao = LOCALIDADE_SITUACOES[flags & 3] as DneRow['localidade_situacao'];
    const tipo = LOCALIDADE_TIPOS[flags >>> 2] as DneRow['localidade_tipo'];
    const bairroIndex = this.readNeighborhoodIndex(index);
    const localidadeNomeId = this.readSparseId(
      sections.localidadeNomeBitmap,
      sections.localidadeNomeRanks,
      sections.localidadeNomeIds,
      index,
      this.dictionaries.bairro.idWidth,
    );
    const bairroNameId = bairroIndex === 0
      ? localidadeNomeId
      : this.readPackedInteger(
        this.bairros.recordsOffset + (bairroIndex - 1) * this.bairros.recordWidth
          + this.bairros.originalIdWidth + this.bairros.localidadeIdWidth,
        this.dictionaries.bairro.idWidth,
      );

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
          this.data as DataView,
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
      municipio: this.readRequiredDictionaryString(this.dictionaries.municipio, municipioId),
      uf: this.readRequiredDictionaryString(this.dictionaries.uf, ufId) as UF,
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
    const mapped = this.mapped as Uint8Array;
    const bitmapByteIndex = rowIndex >>> 3;
    const bitmapByte = mapped[bitmap.offset + bitmapByteIndex] as number;
    const bitIndex = rowIndex & 7;
    if ((bitmapByte & (1 << bitIndex)) === 0) {
      return 0;
    }

    const rankBlock = rowIndex >>> SPARSE_RANK_SHIFT;
    let denseIndex = this.readUint32(ranks.offset + rankBlock * 4);
    const blockByteOffset = rankBlock * (SPARSE_RANK_ROWS >>> 3);
    for (let offset = blockByteOffset; offset < bitmapByteIndex; offset++) {
      denseIndex += popcount[mapped[bitmap.offset + offset] as number] as number;
    }
    denseIndex += popcount[bitmapByte & ((1 << bitIndex) - 1)] as number;
    return this.readPackedInteger(ids.offset + denseIndex * idWidth, idWidth);
  }

  private readDictionaryString(dictionary: BinaryDictionary, id: number) {
    if (id === 0) {
      return null;
    }

    const mapped = this.mapped as Uint8Array;
    if (dictionary.codec === DICTIONARY_CODEC_FSST) {
      return readTrustedFsstString(mapped, this.data as DataView, dictionary, id);
    }
    const index = id - 1;
    const block = index >>> DICTIONARY_BLOCK_SHIFT;
    const blockStart = block << DICTIONARY_BLOCK_SHIFT;
    const relativeOffset = this.readUint32(dictionary.blockOffsetsOffset + block * 4);
    let cursor = dictionary.suffixDataOffset + relativeOffset;
    const decoded = this.decodeScratch;
    let previousLength = 0;

    for (let currentIndex = blockStart; currentIndex <= index; currentIndex++) {
      const length = mapped[dictionary.lengthsOffset + currentIndex] as number;
      const prefixLength = mapped[dictionary.prefixesOffset + currentIndex] as number;
      const suffixLength = length - prefixLength;
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
    const value = this.readRequiredDictionaryString(dictionary, id);
    cache[id] = value;
    return value;
  }

  private readRequiredDictionaryString(dictionary: BinaryDictionary, id: number): string {
    return this.readDictionaryString(dictionary, id) as string;
  }

  private readPacked10(index: number) {
    const mapped = this.mapped as Uint8Array;
    const region = this.header.sections.cepSuffixes;
    const bitOffset = index * CEP_SUFFIX_BITS;
    const byteIndex = bitOffset >>> 3;
    const shift = bitOffset & 7;
    const absoluteOffset = region.offset + byteIndex;
    const value = (mapped[absoluteOffset] as number)
      | ((mapped[absoluteOffset + 1] as number) << 8)
      | ((mapped[absoluteOffset + 2] as number) << 16);
    return (value >>> shift) & 0x3ff;
  }

  private readPackedInteger(offset: number, width: 1 | 2 | 3 | 4) {
    return readPackedIntegerFromData(this.data as DataView, offset, width);
  }

  private readUint32(offset: number) {
    return (this.data as DataView).getUint32(offset, true);
  }
}

/**
 * Opens a binary database, reads its load metadata, and closes the temporary reader.
 * @param path - Path to an existing binary database file.
 * @returns Frozen metadata parsed from the file at open time.
 * @throws {DneBinaryDatabaseIOError} If the file cannot be mapped.
 * @throws {DneBinaryDatabaseVersionError} If the binary version is unsupported.
 * @throws {DneBinaryDatabaseFormatError} If the minimum header, file size, or SHA-256 checksum is invalid.
 */
export async function readBinaryDatabaseMetadata(path: string): Promise<Readonly<LoadMetadata>> {
  const reader = new DneBinaryDatabaseReader(path);
  try {
    return reader.metadata();
  } finally {
    reader.close();
  }
}

function verifyHeader(data: DataView): void {
  if (data.byteLength < BINARY_DATABASE_HEADER_SIZE + BINARY_DATABASE_CHECKSUM_SIZE) {
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

  if (data.getUint32(16, true) !== data.byteLength) {
    throw new DneBinaryDatabaseFormatError(`Binary database size mismatch: header=${data.getUint32(16, true)}, actual=${data.byteLength}`);
  }
}

function readHeader(data: DataView): BinaryHeader {
  const sections = {} as Record<SectionName, Region>;
  for (const [index, name,] of SECTION_NAMES.entries()) {
    const offset = SECTION_TABLE_OFFSET + index * 8;
    sections[name] = {
      length: data.getUint32(offset + 4, true),
      offset: data.getUint32(offset, true),
    };
  }
  return {
    cepPrefixOffsetWidth: data.getUint8(20) as ByteWidth,
    fileSize: data.getUint32(16, true),
    municipalityCount: data.getUint32(28, true),
    municipalityIdWidth: data.getUint8(21) as ByteWidth,
    rowCount: data.getUint32(12, true),
    sections,
  };
}

function readDictionaries(data: DataView, header: BinaryHeader): BinaryDictionaries {
  return {
    bairro: readDictionary(data, header.sections.bairroDictionary),
    bairroAbreviado: readDictionary(data, header.sections.bairroAbreviadoDictionary),
    complemento: readDictionary(data, header.sections.complementoDictionary),
    logradouro: readDictionary(data, header.sections.logradouroDictionary),
    municipio: readDictionary(data, header.sections.municipioDictionary),
    nome: readDictionary(data, header.sections.nomeDictionary),
    uf: readDictionary(data, header.sections.ufDictionary),
  };
}

function readDictionary(data: DataView, region: Region): BinaryDictionary {
  const count = data.getUint32(region.offset, true);
  const prefixesOffset = region.offset + data.getUint32(region.offset + 16, true);
  return {
    blockCount: data.getUint32(region.offset + 4, true),
    blockOffsetsOffset: region.offset + data.getUint32(region.offset + 8, true),
    count,
    codec: data.getUint8(region.offset + 30),
    idWidth: data.getUint8(region.offset + 28) as ByteWidth,
    lengthsOffset: region.offset + data.getUint32(region.offset + 12, true),
    lengthWidth: data.getUint8(region.offset + 31) === 2 ? 2 : 1,
    prefixesOffset,
    region,
    suffixDataLength: data.getUint32(region.offset + 24, true),
    suffixDataOffset: region.offset + data.getUint32(region.offset + 20, true),
    symbolsOffset: prefixesOffset + count,
  };
}

function readNeighborhoods(data: DataView, header: BinaryHeader, dictionaries: BinaryDictionaries): BinaryBairros {
  const region = header.sections.bairros;
  const count = data.getUint32(region.offset, true);
  const originalIdWidth = data.getUint8(region.offset + 4) as ByteWidth;
  const localidadeIdWidth = data.getUint8(region.offset + 5) as ByteWidth;
  const recordWidth = originalIdWidth + localidadeIdWidth + dictionaries.bairro.idWidth
    + dictionaries.bairroAbreviado.idWidth + dictionaries.uf.idWidth;
  return {
    count,
    idWidth: integerByteWidth(count),
    originalIdWidth,
    localidadeIdWidth,
    recordsOffset: region.offset + BINARY_BAIRRO_HEADER_SIZE,
    recordWidth,
  };
}

function parseMetadata(mapped: Uint8Array, region: Region): LoadMetadata {
  return JSON.parse(textDecoder.decode(mapped.subarray(region.offset, region.offset + region.length))) as LoadMetadata;
}
