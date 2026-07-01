# e-DNE Correios Loader

Carregue todos os CEPs do Brasil em um banco SQLite com Bun.

O e-DNE (Diretório Nacional de Endereços) dos Correios contém mais de 1,5 milhão de CEPs e está disponível gratuitamente. Esta versão baixa ou lê os arquivos do e-DNE Básico, processa os TXT delimitados e cria uma tabela unificada pronta para consulta.

## Requisitos

- [Bun](https://bun.sh)
- SQLite é usado via `bun:sqlite`
- Dependências instaladas via Bun

## Uso rápido

```shell
bun run ./src/index.ts fetch dne.db
```

Consultar CEP:

```shell
bun run ./src/index.ts lookup dne.db 01001000
```

## Comandos

```shell
bun run ./src/index.ts fetch dne.db
```

Opções principais:

- `--source <path|zip|url>`: diretório, ZIP local ou URL com o e-DNE. Quando omitido, baixa o e-DNE Básico mais recente dos Correios.
- `--force`: força novo download e nova carga mesmo quando a metadata remota não mudou ou existe cache local.

Downloads remotos usam streaming incremental via `Bun.file(...).writer()`, evitando carregar o ZIP inteiro em memória durante o download.

Depois de carregar uma URL remota, o banco grava `Last-Modified`, ETag e tamanho em `edne_metadata`. Na próxima execução contra a mesma URL, se essa metadata ainda bater, o loader pula download e reprocessamento.

O ZIP remoto também fica em cache em `~/.cache/edne-correios-loader`. Se o banco for removido mas a versão remota for a mesma, o loader reconstrói o SQLite sem novo download.

Consulta:

```shell
bun run ./src/index.ts lookup dne.db 01001000
```

## Tabela unificada

O loader cria `dne` e a tabela pequena `edne_metadata`. Ele não cria tabelas brutas intermediárias: lê ZIPs direto em memória, usa apenas os TXT necessários, lê só as colunas usadas e insere direto na tabela final.

`dne` usa `PRIMARY KEY (cep) WITHOUT ROWID` e `page_size = 32768`, otimizado para busca direta por CEP e menor arquivo SQLite.

Inserções usam batches de 1000 linhas por padrão.

Colunas:

- `cep`
- `logradouro`
- `complemento`
- `bairro`
- `municipio`
- `municipio_cod_ibge`
- `uf`
- `nome`

## Verificação e benchmark

Gerar fixture, carregar com Bun e medir tempo:

```shell
bun run benchmark
```

Benchmark baixando o e-DNE real dos Correios:

```shell
bun run benchmark:download
```

Microbenchmarks com `mitata`:

```shell
bun run benchmark:micro
```

Benchmark de batch size com `mitata` e carga real cacheada:

```shell
bun run benchmark:batch-size
```

Também é possível comparar dois bancos manualmente:

```shell
bun run scripts/compare-sqlite.ts left.db right.db
```
