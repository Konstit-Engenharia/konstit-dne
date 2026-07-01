import { Database } from 'bun:sqlite';
import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DneResolver } from '../src/resolver.ts';
import { buildSchema } from '../src/schema.ts';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-bun-test-'));
const dneDir = join(workDir, 'dne');
const largeDneDir = join(workDir, 'large-dne');
const dbPath = join(workDir, 'dne.db');
const largeDbPath = join(workDir, 'large-dne.db');

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('Bun DNE loader', () => {
  test('loads a fixture into the default unified SQLite table', () => {
    run('bun', ['run', 'scripts/create-benchmark-dne.ts', dneDir, '40']);
    run('bun', ['run', 'src/index.ts', 'fetch', dbPath, '--source', dneDir]);

    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db
        .query('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name')
        .all() as { name: string; }[];
      expect(tables.map((row) => row.name)).toEqual([SQLITE_CEP_TABLE_NAME, 'edne_metadata'].sort());

      const cep = db.query(`SELECT * FROM ${SQLITE_CEP_TABLE_NAME} WHERE cep = ?`).get('30000001');
      expect(cep).toEqual({
        cep: '30000001',
        logradouro: 'Rua Endereco 1',
        complemento: null,
        bairro: 'Bairro 1',
        municipio: 'Municipio 1',
        municipio_cod_ibge: 3500001,
        uf: 'BA',
        nome: null,
      });

      const sourceKind = db.query('SELECT value FROM edne_metadata WHERE key = ?').get('source_kind');
      expect(sourceKind).toEqual({ value: 'local' });
    } finally {
      db.close();
    }
  });

  test('loads batches within SQLite parameter limits', () => {
    run('bun', ['run', 'scripts/create-benchmark-dne.ts', largeDneDir, '2500']);
    run('bun', ['run', 'src/index.ts', 'fetch', largeDbPath, '--source', largeDneDir]);

    const db = new Database(largeDbPath, { readonly: true });
    try {
      const row = db.query(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`).get() as { count: number; };
      expect(row.count).toBeGreaterThan(2500);
    } finally {
      db.close();
    }
  });

  test('updates an existing database visible to an open connection', () => {
    const updateDbPath = join(workDir, 'update-dne.db');
    run('bun', ['run', 'scripts/create-benchmark-dne.ts', dneDir, '40']);
    run('bun', ['run', 'scripts/create-benchmark-dne.ts', largeDneDir, '2500']);
    run('bun', ['run', 'src/index.ts', 'fetch', updateDbPath, '--source', dneDir]);

    const db = new Database(updateDbPath, { readonly: true });
    try {
      const before = rowCount(db);
      run('bun', ['run', 'src/index.ts', 'fetch', updateDbPath, '--source', largeDneDir]);
      const after = rowCount(db);

      expect(before).toBeLessThan(after);
      expect(after).toBeGreaterThan(2500);
      expect(existsSync(`${updateDbPath}-journal`)).toBe(false);
      expect(existsSync(`${updateDbPath}-wal`)).toBe(true);
      expect(existsSync(`${updateDbPath}-shm`)).toBe(true);
    } finally {
      db.close();
    }
  });

  test('force skips remote download cache', async () => {
    const originalFetch = globalThis.fetch;
    const url = `https://example.test/edne-${Date.now()}.zip`;
    let getCount = 0;

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          headers: {
            'content-length': '3',
            'last-modified': 'Wed, 01 Jul 2026 12:00:00 GMT',
          },
        });
      }

      getCount++;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;

    try {
      await expectRejects(resolveInvalidRemote(url));
      expect(getCount).toBe(1);

      await expectRejects(resolveInvalidRemote(url));
      expect(getCount).toBe(1);

      await expectRejects(resolveInvalidRemote(url, { skipCache: true }));
      expect(getCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr.toString()}`);
  }
}

function rowCount(db: Database) {
  const statement = db.prepare(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`);
  try {
    return (
      statement.get() as {
        count: number;
      }
    ).count;
  } finally {
    statement.finalize();
  }
}

async function resolveInvalidRemote(url: string, options: { skipCache?: boolean; } = {}) {
  const resolver = new DneResolver(url, options);
  try {
    await resolver.resolve(buildSchema());
  } finally {
    await resolver.cleanup();
  }
}

async function expectRejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch {
    return;
  }

  throw new Error('Expected promise to reject');
}
