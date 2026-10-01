import {
  expect,
  test,
} from 'bun:test';
import { DneBinaryDatabaseFormatError } from '../src/binary-db-errors.ts';
import {
  DICTIONARY_BLOCK_SIZE,
  FSST_SYMBOL_COUNT,
  FSST_SYMBOL_TABLE_SIZE,
} from '../src/binary-db-format.ts';
import {
  readFsstString,
  type FsstDictionary,
  validateFsstSymbols,
} from '../src/fsst.ts';

type Entry = {
  codes: number[];
  prefix?: number;
};

type Fixture = {
  bytes: Uint8Array;
  data: DataView;
  dictionary: FsstDictionary;
  lengthsOffset: number;
  prefixesOffset: number;
  blockOffsetsOffset: number;
  symbolsOffset: number;
  suffixDataOffset: number;
};

const encoder = new TextEncoder();

test('decodes all symbol lengths from one through eight', () => {
  const symbols = new Map<number, Uint8Array>();
  const entries: Entry[] = [];
  for (let length = 1; length <= 8; length++) {
    const code = length - 1;
    const symbol = Uint8Array.from({ length }, (_, index) => 65 + code + index);
    symbols.set(code, symbol);
    entries.push({ codes: [code] });
  }

  const fixture = makeFixture(entries, symbols);
  for (const [index, entry,] of entries.entries()) {
    const code = entry.codes[0];
    const symbol = code === undefined ? undefined : symbols.get(code);
    if (symbol === undefined) {
      throw new Error(`Missing test symbol ${code}`);
    }
    expect(read(fixture, index + 1)).toBe(String.fromCharCode(...symbol));
  }
});

test('decodes escaped bytes and a prefix that splits a UTF-8 sequence', () => {
  const first = encoder.encode('aé');
  const second = encoder.encode('aê');
  const secondLast = second[second.length - 1];
  if (secondLast === undefined) {
    throw new Error('Missing UTF-8 test byte');
  }
  const fixture = makeFixture([
    { codes: Array.from(first).flatMap((byte) => [255, byte]) },
    { codes: [255, secondLast], prefix: 2 },
  ]);

  expect(read(fixture, 1)).toBe('aé');
  expect(read(fixture, 2)).toBe('aê');
});

test('rejects a prefix longer than the previously decoded string', () => {
  const first = makeFixture([
    { codes: [255, 65] },
    { codes: [255, 66], prefix: 2 },
  ]);
  expect(() => read(first, 2)).toThrow('Invalid binary FSST prefix');

  const firstEntry = makeFixture([{ codes: [255, 65], prefix: 1 }]);
  expect(() => read(firstEntry, 1)).toThrow('Invalid binary FSST prefix');
});

test('supports the 255-byte decoded and 510-byte compressed limits', () => {
  const fixture = makeFixture(
    [{ codes: Array.from({ length: 255 }, () => [255, 65]).flat() }],
    new Map(),
    2,
  );

  expect(fixture.dictionary.lengthWidth).toBe(2);
  expect(fixture.dictionary.suffixDataLength).toBe(510);
  expect(read(fixture, 1)).toBe('A'.repeat(255));
});

test('returns null for the null ID and rejects invalid IDs', () => {
  const fixture = makeFixture([{ codes: [255, 65] }]);

  expect(read(fixture, 0)).toBeNull();
  for (const id of [-1, 1.5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => read(fixture, id)).toThrow(DneBinaryDatabaseFormatError);
  }
});

test('decodes a leading BOM using TextDecoder semantics', () => {
  const bytes = encoder.encode('\ufeffOlá');
  const fixture = makeFixture([{ codes: Array.from(bytes).flatMap((byte) => [255, byte]) }]);

  expect(read(fixture, 1)).toBe('Olá');
});

test('replaces malformed UTF-8 while retaining decoder state for later reads', () => {
  const fixture = makeFixture([
    { codes: [255, 0xc3, 255, 0x28] },
    { codes: [255, 0x41] },
  ]);

  expect(read(fixture, 1)).toBe('\ufffd(');
  expect(read(fixture, 2)).toBe('A');
});

test('validates the fixed symbol table at open time', () => {
  const fixture = makeFixture([{ codes: [0] }], new Map([[0, Uint8Array.of(65)]]));
  fixture.bytes[fixture.symbolsOffset] = 9;

  expect(() => validateFsstSymbols(fixture.data, fixture.symbolsOffset))
    .toThrow(DneBinaryDatabaseFormatError);
  expect(() => validateFsstSymbols(fixture.data, fixture.symbolsOffset))
    .toThrow('Invalid binary FSST symbol length');
});

test('rejects an undefined symbol code and a dangling escape', () => {
  const unknown = makeFixture([{ codes: [254] }]);
  expect(() => read(unknown, 1)).toThrow('Invalid binary FSST symbol');

  const dangling = makeFixture([{ codes: [255] }]);
  expect(() => read(dangling, 1)).toThrow('Invalid binary FSST escape');
});

test('rejects decoded output above 255 bytes and an escape after byte 255', () => {
  const longSymbol = makeFixture(
    [{ codes: Array.from({ length: 32 }, () => 0) }],
    new Map([[0, Uint8Array.from({ length: 8 }, () => 65)]]),
  );
  expect(() => read(longSymbol, 1)).toThrow('Invalid binary FSST symbol');

  const afterLimit = makeFixture(
    [{
      codes: [
        ...Array.from({ length: 247 }, () => [255, 65]).flat(),
        0,
        255,
        66,
      ],
    }],
    new Map([[0, Uint8Array.from({ length: 8 }, () => 65)]]),
  );
  expect(() => read(afterLimit, 1)).toThrow('Invalid binary FSST escape');
});

