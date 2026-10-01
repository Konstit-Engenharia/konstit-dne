import {
  deepStrictEqual,
  throws,
} from 'node:assert/strict';
import { readFsstString as baseline } from './fsst-decoder.ts';
import { readFsstString as candidate } from './fsst-ts-optimized.ts';

let cases = 0;
const scratch = new Uint8Array(255);
const compare = (bytes: Uint8Array, id: number, invalid = false) => {
  const data = new DataView(bytes.buffer);
  const dictionary = {
    count: data.getUint32(0, true),
    blockOffsetsOffset: data.getUint32(8, true),
    lengthsOffset: data.getUint32(12, true),
    prefixesOffset: data.getUint32(16, true),
    suffixDataOffset: data.getUint32(20, true),
    suffixDataLength: data.getUint32(24, true),
    fsstMode: bytes[30] ?? 0,
  };
  if (invalid) {
    throws(() => candidate(bytes, data, dictionary, id, scratch));
  } else {
    // Repeated lookup also checks that wide writes do not leak a preceding result.
    for (let repeat = 0; repeat < 2; repeat++) {
      deepStrictEqual(candidate(bytes, data, dictionary, id, scratch), baseline(bytes, data, dictionary, id, scratch));
    }
  }
  cases++;
};
for (let first = 1; first <= 8; first++) {
  for (let second = 1; second <= 8; second++) {
    const symbols = [new Uint8Array(first).fill(65), new Uint8Array(second).fill(66)];
    compare(makeDictionary([[0, 1, 255, 90]], symbols), 1);
    compare(makeDictionary([[0, 1, 255, 90], [1]], symbols, [0, Math.min(3, first + second)]), 2);
  }
}
const oneByte = [Uint8Array.of(65)];
compare(makeDictionary([Array.from({ length: 255 }, () => 0)], oneByte), 1);
compare(makeDictionary([Array.from({ length: 255 }, () => 0), [0, 0]], oneByte, [0, 253]), 2);
compare(makeDictionary([[255]], oneByte), 1, true);
compare(makeDictionary([Array.from({ length: 255 }, () => 0)], [Uint8Array.of(65, 65)]), 1, true);
compare(makeDictionary([[0], [0]], oneByte, [0, 2]), 2, true);
const badSymbol = makeDictionary([[0]], oneByte);
badSymbol[37] = 9;
compare(badSymbol, 1, true);
const badBlock = makeDictionary([[0]], oneByte);
new DataView(badBlock.buffer).setUint32(32, 0xffff_ffff, true);
compare(badBlock, 1, true);
for (const value of ['São João', '😀', '\ufeff', '\ufeffOlá', '\ufeff\ufeffOlá', '', '\0a']) {
  const codes = Array.from(new TextEncoder().encode(value)).flatMap((byte) => [255, byte]);
  compare(makeDictionary([codes], []), 1);
}
for (const value of [[0xff], [0xc3], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
  compare(makeDictionary([value.flatMap((byte) => [255, byte])], []), 1);
}
console.log(JSON.stringify({ verifiedCases: cases, pairs: Bun.env['DNE_FSST_PAIRS'] === '1' }));

function makeDictionary(strings: number[][], symbols: Uint8Array[], prefixes?: number[]) {
  const count = strings.length;
  const lengthsOffset = 36;
  const prefixesOffset = lengthsOffset + count;
  const symbolLengths = prefixesOffset + (prefixes ? count : 0);
  const symbolData = symbolLengths + 255;
  const payload = symbolData + 255 * 8;
  const codes = strings.flat();
  const bytes = new Uint8Array(payload + codes.length);
  const data = new DataView(bytes.buffer);
  for (const [index, value,] of [count, 1, 32, lengthsOffset, prefixesOffset, payload, codes.length].entries()) {
    data.setUint32(index * 4, value, true);
  }
  bytes[28] = 1;
  bytes[29] = 3;
  bytes[30] = prefixes ? 2 : 1;
  bytes.set(strings.map((value) => value.length), lengthsOffset);
  if (prefixes) {
    bytes.set(prefixes, prefixesOffset);
  }
  for (const [code, symbol,] of symbols.entries()) {
    bytes[symbolLengths + code] = symbol.length;
    bytes.set(symbol, symbolData + code * 8);
  }
  bytes.set(codes, payload);
  return bytes;
}
