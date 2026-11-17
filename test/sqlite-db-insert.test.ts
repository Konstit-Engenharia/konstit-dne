import { Database } from 'bun:sqlite';
import {
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  buildSchema,
  getUnifiedTable,
} from '../src/schema.ts';
import { BatchedUnifiedInsert } from '../src/sqlite-db-insert.ts';
import { createTableSql } from '../src/sqlite-db-schema.ts';

test('flushes complete and partial batches, reuses statements, and finalizes safely', () => {
  using db = new Database(':memory:');
  db.run(createTableSql(getUnifiedTable(buildSchema({ cep_unificado: 'dne' }))));
  const prepare = spyOn(db, 'prepare');
  const insert = new BatchedUnifiedInsert(db, 'dne', 2);
  try {
    insert.flush();
    expect(prepare).not.toHaveBeenCalled();
    for (let index = 1; index <= 5; index++) {
      insert.run(`0100100${index}`, null, null, null, null, 'São Paulo', 3550308, 'SP', null, 1, 'M');
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(db.query('SELECT count(*) AS count FROM dne').get()).toEqual({ count: 4 });
    insert.flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    insert.flush();
    expect(db.query('SELECT cep FROM dne ORDER BY cep').values()).toEqual([
      ['01001001'],
      ['01001002'],
      ['01001003'],
      ['01001004'],
      ['01001005'],
    ]);
  } finally {
    insert.finalize();
    insert.finalize();
    prepare.mockRestore();
  }
});
