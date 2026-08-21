import { Database } from 'bun:sqlite';

const [leftPath, rightPath,] = Bun.argv.slice(2);

if (!leftPath || !rightPath) {
  console.error('Usage: bun run scripts/compare-sqlite.ts <left.db> <right.db>');
  process.exit(1);
}

const db = new Database(leftPath, { readonly: true });

try {
  db.run(`ATTACH DATABASE ${quoteLiteral(rightPath)} AS right_db`);

  const leftTables = comparableTables(getTables('main'));
  const rightTables = comparableTables(getTables('right_db'));
  assertEqual(leftTables, rightTables, 'table list');

  for (const table of leftTables) {
    const leftColumns = getColumns('main', table);
    const rightColumns = getColumns('right_db', table);
    assertEqual(leftColumns, rightColumns, `${table} columns`);

    const leftCount = countRows('main', table);
    const rightCount = countRows('right_db', table);
    assertEqual(leftCount, rightCount, `${table} row count`);

    const leftMinusRight = exceptCount('main', 'right_db', table);
    const rightMinusLeft = exceptCount('right_db', 'main', table);
    assertEqual(leftMinusRight, 0, `${table} left-minus-right rows`);
    assertEqual(rightMinusLeft, 0, `${table} right-minus-left rows`);
  }

  console.log(`SQLite databases are logically equal: ${leftPath} == ${rightPath}`);
} finally {
  db.close();
}

function getTables(schema: string) {
  return (
    db
      .query(
        `SELECT name FROM ${
          quoteIdent(
            schema,
          )
        }.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string; }[]
  ).map((row) => row.name);
}

function comparableTables(tables: string[]) {
  return tables.filter((table) => table !== 'edne_metadata');
}

function getColumns(schema: string, table: string) {
  return (
    db.query(`PRAGMA ${quoteIdent(schema)}.table_info(${quoteIdent(table)})`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function countRows(schema: string, table: string) {
  return (
    db.query(`SELECT count(*) AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)}`).get() as {
      count: number;
    }
  ).count;
}

function exceptCount(leftSchema: string, rightSchema: string, table: string) {
  return (
    db
      .query(`
        SELECT count(*) AS count
        FROM (
          SELECT * FROM ${quoteIdent(leftSchema)}.${quoteIdent(table)}
          EXCEPT
          SELECT * FROM ${quoteIdent(rightSchema)}.${quoteIdent(table)}
        )
      `)
      .get() as { count: number; }
  ).count;
}

function assertEqual(leftValue: unknown, rightValue: unknown, label: string) {
  const leftJson = JSON.stringify(leftValue);
  const rightJson = JSON.stringify(rightValue);
  if (leftJson !== rightJson) {
    console.error(`Mismatch in ${label}`);
    console.error(`left:  ${leftJson.slice(0, 1000)}`);
    console.error(`right: ${rightJson.slice(0, 1000)}`);
    process.exit(1);
  }
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll('\'', '\'\'')}'`;
}