test('rejects block offsets that reverse, cross, or exceed the payload', () => {
  const reversed = makeFixture(
    Array.from({ length: DICTIONARY_BLOCK_SIZE * 2 + 1 }, () => ({ codes: [255, 65] })),
  );
  new DataView(reversed.bytes.buffer).setUint32(reversed.blockOffsetsOffset + 4, 10, true);
  new DataView(reversed.bytes.buffer).setUint32(reversed.blockOffsetsOffset + 8, 5, true);
  expect(() => read(reversed, DICTIONARY_BLOCK_SIZE + 1)).toThrow('Invalid binary FSST block offset');

  const crossing = makeFixture(
    Array.from({ length: DICTIONARY_BLOCK_SIZE + 1 }, () => ({ codes: [255, 65] })),
  );
  new DataView(crossing.bytes.buffer).setUint32(crossing.blockOffsetsOffset + 4, 1, true);
  expect(() => read(crossing, DICTIONARY_BLOCK_SIZE)).toThrow('Invalid binary FSST compressed length');

  const beyondEnd = makeFixture([{ codes: [255, 65] }]);
  new DataView(beyondEnd.bytes.buffer).setUint32(beyondEnd.blockOffsetsOffset, 3, true);
  expect(() => read(beyondEnd, 1)).toThrow('Invalid binary FSST block offset');

  const oversized = makeFixture([{ codes: [0] }], new Map([[0, Uint8Array.of(65)]]), 2);
  new DataView(oversized.bytes.buffer).setUint16(oversized.lengthsOffset, 511, true);
  expect(() => read(oversized, 1)).toThrow('Invalid binary FSST compressed length');
});

test('requires the final entry to consume its complete block', () => {
  const trailing = makeFixture([{ codes: [255, 65] }]);
  trailing.bytes = trailing.bytes.slice(0, -1);
  trailing.data = new DataView(trailing.bytes.buffer);
  trailing.dictionary.suffixDataLength--;
  expect(() => read(trailing, 1)).toThrow('Invalid binary FSST compressed length');

  const extra = makeFixture([{ codes: [255, 65] }]);
  const expanded = new Uint8Array(extra.bytes.length + 1);
  expanded.set(extra.bytes);
  expanded[expanded.length - 1] = 65;
  extra.bytes = expanded;
  extra.data = new DataView(expanded.buffer);
  extra.dictionary.suffixDataLength++;
  expect(() => read(extra, 1)).toThrow('Invalid binary FSST block length');
});

test('does not retain a failed decode after the payload is repaired', () => {
  const fixture = makeFixture([{ codes: [254, 0] }]);

  expect(() => read(fixture, 1)).toThrow('Invalid binary FSST symbol');
  fixture.bytes[fixture.suffixDataOffset] = 255;
  fixture.bytes[fixture.suffixDataOffset + 1] = 65;
  fixture.dictionary.suffixDataLength = 2;
  expect(read(fixture, 1)).toBe('A');
});

function read(fixture: Fixture, id: number) {
  return readFsstString(fixture.bytes, fixture.data, fixture.dictionary, id);
}

function makeFixture(
  entries: Entry[],
  symbols = new Map<number, Uint8Array>(),
  lengthWidth: 1 | 2 = 1,
): Fixture {
  const count = entries.length;
  const blockCount = Math.ceil(count / DICTIONARY_BLOCK_SIZE);
  const blockOffsetsOffset = 0;
  const lengthsOffset = blockOffsetsOffset + blockCount * 4;
  const prefixesOffset = lengthsOffset + count * lengthWidth;
  const symbolsOffset = prefixesOffset + count;
  const suffixDataOffset = symbolsOffset + FSST_SYMBOL_TABLE_SIZE;
  const payload = Uint8Array.from(entries.flatMap(({ codes, }) => codes));
  const bytes = new Uint8Array(suffixDataOffset + payload.length);
  const data = new DataView(bytes.buffer);
  let payloadOffset = 0;
  for (let block = 0; block < blockCount; block++) {
    data.setUint32(blockOffsetsOffset + block * 4, payloadOffset, true);
    const first = block * DICTIONARY_BLOCK_SIZE;
    const last = Math.min(first + DICTIONARY_BLOCK_SIZE, count);
    for (let index = first; index < last; index++) {
      payloadOffset += entries[index]?.codes.length ?? 0;
    }
  }
  for (const [index, entry,] of entries.entries()) {
    if (lengthWidth === 1) {
      data.setUint8(lengthsOffset + index, entry.codes.length);
    } else {
      data.setUint16(lengthsOffset + index * 2, entry.codes.length, true);
    }
    bytes[prefixesOffset + index] = entry.prefix ?? 0;
  }
  for (const [code, symbol,] of symbols) {
    if (code < 0 || code >= FSST_SYMBOL_COUNT || symbol.length > 8) {
      throw new Error(`Invalid test symbol ${code}`);
    }
    bytes[symbolsOffset + code] = symbol.length;
    bytes.set(symbol, symbolsOffset + FSST_SYMBOL_COUNT + code * 8);
  }
  bytes.set(payload, suffixDataOffset);
  return {
    bytes,
    data,
    dictionary: {
      blockCount,
      blockOffsetsOffset,
      count,
      lengthsOffset,
      lengthWidth,
      prefixesOffset,
      symbolsOffset,
      suffixDataLength: payload.length,
      suffixDataOffset,
    },
    lengthsOffset,
    prefixesOffset,
    blockOffsetsOffset,
    symbolsOffset,
    suffixDataOffset,
  };
}
