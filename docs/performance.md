# Desempenho

[Voltar ao README](../README.md)

Os resultados abaixo registram duas medições distintas: consultas em 30/09/2026 e importação em 30/08/2026. Cada medição usa sua própria base e condições; os tamanhos não representam o mesmo conjunto de dados.

## Consultas por CEP

O leitor binário atingiu **3,11 milhões de consultas por segundo**, calculadas pela mediana, e foi **30,6× mais rápido que o leitor SQLite** da biblioteca nesta carga.

| Métrica                                        |          Binário |    SQLite |
| ---------------------------------------------- | ---------------: | --------: |
| Mediana por 100 mil consultas                  |     **32,16 ms** | 984,34 ms |
| Consultas por segundo, calculadas pela mediana | **3,11 milhões** | 101,6 mil |
| Tamanho da base                                |      **32,2 MB** |  109,2 MB |

Medição realizada em **30/09/2026**, em um **Apple M4 com Bun 1.4.2**, usando [bench/binary-lookup.bench.ts](../bench/binary-lookup.bench.ts) e uma base com 1.611.629 CEPs. Cada rodada executou 50 mil consultas a CEPs existentes e 50 mil a CEPs ausentes, com duas rodadas de aquecimento e nove medições. Ambos os leitores encontraram os 50 mil CEPs esperados. Os tempos incluem somente as consultas após aquecimento, sem a abertura da base; os tamanhos estão em MB decimais.

Estes resultados usam o formato binário v1. O índice de bairros da v2 altera o tamanho do arquivo e o tempo das consultas; a tabela acima permanece como referência histórica.

### Reproduzir a comparação

Para comparar os leitores usando os mesmos CEPs, execute os comandos na raiz do repositório, com as dependências instaladas e as duas bases disponíveis:

```sh
bun run bench/binary-lookup.bench.ts data/dne.bin 100000 ./dne.db
bun run bench/binary-lookup.bench.ts ./dne.db 100000 ./dne.db
```

A base SQLite deve representar a mesma fonte usada para gerar o binário. O terceiro argumento fornece a base SQLite usada para selecionar 50% de CEPs existentes e 50% de ausentes. O resultado inclui nove medições após duas rodadas de aquecimento.

### Métricas de memória

`memoryBytes` registra a memória antes de abrir a base, após abri-la, após o primeiro lote de consultas, após a coleta de lixo desse lote e ao final das medições, sempre antes de fechar o leitor. A coleta de lixo inicial e a do primeiro lote ficam fora das medições de tempo.

Todos os valores de memória estão em bytes. `rss` é o consumo do processo reportado pelo Bun, incluindo o runtime e a lista de consultas; não representa apenas o banco. `heapUsed`, `heapTotal`, `external` e `arrayBuffers` são os valores originais de `process.memoryUsage()`. Não os some: há sobreposição, e o Bun pode incluir buffers externos em `heapUsed`. `heapObjectBytes` separa os objetos do heap de strings e buffers alocados externamente, usando `heapSize - extraMemorySize` de `bun:jsc`. Esse contador reflete a última coleta de lixo; compare `beforeOpen` com `afterFirstBatchGc` para avaliar os objetos que continuam ocupando memória. [Detalhes das métricas do Bun](https://bun.com/reference/bun/jsc/heapStats).

## Importação a partir da fonte pública

Medição histórica de **30/08/2026**, com **10 execuções** do `@konstit/dne`. A geração completa levou **5,73 segundos em média**, incluindo o download, e produziu uma base com **1.605.136 registros**. Os tamanhos desta comparação estão em **MiB**.

| Métrica                       |                 `@konstit/dne` | `edne-correios-loader` |
| ----------------------------- | -----------------------------: | ---------------------: |
| Tempo de importação reportado | 5,73 s (média de 10 execuções) |                   30 s |
| Tamanho da base SQLite        |                      125,4 MiB |  394 MiB, sem `VACUUM` |

A comparação registrada usou `uvx edne-correios-loader load --database-url sqlite:///dne.db` nas mesmas condições e apontou importação **5,2× mais rápida**, com **68,2% menos espaço em disco** para o `@konstit/dne`. Esse resultado é separado do benchmark de consultas acima, cuja base SQLite ocupa 109,2 MB.

Para executar os benchmarks de importação e download disponíveis no projeto:

```sh
bun run benchmark
bun run benchmark:download
```

Os demais scripts estão em [`package.json`](../package.json).
