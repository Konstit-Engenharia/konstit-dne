# SQLite

Esta página documenta o banco SQLite gerado por `@konstit/dne`, as consultas SQL e a integração com Drizzle ORM. Para abrir a base pela API, consulte [API de leitura](api.md). O ponto de entrada do projeto está no [README](../README.md).

## Quando usar SQLite

Use o formato SQLite quando a aplicação precisa executar SQL, integrar ferramentas do ecossistema SQLite ou inspecionar as tabelas importadas. O formato binário é mais compacto e otimizado para lookup direto por CEP; sua estrutura está descrita em [Formato binário](binary-layout.md).

O `DneDatabaseReader` abre a base em modo somente leitura. A CLI cria e atualiza o arquivo usando uma transação; leitores existentes não observam uma carga parcialmente gravada. A API e os exemplos de consulta estão em [API de leitura](api.md).

## Esquema

Uma base atual contém as tabelas normalizadas `dne`, `bairros` e `bairro_faixas`, além da view `dne_consulta`:

```sql
CREATE TABLE IF NOT EXISTS "bairros" (
  "bairro_id" INTEGER NOT NULL CHECK (bairro_id > 0),
  "localidade_id" INTEGER NOT NULL CHECK (localidade_id > 0),
  "uf" TEXT NOT NULL,
  "nome" TEXT NOT NULL,
  "nome_abreviado" TEXT,
  PRIMARY KEY ("bairro_id")
);

CREATE TABLE IF NOT EXISTS "bairro_faixas" (
  "bairro_id" INTEGER NOT NULL REFERENCES "bairros" ("bairro_id"),
  "cep_inicial" TEXT NOT NULL CHECK (length(cep_inicial) = 8 AND cep_inicial NOT GLOB '*[^0-9]*'),
  "cep_final" TEXT NOT NULL CHECK (length(cep_final) = 8 AND cep_final NOT GLOB '*[^0-9]*' AND cep_inicial <= cep_final),
  PRIMARY KEY ("bairro_id", "cep_inicial", "cep_final")
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS "dne" (
  "cep" TEXT NOT NULL /* Contém somente os oito dígitos do CEP, sem separadores. */,
  "logradouro" TEXT,
  "complemento" TEXT,
  "bairro_id" INTEGER REFERENCES "bairros" ("bairro_id"),
  "localidade_nome" TEXT CHECK (localidade_nome IS NULL OR (bairro_id IS NULL AND localidade_tipo IN ('D', 'P'))) /* Nome original do distrito ou povoado para um CEP geral da localidade. */,
  "municipio" TEXT NOT NULL,
  "municipio_cod_ibge" INTEGER NOT NULL,
  "uf" TEXT NOT NULL,
  "nome" TEXT,
  "localidade_situacao" INTEGER NOT NULL CHECK (localidade_situacao IN (0, 1, 2, 3)),
  "localidade_tipo" TEXT NOT NULL CHECK (localidade_tipo IN ('M', 'D', 'P')),
  PRIMARY KEY ("cep")
) WITHOUT ROWID;

CREATE VIEW "dne_consulta" AS
    SELECT d.cep, d.logradouro, d.complemento, COALESCE(b.nome, d.localidade_nome) AS bairro,
      d.municipio, d.municipio_cod_ibge, d.uf, d.nome, d.localidade_situacao, d.localidade_tipo
    FROM "dne" d
    LEFT JOIN "bairros" b ON b.bairro_id = d.bairro_id;
```

`cep` é a chave primária e não contém hífen. `dne` e `bairro_faixas` usam `WITHOUT ROWID`; a base usa páginas SQLite de 32 KiB para reduzir o custo de lookup e o espaço ocupado.

`bairros` preserva o identificador original `BAI_NU`, a localidade `LOC_NU`, a UF, o nome e a abreviação de `LOG_BAIRRO.TXT`, inclusive para bairros sem CEP associado. Bairros homônimos continuam distintos. `dne.bairro_id` referencia esse cadastro.

`bairro_faixas` guarda todos os intervalos de `LOG_FAIXA_BAIRRO.TXT`, com limites inclusivos e zeros à esquerda. Os intervalos não são consolidados em um mínimo e máximo: lacunas são preservadas, e pertencer a uma faixa não garante que o CEP esteja cadastrado em `dne`.

Para manter os dez campos públicos da consulta por CEP, incluindo o nome do bairro, use a view `dne_consulta`. Nos CEPs gerais de distritos e povoados, o nome original fica em `dne.localidade_nome`; esses registros não criam bairros artificiais. `get` na CLI e `queryCep()` na API continuam retornando o mesmo objeto.

## Consultas SQL

