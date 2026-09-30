# CEPs do Brasil com e-DNE dos Correios

Crie em segundos uma base local, em SQLite ou em formato binário compacto, pronta para consultar os CEPs do Brasil com dados do e-DNE dos Correios. Depois da carga, as consultas funcionam sem servidor e sem acesso à rede.

O `@konstit/dne` inclui uma base binária pronta para consultas em aplicações Bun. A CLI também recebe um diretório, um arquivo ZIP local ou o arquivo público mais recente do e-DNE para gerar bases próprias. Os dados são processados em fluxo e gravados nas tabelas `dne`, `bairros` e `bairro_faixas`, sem tabelas brutas intermediárias.

**3,11 milhões de consultas por segundo:** no benchmark de leitura, `DneBinaryDatabaseReader` consultou 100 mil CEPs em **32,16 ms**, sendo **30,6× mais rápido que o leitor SQLite** da biblioteca na mesma carga.

| Métrica | Binário | SQLite |
| --- | ---: | ---: |
| Mediana por 100 mil consultas | **32,16 ms** | 984,34 ms |
| Consultas por segundo, calculadas pela mediana | **3,11 milhões** | 101,6 mil |
| Tamanho da base | **32,2 MB** | 109,2 MB |

Medição realizada em **30/09/2026**, em um **Apple M4 com Bun 1.4.2**, usando [bench/binary-lookup.bench.ts](bench/binary-lookup.bench.ts) e uma base com 1.611.629 CEPs. Cada rodada executou 50 mil consultas a CEPs existentes e 50 mil a CEPs ausentes, com duas rodadas de aquecimento e nove medições. Ambos os leitores encontraram os 50 mil CEPs esperados. Os tempos incluem somente as consultas após aquecimento, sem a abertura da base; os tamanhos estão em MB decimais.

Principais vantagens:

- **Rápido e compacto:** em um benchmark de 10 execuções realizado em 2026-08-30, a geração completa a partir do arquivo público levou 5,73 segundos em média, incluindo o download. A base final continha 1.605.136 registros e ocupava 125,4 MiB.
- **Consultas locais simples:** procure um CEP, consulte vários CEPs em lote ou execute SQL somente leitura diretamente no arquivo SQLite.
- **Formato binário opcional:** use `--format binary` para gerar um arquivo SoA com strings internadas e leitura mmap, otimizado para lookup por CEP.
- **Atualizações seguras:** o modo WAL e uma única transação permitem atualizar a base sem expor dados parciais aos processos de leitura.
- **Atualizações automáticas:** registre uma agenda com `Bun.cron` para manter a base atualizada no Linux ou macOS. Cada job usa uma versão fixada do pacote, e o lock exclusivo evita cargas simultâneas.
- **Pronto para automação:** a CLI oferece saídas JSON e JSONL estáveis, códigos de saída documentados e separação entre dados e mensagens de progresso.

Nas mesmas condições do benchmark, `uvx edne-correios-loader load --database-url sqlite:///dne.db` levou 30 segundos e gerou uma base de 394 MiB sem `VACUUM`. Nessa comparação, o `@konstit/dne` foi 5,2 vezes mais rápido e usou 68,2% menos espaço em disco.

O pacote oferece uma API de leitura e mantém a CLI via `bunx @konstit/dne`.

## Requisitos

- Bun 1.4 ou mais recente
- macOS ou Linux

## Início rápido

Instale o pacote para consultar a base incluída:

```sh
bun add @konstit/dne
```

```typescript
import {
  DneBinaryDatabaseReader,
  type DneRow,
} from '@konstit/dne';

const db = new DneBinaryDatabaseReader();
try {
  const endereco: DneRow | null = db.queryCep('01141-000');
  const bairro = db.queryNeighborhoodByCep('01141-000');
  const faixas = bairro ? db.queryNeighborhoodCepRanges(bairro.bairro_id) : [];
  console.log({ endereco, bairro, faixas });
} finally {
  db.close();
}
```

Sem argumentos, o leitor abre `data/dne.bin` dentro do pacote instalado, independentemente do diretório de trabalho. Nenhum download é feito na instalação ou na consulta. A base representa a fonte usada no empacotamento daquela versão; instale uma versão mais recente para receber outra cópia ou passe o caminho de uma base própria: `new DneBinaryDatabaseReader('/dados/dne.bin')`.

