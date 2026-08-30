import { UserError } from './errors.ts';

const CEP_PATTERN = /^(?:\d{8}|\d{5}-\d{3})$/;
const CEP_SEPARATOR_PATTERN = /[\s,;]/;

export function normalizeCep(value: string) {
  const trimmed = value.trim();
  if (!CEP_PATTERN.test(trimmed)) {
    throw new UserError(
      'invalid-cep',
      `CEP inválido '${value}'. Use 01001000 ou 01001-000.`,
      2,
      { input: value },
    );
  }
  return trimmed.replace('-', '');
}

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
