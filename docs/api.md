# API de leitura

Esta página descreve os leitores públicos exportados por `@konstit/dne`. Para o esquema físico do SQLite, consultas SQL, indicadores de localidade e migrações, veja [SQLite](sqlite.md). O ponto de entrada do projeto está no [README](../README.md).

## Instalação

```sh
bun add @konstit/dne
```

A biblioteca pode ser importada diretamente. Importá-la não executa a CLI nem baixa dados.

## Leitor binário

`DneBinaryDatabaseReader` faz consultas síncronas em um arquivo binário mapeado em memória. Sem argumento, ele abre `data/dne.bin` dentro do pacote instalado, independentemente do diretório de trabalho:

```typescript
import {
  DneBinaryDatabaseReader,
  type DneRow,
} from '@konstit/dne';

const reader = new DneBinaryDatabaseReader();
try {
  const endereco: DneRow | undefined = reader.queryCep('01141-000');
  console.log(endereco);
} finally {
  reader.close();
}
```

Nenhum download é feito na instalação ou na consulta. A base incluída corresponde à fonte usada no empacotamento daquela versão do pacote; instale uma versão mais recente para receber outra cópia. Para usar uma base própria, passe o caminho do arquivo:

```typescript
const reader = new DneBinaryDatabaseReader('/dados/dne.bin');
```

O arquivo deve permanecer imutável enquanto o leitor estiver aberto. O construtor valida o cabeçalho, a versão, as seções, os dicionários e os metadados antes de liberar o leitor. `close()` pode ser chamado mais de uma vez. Depois de fechar, as consultas lançam `DneBinaryDatabaseClosedError`; `metadata()` e `rowCount()` continuam disponíveis.

## Leitor SQLite

`DneDatabaseReader` abre uma base SQLite existente em modo somente leitura:

```typescript
import { DneDatabaseReader } from '@konstit/dne';

const reader = new DneDatabaseReader('/dados/dne.db');
try {
  const endereco = reader.queryCep('01141000');
  console.log(endereco);
} finally {
  reader.close();
}
```

A base incluída no pacote é binária. Para usar o leitor SQLite, informe o caminho de uma base própria gerada pela CLI ou por outro processo de importação. `close()` é idempotente; qualquer leitura posterior, inclusive com entrada inválida, lança `DneDatabaseClosedError`.

Os dois leitores aceitam CEP com oito dígitos (`01141000`) ou no formato `01141-000`. Espaços ao redor não são aceitos. `queryCep()` retorna `undefined` quando a entrada é inválida ou o CEP não existe.

## Consultas

Os dois leitores oferecem as mesmas consultas de CEP e de bairros:

```typescript
const endereco = reader.queryCep('01141-000');

const bairro = reader.queryNeighborhood(12345);
const bairroDoCep = reader.queryNeighborhoodByCep('01141-000');
const faixas = reader.queryNeighborhoodCepRanges(12345);
```

`queryNeighborhood()` usa o identificador original `BAI_NU`, por isso bairros com o mesmo nome continuam distintos. `queryNeighborhoodByCep()` retorna o bairro efetivamente associado ao registro do CEP. CEPs gerais de distritos e povoados não recebem um bairro artificial e, nesses casos, o resultado é `undefined`. `queryNeighborhoodCepRanges()` retorna as faixas originais, ordenadas por limite inicial e final, sem unir lacunas.

Os retornos para identificadores inválidos ou desconhecidos são `undefined` em `queryNeighborhood()` e `queryNeighborhoodByCep()`, e `[]` em `queryNeighborhoodCepRanges()`.

### `DneRow`

`queryCep()` retorna um `DneRow` quando encontra o CEP:

| Campo                 | Tipo                                      | Significado                                                                 |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `cep`                 | `string`                                  | Oito dígitos, preservando zeros à esquerda e sem hífen.                     |
| `logradouro`          | `string \| null`                          | Logradouro ou `null` para CEP geral da localidade.                          |
| `complemento`         | `string \| null`                          | Informação complementar, quando disponível.                                 |
| `bairro`              | `string \| null`                          | Bairro ou nome da localidade subordinada, quando disponível.                |
| `municipio`           | `string`                                  | Município; para distrito ou povoado, é o município superior.                |
| `municipio_cod_ibge`  | `number`                                  | Código IBGE do município, como inteiro.                                     |
| `uf`                  | [`UF`](#tipos-exportados)                 | Sigla de duas letras da unidade federativa.                                 |
| `nome`                | `string \| null`                          | Destinatário, caixa postal comunitária ou unidade postal, quando aplicável. |
| `localidade_tipo`     | [`LocalidadeTipo`](#tipos-exportados)     | `municipio`, `distrito` ou `povoado`.                                       |
| `localidade_situacao` | [`LocalidadeSituacao`](#tipos-exportados) | Situação da codificação postal da localidade.                               |

Os indicadores de localidade são convertidos dos códigos DNE armazenados para strings descritivas durante a leitura. A tabela de conversão e a semântica de cada situação estão em [Indicadores de localidade](sqlite.md#indicadores-de-localidade). Consultas SQL diretas continuam vendo os códigos originais.

### `DneBairro` e `DneFaixaCep`

Um bairro retornado pelos métodos de bairro tem este formato:

```typescript
type DneBairro = {
  bairro_id: number; // BAI_NU original
  localidade_id: number; // LOC_NU original
  uf: UF;
  nome: string;
  nome_abreviado: string | null;
};
```

Cada faixa retornada por `queryNeighborhoodCepRanges()` é inclusiva:

```typescript
type DneFaixaCep = {
  cep_inicial: string; // oito dígitos
  cep_final: string; // oito dígitos
};
```

As faixas preservam zeros à esquerda e os intervalos originais do e-DNE. Pertencer a uma faixa não garante, por si só, que o CEP esteja cadastrado na tabela de endereços.

## Metadados e inspeção

Ambos os leitores expõem `metadata()`. O leitor binário expõe `rowCount()`; o leitor SQLite recebe o nome da tabela em `rowCount(tableName)`:

```typescript
const binaryReader = new DneBinaryDatabaseReader();
const sqliteReader = new DneDatabaseReader('/dados/dne.db');
const metadata = binaryReader.metadata();
const totalBinary = binaryReader.rowCount();
const totalSqlite = sqliteReader.rowCount('dne');
```

`LoadMetadata` é um mapa `Record<string, string>` com campos conhecidos como `loaded_at`, `package_version`, `schema_version`, `source_input`, `source_kind`, `source_url`, `source_last_modified`, `source_etag` e `source_content_length`. Alguns campos são opcionais porque dependem da fonte usada na carga. No leitor binário, os metadados são lidos no construtor. No SQLite, `metadata()` retorna `undefined` quando `edne_metadata` não existe.

O leitor SQLite também oferece operações de inspeção e SQL somente leitura:

```typescript
sqliteReader.hasTable('dne');
sqliteReader.rowCount('dne');
sqliteReader.tableSchema('dne');

const result = sqliteReader.querySql(
  'SELECT cep, municipio, uf FROM dne WHERE uf = \'SP\' LIMIT 10',
  100,
);
// { rows: Record<string, unknown>[], truncated: boolean }
```

`tableSchema()` retorna a instrução `CREATE TABLE` armazenada no catálogo ou `undefined` quando não há definição. `querySql()` usa a conexão somente leitura, mantém no máximo `limit` linhas na memória e informa em `truncated` se havia outra linha disponível. Ele não aplica o filtro de comandos SQL da CLI; valide e limite o SQL da aplicação conforme necessário.

Também são exportados `readDatabaseMetadata()`, `hasTable()`, `sqlitePathFromDatabaseUrl()`, `isBinaryDatabase()`, `parseUF()` e os helpers de CEP. `sqlitePathFromDatabaseUrl()` aceita caminhos comuns, `:memory:` e URLs `sqlite:///`; outros esquemas são rejeitados.

## Tipos exportados

Os tipos públicos podem ser importados da raiz do pacote:

```typescript
import type {
  DneBairro,
  DneFaixaCep,
  DneRow,
  LoadMetadata,
  LocalidadeSituacao,
  LocalidadeTipo,
  UF,
} from '@konstit/dne';
```

`UF` é a união das siglas federativas suportadas. `parseUF()` aceita a sigla sem diferenciar maiúsculas e minúsculas e retorna a forma canônica; uma sigla desconhecida lança `Error`. `LocalidadeTipo` e `LocalidadeSituacao` são unions das strings retornadas por `queryCep()`. Os códigos numéricos e as strings correspondentes estão documentados em [Indicadores de localidade](sqlite.md#indicadores-de-localidade).

## Erros

Os leitores expõem classes de erro com códigos estáveis em `error.code`. O erro original, quando existe, fica disponível em `error.cause`.

### SQLite

Todas as exceções SQLite herdam de `DneDatabaseError`.

| Classe                   | `code`           | Situação                                                                                |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------------- |
| `DneDatabaseIOError`     | `IO_ERROR`       | Falha ao abrir, configurar ou fechar a conexão. A propriedade `path` identifica a base. |
| `DneDatabaseSchemaError` | `INVALID_SCHEMA` | A base não tem a view normalizada, os bairros ou os campos de localidade necessários.   |
| `DneDatabaseDataError`   | `INVALID_DATA`   | O registro consultado contém indicadores de localidade inválidos.                       |
| `DneDatabaseQueryError`  | `QUERY_ERROR`    | O SQLite não conseguiu preparar ou executar uma leitura.                                |
| `DneDatabaseClosedError` | `READER_CLOSED`  | Uma operação foi feita depois de `close()`.                                             |

O tipo `DneDatabaseErrorCode` reúne esses cinco códigos. Uma base criada antes do esquema normalizado precisa ser recriada; consulte [Migrações e compatibilidade](sqlite.md#migrações-e-compatibilidade).

### Binário

Todas as exceções binárias herdam de `DneBinaryDatabaseError`.

| Classe                          | `code`                | Situação                                                                                                       |
| ------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DneBinaryDatabaseIOError`      | `IO_ERROR`            | O arquivo não pôde ser aberto, mapeado ou lido. A propriedade `path` identifica o caminho.                     |
| `DneBinaryDatabaseFormatError`  | `INVALID_FORMAT`      | O cabeçalho, as seções, os dicionários, os metadados ou um registro violam o formato.                          |
| `DneBinaryDatabaseVersionError` | `UNSUPPORTED_VERSION` | O arquivo declara uma versão que o leitor não suporta. `actualVersion` e `supportedVersion` ficam disponíveis. |
| `DneBinaryDatabaseClosedError`  | `READER_CLOSED`       | Uma consulta foi feita depois de `close()`.                                                                    |

O tipo `DneBinaryDatabaseErrorCode` reúne esses códigos. A especificação para implementar leitores em outras linguagens está em [Formato binário](binary-layout.md).

## Exemplo com tratamento de erro

```typescript
import {
  DneBinaryDatabaseError,
  DneBinaryDatabaseReader,
} from '@konstit/dne';

const reader = new DneBinaryDatabaseReader();
try {
  console.log(reader.queryCep('01141000'));
} catch (error) {
  if (error instanceof DneBinaryDatabaseError) {
    console.error(error.code, error.message, error.cause);
  }
  throw error;
} finally {
  reader.close();
}
```
