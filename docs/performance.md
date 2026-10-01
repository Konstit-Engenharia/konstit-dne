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

Estes resultados usam o formato binário v1. A compressão das versões v2 e v3 altera o tamanho do arquivo e o tempo das consultas; a tabela acima permanece como referência histórica.

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

## Compressão do binário v3

Investigação em **30/09/2026**, no Apple M4 com Bun 1.4.2, usando a mesma base SQLite normalizada de 1.611.629 CEPs e 84.952 bairros para todas as variantes. A referência é o commit `74d9cbe`, que já comprime os índices de bairro com RLE e Elias–Fano. A v3 preserva a API pública do leitor e exige regenerar os binários anteriores.

| Variante | Bytes do arquivo | Economia sobre a etapa anterior |
| --- | ---: | ---: |
| v2: bairros com RLE/Elias–Fano | 28.046.056 | — |
| + runs conjuntos de município e indicadores | 23.299.488 | 4.746.568 (16,92%) |
| + IDs de logradouro em 20 bits, v3 | **22.493.680** | 805.808 (3,46%) |
| + FSST nos sufixos, experimental | **18.674.624** | 3.819.056 (16,98%) |

As duas alterações incorporadas à v3 economizam **19,80%** sobre a v2. Há apenas 9.017 runs de município/indicadores para 1.611.629 linhas. Um diretório a cada 256 linhas limita a busca dentro dos runs. Os 815.305 nomes distintos de logradouro exigem 20 bits por ID, incluindo zero para nulo, em vez dos 24 bits anteriores.

### Tempo de consulta

Cada comparação valida primeiro a igualdade de todos os resultados de `queryCep` para os 1.611.629 CEPs. Depois executa três aquecimentos e onze medições por leitor, alternando a ordem AB/BA. As cargas têm 100 mil consultas: somente existentes, metade existentes/metade ausentes e somente ausentes. Os CEPs existentes são amostrados ao longo de toda a base; os ausentes são confirmados no SQLite. Consultas embaralhadas e sementes fixas tornam os conjuntos reproduzíveis.

Medianas em milissegundos por 100 mil consultas. Cada linha é uma comparação dentro do mesmo processo; não compare tempos absolutos de linhas diferentes como uma sequência de ganhos.

| Comparação | Existentes: antes → depois | Mista: antes → depois | Ausentes: antes → depois |
| --- | ---: | ---: | ---: |
| Runs de município/indicadores | 78,28 → 76,99 | 39,72 → 40,01 | 5,02 → 4,95 |
| IDs de logradouro em bits | 73,70 → 74,75 | 42,61 → 41,69 | 5,12 → 5,11 |
| v2 → v3, ambas as mudanças | **76,34 → 74,24** | **45,27 → 43,48** | 6,07 → 5,53 |
| v3 → FSST nos sufixos | 74,10 → 73,70 | 40,44 → 42,34 | 5,43 → 5,97 |
| v3 → FSST nos nomes completos | 72,37 → 64,50 | 39,91 → 36,55 | 5,21 → 5,29 |

O resultado sustenta manter as duas mudanças da v3: redução relevante de tamanho sem regressão observada de consulta nesta carga. A abertura com cache do sistema aquecido passou de 4,41 ms para 4,24 ms na comparação conjunta. As medições não avaliam leitura com cache frio nem concorrência. Diferenças pequenas dependem do runtime, hardware e carga; a oscilação dos ausentes, que não decodificam strings, não deve ser atribuída diretamente ao FSST.

### Resultado do FSST

