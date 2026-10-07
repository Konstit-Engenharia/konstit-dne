import { Database } from 'bun:sqlite';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addressTokens,
  createAddressRanker,
} from '../src/address-search-text.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import {
  buildAddressSearchIndex,
  DneAddressSearch,
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseReader,
  type DneRow,
  type UF,
} from '../src/library.ts';
import { buildSchema } from '../src/schema.ts';
import { prepareDatabaseForLoad } from '../src/sqlite-db-schema.ts';

const directory = mkdtempSync(join(tmpdir(), 'dne-search-'));
const binaryPath = join(directory, 'dne.bin');
let database: DneBinaryDatabaseReader;
let search: DneAddressSearch;
let bytes: Uint8Array;

beforeAll(async () => {
  const path = join(directory, 'dne.db');
  const db = new Database(path);
  prepareDatabaseForLoad(db, buildSchema({ cep_unificado: 'dne' }));
  const insert = db.prepare(`INSERT INTO dne
    (cep, logradouro, complemento, municipio, municipio_cod_ibge, uf, nome, localidade_situacao, localidade_tipo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'M')`);
  const rows: [string, string | null, string | null, string, number, string, string | null][] = [
    ['01001000', 'Rua Rubens Meireles', 'lado par', 'São Paulo', 3550308, 'SP', null],
    ['01001001', 'Rua Rubens Meireles', 'lado ímpar', 'São Paulo', 3550308, 'SP', null],
    ['01141000', 'Avenida Paulista', null, 'São Paulo', 3550308, 'SP', null],
    ['01142000', 'Rua 25 de Março', null, 'São Paulo', 3550308, 'SP', null],
    ['01143000', 'Rua Doutor João', null, 'São Paulo', 3550308, 'SP', null],
    ['01144000', 'Rua Meireles Rubens', null, 'São Paulo', 3550308, 'SP', null],
    ['01145000', 'Rubens', null, 'São Paulo', 3550308, 'SP', null],
    ['01146000', null, null, 'São Paulo', 3550308, 'SP', 'Agência Central'],
    ['01147000', 'Rua Pauli Paulino', null, 'São Paulo', 3550308, 'SP', null],
    ['13010000', 'Rua Rubens Meireles', null, 'Campinas', 3509502, 'SP', null],
    ['20040002', 'Rua Rubens Meireles', null, 'Rio de Janeiro', 3304557, 'RJ', null],
    ['40010000', 'Avenida Rubens Meireles', null, 'Salvador', 2927408, 'BA', null],
  ];
  for (const row of rows) {
    insert.run(...row);
  }
  db.run('INSERT INTO bairros VALUES (1, 1, \'SP\', \'Sé\', \'SE\')');
  db.run('UPDATE dne SET bairro_id = 1 WHERE cep = \'01142000\'');
  // Exercise delta encoding across large gaps and prefix unions with many distinct terms.
  for (let id = 0; id < 300; id++) {
    insert.run(String(50000000 + id), `Rua Teste ${id}`, null, 'Recife', 2611606, 'PE', null);
  }
  insert.run('99999999', 'Rua Última Rubens', null, 'Recife', 2611606, 'PE', null);
  db.close();
  await buildBinaryDatabase(path, binaryPath);
  database = new DneBinaryDatabaseReader(binaryPath);
  bytes = buildAddressSearchIndex(database);
  search = new DneAddressSearch(database, bytes);
});

afterAll(() => {
  search?.close();
  database?.close();
  rmSync(directory, { recursive: true, force: true });
});

function ceps(rows: DneRow[]): string[] {
  return rows.map((row) => row.cep);
}

