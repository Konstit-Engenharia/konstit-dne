// Copied into a private reader snapshot by fsst-experiment.py.
import {
  cc,
  dlopen,
  ptr,
  type Pointer,
} from 'bun:ffi';

const symbols = {
  fsst_decode: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32'], returns: 'i32' },
} as const;
const native = Bun.env['DNE_FSST_LIBRARY']
  ? dlopen(Bun.env['DNE_FSST_LIBRARY'], symbols)
  : cc({
    source: new URL('./fsst-native.c', import.meta.url),
    define: { FSST_NEON: Bun.env['DNE_FSST_NEON'] === '1' ? '1' : '0' },
    symbols,
  });
const decoder = new TextDecoder();
// Materialize the ArrayBuffer before taking its pointer. Creating a subarray
// later must not move a small typed array out of inline storage in JavaScriptCore.
const output = new Uint8Array(new ArrayBuffer(272));
const outputPointer = ptr(output);
type Dictionary = { region: { offset: number; length: number; }; };
const pointers = new WeakMap<Dictionary, Pointer>();

/** Decode the complete front-coded chain in one synchronous FFI call per string. */
export function readFsstString(mapped: Uint8Array, _data: DataView, dictionary: Dictionary, id: number, _scratch: Uint8Array) {
  if (id === 0) {
    return null;
  }
  let pointer = pointers.get(dictionary);
  if (pointer === undefined) {
    pointer = ptr(mapped, dictionary.region.offset);
    pointers.set(dictionary, pointer);
  }
  const length = native.symbols.fsst_decode(pointer, dictionary.region.length, id, outputPointer, output.length);
  if (length < 0) {
    throw new Error(`Invalid FSST native input: ${length}`);
  }
  return decoder.decode(output.subarray(0, length));
}
