import {
  expect,
  test,
} from 'bun:test';
import {
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  DICTIONARY_CODEC_FSST,
  DICTIONARY_HEADER_SIZE,
  FSST_SYMBOL_TABLE_SIZE,
} from '../src/binary-db-format.ts';
import {
  encodeFsstSuffixes,
  encodeFsstSuffixSource,
  type EncodedFsstSuffixes,
  type FsstSuffixSource,
} from '../src/fsst-encoder.ts';
import {
  readFsstString,
  type FsstDictionary,
} from '../src/fsst.ts';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

test('trains deterministically for the same suffixes', () => {
  const suffixes = [
    textEncoder.encode('Rua das Flores'),
    textEncoder.encode('Rua das Acácias'),
    textEncoder.encode('Avenida das Flores'),
    textEncoder.encode(''),
  ];

  const first = encodeFsstSuffixes(suffixes);
  const second = encodeFsstSuffixes(suffixes.map((suffix) => suffix.slice()));

  expect(second).toEqual(first);
});

test('encodes a compact front-coded source across block boundaries', () => {
  const values = Array.from({ length: 17 }, (_, index) => textEncoder.encode(`Rua ${index.toString().padStart(2, '0')} das Flores`));
  const suffixes = values.map((value, index) => {
    const previous = index % DICTIONARY_BLOCK_SIZE === 0 ? new Uint8Array() : values[index - 1] ?? new Uint8Array();
    let prefix = 0;
    while (prefix < previous.byteLength && prefix < value.byteLength && previous[prefix] === value[prefix]) {
      prefix++;
    }
    return value.slice(prefix);
  });
  const storage = Uint8Array.from(suffixes.flatMap((suffix) => [...suffix]));
  const offsets = suffixes.map((_, index) => suffixes.slice(0, index).reduce((offset, suffix) => offset + suffix.byteLength, 0));
  const source: FsstSuffixSource = {
    count: suffixes.length,
    totalBytes: storage.byteLength,
    get(index) {
      const offset = offsets[index] ?? 0;
      const length = suffixes[index]?.byteLength ?? 0;
      return storage.subarray(offset, offset + length);
    },
  };

  expect(encodeFsstSuffixSource(source)).toEqual(encodeFsstSuffixes(suffixes));
});

test('round trips UTF-8 strings and empty suffixes through the production decoder', () => {
  const values = ['São Paulo', 'Avenida 你好', 'Rua 🚀', '', 'São José'];
  const suffixes = values.map((value) => textEncoder.encode(value));
  const encoded = encodeFsstSuffixes(suffixes);
  const fixture = makeDictionary(encoded, suffixes.length);

  expect(encoded.payload.byteLength).toBe(totalLength(encoded));
  for (const [index, value,] of values.entries()) {
    expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, index + 1)).toBe(value);
  }
});

test('round trips every byte value and emits literal escapes', () => {
  // The dictionary format permits at most 255 decoded bytes per entry, so
  // split the 256 byte values across two entries.
  const first = Uint8Array.from({ length: 255 }, (_, byte) => byte);
  const second = Uint8Array.of(255);
  const encoded = encodeFsstSuffixes([first, second]);
  const fixture = makeDictionary(encoded, 2);

  expect(encoded.payload).toContain(255);
  expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, 1)).toBe(textDecoder.decode(first));
  expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, 2)).toBe(textDecoder.decode(second));
});

test('round trips the maximum 255-byte decoded suffix', () => {
  const value = textEncoder.encode('A'.repeat(255));
  const encoded = encodeFsstSuffixes([value]);
  const fixture = makeDictionary(encoded, 1);

  expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, 1)).toBe('A'.repeat(255));
});

test('packs a 510-byte escaped suffix with two-byte lengths', () => {
  const common = Array.from({ length: 258 }, () => Uint8Array.from({ length: 255 }, () => 0));
  const escaped = Uint8Array.from({ length: 255 }, (_, byte) => byte + 1);
  const encoded = encodeFsstSuffixes([...common, escaped]);
  const fixture = makeDictionary(encoded, common.length + 1);
  const escapedLength = readLength(encoded, common.length);

  expect(encoded.lengthWidth).toBe(2);
  expect(escapedLength).toBe(510);
  expect(encoded.payload.byteLength).toBe(totalLength(encoded));
  expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, common.length + 1))
    .toBe(textDecoder.decode(escaped));
});

