# Exemplos da API pública

Os exemplos usam somente exports de [`src/library.ts`](../src/library.ts), o ponto de entrada público de `@konstit/dne`. Execute os comandos na raiz deste repositório, com Bun 1.4 ou mais recente e as dependências instaladas com `bun install`. Para copiar um exemplo para outra aplicação, instale `@konstit/dne` e substitua `../src/library.ts` por `@konstit/dne` nos imports.

## Catálogo

| Exemplo | APIs demonstradas | Dados necessários |
| --- | --- | --- |
| [`cep-and-address.ts`](cep-and-address.ts) | `normalizeCep`, `cepToU32`, `formatCep`, `ufForCep`, `CEP_RANGES`, `expandAddress`. | Nenhum. |
| [`states.ts`](states.ts) | `ALL_UFS`, `parseUF`, `ufToStateName`, `stateNameToUF`, `ufToStateCode`, `stateCodeToUF`, tipo `UF`. | Nenhum. |
| [`binary-reader.ts`](binary-reader.ts) | `DneBinaryDatabaseReader`, abertura por caminho, `queryCep`, `queryMunicipality`, `queryMunicipalityCodesByUf`, `queryNeighborhood`, `queryNeighborhoodByCep`, `queryNeighborhoodCepRanges`, `metadata`, `rowCount`, `checksum`, `entries`, `close`. | Base binária. |
| [`binary-inspection.ts`](binary-inspection.ts) | `BINARY_DATABASE_VERSION`, `BINARY_DATABASE_HEADER_SIZE`, `isBinaryDatabase`, `readBinaryDatabaseMetadata`. | Caminho de um arquivo. |
| [`sqlite-reader.ts`](sqlite-reader.ts) | `DneDatabaseReader`: abertura por caminho, `queryCep`, `queryNeighborhood`, `queryNeighborhoodByCep`, `queryNeighborhoodCepRanges`, `metadata`, `hasTable`, `rowCount`, `tableSchema`, `querySql`, `close`. | Base SQLite. |
| [`reader-disposal.ts`](reader-disposal.ts) | `Disposable`, `using` e `[Symbol.dispose]()` nos leitores binário e SQLite, com fechamento automático ao sair do bloco. | Base binária e SQLite. |
| [`build-search-index.ts`](build-search-index.ts) | `buildAddressSearchIndex`, geração dos bytes e gravação em um arquivo novo. | Base binária e caminho de saída. |
| [`address-search.ts`](address-search.ts) | `DneAddressSearch`: construtor com caminho ou `Uint8Array`, `searchAddresses`, `using` e `[Symbol.dispose]()` delegando a `close()`; filtros com `AddressSearchOptions`. | Base binária e índice compatível. |
| [`address-search-pool.ts`](address-search-pool.ts) | `DneAddressSearchPool.open`, `searchAddresses`, `close`, concorrência, cancelamento, drenagem e erros; `AddressSearchPoolOptions` e `AddressSearchAsyncOptions`. | Base binária e índice compatível. |
| [`database-errors.ts`](database-errors.ts) | Classes e códigos de erro dos dois leitores, descritos abaixo. | Base binária e SQLite; caminhos inválidos também demonstram o tratamento de erro. |
| [`address-search-server.ts`](address-search-server.ts) | Pool persistente em `Bun.serve`, filtros, validação HTTP, prazo, fila limitada e encerramento. | Base binária e índice compatível. |

`binary-reader.ts` usa os tipos `DneRow`, `DneBairro`, `DneFaixaCep`, `LoadMetadata`, `LocalidadeTipo` e `LocalidadeSituacao` nos retornos das consultas. `sqlite-reader.ts` demonstra também metadados opcionais. Os tipos são importados com `import type` e não existem em tempo de execução.

O exemplo de erros trata todos os erros públicos dos leitores:

| Família | Classes e tipos |
| --- | --- |
| Binário | `DneBinaryDatabaseError`, `DneBinaryDatabaseIOError`, `DneBinaryDatabaseFormatError`, `DneBinaryDatabaseVersionError`, `DneBinaryDatabaseClosedError`, `DneBinaryDatabaseErrorCode`. |
| SQLite | `DneDatabaseError`, `DneDatabaseIOError`, `DneDatabaseSchemaError`, `DneDatabaseDataError`, `DneDatabaseQueryError`, `DneDatabaseClosedError`, `DneDatabaseErrorCode`. |
| Pool, nos exemplos de pool e servidor | `DneAddressSearchQueueFullError`, `DneAddressSearchPoolClosedError`, `DneAddressSearchWorkerError`. |