describe('address autocomplete', () => {
  test('normalizes accents, case, abbreviations, punctuation and decomposed Unicode', () => {
    expect(ceps(search.searchAddresses('R. 25 de MARÇ'))).toEqual(['01142000']);
    expect(ceps(search.searchAddresses('av. pauli'))).toEqual(['01141000']);
    expect(ceps(search.searchAddresses('r dr joa\u0303'))).toEqual(['01143000']);
    expect(ceps(search.searchAddresses('  r   rubens, mei '))).toContain('01001000');
    expect(ceps(search.searchAddresses('25 de marco se'))).toEqual(['01142000']);
    expect(ceps(search.searchAddresses('agencia cen'))).toEqual(['01146000']);
    expect(addressTokens('Rod. BR-101')).toEqual(['rodovia', 'br', '101']);
  });

  test('matches complete words plus the final prefix across address fields', () => {
    expect(ceps(search.searchAddresses('rubens mei', { municipioCodIbge: 3550308 })))
      .toEqual(['01001000', '01001001', '01144000']);
    expect(search.searchAddresses('rub mei')).toEqual([]);
    expect(ceps(search.searchAddresses('campinas rubens mei'))).toEqual(['13010000']);
    expect(ceps(search.searchAddresses('pauli'))).toEqual(['01147000', '01141000']);
  });

  test('filters by UF, municipality, and their intersection', () => {
    expect(ceps(search.searchAddresses('rubens mei', { uf: 'RJ' }))).toEqual(['20040002']);
    expect(ceps(search.searchAddresses('rubens mei', { uf: 'SP', municipioCodIbge: 3509502 }))).toEqual(['13010000']);
    expect(search.searchAddresses('rubens mei', { uf: 'RJ', municipioCodIbge: 3509502 })).toEqual([]);
    expect(search.searchAddresses('rubens mei', { uf: 'AC' })).toEqual([]);
    expect(search.searchAddresses('rubens mei', { uf: 'XX' as UF })).toEqual([]);
    expect(search.searchAddresses('rubens mei', { municipioCodIbge: NaN })).toEqual([]);
    expect(search.searchAddresses('rubens mei', { municipioCodIbge: 3550309 })).toEqual([]);
    expect(ceps(search.searchAddresses('rubens mei', { uf: ' sp ' as UF })))
      .toEqual(['01001000', '01001001', '13010000', '01144000']);
  });

  test('infers municipality from a complete CEP anywhere in the query', () => {
    for (const query of ['rubens mei 01141-000', '01141000 rubens mei', 'rubens CEP: 01141-000 mei', '(CEP 01141-000), rubens mei']) {
      expect(ceps(search.searchAddresses(query))).toEqual(['01001000', '01001001', '01144000']);
    }
    expect(ceps(search.searchAddresses('rubens mei 01141000', { uf: 'SP', municipioCodIbge: 3550308 })))
      .toEqual(['01001000', '01001001', '01144000']);
    expect(search.searchAddresses('rubens mei 01141000', { uf: 'RJ' })).toEqual([]);
    expect(search.searchAddresses('rubens mei 01141000', { municipioCodIbge: 3509502 })).toEqual([]);
    expect(search.searchAddresses('rubens mei 01141001')).toEqual([]);
    expect(search.searchAddresses('rubens mei 011410001')).toEqual([]);
    expect(search.searchAddresses('rubens mei x01141000')).toEqual([]);
  });

  test('resolves CEP-only queries exactly and requires multiple CEPs to agree on municipality', () => {
    expect(ceps(search.searchAddresses('CEP: 01141-000'))).toEqual(['01141000']);
    expect(ceps(search.searchAddresses('01141000 01141-000'))).toEqual(['01141000']);
    expect(ceps(search.searchAddresses('01141000 01001000'))).toEqual(['01001000', '01141000']);
    expect(ceps(search.searchAddresses('01141000 01001000', { limit: 1 }))).toEqual(['01001000']);
    expect(search.searchAddresses('01141000 20040002')).toEqual([]);
    expect(search.searchAddresses('01141000', { uf: 'RJ' })).toEqual([]);
    expect(search.searchAddresses('01141')).toEqual([]);
  });

  test('ranks exact names and phrases before unordered matches, keeping individual CEPs', () => {
    const rows = search.searchAddresses('rubens', { uf: 'SP', limit: 2 });
    expect(ceps(rows)).toEqual(['01145000', '01001000']);
    expect(ceps(search.searchAddresses('meireles rubens', { municipioCodIbge: 3550308, limit: 1 }))).toEqual(['01144000']);
    const pairs = search.searchAddresses('rua rubens mei', { municipioCodIbge: 3550308 });
    expect(pairs.slice(0, 2).map((row) => row.complemento)).toEqual(['lado par', 'lado ímpar']);
    const rank = createAddressRanker(['rubens', 'meireles']);
    expect(rank(['Rubens Meireles', null, null, 'São Paulo']))
      .toBeGreaterThan(rank(['Meireles Rubens', null, null, 'São Paulo']));
    expect(ceps(search.searchAddresses('ultima'))).toEqual(['99999999']);
    const rankPaulista = createAddressRanker(['paulista']);
    expect(rankPaulista(['Avenida Paulista', null, null, 'São Paulo']))
      .toBeGreaterThan(rankPaulista(['Rua Federação Paulista', null, 'Paulista', 'São Paulo']));
  });

  test('bounds output and handles empty, unknown, and uninformative queries', () => {
    for (const text of ['', ' ', '---', 'rua', 'avenida', 'de da do', 'zzzzzzzzzz', 'rubens zzz']) {
      expect(search.searchAddresses(text)).toEqual([]);
    }
    expect(search.searchAddresses('teste')).toHaveLength(10);
    expect(search.searchAddresses('teste', { limit: 50 })).toHaveLength(50);
    for (const limit of [0, -1, 51, 1.5, NaN, Infinity]) {
      expect(() => search.searchAddresses('teste', { limit })).toThrow(RangeError);
    }
    expect(() => search.searchAddresses('x'.repeat(257))).toThrow(RangeError);
  });

  test('matches a scan oracle on combinations of words, filters, and prefixes', () => {
    const rows = [...database.entries()];
    for (const text of ['rubens mei', 'pauli', 'teste 29', 'sao paulo', 'rio rubens', 'joao', '25 de mar', 'meireles rub']) {
      const tokens = addressTokens(text);
      for (const uf of [undefined, 'SP', 'RJ', 'BA'] as const) {
        const expected = rows.filter((row) => {
          const words = [row.logradouro, row.bairro, row.municipio, row.nome].flatMap((field) => addressTokens(field ?? ''));
          return (uf === undefined || row.uf === uf)
            && tokens.every((token, id) => words.some((word) => id === tokens.length - 1 ? word.startsWith(token) : word === token));
        }).sort((a, b) => a.cep.localeCompare(b.cep));
        const actual = search.searchAddresses(text, { uf, limit: 50 }).sort((a, b) => a.cep.localeCompare(b.cep));
        expect(actual).toEqual(expected);
      }
    }
  });

  test('owns its index bytes and releases search independently of the database', () => {
    const source = bytes.slice();
    const own = new DneAddressSearch(database, source);
    source.fill(0);
    expect(own.searchAddresses('rubens')).not.toBeEmpty();
    own.close();
    own.close();
    expect(() => own.searchAddresses('')).toThrow('Address search is closed');
    expect(database.queryCep('01141000')).toBeDefined();
    const reader = new DneBinaryDatabaseReader(binaryPath);
    const dependent = new DneAddressSearch(reader, bytes);
    const iterator = reader.entries();
    const endIterator = reader.entries();
    for (let id = 0; id < reader.rowCount(); id++) {
      endIterator.next();
    }
    expect(iterator.next().value).toEqual(reader.queryCep('01001000'));
    reader.close();
    expect(() => iterator.next()).toThrow(DneBinaryDatabaseClosedError);
    expect(() => endIterator.next()).toThrow(DneBinaryDatabaseClosedError);
    expect(() => reader.entries().next()).toThrow(DneBinaryDatabaseClosedError);
    expect(() => dependent.searchAddresses('')).toThrow(DneBinaryDatabaseClosedError);
    expect(() => buildAddressSearchIndex(reader)).toThrow(DneBinaryDatabaseClosedError);
    dependent.close();
  });

  test('generates reproducible index bytes through the build command', async () => {
    const indexPath = join(directory, 'dne.search.bin');
    const result = Bun.spawnSync(['bun', 'run', 'scripts/build-search-index.ts', binaryPath, indexPath]);
    expect(result.exitCode).toBe(0);
    expect(bytes).toEqual(new Uint8Array(await Bun.file(indexPath).arrayBuffer()));
    const rejected = Bun.spawnSync(['bun', 'run', 'scripts/build-search-index.ts', binaryPath, binaryPath]);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain('must differ');
    const reopened = new DneBinaryDatabaseReader(binaryPath);
    expect(reopened.checksum()).toBe(database.checksum());
    reopened.close();
  });
});