test('accepts a dictionary made only of empty suffixes', () => {
  const encoded = encodeFsstSuffixes([new Uint8Array(), new Uint8Array()]);
  const fixture = makeDictionary(encoded, 2);

  expect(encoded.lengthWidth).toBe(1);
  expect(encoded.payload).toHaveLength(0);
  expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, 1)).toBe('');
  expect(readFsstString(fixture.bytes, fixture.data, fixture.dictionary, 2)).toBe('');
});

test('rejects training an empty dictionary', () => {
  expect(() => encodeFsstSuffixes([])).toThrow('Cannot train FSST with an empty dictionary');
});

type Fixture = {
  bytes: Uint8Array;
  data: DataView;
  dictionary: FsstDictionary;
};

function makeDictionary(encoded: EncodedFsstSuffixes, count: number): Fixture {
  const blockCount = Math.ceil(count / DICTIONARY_BLOCK_SIZE);
  const blockOffsetsOffset = DICTIONARY_HEADER_SIZE;
  const lengthsOffset = blockOffsetsOffset + blockCount * 4;
  const prefixesOffset = lengthsOffset + encoded.compressedLengths.byteLength;
  const symbolsOffset = prefixesOffset + count;
  const suffixDataOffset = symbolsOffset + FSST_SYMBOL_TABLE_SIZE;
  const bytes = new Uint8Array(suffixDataOffset + encoded.payload.byteLength);
  const data = new DataView(bytes.buffer);
  const blockOffsets = new Uint32Array(blockCount);
  let payloadOffset = 0;
  for (let index = 0; index < count; index++) {
    if (index % DICTIONARY_BLOCK_SIZE === 0) {
      blockOffsets[index >>> DICTIONARY_BLOCK_SHIFT] = payloadOffset;
    }
    payloadOffset += readLength(encoded, index);
  }
  data.setUint32(0, count, true);
  data.setUint32(4, blockCount, true);
  data.setUint32(8, blockOffsetsOffset, true);
  data.setUint32(12, lengthsOffset, true);
  data.setUint32(16, prefixesOffset, true);
  data.setUint32(20, suffixDataOffset, true);
  data.setUint32(24, encoded.payload.byteLength, true);
  data.setUint8(28, 1);
  data.setUint8(29, DICTIONARY_BLOCK_SHIFT);
  data.setUint8(30, DICTIONARY_CODEC_FSST);
  data.setUint8(31, encoded.lengthWidth);
  bytes.set(new Uint8Array(blockOffsets.buffer), blockOffsetsOffset);
  bytes.set(encoded.compressedLengths, lengthsOffset);
  bytes.set(new Uint8Array(count), prefixesOffset);
  bytes.set(encoded.symbols, symbolsOffset);
  bytes.set(encoded.payload, suffixDataOffset);
  return {
    bytes,
    data,
    dictionary: {
      blockCount,
      blockOffsetsOffset,
      count,
      lengthsOffset,
      lengthWidth: encoded.lengthWidth,
      prefixesOffset,
      symbolsOffset,
      suffixDataLength: encoded.payload.byteLength,
      suffixDataOffset,
    },
  };
}

function readLength(encoded: EncodedFsstSuffixes, index: number) {
  if (encoded.lengthWidth === 1) {
    return encoded.compressedLengths[index] ?? 0;
  }
  const offset = index * 2;
  return (encoded.compressedLengths[offset] ?? 0) | ((encoded.compressedLengths[offset + 1] ?? 0) << 8);
}

function totalLength(encoded: EncodedFsstSuffixes) {
  let total = 0;
  for (let index = 0; index < encoded.compressedLengths.byteLength / encoded.lengthWidth; index++) {
    total += readLength(encoded, index);
  }
  return total;
}
