import {
  expect,
  mock,
  test,
} from 'bun:test';
import { forEachSelectedRow } from '../src/dne-source-parser.ts';
import { LoadQualityTracker } from '../src/dne-source-quality.ts';
import type { DneDataSource } from '../src/dne-source.ts';
import {
  buildSchema,
  getUnifiedTable,
} from '../src/schema.ts';
import { captureRejection } from './assertions.ts';

test('skips generated tables without reading source files or changing validation counts', async () => {
  const matchingFiles = mock(() => []);
  const readLines = mock(async function*() {
    yield 'unexpected';
  });
  const source: DneDataSource = { matchingFiles, readLines };
  const quality = new LoadQualityTracker();
  const visit = mock(() => {});
  await forEachSelectedRow(getUnifiedTable(buildSchema()), source, [], quality, visit);
  expect(matchingFiles).not.toHaveBeenCalled();
  expect(readLines).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
  expect(quality.report(0)).toMatchObject({ stages: {}, totals: { read: 0, accepted: 0, rejected: 0 } });
});

test('reports a missing required source file before visiting rows', async () => {
  const source: DneDataSource = {
    matchingFiles: () => [],
    async *readLines() {
      yield 'unexpected';
    },
  };
  const quality = new LoadQualityTracker();
  const visit = mock(() => {});
  const error = await captureRejection(forEachSelectedRow(
    { name: 'localidades', originalName: 'log_localidade', columns: [] },
    source,
    [0],
    quality,
    visit,
  ));
  expect(error).toEqual(new Error('DNE data file not found: LOG_LOCALIDADE.TXT'));
  expect(visit).not.toHaveBeenCalled();
  expect(quality.report(0).totals).toEqual({ read: 0, accepted: 0, rejected: 0 });
});