Os tipos `DneRow`, `DneBairro`, `DneFaixaCep`, `LoadMetadata`, `UF`, `LocalidadeTipo`, `LocalidadeSituacao` e `DneBinaryDatabaseErrorCode` são exportados na raiz do pacote. As classes `DneBinaryDatabaseError`, `DneBinaryDatabaseIOError`, `DneBinaryDatabaseFormatError`, `DneBinaryDatabaseVersionError` e `DneBinaryDatabaseClosedError` também estão disponíveis para tratamento de erros. Importar a biblioteca não executa a CLI.

Para criar ou consultar suas próprias bases pela CLI:

```sh
bunx @konstit/dne build --db ./dne.db
bunx @konstit/dne build --format binary
bunx @konstit/dne get 01001-000 --db ./dne.bin
bunx @konstit/dne get 01001-000 --db ./dne.db
```

## Execução

Execute a CLI sem instalação global:

```sh
bunx @konstit/dne --version
bunx @konstit/dne --json doctor --offline
```

Os nomes de comandos, subcomandos, opções e flags permanecem em inglês. A ajuda, o progresso, os resultados textuais e as mensagens de erro são exibidos em português. O contrato JSON mantém chaves, códigos e valores de estado estáveis em inglês.

`--db` é uma opção global. Ela pode aparecer antes ou depois de um subcomando. O caminho da base segue esta ordem de precedência:

1. `--db PATH`
2. `./dne.bin` em `build --format binary`; `./dne.db` nos demais comandos.

No build binário, a extensão do caminho é substituída por `.bin` ou adicionada quando não existe: `--db ./base.db` e `--db ./base` geram `./base.bin`. Para consultar ou inspecionar o arquivo binário, informe seu caminho com `--db ./base.bin`.

Use `--color` para forçar cores e `--no-color` para desativá-las. Sem essas opções, a CLI detecta o terminal. A presença da variável `NO_COLOR` sempre desativa as cores.

## Criar e atualizar

```sh
bunx @konstit/dne build --db ./dne.db
bunx @konstit/dne build --db ./dne.db --source ./eDNE_Basico.zip
bunx @konstit/dne build --db ./dne.db --source ./Delimitado
bunx @konstit/dne build --db ./dne.db --source https://example.com/eDNE_Basico.zip
bunx @konstit/dne build --db ./dne.db --force
bunx @konstit/dne build --db ./dne.db --check --json
```

`build` grava cada etapa e sua duração em formato compacto (`ms`, `s`, `min` ou `h`) em stderr. O resultado final é gravado em stdout. Use `--quiet` para ocultar o progresso. Use `--json` para receber o caminho da base, a quantidade de registros, o tamanho em bytes, os metadados da fonte, o tempo total em `elapsed_ms` e o estado da atualização.

Cada carga grava a versão do `@konstit/dne` em `edne_metadata` (ou no cabeçalho do arquivo binário). Ao usar uma fonte remota, a CLI também grava `Last-Modified`, ETag, tamanho do conteúdo, URL da fonte e horário da carga. Todos os validadores disponíveis devem continuar iguais para a base ser considerada atual. Uma execução posterior de `build` não recria a base se a fonte não mudou e mostra o `Last-Modified` remoto na saída textual. `--check` valida a estrutura de uma fonte local ou verifica se há uma atualização remota, sem alterar a base. `--force` ignora os metadados e recria a base.

O formato binário é selecionado explicitamente com `--format binary`. Ele mantém os mesmos dez campos da consulta por CEP em um layout próprio para `mmap`: o CEP usa um diretório de prefixos e sufixos de 10 bits; município e UF são compartilhados; campos opcionais usam bitmaps; os indicadores da localidade ocupam um byte por CEP; e as strings ficam em dicionários por coluna com front-coding em blocos de oito. `get`, `status` e `schema` detectam o formato automaticamente. O comando `sql` continua disponível somente para bases SQLite.

A especificação completa para implementar leitores em outras linguagens está em [docs/binary-layout.md](docs/binary-layout.md).

Para fontes HTTP ou HTTPS, a CLI tenta obter os metadados com `HEAD`. Se o servidor não aceitar esse método, ela usa uma requisição `GET` limitada ao primeiro byte. Requisições têm timeout de 30 segundos e até duas novas tentativas para falhas transitórias, respostas 408, 425, 429 e 5xx.

As entradas do ZIP são verificadas com seus valores CRC32 durante a leitura. A carga também valida CEP, UF, código IBGE, campos obrigatórios e referências entre os arquivos. Qualquer rejeição interrompe a transação. Uma carga válida grava em `quality_report` as linhas lidas, aceitas e rejeitadas por etapa e arquivo.

## Acesso simultâneo

