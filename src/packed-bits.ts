/** Minimum nonzero bit width for a column containing values from zero through maxValue. */
export function integerBitWidth(maxValue: number): number {
  return Math.max(1, Math.ceil(Math.log2(maxValue + 1)));
}

/** Reads one unsigned value without decoding any preceding values. Width must be in 1..32. */
export function readPackedBits(data: DataView, offset: number, index: number, width: number): number {
  const bit = index * width;
  const byte = offset + Math.floor(bit / 8);
  const shift = bit & 7;
  const end = shift + width;
  let value = data.getUint8(byte);
  if (end > 8) {
    value |= data.getUint8(byte + 1) << 8;
  }
  if (end > 16) {
    value |= data.getUint8(byte + 2) << 16;
  }
  if (end > 24) {
    value |= data.getUint8(byte + 3) << 24;
  }
  let result = (value >>> shift) & (0xffff_ffff >>> (32 - width));
  if (end > 32) {
    result += (data.getUint8(byte + 4) & ((1 << (end - 32)) - 1)) * 2 ** (32 - shift);
  }
  return result >>> 0;
}

/** Writes one unsigned value into a zero-initialized packed column. */
export function writePackedBits(bytes: Uint8Array, index: number, width: number, value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** width || width < 1 || width > 32) {
    throw new Error(`Invalid ${width}-bit column value: ${value}`);
  }
  const bit = index * width;
  const byte = Math.floor(bit / 8);
  const shift = bit & 7;
  const shifted = value * 2 ** shift;
  const count = Math.ceil((shift + width) / 8);
  for (let part = 0; part < count; part++) {
    bytes[byte + part] = (bytes[byte + part] ?? 0) | (Math.floor(shifted / 2 ** (part * 8)) & 255);
  }
}
