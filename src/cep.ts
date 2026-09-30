import { UserError } from './errors.ts';

const CEP_SEPARATOR_PATTERN = /[\s,;]/;

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
