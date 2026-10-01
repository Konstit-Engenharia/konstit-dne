import { Database } from 'bun:sqlite';

const [sourcePath, outputPath,] = Bun.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error('Usage: bun bench/prepare-profile-queries.ts <source.db> <queries.json>');
}
const db = new Database(sourcePath, { readonly: true });
try {
  const count = (db.query('SELECT count(*) AS count FROM dne').get() as { count: number; }).count;
  if (count < 100_000) {
    throw new Error('This profiling fixture requires at least 100000 rows');
  }
  const hits: string[] = [];
  let checked = 0;
  for (const row of db.query('SELECT cep FROM dne ORDER BY cep').iterate() as Iterable<{ cep: string; }>) {
    if (checked >= Math.floor(hits.length * count / 100_000) && hits.length < 100_000) {
      hits.push(row.cep);
    }
    checked++;
  }
  let state = 0x9e37_79b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const exists = db.query('SELECT 1 FROM dne WHERE cep = ?');
  const misses: string[] = [];
  while (misses.length < hits.length) {
    const cep = String(random() % 100_000_000).padStart(8, '0');
    if (!exists.get(cep)) {
      misses.push(cep);
    }
  }
  const mixed = hits.slice(0, 50_000).concat(misses.slice(0, 50_000));
  for (const queries of [hits, misses, mixed]) {
    for (let index = queries.length - 1; index > 0; index--) {
      const other = random() % (index + 1);
      const value = queries[index] ?? '';
      queries[index] = queries[other] ?? '';
      queries[other] = value;
    }
  }
  await Bun.write(outputPath, JSON.stringify({ sourceRows: count, hits, misses, mixed }));
} finally {
  db.close();
}