`database-errors.ts` consulta cada leitor e depois provoca intencionalmente uma consulta após `close()`. Ele imprime o código e a orientação correspondente; para demonstrar falha de abertura, informe um caminho inexistente. Outros tipos de erro são tratados no mesmo handler sem alterar os dados. O cancelamento do pool rejeita a promise com `signal.reason`, que não é uma dessas classes.

## Executar os exemplos

Helpers de CEP, endereço e UF não acessam arquivos nem a rede:

```sh
bun examples/cep-and-address.ts ' 01001-000 '
bun examples/states.ts ' sp '
```

Gere as bases usadas pelos exemplos com a CLI, fornecendo sua fonte e-DNE em `--source`.

```sh
bun run src/index.ts build --format binary --db ./data/dne.bin --source /dados/eDNE_Basico.zip
bun run src/index.ts build --db ./data/dne.db --source /dados/eDNE_Basico.zip
```

`--source` também aceita uma URL ou um diretório DNE. A base SQLite é necessária apenas para seus exemplos. Execute as consultas abaixo.

```sh
DNE_DATABASE=./data/dne.bin bun examples/binary-reader.ts 01001-000
bun examples/binary-inspection.ts ./data/dne.bin
DNE_SQLITE_DATABASE=./data/dne.db bun examples/sqlite-reader.ts 01001-000
DNE_DATABASE=./data/dne.bin DNE_SQLITE_DATABASE=./data/dne.db bun examples/reader-disposal.ts 01001-000
DNE_DATABASE=./data/dne.bin DNE_SQLITE_DATABASE=./data/dne.db bun examples/database-errors.ts
```

Os exemplos usam `./data/dne.bin` como caminho local padrão. Informe `DNE_DATABASE` para abrir outra base. `DNE_SQLITE_DATABASE` tem padrão `./data/dne.db`. CEPs ausentes retornam `undefined`, e consultas sem correspondências retornam listas vazias. O resultado depende da base fornecida.

Gere um índice para a mesma base usada nas buscas. O exemplo de geração exige um caminho de saída novo e não sobrescreve um índice existente:

```sh
DNE_DATABASE=./data/dne.bin bun examples/build-search-index.ts ./data/dne.bin.search.bin
DNE_DATABASE=./data/dne.bin DNE_SEARCH_INDEX=./data/dne.bin.search.bin bun examples/address-search.ts 'paulista'
DNE_DATABASE=./data/dne.bin DNE_SEARCH_INDEX=./data/dne.bin.search.bin bun examples/address-search-pool.ts 'paulista'
```

`DNE_SEARCH_INDEX` tem padrão `<DNE_DATABASE>.search.bin`, ou `./data/dne.bin.search.bin` quando a base padrão é usada. O exemplo síncrono mostra separadamente as duas formas de abrir o índice; em uma aplicação, escolha uma delas e reutilize a busca. O exemplo do pool usa dois workers e oito posições de espera. Os exemplos usam `finally`, `using` ou descarte explícito para fechar os leitores e pools.

## Endpoint de autocomplete com Bun

[`address-search-server.ts`](address-search-server.ts) oferece `GET /addresses` com `Bun.serve` e um `DneAddressSearchPool` persistente. A busca e o carregamento dos arquivos acontecem nos workers nativos do Bun. A base e o índice são carregados uma vez pelo primeiro worker e compartilhados com os demais via `SharedArrayBuffer`. O exemplo valida os parâmetros, limita a fila, trata cancelamento e encerra o servidor e o pool ao receber `SIGINT` ou `SIGTERM`.

### Executar o servidor

Requer Bun 1.4 ou mais recente e uma base binária. Execute na raiz do repositório:

```sh
bun install
# Gere a base local a partir do arquivo e-DNE fornecido.
bun run src/index.ts build --format binary --db ./data/dne.bin --source /dados/eDNE_Basico.zip
# O índice precisa ter sido gerado a partir dessa mesma base:
bun run build:search-index ./data/dne.bin ./data/dne.bin.search.bin
bun examples/address-search-server.ts
```

O servidor escuta em `http://127.0.0.1:3000`. A abertura do pool termina antes de aceitar conexões; arquivos ausentes ou incompatíveis impedem a inicialização.

