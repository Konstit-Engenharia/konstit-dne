import {
  cc,
  ptr,
} from 'bun:ffi';
import {
  deepStrictEqual,
  equal,
  ok,
} from 'node:assert/strict';

// Focused checks for wide writes and malformed compressed strings. The complete
// real-data comparison lives in compression.bench.ts and checks every CEP.
const modes = process.arch === 'arm64' ? [0, 1] : [0];
let cases = 0;
for (const neon of modes) {
  const lib = cc({
    source: new URL('./fsst-native.c', import.meta.url),
    define: { FSST_NEON: String(neon) },
    symbols: { fsst_decode: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32'], returns: 'i32' } },
  });
  try {
    const decode = (dictionary: Uint8Array, id: number, expected: Uint8Array | null) => {
      const allocation = new Uint8Array(new ArrayBuffer(16 + 272 + 16)).fill(0xa5);
      const output = allocation.subarray(16, 16 + 272);
      const length = lib.symbols.fsst_decode(ptr(dictionary), dictionary.length, id, ptr(output), output.length);
      if (expected === null) {
        ok(length < 0);
      } else {
        equal(length, expected.length);
        deepStrictEqual(output.slice(0, length), expected);
      }
      ok(allocation.subarray(0, 16).every((byte) => byte === 0xa5));
      ok(allocation.subarray(16 + 272).every((byte) => byte === 0xa5));
      cases++;
    };
    for (let first = 1; first <= 8; first++) {
      for (let second = 1; second <= 8; second++) {
        const symbols = [new Uint8Array(first).fill(65), new Uint8Array(second).fill(66)];
        const joined = Uint8Array.from([...symbols[0] ?? [], ...symbols[1] ?? [], 90]);
        decode(makeDictionary([[0, 1, 255, 90]], symbols), 1, joined);
        const prefix = Math.min(3, joined.length);
        const following = Uint8Array.from([...joined.subarray(0, prefix), ...symbols[1] ?? []]);
        decode(makeDictionary([[0, 1, 255, 90], [1]], symbols, [0, prefix]), 2, following);
      }
    }
    const oneByte = [Uint8Array.of(65)];
    decode(makeDictionary([Array.from({ length: 255 }, () => 0)], oneByte), 1, new Uint8Array(255).fill(65));
    decode(makeDictionary([Array.from({ length: 255 }, () => 0), [0, 0]], oneByte, [0, 253]), 2, new Uint8Array(255).fill(65));
    decode(makeDictionary([[255]], oneByte), 1, null);
    decode(makeDictionary([Array.from({ length: 255 }, () => 0)], [Uint8Array.of(65, 65)]), 1, null);
    decode(makeDictionary([[0], [0]], oneByte, [0, 2]), 2, null);
    const badSymbol = makeDictionary([[0]], oneByte);
    badSymbol[37] = 9;
    decode(badSymbol, 1, null);
    const badBlock = makeDictionary([[0]], oneByte);
    new DataView(badBlock.buffer).setUint32(32, 0xffff_ffff, true);
    decode(badBlock, 1, null);
  } finally {
    lib.close();
  }
}
console.log(JSON.stringify({ verifiedCases: cases, compilers: 'bun:ffi cc', variants: modes }));

function makeDictionary(strings: number[][], symbols: Uint8Array[], prefixes?: number[]) {
  const count = strings.length;
  const lengthsOffset = 36;
  const prefixesOffset = lengthsOffset + count;
  const symbolLengths = prefixesOffset + (prefixes ? count : 0);
  const symbolData = symbolLengths + 255;
  const payload = symbolData + 255 * 8;
  const codes = strings.flat();
  const bytes = new Uint8Array(new ArrayBuffer(payload + codes.length));
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
