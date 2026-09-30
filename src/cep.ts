import { UserError } from './errors.ts';
import type { UF } from './types.ts';

const CEP_SEPARATOR_PATTERN = /[\s,;]/;

// Inclusive CEP ranges.
export const cepRanges: readonly (readonly [number, number, UF])[] = [
  [1000000, 19999999, 'SP'],
  [20000000, 28999999, 'RJ'],
  [29000000, 29999999, 'ES'],
  [30000000, 39999999, 'MG'],
  [40000000, 48999999, 'BA'],
  [49000000, 49999999, 'SE'],
  [50000000, 56999999, 'PE'],
  [57000000, 57999999, 'AL'],
  [58000000, 58999999, 'PB'],
  [59000000, 59999999, 'RN'],
  [60000000, 63999999, 'CE'],
  [64000000, 64999999, 'PI'],
  [65000000, 65999999, 'MA'],
  [66000000, 68899999, 'PA'],
  [68900000, 68999999, 'AP'],
  [69000000, 69299999, 'AM'],
  [69300000, 69399999, 'RR'],
  [69400000, 69899999, 'AM'],
  [69900000, 69999999, 'AC'],
  [70000000, 72799999, 'DF'],
  [72800000, 72999999, 'GO'],
  [73000000, 73699999, 'DF'],
  [73700000, 76799999, 'GO'],
  [76800000, 76999999, 'RO'],
  [77000000, 77999999, 'TO'],
  [78000000, 78899999, 'MT'],
  [79000000, 79999999, 'MS'],
  [80000000, 87999999, 'PR'],
  [88000000, 89999999, 'SC'],
  [90000000, 99999999, 'RS'],
];

/**
 * Returns the Brazilian federative unit whose postal range contains a CEP.
 *
 * @param cep Numeric CEP value.
 * @returns The matching state, or `undefined` for an out-of-range CEP.
 */
export function ufForCep(cep: number | string): UF | undefined {
  if (typeof cep === 'string') {
    cep = cepToU32(cep);
  }
  if (Number.isNaN(cep)) {
    return undefined;
  }
  for (const [first, last, uf,] of cepRanges) {
    if (cep >= first && cep <= last) {
      return uf;
    }
  }
  return undefined;
}

/**
 * Parses a CEP without allocating a normalized string.
 * @param value - Eight ASCII digits or the form `NNNNN-NNN`, without surrounding whitespace.
 * @returns An integer from 0 through 99999999, or NaN for invalid syntax. Leading zeros are not retained.
 */
export function cepToU32(value: string): number {
  const length = value.length;

  if (length !== 8 && length !== 9) {
    return Number.NaN;
  }
  if (length === 9 && value.charCodeAt(5) !== 45) {
    return Number.NaN;
  }

  const d0 = value.charCodeAt(0) - 48;
  const d1 = value.charCodeAt(1) - 48;
  const d2 = value.charCodeAt(2) - 48;
  const d3 = value.charCodeAt(3) - 48;
  const d4 = value.charCodeAt(4) - 48;
  const d5 = value.charCodeAt(length - 3) - 48;
  const d6 = value.charCodeAt(length - 2) - 48;
  const d7 = value.charCodeAt(length - 1) - 48;

  if (
    (
      d0 | d1 | d2 | d3 | d4 | d5 | d6 | d7
      | (9 - d0) | (9 - d1) | (9 - d2) | (9 - d3)
      | (9 - d4) | (9 - d5) | (9 - d6) | (9 - d7)
    ) < 0
  ) {
    return Number.NaN;
  }

  return (
    d0 * 10_000_000
    + d1 * 1_000_000
    + d2 * 100_000
    + d3 * 10_000
    + d4 * 1_000
    + d5 * 100
    + d6 * 10
    + d7
  );
}

/**
 * Trims and normalizes a CEP for storage or lookup.
 * @param value - A plain or hyphenated CEP, optionally surrounded by whitespace.
 * @returns Exactly eight ASCII digits, including leading zeros.
 * @throws {UserError} With code `invalid-cep` when the trimmed value is invalid.
 */
export function normalizeCep(value: string) {
  const trimmed = value.trim();
  const parsed = cepToU32(trimmed);
  if (Number.isNaN(parsed)) {
    throw new UserError(
      'invalid-cep',
      `CEP inválido '${value}'. Use 01001000 ou 01001-000.`,
      2,
      { input: value },
    );
  }
  return String(parsed).padStart(8, '0');
}

/**
 * Collects positional CEPs followed by file or standard-input tokens without buffering the full input.
 * @param inputs - Positional values, yielded as supplied.
 * @param file - Optional input path; `-` selects standard input.
 * @param stdinIsTty - Whether stdin is interactive. Noninteractive stdin is used when no other input is supplied.
 * @returns An asynchronous sequence of unvalidated CEP strings.
 * @throws {UserError} If an explicitly requested input file does not exist.
 * @throws {Error} If the selected input stream cannot be read.
 */
export async function* collectCepInputs(
  inputs: readonly string[],
  file: string | undefined,
  stdinIsTty = process.stdin.isTTY === true,
): AsyncIterable<string> {
  const source = file ? (file === '-' ? Bun.stdin : Bun.file(file)) : null;
  if (file && file !== '-' && source && !(await source.exists())) {
    throw new UserError('input-file-not-found', `Arquivo de entrada com CEPs não encontrado: ${file}`);
  }

  for (const input of inputs) {
    yield input;
  }

  if (source) {
    yield* splitCepStream(source.stream());
    return;
  }

  if (!inputs.length && !stdinIsTty) {
    yield* splitCepStream(Bun.stdin.stream());
  }
}

/**
 * Splits UTF-8 input at whitespace, commas, and semicolons, preserving tokens across chunk boundaries.
 * @param chunks - Byte chunks from a readable stream.
 * @returns Nonempty tokens in input order; no CEP validation or deduplication is performed.
 */
export async function* splitCepStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = '';

  for await (const chunk of chunks) {
    const content = pending + decoder.decode(chunk, { stream: true });
    let start = 0;

    for (let offset = 0; offset < content.length; offset++) {
      if (!CEP_SEPARATOR_PATTERN.test(content[offset] ?? '')) {
        continue;
      }
      if (offset > start) {
        yield content.slice(start, offset);
      }
      start = offset + 1;
    }
    pending = content.slice(start);
  }

  pending += decoder.decode();
  if (pending) {
    yield pending;
  }
}