O experimento usa o [compressor oficial FSST](https://github.com/cwida/fsst/tree/e638d4cf8c26129d73c242a4127b42b975de5b63), compilado em C++, e um decoder em TypeScript executado pelo próprio leitor em Bun. Apenas o dicionário de logradouros é substituído. Os tamanhos incluem tabela de símbolos, comprimentos comprimidos, offsets por bloco e alinhamento do arquivo.

- **Nomes completos:** elimina a reconstrução dos nomes anteriores do bloco, reduzindo o tempo de consulta em aproximadamente 8–11% nas cargas com resultados. Porém, aumenta o arquivo para **22.856.240 bytes**, 1,61% acima da v3. Não é a melhor opção para reduzir espaço nesta base.
- **Sufixos do front coding:** preserva os blocos de oito nomes, mas comprime seus sufixos com FSST. O dicionário cai de 10.358.914 para **6.539.862 bytes** e o arquivo chega a **18,67 MB**, 33,41% abaixo da v2. Consultas existentes ficaram estáveis (-0,54%); a carga mista ficou 4,67% mais lenta. É a variante mais promissora para continuar a redução.

O FSST permanece um protótipo em `bench/`, sem dependência nativa no pacote nem alteração nos dicionários da v3. Os binários experimentais usam a versão `65535` e só são aceitos pelo leitor experimental gerado. Para incorporá-lo ao produto ainda é preciso escolher a integração do encoder no processo de geração e completar a validação do formato para entradas corrompidas. O protótipo exige comprimentos comprimidos de até 255 bytes; o máximo observado foi 62 bytes nos nomes completos e 55 nos sufixos.

### Reproduzir a investigação

Os [resultados completos](benchmarks/compression-v3.json) incluem todas as amostras, tempos de abertura, tamanho e SHA-256 do SQLite de origem. Com uma base SQLite de esquema 4 em `./dne.db`, crie binários da v2 e v3:

```sh
mkdir -p outputs/compression-followup/baseline
git archive 74d9cbe src | tar -x -C outputs/compression-followup/baseline
bun -e 'import { buildBinaryDatabase } from "./outputs/compression-followup/baseline/src/binary-db-writer.ts"; await buildBinaryDatabase("./dne.db", "outputs/compression-followup/baseline-v2.bin")'
bun -e 'import { buildBinaryDatabase } from "./src/binary-db-writer.ts"; await buildBinaryDatabase("./dne.db", "outputs/compression-followup/columns-v3.bin")'
bun bench/compression.bench.ts ./dne.db outputs/compression-followup/baseline/src/binary-db-reader.ts outputs/compression-followup/baseline-v2.bin src/binary-db-reader.ts outputs/compression-followup/columns-v3.bin
```

Para o experimento FSST, são necessários Python 3, `clang++` e acesso ao GitHub para baixar a revisão fixada do compressor MIT. O script mantém fontes, artefatos e um snapshot do leitor dentro de `outputs/`:

```sh
python3 bench/fsst-experiment.py outputs/compression-followup/columns-v3.bin outputs/compression-followup
bun bench/compression.bench.ts ./dne.db src/binary-db-reader.ts outputs/compression-followup/columns-v3.bin outputs/compression-followup/fsst-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin
bun bench/compression.bench.ts ./dne.db src/binary-db-reader.ts outputs/compression-followup/columns-v3.bin outputs/compression-followup/fsst-source/src/binary-db-reader.ts outputs/compression-followup/fsst-full.bin
```

### Decoder C compilado pelo Bun e assembly NEON

O [compilador C do Bun](https://bun.com/docs/runtime/c-compiler) permite carregar o decoder com `cc()` de `bun:ffi`, usando TinyCC. O protótipo faz uma única chamada FFI por nome, incluindo toda a reconstrução do bloco, e converte os bytes UTF-8 para uma string em JavaScript. Os mesmos arquivos de **18.674.624 bytes** são usados em todos estes testes.

Foram implementadas duas variantes em [`bench/fsst-native.c`](../bench/fsst-native.c):

- **C escalar:** copia símbolos em palavras de 64 bits, dois por iteração.
- **NEON ARM64:** carrega dois símbolos de oito bytes, usa `TBL` para juntar seus bytes úteis e faz uma escrita de 16 bytes. Usa assembly inline GCC, sem `<arm_neon.h>`. O assembler TinyCC do Bun 1.4.2 instalado rejeita alguns mnemônicos NEON, como `movi`; as instruções foram emitidas com `.long`, com os códigos conferidos pelo Clang e `otool`, e clobbers explícitos para registradores e memória.

Medianas em ms por 100 mil consultas, com o mesmo protocolo de comparação em pares:

| Comparação | Existentes: antes → depois | Mista: antes → depois | Ausentes: antes → depois |
| --- | ---: | ---: | ---: |
| FSST TypeScript → C via `cc()` | **75,51 → 71,67** | 47,41 → 46,82 | 5,29 → 5,09 |
| FSST TypeScript → NEON via `cc()` | 68,87 → 66,75 | 37,08 → 37,50 | 5,09 → 4,99 |
| C escalar → NEON, ambos via `cc()` | **66,21 → 66,36** | **37,24 → 39,38** | 4,84 → 4,94 |
| FSST TypeScript → C escalar via Clang `-O3`, controle | **68,12 → 56,73** | **37,56 → 32,93** | 5,22 → 5,26 |

Nesta implementação, `cc()` reduziu o tempo em 5,08% nos existentes e 1,24% na carga mista em relação ao decoder TypeScript. NEON não trouxe ganho sobre C escalar: +0,23% e +5,76%, respectivamente. Os símbolos têm no máximo oito bytes e exigem escritas com deslocamentos variáveis; o shuffle e a preparação de registradores podem custar mais que duas cópias escalares curtas. Isso é uma hipótese para este resultado, não um limite geral para SIMD no FSST.

Como controle, o mesmo C escalar compilado com Clang `-O3` reduziu os tempos em 16,73% e 12,32% frente ao TypeScript. Portanto, a qualidade do código gerado merece investigação antes de ampliar o uso de SIMD. Esse controle usa uma biblioteca externa; `cc()` continua sendo a variante que compila inteiramente dentro do Bun.

Todas as comparações passaram pela igualdade dos 1.611.629 resultados. Além disso, [`bench/fsst-native.check.ts`](../bench/fsst-native.check.ts) executou **270 verificações** entre escalar e NEON: todas as combinações de comprimentos de símbolos de 1 a 8 bytes, prefixos, escapes, strings de 255 bytes, dados inválidos e sentinelas antes/depois do buffer. O buffer nativo tem 272 bytes para permitir as escritas largas, e seu `ArrayBuffer` é materializado antes de obter o ponteiro. A compilação e carga do módulo ficam fora das medições de consulta e abertura.

Os decoders nativos permanecem experimentais em `bench/`. O Bun também classifica `bun:ffi` e `cc()` como experimentais. A API e o decoder de produção da v3 continuam em TypeScript.

Depois de executar `fsst-experiment.py`, reproduza os testes nativos:

```sh
bun bench/fsst-native.check.ts
bun bench/compression.bench.ts ./dne.db outputs/compression-followup/fsst-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin outputs/compression-followup/fsst-native-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin
bun bench/compression.bench.ts ./dne.db outputs/compression-followup/fsst-native-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin outputs/compression-followup/fsst-neon-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin
```

O snapshot `fsst-neon-source` exige ARM64. Para o controle com Clang no macOS:

```sh
clang -O3 -dynamiclib bench/fsst-native.c -o outputs/compression-followup/fsst-clang-scalar.dylib
DNE_FSST_LIBRARY="$PWD/outputs/compression-followup/fsst-clang-scalar.dylib" bun bench/compression.bench.ts ./dne.db outputs/compression-followup/fsst-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin outputs/compression-followup/fsst-native-source/src/binary-db-reader.ts outputs/compression-followup/fsst-suffix.bin
```

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
