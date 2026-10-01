import { Database } from 'bun:sqlite';
import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINARY_SECTION_NAMES,
  SECTION_TABLE_OFFSET,
} from '../src/binary-db-format.ts';
import {
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseReader,
} from '../src/binary-db-reader.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import {
  DneDatabaseReader,
  DneDatabaseWriter,
  DneSourceQualityError,
} from '../src/db.ts';
import { DirectoryDneSource } from '../src/dne-source.ts';
import { buildSchema } from '../src/schema.ts';
import {
  createLocalityFixture,
  fetchDatabase,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'dne-bairros-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('normalized neighborhoods', () => {
  test('preserves identities, unused neighborhoods, disjoint ranges, and locality names in both readers', async () => {
    const { source, sqlite, binary } = fixture('identities');
    appendFileSync(join(source, 'LOG_BAIRRO.TXT'), '\n999@SP@1@Centro@Centro sem CEP', 'latin1');
    fetchDatabase(sqlite, source);
    await buildBinaryDatabase(sqlite, binary);
    const readers = [new DneDatabaseReader(sqlite), new DneBinaryDatabaseReader(binary)];
    for (const reader of readers) {
      try {
        expect(reader.queryNeighborhood(11)).toEqual({ bairro_id: 11, localidade_id: 1, uf: 'SP', nome: 'Centro', nome_abreviado: 'Ctr' });
        expect(reader.queryNeighborhood(12)).toMatchObject({ bairro_id: 12, localidade_id: 2, nome: 'Centro', nome_abreviado: null });
        expect(reader.queryNeighborhood(999)).toMatchObject({ bairro_id: 999, localidade_id: 1, nome: 'Centro' });
        expect(reader.queryNeighborhoodCepRanges(999)).toEqual([]);
        expect(reader.queryNeighborhoodByCep('21000-000')).toEqual(reader.queryNeighborhood(11));
        expect(reader.queryNeighborhoodByCep('24000000')).toEqual(reader.queryNeighborhood(14));
        expect(reader.queryNeighborhoodByCep('25000000')).toEqual(reader.queryNeighborhood(15));
        expect(reader.queryNeighborhoodCepRanges(11)).toEqual([
          { cep_inicial: '01000000', cep_final: '01000010' },
          { cep_inicial: '21000000', cep_final: '21000000' },
        ]);
        for (const [cep, name,] of [['11000000', 'Distrito Unico'], ['14000000', 'Povoado em Codificacao']] as const) {
          expect(reader.queryNeighborhoodByCep(cep)).toBeUndefined();
          expect(reader.queryCep(cep)?.bairro).toBe(name);
        }
        for (const id of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000, 13]) {
          expect(reader.queryNeighborhood(id)).toBeUndefined();
          expect(reader.queryNeighborhoodCepRanges(id)).toEqual([]);
        }
        for (const cep of ['invalid', '99999999', '10000000', '41000000']) {
          expect(reader.queryNeighborhoodByCep(cep)).toBeUndefined();
        }
      } finally {
        reader.close();
      }
    }
    const db = new Database(sqlite);
    try {
      db.run('PRAGMA foreign_keys = ON');
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.query('SELECT bairro_id, localidade_nome FROM dne WHERE cep = ?').get('11000000')).toEqual({
        bairro_id: null,
        localidade_nome: 'Distrito Unico',
      });
      expect(() => db.run('UPDATE dne SET bairro_id = 123456 WHERE cep = ?', ['21000000'])).toThrow();
      expect(() => db.run('UPDATE dne SET localidade_nome = ? WHERE cep = ?', ['Invalid', '21000000'])).toThrow();
    } finally {
      db.close();
    }
  });

  test.each([
    ['999@01000000@01000010', 'missing_bairro'],
    ['11@0100000X@01000010', 'invalid_cep_range'],
    ['11@01000011@01000010', 'reversed_cep_range'],
    ['11@01000000@01000010', 'duplicate_cep_range'],
  ])('rejects range %s and rolls back all tables and metadata', async (row, reason) => {
    const { source, sqlite } = fixture(reason);
    const writer = new DneDatabaseWriter(sqlite, buildSchema({ cep_unificado: 'dne' }));
    try {
      await writer.loadFromSource(new DirectoryDneSource(source), { marker: 'original' });
      appendFileSync(join(source, 'LOG_FAIXA_BAIRRO.TXT'), `\n${row}`, 'latin1');
      const bairrosPath = join(source, 'LOG_BAIRRO.TXT');
      writeFileSync(bairrosPath, readFileSync(bairrosPath, 'latin1').replace('Centro@Ctr', 'Changed@New'), 'latin1');
      const error = await writer.loadFromSource(new DirectoryDneSource(source), { marker: 'replacement' }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DneSourceQualityError);
      expect(String(error)).toContain(reason);
    } finally {
      writer.close();
    }
    const reader = new DneDatabaseReader(sqlite);
    try {
      expect(reader.queryNeighborhood(11)?.nome).toBe('Centro');
      expect(reader.queryNeighborhoodCepRanges(11)).toHaveLength(2);
      expect(reader.queryCep('21000000')?.bairro).toBe('Centro');
      expect(reader.metadata()?.['marker']).toBe('original');
    } finally {
      reader.close();
    }
  });

  test('publishes neighborhoods, ranges, and the view to an already open SQLite reader', () => {
    const { source, sqlite } = fixture('update');
    fetchDatabase(sqlite, source);
    const reader = new DneDatabaseReader(sqlite);
    try {
      expect(reader.queryNeighborhood(11)?.nome).toBe('Centro');
      const bairrosPath = join(source, 'LOG_BAIRRO.TXT');
      writeFileSync(bairrosPath, readFileSync(bairrosPath, 'latin1').replace('Centro@Ctr', 'Changed@New'), 'latin1');
      appendFileSync(join(source, 'LOG_FAIXA_BAIRRO.TXT'), '\n11@02000000@02000010', 'latin1');
      fetchDatabase(sqlite, source);
      expect(reader.queryNeighborhood(11)?.nome).toBe('Changed');
      expect(reader.queryCep('21000000')?.bairro).toBe('Changed');
      expect(reader.queryNeighborhoodCepRanges(11)).toHaveLength(3);
    } finally {
      reader.close();
    }
  });

  test('recognizes a schema migration while the SQLite reader stays open', () => {
    const { source, sqlite } = fixture('migration');
    const db = new Database(sqlite);
    db.run('CREATE TABLE dne (cep TEXT PRIMARY KEY, bairro TEXT)');
    db.close();
    const reader = new DneDatabaseReader(sqlite);
    try {
      expect(() => reader.queryCep('21000000')).toThrow('build --force');
      fetchDatabase(sqlite, source);
      expect(reader.queryCep('21000000')?.bairro).toBe('Centro');
      expect(reader.queryNeighborhoodByCep('21000000')?.bairro_id).toBe(11);
      expect(reader.queryNeighborhoodCepRanges(11)).toHaveLength(2);
    } finally {
      reader.close();
    }
  });

  test('uses three-byte neighborhood indexes in compressed runs without confusing them with name IDs', async () => {
    const { source, sqlite, binary } = fixture('wide');
    fetchDatabase(sqlite, source);
    const db = new Database(sqlite);
    try {
      const insert = db.prepare('INSERT INTO bairros VALUES (?, 1, ?, ?, NULL)');
      db.transaction(() => {
        for (let id = 100; id < 65_630; id++) {
          insert.run(id, 'SP', 'Centro');
        }
        db.run('UPDATE dne SET bairro_id = 65629 WHERE cep = ?', ['21000000']);
      })();
      insert.finalize();
    } finally {
      db.close();
    }
    await buildBinaryDatabase(sqlite, binary);
    const reader = new DneBinaryDatabaseReader(binary);
    try {
      expect(reader.queryNeighborhoodByCep('21000000')?.bairro_id).toBe(65_629);
      expect(reader.queryCep('21000000')?.bairro).toBe('Centro');
      expect(reader.queryNeighborhood(65_629)?.nome_abreviado).toBeNull();
    } finally {
      reader.close();
    }
  });

  test('supports a database with locality CEPs and no neighborhoods or ranges', async () => {
    const { source, sqlite, binary } = fixture('empty');
    for (const name of ['LOG_BAIRRO.TXT', 'LOG_FAIXA_BAIRRO.TXT', 'LOG_LOGRADOURO_SP.TXT', 'LOG_GRANDE_USUARIO.TXT', 'LOG_UNID_OPER.TXT']) {
      writeFileSync(join(source, name), '');
    }
    fetchDatabase(sqlite, source);
    await buildBinaryDatabase(sqlite, binary);
    const reader = new DneBinaryDatabaseReader(binary);
    try {
      expect(reader.queryNeighborhood(11)).toBeUndefined();
      expect(reader.queryNeighborhoodCepRanges(11)).toEqual([]);
      expect(reader.queryCep('11000000')?.bairro).toBe('Distrito Unico');
    } finally {
      reader.close();
    }
  });

  test('types corrupt neighborhood records and ranges and rejects queries after close', async () => {
    const { source, sqlite, binary } = fixture('corruption');
    fetchDatabase(sqlite, source);
    await buildBinaryDatabase(sqlite, binary);
    const original = new Uint8Array(await Bun.file(binary).arrayBuffer());
    const header = new DataView(original.buffer);
    const section = (name: typeof BINARY_SECTION_NAMES[number]) =>
      header.getUint32(SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf(name) * 8, true);
    for (
      const [name, offset, value,] of [
        ['id', section('bairros') + 16, 0],
        ['width', section('bairros') + 4, 0],
        ['count', section('bairros'), 255],
        ['first-range', section('bairroFaixaOffsets'), 1],
        ['range-offset', section('bairroFaixaOffsets') + 4, 255],
        ['reversed-range', section('bairroFaixas'), 255],
      ] as const
    ) {
      const bytes = original.slice();
      bytes[offset] = value;
      const path = join(workDir, `${name}.bin`);
      await Bun.write(path, bytes);
      expect(() => new DneBinaryDatabaseReader(path)).toThrow(DneBinaryDatabaseFormatError);
    }
    const reader = new DneBinaryDatabaseReader(binary);
    reader.close();
    for (
      const query of [
        () => reader.queryNeighborhood(11),
        () => reader.queryNeighborhood(NaN),
        () => reader.queryNeighborhoodByCep('invalid'),
        () => reader.queryNeighborhoodCepRanges(11),
      ]
    ) {
      expect(query).toThrow(DneBinaryDatabaseClosedError);
    }
  });
});

function fixture(name: string) {
  const directory = join(workDir, name);
  createLocalityFixture(directory);
  return { source: join(directory, 'Delimitado'), sqlite: `${directory}.db`, binary: `${directory}.bin` };
}