function corrupt(change: (data: DataView, bytes: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice();
  change(new DataView(copy.buffer), copy);
  copy.set(createHash('sha256').update(copy.subarray(0, -32)).digest(), copy.length - 32);
  return copy;
}

describe('search index validation', () => {
  test('rejects truncation, bad magic, unsupported version, and corruption', () => {
    expect(() => new DneAddressSearch(database, bytes.slice(0, 50))).toThrow('header');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((_data, copy) => {
          copy[0] = 0;
        }),
      )
    ).toThrow('header');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(8, 2, true)))).toThrow('version');
    const broken = bytes.slice();
    broken[broken.length - 1] = (broken[broken.length - 1] as number) ^ 1;
    expect(() => new DneAddressSearch(database, broken)).toThrow('checksum');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(12, 1, true)))).toThrow('different database');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((_data, copy) => {
          copy[32] = (copy[32] as number) ^ 1;
        }),
      )
    )
      .toThrow('different database');
  });

  test('rejects invalid sizes, CEP ordering and vocabulary', () => {
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(16, 0xffffffff, true)))).toThrow('size');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(28, 1, true)))).toThrow('size');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(64, 100000000, true)))).toThrow('CEP');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(68, data.getUint32(64, true), true)))).toThrow('CEP');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((data, copy) => {
          const lexiconOffset = 64 + data.getUint32(12, true) * 4 + (data.getUint32(20, true) + 1) * 4;
          copy[lexiconOffset + 2] = 126;
        }),
      )
    ).toThrow('vocabulary');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((data, copy) => {
          const lexiconOffset = 64 + data.getUint32(12, true) * 4 + (data.getUint32(20, true) + 1) * 4;
          copy[lexiconOffset] = 33;
        }),
      )
    ).toThrow();
  });

  test('rejects inconsistent posting offsets, truncated varints, and invalid row IDs', () => {
    const offsets = 64 + database.rowCount() * 4;
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(offsets, 1, true)))).toThrow('offsets');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(offsets + 4, 0, true)))).toThrow('range');
    expect(() => new DneAddressSearch(database, corrupt((data) => data.setUint32(offsets + 4, 0xffffffff, true)))).toThrow('range');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((data, copy) => {
          const postingsOffset = 64 + database.rowCount() * 4 + (data.getUint32(20, true) + 1) * 4 + data.getUint32(16, true);
          copy[postingsOffset] = 0;
        }),
      )
    ).toThrow('row');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((data, copy) => {
          const postingsOffset = 64 + database.rowCount() * 4 + (data.getUint32(20, true) + 1) * 4 + data.getUint32(16, true);
          const end = data.getUint32(offsets + 4, true);
          copy.fill(255, postingsOffset, postingsOffset + end);
        }),
      )
    ).toThrow('encoding');
    expect(() =>
      new DneAddressSearch(
        database,
        corrupt((data, copy) => {
          const postingsOffset = 64 + database.rowCount() * 4 + (data.getUint32(20, true) + 1) * 4 + data.getUint32(16, true);
          copy[postingsOffset] = 255;
          copy[postingsOffset + 1] = 127;
        }),
      )
    ).toThrow('row');
  });
});
