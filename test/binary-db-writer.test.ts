import { Database } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DneBinaryDatabaseReader } from '../src/binary-db-reader.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import { captureRejection } from './assertions.ts';

const directory = mkdtempSync(join(tmpdir(), 'dne-binary-writer-'));
const validRow = {
  cep: '01001000',
  logradouro: 'Rua Principal',
  complemento: null,
  bairro_id: 1,
  localidade_nome: null,
  municipio: 'São Paulo',
  municipio_cod_ibge: 3550308,
  uf: 'SP',
  nome: null,
  localidade_situacao: 1,
  localidade_tipo: 'M',
};
type Row = Record<keyof typeof validRow, string | number | null>;

afterEach(() => mock.restore());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function createDatabase(rows: Row[] = [validRow], alter?: (db: Database) => void) {
  const path = join(directory, `${crypto.randomUUID()}.db`);
  const db = new Database(path);
  try {
    db.run(`CREATE TABLE dne (
      cep TEXT, logradouro TEXT, complemento TEXT, bairro_id INTEGER, localidade_nome TEXT,
      municipio TEXT, municipio_cod_ibge INTEGER, uf TEXT, nome TEXT, localidade_situacao INTEGER, localidade_tipo TEXT
    )`);
    db.run('CREATE TABLE bairros (bairro_id INTEGER, localidade_id INTEGER, uf TEXT, nome TEXT, nome_abreviado TEXT)');
    db.run('INSERT INTO bairros VALUES (1, 1, \'SP\', \'Centro\', NULL)');
    db.run('CREATE TABLE bairro_faixas (bairro_id INTEGER, cep_inicial TEXT, cep_final TEXT)');
    for (const row of rows) {
      db.run('INSERT INTO dne VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', Object.values(row));
    }
    alter?.(db);
  } finally {
    db.close();
  }
  return path;
}

test('exports a database without optional metadata', async () => {
  const path = createDatabase();
  expect(await buildBinaryDatabase(path, `${path}.bin`)).toBe(1);
  const reader = new DneBinaryDatabaseReader(`${path}.bin`);
  try {
    expect(reader.metadata()).toEqual({});
    expect(reader.queryCep('01001000')).toMatchObject({ cep: '01001000', bairro: 'Centro', municipio: 'São Paulo' });
  } finally {
    reader.close();
  }
});

test.each(
  [
    [[], 'without rows'],
    [[validRow, validRow], 'unique and ordered'],
    [[{ ...validRow, cep: 'invalid' }], 'Invalid CEP'],
    [[{ ...validRow, localidade_tipo: 'Z' }], 'Invalid locality indicators'],
    [[{ ...validRow, localidade_situacao: 4 }], 'Invalid locality indicators'],
    [[{ ...validRow, bairro_id: 404 }], 'Unknown bairro_id'],
    [[{ ...validRow, bairro_id: null, localidade_nome: 'District' }], 'Invalid subordinate locality name'],
    [[{ ...validRow, localidade_tipo: 'D', localidade_nome: 'District' }], 'Invalid subordinate locality name'],
    [[validRow, { ...validRow, cep: '01001001', municipio: 'Another city' }], 'multiple municipalities'],
    [[{ ...validRow, logradouro: 'á'.repeat(128) }], 'exceeds 255 UTF-8 bytes'],
  ] satisfies [Row[], string][],
)('rejects invalid address rows: %j (%s)', async (rows, message) => {
  const path = createDatabase(rows);
  expect(await captureRejection(buildBinaryDatabase(path, `${path}.bin`))).toMatchObject({ message: expect.stringContaining(message) });
  expect(existsSync(`${path}.bin`)).toBe(false);
});

test.each([
  ['UPDATE bairros SET bairro_id = -1', 'Invalid neighborhood'],
  ['INSERT INTO bairro_faixas VALUES (404, \'01001000\', \'01001001\')', 'Unknown neighborhood in CEP range'],
  ['INSERT INTO bairro_faixas VALUES (1, \'01001001\', \'01001000\')', 'Reversed neighborhood CEP range'],
  ['INSERT INTO bairro_faixas VALUES (1, \'01001000\', \'01001001\'), (1, \'01001000\', \'01001001\')', 'Duplicate neighborhood CEP range'],
])('rejects invalid neighborhood data: %s', async (sql, message) => {
  const path = createDatabase([validRow], (db) => {
    db.run(sql);
  });
  expect(await captureRejection(buildBinaryDatabase(path, `${path}.bin`))).toMatchObject({ message: expect.stringContaining(message) });
  expect(existsSync(`${path}.bin`)).toBe(false);
});

test('rejects row counts that exceed the format capacity before allocating columns', async () => {
  const path = createDatabase();
  const query = Object.getOwnPropertyDescriptor(Database.prototype, 'query')?.value as Database['query'];
  spyOn(Database.prototype, 'query').mockImplementation(
    function(this: Database, sql: string) {
      const statement = query.call(this, sql);
      if (sql.startsWith('SELECT count(*)')) {
        spyOn(statement, 'get').mockReturnValue({ count: 0x1_0000_0000 });
      }
      return statement;
    } as Database['query'],
  );
  expect(await captureRejection(buildBinaryDatabase(path, `${path}.bin`))).toMatchObject({
    message: expect.stringContaining('row count exceeds the uint32 limit'),
  });
});

test.each(
  [
    [[{ ...validRow, logradouro: 'new value' }], 'Missing binary string dictionary value'],
    [[{ ...validRow, municipio_cod_ibge: 9999999 }], 'Missing municipality for IBGE code'],
    [[], 'row count changed'],
    [[{ ...validRow, complemento: null }], 'nullable field counts changed'],
  ] satisfies [Row[], string][],
)('detects inconsistent snapshots between export passes: %s (%s)', async (rows, message) => {
  const path = createDatabase([{ ...validRow, complemento: 'apartment' }]);
  const query = Object.getOwnPropertyDescriptor(Database.prototype, 'query')?.value as Database['query'];
  let rowPass = 0;
  spyOn(Database.prototype, 'query').mockImplementation(
    function(this: Database, sql: string) {
      const statement = query.call(this, sql);
      if (sql.includes('SELECT cep, logradouro') && ++rowPass === 2) {
        spyOn(statement, 'iterate').mockImplementation(function*() {
          yield* rows;
        });
      }
      return statement;
    } as Database['query'],
  );
  expect(await captureRejection(buildBinaryDatabase(path, `${path}.bin`))).toMatchObject({ message: expect.stringContaining(message) });
  expect(existsSync(`${path}.bin`)).toBe(false);
});

test('rejects an unsupported host byte order before opening the source', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Uint16Array.prototype, 'buffer');
  Object.defineProperty(Uint16Array.prototype, 'buffer', {
    configurable: true,
    get: () => new Uint8Array([0, 1]).buffer,
  });
  try {
    expect(await captureRejection(buildBinaryDatabase('unused.db', 'unused.bin'))).toMatchObject({
      message: expect.stringContaining('little-endian platform'),
    });
  } finally {
    if (descriptor) {
      Object.defineProperty(Uint16Array.prototype, 'buffer', descriptor);
    } else {
      Reflect.deleteProperty(Uint16Array.prototype, 'buffer');
    }
  }
});