```sh
curl --get 'http://127.0.0.1:3000/addresses' \
  --data-urlencode 'q=rubens mei' \
  --data-urlencode 'municipioCodIbge=3550308' \
  --data-urlencode 'limit=5'

curl --get 'http://127.0.0.1:3000/addresses' \
  --data-urlencode 'q=paulista' \
  --data-urlencode 'uf=SP'
```

A resposta é `{ "addresses": [...] }`, com os objetos `DneRow` completos e a mesma ordem da API síncrona. Nenhum resultado produz `{ "addresses": [] }` com HTTP 200.

### Configuração do servidor

| Variável           | Padrão                      | Significado                                                                                    |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `DNE_DATABASE`     | `./data/dne.bin`            | Caminho da base binária.                                                                       |
| `DNE_SEARCH_INDEX` | `<DNE_DATABASE>.search.bin` | Índice compatível com a base.                                                                  |
| `DNE_WORKERS`      | `1`                         | Quantidade positiva de workers. Compartilham base e índice; caches e buffers de busca são privados. |
| `DNE_MAX_QUEUE`    | `64`                        | Quantidade de consultas aguardando, além das que já estão executando; `0` desabilita a espera. |
| `HOST`             | `127.0.0.1`                 | Interface de escuta; use `0.0.0.0` quando necessário em um contêiner.                          |
| `PORT`             | `3000`                      | Porta HTTP.                                                                                    |

```sh
DNE_DATABASE=/dados/dne.bin \
DNE_SEARCH_INDEX=/dados/dne.search.bin \
DNE_WORKERS=2 DNE_MAX_QUEUE=64 \
bun examples/address-search-server.ts
```

### Contrato HTTP

| Parâmetro          | Regra                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `q`                | Obrigatório, de 3 a 256 caracteres após remover espaços nas extremidades. O mínimo é uma política deste endpoint, não do pool. |
| `uf`               | Opcional; sigla válida, normalizada pela biblioteca.                                                                           |
| `municipioCodIbge` | Opcional; código positivo de sete dígitos. Códigos inexistentes na base retornam uma lista vazia.                              |
| `limit`            | Inteiro de 1 a 50; padrão 10.                                                                                                  |

UF e município são cumulativos. A última palavra aceita prefixo. Um CEP completo no texto pode restringir a busca ao município correspondente; o algoritmo não corrige erros de digitação. Consulte as [regras da busca](../docs/address-search.md).

Parâmetros inválidos retornam 400, rotas desconhecidas 404 e métodos diferentes de GET 405. Fila cheia retorna 503 com `Retry-After: 1`; falha ou fechamento do pool também retorna 503. O exemplo não expõe detalhes internos dos erros ao cliente.

Cada consulta tem um prazo de 1 segundo, incluindo a espera na fila; prazo excedido retorna 504. O `request.signal` também cancela consultas de clientes desconectados. Nesse caso, o handler usa a convenção não padronizada 499, embora um cliente já desconectado não receba a resposta. Cancelar remove uma consulta da fila, mas uma consulta em execução continua consumindo seu worker até terminar. O pool descarta o resultado sem reutilizar prematuramente os buffers.

### Integrar em outra aplicação

Copie o exemplo e altere o import de `../src/library.ts` para `@konstit/dne`. Instale uma versão do pacote que inclua `DneAddressSearchPool`. Gere o índice para a base que será usada e mantenha apenas um pool por processo, criado durante a inicialização.

O pool incorpora o código do worker e o inicia por Blob URL. Você pode incluir `@konstit/dne` em um bundle Bun, inclusive com `--splitting`, ou em um executável `--compile`, sem um arquivo separado do worker ou um segundo entrypoint.

Este servidor recebe caminhos por variáveis de ambiente e lê a base e o índice de arquivos externos. Para um executável com os dados embutidos, importe a base e o índice com `with { type: 'file' }`, resolva esses caminhos a partir de `import.meta.url` e passe-os a `open()`. Em bundles JavaScript, distribua também os assets e chunks gerados no diretório de saída. Consulte o exemplo completo e os comandos de build no [guia de distribuição](../docs/address-search.md#bundles-e-executáveis-do-bun).

Na interface de autocomplete, faça debounce e aborte a requisição anterior quando o texto mudar. Comece com um worker e meça latência e memória sob concorrência antes de aumentar a quantidade. Mais workers não garantem que uma consulta individual fique mais rápida. O prazo e o limite da fila do exemplo são escolhas iniciais, não resultados de dimensionamento.