Cada execução de `build` que pode alterar a base adquire um lock exclusivo antes de verificar a fonte. Outra instância do `@konstit/dne` aguarda por até 30 segundos, então verifica novamente os metadados e evita uma carga duplicada se a primeira instância já atualizou a base. `build --check` não adquire esse lock.

O lock fica no diretório temporário do sistema, dentro de `konstit-dne-<uid>`. Seu nome contém um hash do caminho absoluto da base, evitando conflitos entre bases com o mesmo nome. Ele é removido quando a execução termina e também ao receber `SIGHUP`, `SIGINT` ou `SIGTERM`. Se o processo for encerrado sem executar essa limpeza, a próxima execução identifica o PID inativo e remove o lock antes de continuar. Processos que coordenam a mesma base devem usar o mesmo host e usuário do sistema.

Uma base existente é atualizada no próprio arquivo com o modo WAL do SQLite e uma única transação. Outros processos podem manter a base aberta para leitura durante a atualização. Esses processos não veem uma tabela atualizada parcialmente.

Um leitor com uma transação ativa continua vendo a versão anterior até o fim da transação. A próxima transação vê os dados atualizados.

O SQLite permite um escritor por vez. Se outro processo mantiver uma transação de escrita, a atualização aguarda por até 30 segundos. Depois desse período, ela falha se o bloqueio continuar ativo.

## Atualização automática

Instale uma atualização semanal para a base:

```sh
bunx @konstit/dne cron install --db ./dne.db
```

O padrão `0 0 * * 5` executa à meia-noite de sexta-feira, no fuso local do cron. Informe outra expressão como argumento quando necessário:

```sh
bunx @konstit/dne cron install '30 6 * * 5' --db ./dne.db
bunx @konstit/dne cron install --db ./dne.db --source https://example.com/eDNE_Basico.zip
bunx @konstit/dne cron install '@weekly' --db ./dne.db --dry-run
bunx @konstit/dne cron status --db ./dne.db --json
bunx @konstit/dne cron remove --db ./dne.db
```

`cron install` usa `Bun.cron` para registrar o job no agendador do sistema operacional: `crontab` no Linux e `launchd` no macOS. O título contém um hash do caminho absoluto da base. Uma nova instalação para a mesma base substitui o job existente, enquanto bases diferentes mantêm agendamentos independentes. `cron remove` usa `Bun.cron.remove`.

Cada job recebe um módulo persistente e metadados no diretório de estado do usuário. O módulo executa os caminhos absolutos do `bunx`, da base e de fontes locais. A versão atual do `@konstit/dne` e a fonte ficam fixadas no comando. Alterar somente a expressão preserva a fonte já instalada. Execute `cron install` novamente depois de atualizar o pacote para usar a nova versão. A execução usa `--quiet`, descarta a saída normal e mantém erros em stderr para o agendador do sistema. `cron status` mostra a fonte e também calcula a próxima execução com `Bun.cron.parse`.

## Consultar CEPs

Consulta individual:

```sh
bunx @konstit/dne get 01001000
bunx @konstit/dne get 01001-000 --json
```

Consulta em lote:

```sh
bunx @konstit/dne get 01001000 20040002 --json
bunx @konstit/dne get --file ./ceps.txt --jsonl
printf '01001000\n20040002\n' | bunx @konstit/dne get --jsonl
```

Os formatos aceitos são `01001000` e `01001-000`. A entrada por arquivo ou stdin pode usar espaços, vírgulas ou pontos e vírgulas como separadores.

`get` abre o SQLite em modo somente leitura ou mapeia o arquivo binário com `mmap`. Se o caminho da base não existir, nenhum arquivo será criado. O formato JSONL lê a entrada e grava cada resultado de forma incremental, sem manter o lote completo na memória.

## Inspecionar a base

```sh
bunx @konstit/dne status --json
bunx @konstit/dne schema --json
bunx @konstit/dne schema --expected
bunx @konstit/dne doctor --json
bunx @konstit/dne doctor --offline --json
```

`status` informa o tamanho do arquivo, a quantidade de registros, o esquema atual, a versão do pacote, o `Last-Modified` da fonte e os demais metadados da carga. A saída textual formata datas e números com a localidade `pt-BR`; a saída JSON mantém os valores originais. `schema` lê o esquema real do SQLite. `schema --expected` mostra o esquema definido pela CLI. `doctor` verifica o Bun, a configuração da base e o acesso à fonte remota. O modo offline não faz a verificação de rede.

## SQL somente leitura

```sh
bunx @konstit/dne sql 'SELECT cep, municipio, uf FROM dne WHERE uf = "SP" LIMIT 10' --json
bunx @konstit/dne sql 'PRAGMA page_size' --limit 20 --json
```

