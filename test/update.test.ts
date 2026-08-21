import { Database } from 'bun:sqlite';
import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFixture,
  fetchDatabase,
  rowCount,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-update-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('in-place update', () => {
  test('updates an existing database visible to an open connection', () => {
    const smallDneDir = join(workDir, 'dne');
    const largeDneDir = join(workDir, 'large-dne');
    const dbPath = join(workDir, 'update-dne.db');

    createFixture(smallDneDir, 40);
    createFixture(largeDneDir, 2500);
    fetchDatabase(dbPath, smallDneDir);

    const db = new Database(dbPath, { readonly: true });
    try {
      const before = rowCount(db);
      fetchDatabase(dbPath, largeDneDir);
      const after = rowCount(db);

      expect(before).toBeLessThan(after);
      expect(after).toBeGreaterThan(2500);
      expect(existsSync(`${dbPath}-journal`)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
    } finally {
      db.close();
    }
  });
});
