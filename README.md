# e-DNE Correios CLI

Build and query a local SQLite database with Brazilian postal code data from Correios e-DNE.

The loader reads a directory, a local ZIP file, or the current public e-DNE archive. It streams the source into one indexed `dne` table without intermediate raw tables.

In a 10-run benchmark on 2026-08-30, full generation from the public archive averaged 5.73 seconds, including the download. The final database contained 1,605,136 rows and used 125.4 MiB without `VACUUM`.

For comparison, `uvx edne-correios-loader load --database-url sqlite:///dne.db` averaged 30 seconds and produced a 394 MiB database without `VACUUM`. `@konstit/dne` was 5.2 times faster and used 68.2% less disk. After a manual `VACUUM`, the other database used 148.2 MiB, which was still 15.4% larger than this CLI's database.

This package exposes a CLI only. It has no public library API.

## Requirements

- Bun 1.4 or newer
- macOS or Linux

The CLI does not need authentication.

## Quick start

```sh
bunx @konstit/dne fetch --db ./dne.db
bunx @konstit/dne lookup 01001-000 --db ./dne.db
```

## Run

Run the CLI without a global installation:

```sh
bunx @konstit/dne --version
bunx @konstit/dne --json doctor --offline
```

`--db` is global. It works before or after a subcommand. The database path uses this precedence:

1. `--db PATH`
2. `DNE_DB`
3. `./dne.db`

The old forms remain valid:

```sh
bunx @konstit/dne fetch ./dne.db
bunx @konstit/dne lookup ./dne.db 01001000
```

## Fetch and update

```sh
bunx @konstit/dne fetch --db ./dne.db
bunx @konstit/dne fetch --db ./dne.db --source ./eDNE_Basico.zip
bunx @konstit/dne fetch --db ./dne.db --source ./Delimitado
bunx @konstit/dne fetch --db ./dne.db --source https://example.com/eDNE_Basico.zip
bunx @konstit/dne fetch --db ./dne.db --force
bunx @konstit/dne fetch --db ./dne.db --check --json
```

`fetch` writes progress to stderr. Its final result goes to stdout. Add `--quiet` to hide progress. Add `--json` to get the database path, row count, byte size, source metadata, elapsed time, and update status.

Remote builds store `Last-Modified`, ETag, content length, source URL, and load time in `edne_metadata`. A later fetch skips the rebuild when the source is unchanged. `--check` checks freshness without changing the database. `--force` ignores freshness metadata and rebuilds the database.

An HTTP or HTTPS source must support `HEAD`. The CLI uses it to read file size and freshness metadata before downloading the ZIP.

ZIP entries are checked against their CRC32 values while they are read. A mismatch stops the fetch before the database is committed.

## Concurrent access

An existing database is updated in place with SQLite WAL mode and one transaction. Other processes can keep the database open for reading during the update. Readers do not see a partially updated table.

A reader with an active transaction continues to see its previous snapshot until that transaction ends. Its next transaction sees the updated data.

SQLite permits one writer at a time. If another process holds a write transaction, the update waits for up to 30 seconds and then fails if the lock is still active.

## Look up CEP values

Single lookup:

```sh
bunx @konstit/dne lookup 01001000
bunx @konstit/dne lookup 01001-000 --json
```

Bulk lookup:

```sh
bunx @konstit/dne lookup 01001000 20040002 --json
bunx @konstit/dne lookup --file ./ceps.txt --jsonl
printf '01001000\n20040002\n' | bunx @konstit/dne lookup --jsonl
```

Accepted input formats are `01001000` and `01001-000`. File and stdin input can use whitespace, commas, or semicolons as separators.

`lookup` opens SQLite in read-only mode. A missing database path does not create a file. JSONL writes one complete result per line and is suitable for large batches.

## Inspect the database

```sh
bunx @konstit/dne status --json
bunx @konstit/dne schema --json
bunx @konstit/dne schema --expected
bunx @konstit/dne doctor --json
bunx @konstit/dne doctor --offline --json
```

`status` reports file size, row count, actual schema, and load metadata. `schema` reads the real SQLite schema. `schema --expected` prints the schema declared by this CLI. `doctor` checks Bun, database setup, and remote source reachability. Offline mode skips the network check.

## Read-only SQL escape hatch

```sh
bunx @konstit/dne sql 'SELECT cep, municipio, uf FROM dne WHERE uf = "SP" LIMIT 10' --json
bunx @konstit/dne sql 'PRAGMA page_size' --limit 20 --json
```

The `sql` command opens the database in read-only mode. It accepts `SELECT`, `WITH`, `PRAGMA`, and `EXPLAIN`. `--limit` defaults to 100 and has a maximum of 10,000 rows.

## JSON contract

`--json` writes one stable envelope to stdout:

```json
{
  "ok": true,
  "data": {}
}
```

Runtime and argument errors use this shape on stderr:

```json
{
  "ok": false,
  "error": {
    "code": "invalid-cep",
    "message": "Invalid CEP 'x'. Use 01001000 or 01001-000."
  }
}
```

Progress and diagnostics go to stderr. JSON stdout does not include progress text.

Exit codes:

- `0`: command completed
- `1`: database, source, network, or runtime failure
- `2`: invalid arguments or invalid CEP input
- `3`: one or more valid CEP values were not found

## SQLite schema

```sql
CREATE TABLE "dne" (
  "cep" TEXT NOT NULL,
  "logradouro" TEXT,
  "complemento" TEXT,
  "bairro" TEXT,
  "municipio" TEXT NOT NULL,
  "municipio_cod_ibge" INTEGER NOT NULL,
  "uf" TEXT NOT NULL,
  "nome" TEXT,
  PRIMARY KEY ("cep")
) WITHOUT ROWID;
```

`cep` is the primary key. The table uses `WITHOUT ROWID` and a 32 KiB page size for compact direct lookups.

## Development

The `zip` command is required for fixture and nested-ZIP development tests.

```sh
bun test
bun run lint
bun run fmt
bun run benchmark
bun run benchmark:download
```

Other focused benchmark scripts are listed in `package.json`.