O comando `sql` abre a base em modo somente leitura. Ele aceita `SELECT`, `WITH`, `PRAGMA` e `EXPLAIN`. O valor padrão de `--limit` é 100, com limite máximo de 10.000 registros.

## Contrato JSON

`--json` grava em stdout um envelope estável:

```json
{
  "ok": true,
  "data": {}
}
```

Erros de execução e de argumentos usam este formato em stderr:

```json
{
  "ok": false,
  "error": {
    "code": "invalid-cep",
    "message": "CEP inválido 'x'. Use 01001000 ou 01001-000."
  }
}
```

O progresso e os diagnósticos são gravados em stderr. A saída JSON em stdout não inclui mensagens de progresso.

Códigos de saída:

- `0`: comando concluído
- `1`: falha na base, na fonte, na rede ou na execução
- `2`: argumentos inválidos ou CEP em formato inválido
- `3`: um ou mais CEPs válidos não foram encontrados

## Schema SQLite

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
  "localidade_nome" TEXT CHECK (localidade_nome IS NULL OR (bairro_id IS NULL AND localidade_tipo IN ('D', 'P'))) /* Original district or village name for a locality-wide CEP. */,
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

`cep` é a chave primária, sem digito separador. A tabela usa `WITHOUT ROWID` e páginas de 32 KiB para oferecer consultas diretas com menor uso de espaço.

`bairros` preserva o identificador original `BAI_NU`, a localidade `LOC_NU`, UF, nome e abreviação de `LOG_BAIRRO.TXT`, inclusive bairros sem CEP associado. Bairros homônimos continuam distintos. `dne.bairro_id` referencia esse cadastro; `bairro_faixas` armazena todos os intervalos de `LOG_FAIXA_BAIRRO.TXT`, com limites inclusivos e zeros à esquerda. As faixas não são consolidadas em um único mínimo/máximo: lacunas são preservadas, e pertencer a uma faixa não garante que um CEP esteja cadastrado.

Para manter os dez campos da consulta por CEP, incluindo o nome do bairro, use `dne_consulta`. Nos CEPs gerais de distritos e povoados, o nome original fica em `dne.localidade_nome`; esses registros não viram bairros artificiais. `get` e `queryCep()` continuam retornando o mesmo objeto.

```sql
SELECT * FROM dne_consulta WHERE cep = '01141000';

SELECT b.*, f.cep_inicial, f.cep_final
FROM dne d
JOIN bairros b ON b.bairro_id = d.bairro_id
LEFT JOIN bairro_faixas f ON f.bairro_id = b.bairro_id
WHERE d.cep = '01141000'
ORDER BY f.cep_inicial, f.cep_final;
```

Os leitores `DneDatabaseReader` e `DneBinaryDatabaseReader` oferecem as mesmas consultas adicionais:

- `queryNeighborhood(bairroId)`: retorna `{ bairro_id, localidade_id, uf, nome, nome_abreviado }` pelo identificador original.
- `queryNeighborhoodByCep(cep)`: retorna o bairro efetivamente associado ao CEP, ou `null` quando ausente, inclusive nos CEPs gerais de distritos e povoados.
- `queryNeighborhoodCepRanges(bairroId)`: retorna `{ cep_inicial, cep_final }[]`, ordenado pelos limites, ou `[]` quando não há faixas.

Identificadores inválidos ou desconhecidos retornam `null`/`[]`. No binário, o cadastro de bairros tem índices internos compactos e preserva os identificadores originais; os intervalos usam pares de inteiros de 32 bits e são convertidos para oito dígitos na leitura.

No SQLite, `localidade_situacao` preserva `LOC_IN_SIT` (`0`, `1`, `2` ou `3`) e `localidade_tipo` preserva `LOC_IN_TIPO_LOC` (`M`, `D` ou `P`). O binário mantém esses indicadores compactados em um byte por CEP. `queryCep()` converte os códigos para strings descritivas nos dois leitores; a CLI também retorna essas strings nas consultas `get`:

| Campo | Código DNE | Valor retornado pela API |
| --- | --- | --- |
| `localidade_tipo` | `M` | `municipio` |
| `localidade_tipo` | `D` | `distrito` |
| `localidade_tipo` | `P` | `povoado` |
| `localidade_situacao` | `0` | `sem_codificacao_por_logradouro` |
| `localidade_situacao` | `1` | `codificada_por_logradouro` |
| `localidade_situacao` | `2` | `inserida_na_codificacao_por_logradouro` |
| `localidade_situacao` | `3` | `em_codificacao_por_logradouro` |