O comando `sql` da CLI usa a base em modo somente leitura e aceita `SELECT`, `WITH`, `PRAGMA` e `EXPLAIN`. Na aplicação, `DneDatabaseReader.querySql()` retorna `{ rows, truncated }`; veja [Inspeção e SQL na API](api.md#metadados-e-inspeção).

```sql
SELECT *
FROM dne_consulta
WHERE cep = '01141000';

SELECT b.*, f.cep_inicial, f.cep_final
FROM dne d
JOIN bairros b ON b.bairro_id = d.bairro_id
LEFT JOIN bairro_faixas f ON f.bairro_id = b.bairro_id
WHERE d.cep = '01141000'
ORDER BY f.cep_inicial, f.cep_final;
```

Para consultar o bairro efetivamente associado a um CEP, faça a junção com `bairros`. Um CEP geral de distrito ou povoado não terá `bairro_id` e deve ser lido por `localidade_nome` ou pela view.

## Indicadores de localidade

O SQLite mantém os códigos originais do e-DNE. `localidade_tipo` preserva `LOC_IN_TIPO_LOC`; `localidade_situacao` preserva `LOC_IN_SIT`. Os leitores da [API](api.md) convertem esses códigos em strings descritivas:

| Campo                 | Código DNE | Valor retornado pela API                 |
| --------------------- | ---------- | ---------------------------------------- |
| `localidade_tipo`     | `M`        | `municipio`                              |
| `localidade_tipo`     | `D`        | `distrito`                               |
| `localidade_tipo`     | `P`        | `povoado`                                |
| `localidade_situacao` | `0`        | `sem_codificacao_por_logradouro`         |
| `localidade_situacao` | `1`        | `codificada_por_logradouro`              |
| `localidade_situacao` | `2`        | `inserida_na_codificacao_por_logradouro` |
| `localidade_situacao` | `3`        | `em_codificacao_por_logradouro`          |

`LocalidadeTipo` e `LocalidadeSituacao` são unions das strings retornadas. SQL direto continua usando `M`, `D`, `P` e `0` a `3`; a conversão ocorre durante a leitura e não exige alterar uma base atualizada.

Na situação `3`, o CEP geral e os CEPs de logradouros coexistem durante a transição, conforme `Delimitado/Leiautes_delimitador.doc` no [arquivo oficial do e-DNE](https://www2.correios.com.br/sistemas/edne/download/eDNE_Basico.zip). Os indicadores pertencem à localidade de origem de cada CEP, inclusive em registros de logradouros, caixas postais comunitárias, grandes usuários e unidades operacionais.

Para distritos e povoados, `municipio` e `municipio_cod_ibge` continuam identificando o município superior. Para listar municípios com CEP geral:

```sql
SELECT DISTINCT municipio, municipio_cod_ibge, uf
FROM dne
WHERE localidade_tipo = 'M' AND localidade_situacao = 0
ORDER BY uf, municipio;
```

Um município com CEP geral ainda pode ter CEPs específicos de estabelecimentos ou unidades postais. Contar registros e exigir somente um CEP não substitui os indicadores oficiais.

## Migrações e compatibilidade

O esquema SQLite atual está na versão `4`, gravada em `schema_version` dentro de `edne_metadata`. Bases anteriores precisam de uma nova importação para recuperar `bairros`, `bairro_faixas`, a view normalizada e os indicadores de localidade. Informe `--source` quando a base usa uma fonte própria:

```sh
bunx @konstit/dne build --force --db ./dne.db
bunx @konstit/dne build --force --db ./dne.db --source /dados/eDNE_Basico.zip
```

A atualização substitui o esquema dentro de uma única transação e só confirma a nova base depois de validar a carga. Se a fonte for remota, a CLI também compara a versão do esquema com os validadores disponíveis; uma base antiga deixa de ser considerada atual mesmo quando a fonte não mudou.

O formato binário tem versão `2` e usa sequências comprimidas para os índices de bairro. Arquivos binários da versão `1` precisam ser regenerados. O leitor SQLite lança `DneDatabaseSchemaError` quando a base não possui a view ou os campos normalizados esperados; consulte [Erros da API](api.md#erros).

## Drizzle ORM

O schema abaixo descreve as tabelas para consultas com Drizzle:

```typescript
import {
  primaryKey,
  sqliteTable,
} from 'drizzle-orm/sqlite-core';

export const bairrosTable = sqliteTable('bairros', (t) => ({
  bairro_id: t.integer().primaryKey(),
  localidade_id: t.integer().notNull(),
  uf: t.text().notNull(),
  nome: t.text().notNull(),
  nome_abreviado: t.text(),
}));

export const bairroFaixasTable = sqliteTable(
  'bairro_faixas',
  (t) => ({
    bairro_id: t.integer().notNull().references(() => bairrosTable.bairro_id),
    cep_inicial: t.text().notNull(),
    cep_final: t.text().notNull(),
  }),
  (t) => [primaryKey({ columns: [t.bairro_id, t.cep_inicial, t.cep_final] })],
);

export const dneTable = sqliteTable('dne', (t) => ({
  cep: t.text().primaryKey(),
  logradouro: t.text(),
  complemento: t.text(),
  bairro_id: t.integer().references(() => bairrosTable.bairro_id),
  localidade_nome: t.text(),
  municipio: t.text().notNull(),
  municipio_cod_ibge: t.integer().notNull(),
  uf: t.text().notNull(),
  nome: t.text(),
  localidade_situacao: t.integer().$type<0 | 1 | 2 | 3>().notNull(),
  localidade_tipo: t.text({ enum: ['M', 'D', 'P'] }).notNull(),
}));
```

Esse schema serve para consultar uma base criada por `@konstit/dne`. O Drizzle não representa `WITHOUT ROWID`; portanto, usar o Drizzle Kit para gerar ou migrar essas tabelas cria uma estrutura física diferente da base gerada. Preserve as tabelas geradas quando precisar manter o layout e as restrições do importador.
