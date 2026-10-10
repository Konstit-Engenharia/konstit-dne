# Medição de desempenho do autocomplete HTTP

O benchmark HTTP compara a API síncrona com pools de workers sob requisições concorrentes. Ele mede latência, vazão, memória do servidor, tempo de abertura e resposta de uma rota de controle. Use-o para dimensionar o pool com a base e o ambiente da aplicação.

As instruções de uso da biblioteca estão na [API de autocomplete](address-search.md) e no [exemplo com Bun.serve](../examples/README.md).

## Executar

Na raiz do repositório, com Bun, o comando `ps`, uma base binária e seu índice compatível:

```sh
bun run benchmark:search-http data/dne.bin data/dne.search.bin
```

Para verificar rapidamente o funcionamento do coletor:

```sh
DNE_BENCH_ROUNDS=1 DNE_BENCH_DURATION_MS=300 \
DNE_BENCH_WARMUP_MS=100 DNE_BENCH_CONCURRENCY=1,8 \
bun run benchmark:search-http data/dne.bin data/dne.search.bin
```

Uma execução curta serve para verificar a coleta; use várias rodadas para avaliar desempenho. O comando exibe o progresso e, ao terminar, informa onde salvou o relatório. Um terceiro argumento permite escolher o destino.

## Configuração

| Variável | Padrão | Significado |
| --- | --- | --- |
| `DNE_BENCH_ROUNDS` | `7` | Repetições de cada combinação de API e concorrência. |
| `DNE_BENCH_DURATION_MS` | `3000` | Duração da janela de requisições medida, em milissegundos. |
| `DNE_BENCH_WARMUP_MS` | `500` | Duração de cada uma das duas fases de aquecimento. |
| `DNE_BENCH_CONCURRENCY` | `1,8,32` | Quantidades de requisições simultâneas, separadas por vírgulas. |

O coletor usa a API síncrona e pools de um, dois e quatro workers. Cada pool permite 64 buscas aguardando. A concorrência máxima aceita é 65, para evitar sobrecarga deliberada da fila do pool com um worker.

## Carga e validação

Cada medição inicia novos processos de servidor e cliente. O servidor usa `Bun.serve`; o cliente envia requisições HTTP locais, reutiliza conexões e alterna treze consultas com prefixos, filtros geográficos, busca ampla, ausência de resultado e CEP exato. O limite é de dez resultados.

O cliente compara cada resposta integralmente com a referência síncrona, incluindo campos e ordenação. A rota `/health` responde apenas `ok`, permitindo observar se o trabalho de busca atrasa outras rotas. O coletor alterna a ordem dos modos e concorrências entre rodadas.

O [coordenador](../bench/address-search-http.bench.ts), o [servidor](../bench/address-search-http-server.bench.ts), o [cliente](../bench/address-search-http-client.bench.ts) e o [cálculo de percentis](../bench/address-search-http-common.ts) usam a implementação da biblioteca.

## Interpretar as métricas

- **Latência:** intervalo entre o início de `fetch()` e a leitura completa do corpo. Os percentis agregados são medianas dos percentis de cada repetição, não percentis globais de todas as requisições.
- **Vazão:** respostas corretas por segundo. O denominador inclui a drenagem das requisições iniciadas dentro da janela medida.
- **Abertura:** tempo até a API estar pronta para aceitar consultas, separado da janela de busca.
- **RSS:** memória residente do processo servidor inteiro, incluindo os workers. Cliente e coordenador ficam fora desse valor.
- **Rota de controle:** latência de `/health` durante a carga de buscas.

O coordenador amostra o RSS com `ps -o rss= -p PID` a cada 100 ms nominalmente, sem forçar coleta de lixo no servidor. Ele registra valores após abertura, após aquecimento, a mediana durante a carga e o maior valor amostrado. Picos entre amostras podem ser perdidos; RSS também inclui runtime e memória retida pelo alocador.

A carga usa um modelo fechado: cada fluxo espera a resposta antes de enviar a próxima requisição. Ela não representa uma taxa independente de chegada, não corrige a subamostragem de atrasos causada por esse modelo e não inclui TLS, proxy ou cotas de CPU. Cache do sistema, atividade externa e escalonamento influenciam os resultados.

## Dimensionar o pool

Abra o pool durante a inicialização do servidor e reutilize-o entre requisições. A base e o índice são compartilhados, mas cada worker mantém seu vocabulário decodificado, mapas, caches, buffers de busca e heap JavaScript. Mais workers aumentam o paralelismo e também consomem memória adicional.

Compare configurações usando os mesmos dados, consultas, limites, dependências e condições de execução. Observe a variação entre rodadas junto com latência, vazão e memória. Os resultados locais não são limites de memória nem garantias de latência em produção.