`LocalidadeTipo` e `LocalidadeSituacao` são string unions desses valores. Consultas SQL diretas continuam usando os códigos originais. A conversão acontece na leitura e não exige reconstruir bases existentes do formato atual.

Na situação `3`, o CEP geral e os CEPs de logradouros coexistem durante a transição, conforme `Delimitado/Leiautes_delimitador.doc` incluído no [arquivo oficial do e-DNE](https://www2.correios.com.br/sistemas/edne/download/eDNE_Basico.zip). Os indicadores pertencem à localidade de origem de cada CEP, inclusive nos registros de logradouros, caixas postais comunitárias, grandes usuários e unidades operacionais. Para distritos e povoados, `municipio` e `municipio_cod_ibge` continuam identificando o município superior.

Para listar municípios com CEP único:

```sql
SELECT DISTINCT municipio, municipio_cod_ibge, uf
FROM dne
WHERE localidade_tipo = 'M' AND localidade_situacao = 0
ORDER BY uf, municipio;
```

Um município com CEP geral ainda pode ter CEPs específicos de estabelecimentos ou unidades postais. Por isso, contar seus registros e exigir apenas um CEP não substitui os indicadores oficiais.

Bases anteriores precisam de uma nova importação para recuperar esses campos. Execute `build --force` com a fonte e o caminho da base desejados. A atualização do SQLite substitui o esquema dentro da transação somente após validar a nova carga. O esquema SQLite está na versão 4. O formato binário foi redefinido como versão 1, sem retrocompatibilidade; regenere os arquivos binários existentes. A versão do esquema é gravada em `schema_version`, e uma base com esquema antigo deixa de ser considerada atual mesmo quando os validadores da fonte remota não mudaram.

### Drizzle ORM schema

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

Este schema serve para consultar um banco criado pelo `@konstit/dne`. O Drizzle não representa `WITHOUT ROWID`; portanto, usar o Drizzle Kit para gerar ou migrar essas tabelas cria uma estrutura física diferente.

## Desenvolvimento

O comando `zip` é necessário para os testes com arquivos ZIP aninhados. Os testes de distribuição também usam `npm` e `tar` para empacotar e instalar uma fixture isolada, sem baixar os dados reais.

```sh
bun test
bun run lint
bun run fmt
bun run benchmark
bun run benchmark:download
```

Outros scripts de benchmark específicos estão listados em `package.json`.

Para comparar consultas no binário e no SQLite usando os mesmos CEPs:

```sh
bun run bench/binary-lookup.bench.ts data/dne.bin 100000 ./dne.db
bun run bench/binary-lookup.bench.ts ./dne.db 100000 ./dne.db
```

O terceiro argumento fornece a base SQLite usada para selecionar 50% de CEPs existentes e 50% de ausentes. O resultado inclui nove medições após duas rodadas de aquecimento. `memoryBytes` registra a memória antes de abrir a base, após abri-la, após o primeiro lote de consultas, após a coleta de lixo desse lote e ao final das medições, sempre antes de fechar o leitor. A coleta de lixo inicial e a do primeiro lote ficam fora das medições de tempo.

Todos os valores de memória estão em bytes. `rss` é o consumo do processo reportado pelo Bun, incluindo o runtime e a lista de consultas; não representa apenas o banco. `heapUsed`, `heapTotal`, `external` e `arrayBuffers` são os valores originais de `process.memoryUsage()`. Não os some: há sobreposição, e o Bun pode incluir buffers externos em `heapUsed`. `heapObjectBytes` separa os objetos do heap de strings e buffers alocados externamente, usando `heapSize - extraMemorySize` de `bun:jsc`. Esse contador reflete a última coleta de lixo; compare `beforeOpen` com `afterFirstBatchGc` para avaliar os objetos que continuam ocupando memória. [Detalhes das métricas do Bun](https://bun.com/reference/bun/jsc/heapStats).

### Distribuição do pacote

`bun run build` gera a CLI em `dist/index.js` e a biblioteca com declarações TypeScript em `dist/library.js` e `dist/library.d.ts`. `npm pack` e `bun pm pack` executam `prepack`: compilam essas entradas e geram `data/dne.bin` a partir da fonte pública dos Correios. A base completa acompanha o tarball; não há script de instalação para baixá-la. Os testes de publicação verificam a CLI e a leitura da base no pacote instalado.

Para empacotar a partir de um diretório ou ZIP local, informe `DNE_PACKAGE_SOURCE`:

```sh
DNE_PACKAGE_SOURCE=/dados/eDNE_Basico.zip npm pack
```

`bun run build:package-database` prepara somente a base incluída. Os arquivos gerados permanecem fora do Git.
