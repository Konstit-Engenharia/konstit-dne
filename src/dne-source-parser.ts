import type {
  LoadQualityCounter,
  LoadQualityTracker,
} from './dne-source-quality.ts';
import type { DneDataSource } from './dne-source.ts';
import {
  getTableFilesGlob,
  type TableDefinition,
} from './schema.ts';

/** Visits selected source fields while recording each row in its quality counter. */
export async function forEachSelectedRow(
  table: TableDefinition,
  source: DneDataSource,
  indexes: number[],
  quality: LoadQualityTracker,
  fn: (row: (string | null)[], file: string, counter: LoadQualityCounter) => void,
) {
  const glob = getTableFilesGlob(table);
  if (!glob) {
    return;
  }

  const files = source.matchingFiles(glob);
  if (!files.length) {
    throw new Error(`DNE data file not found: ${glob}`);
  }

  for (const file of files) {
    const counter = quality.counter(table.originalName, file);
    if (source.readText) {
      const content = await source.readText(file);
      forEachLine(content, (start, end) => {
        counter.read();
        fn(selectDelimitedFieldsInRange(content, start, end, indexes), file, counter);
      });
      continue;
    }

    for await (const line of source.readLines(file)) {
      counter.read();
      fn(selectDelimitedFields(line, indexes), file, counter);
    }
  }
}

/**
 * Extracts selected fields from one @-delimited DNE record.
 * @param line - A decoded source record without its line terminator.
 * @param indexes - Unique, ascending zero-based field positions.
 * @returns Trimmed field values in index order; missing or empty values are null.
 */
export function selectDelimitedFields(line: string, indexes: number[]) {
  return selectDelimitedFieldsInRange(line, 0, line.length, indexes);
}

function selectDelimitedFieldsInRange(line: string, lineStart: number, lineEnd: number, indexes: number[]) {
  const values = Array.from({ length: indexes.length }, () => null as string | null);
  let outputIndex = 0;
  let fieldIndex = 0;
  let start = lineStart;

  for (let offset = lineStart; offset <= lineEnd; offset++) {
    if (offset !== lineEnd && line.charCodeAt(offset) !== 64) {
      continue;
    }

    if (fieldIndex === indexes[outputIndex]) {
      values[outputIndex] = normalizeField(line, start, offset);
      outputIndex++;
      if (outputIndex === indexes.length) {
        break;
      }
    }

    fieldIndex++;
    start = offset + 1;
  }

  return values;
}

function forEachLine(content: string, fn: (start: number, end: number) => void) {
  let start = 0;

  for (let offset = 0; offset <= content.length; offset++) {
    if (offset !== content.length && content.charCodeAt(offset) !== 10) {
      continue;
    }

    let end = offset;
    if (end > start && content.charCodeAt(end - 1) === 13) {
      end--;
    }
    if (end > start) {
      fn(start, end);
    }
    start = offset + 1;
  }
}

function normalizeField(line: string, start: number, end: number) {
  if (start === end) {
    return null;
  }

  const first = line.charCodeAt(start);
  const last = line.charCodeAt(end - 1);
  const value = needsTrim(first) || needsTrim(last) ? line.slice(start, end).trim() : line.slice(start, end);
  return value === '' ? null : value;
}

function needsTrim(char: number) {
  return char <= 32 || char === 160;
}
