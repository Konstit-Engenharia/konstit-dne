// Experimental decoder for bun:ffi cc(). Output needs 16 bytes of padding.
// FSST_NEON=1 uses AArch64 NEON to join two symbols in one 16-byte store.
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef struct __attribute__((packed, may_alias)) { u32 value; } unaligned32;
typedef struct __attribute__((packed, may_alias)) { u64 value; } unaligned64;
#define LOAD32(pointer) (((const unaligned32 *)(pointer))->value)
#define COPY8(output, input) (((unaligned64 *)(output))->value = ((const unaligned64 *)(input))->value)

#ifndef FSST_NEON
#define FSST_NEON 0
#endif

#if FSST_NEON
#if !defined(__aarch64__)
#error FSST_NEON requires AArch64
#endif
// Concatenate the first symbol's valid bytes with the second symbol's eight bytes.
static const u8 masks[8][16] = {
  {0,8,9,10,11,12,13,14,15,255,255,255,255,255,255,255},
  {0,1,8,9,10,11,12,13,14,15,255,255,255,255,255,255},
  {0,1,2,8,9,10,11,12,13,14,15,255,255,255,255,255},
  {0,1,2,3,8,9,10,11,12,13,14,15,255,255,255,255},
  {0,1,2,3,4,8,9,10,11,12,13,14,15,255,255,255},
  {0,1,2,3,4,5,8,9,10,11,12,13,14,15,255,255},
  {0,1,2,3,4,5,6,8,9,10,11,12,13,14,15,255},
  {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},
};
#endif

int fsst_decode(const u8 *dictionary, u32 size, u32 id, u8 *output, u32 capacity) {
  if (size < 32 || capacity < 271) return -1;
  u32 count = LOAD32(dictionary);
  if (!id || id > count) return -2;
  u32 block_offsets = LOAD32(dictionary + 8);
  u32 lengths = LOAD32(dictionary + 12);
  u32 prefixes = LOAD32(dictionary + 16);
  u32 payload = LOAD32(dictionary + 20);
  u32 payload_size = LOAD32(dictionary + 24);
  u32 mode = dictionary[30];
  if ((mode != 1 && mode != 2) || block_offsets != 32 || lengths > size || count > size - lengths) return -3;
  if (prefixes != lengths + count || prefixes > size || (mode == 2 && count > size - prefixes)) return -3;
  u32 symbol_lengths = prefixes + (mode == 2 ? count : 0);
  if (symbol_lengths > size || size - symbol_lengths < 2295 || payload != symbol_lengths + 2295) return -3;
  if (payload_size > size - payload) return -3;
  u32 index = id - 1;
  u32 block = index >> 3;
  if ((u64)block_offsets + (u64)block * 4 + 4 > lengths) return -3;
  u32 relative = LOAD32(dictionary + block_offsets + block * 4);
  if (relative > payload_size) return -3;
  u32 cursor = payload + relative;
  u32 previous = 0;
  const u8 *symbols = dictionary + symbol_lengths + 255;
  const u8 *symbol_sizes = dictionary + symbol_lengths;
  for (u32 current = index & ~7u; current <= index; current++) {
    u32 compressed_length = dictionary[lengths + current];
    if (compressed_length > payload + payload_size - cursor) return -4;
    u32 end = cursor + compressed_length;
    if (mode == 1 && current != index) { cursor = end; continue; }
    u32 offset = mode == 2 ? dictionary[prefixes + current] : 0;
    if (offset > previous) return -5;
    while (cursor < end) {
      u32 code = dictionary[cursor++];
      if (code == 255) {
        if (cursor == end || offset == 255) return -6;
        output[offset++] = dictionary[cursor++];
        continue;
      }
      u32 length = symbol_sizes[code];
      if (!length || length > 8 || offset + length > 255) return -7;
      const u8 *first = symbols + code * 8;
      if (cursor < end && dictionary[cursor] != 255) {
        u32 second_code = dictionary[cursor++];
        u32 second_length = symbol_sizes[second_code];
        if (!second_length || second_length > 8 || offset + length + second_length > 255) return -7;
        const u8 *second = symbols + second_code * 8;
#if FSST_NEON
        // TinyCC in Bun 1.4.2 lacks these NEON mnemonics. The encodings below
        // were verified with clang -c and otool; .long emits a 32-bit word.
        __asm__ volatile(
          "mov x9, %0\n\t"
          "mov x10, %1\n\t"
          "mov x11, %2\n\t"
          "mov x12, %3\n\t"
          ".long 0x0d408540\n\t" // ld1 {v0.d}[0], [x10]
          ".long 0x4d408560\n\t" // ld1 {v0.d}[1], [x11]
          ".long 0x3dc00181\n\t" // ldr q1, [x12]
          ".long 0x4e010000\n\t" // tbl v0.16b, {v0.16b}, v1.16b
          ".long 0x3d800120\n\t" // str q0, [x9]
          : : "r" (output + offset), "r" (first), "r" (second), "r" (masks[length - 1])
          : "x9", "x10", "x11", "x12", "v0", "v1", "memory");
#else
        COPY8(output + offset, first);
        COPY8(output + offset + length, second);
#endif
        offset += length + second_length;
      } else {
        COPY8(output + offset, first);
        offset += length;
      }
    }
    previous = offset;
  }
  return previous;
}
