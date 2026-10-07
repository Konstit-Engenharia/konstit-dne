# Autocomplete de endereços

O autocomplete experimental usa um índice invertido opcional associado à base binária. Pesquisa palavras de `logradouro`, `bairro`, `municipio` e `nome`, mantendo um resultado por CEP e preservando os campos originais, inclusive `complemento`.

## Gerar e consultar

Gere o índice a partir da base que será consultada. A geração não modifica `dne.bin`:

```sh
bunx @konstit/dne build-search-index --db ./dne.bin
bunx @konstit/dne build-search-index --db ./dne.bin --output ./indices/autocomplete.bin --json
```

O comando exige uma base binária existente. Sem `--output`, grava `<base>.search.bin` ao lado da base. Constrói e valida o índice antes de substituir o destino por renomeação atômica. `--quiet` oculta o progresso e `--json` retorna caminho, quantidade de registros, bytes e duração. Para executar os scripts de desenvolvimento:

```sh
bun run build:search-index data/dne.bin data/dne.search.bin
bun run benchmark:search data/dne.bin data/dne.search.bin
```

```typescript
import { DneAddressSearch, DneBinaryDatabaseReader } from '@konstit/dne';

const database = new DneBinaryDatabaseReader('./dne.bin');
const search = new DneAddressSearch(database, './dne.search.bin');

try {
  console.log(search.searchAddresses('rubens mei', { uf: 'SP', limit: 10 }));
  console.log(search.searchAddresses('rubens mei', { municipioCodIbge: 3550308 }));
  console.log(search.searchAddresses('rubens mei CEP: 01141-000', { uf: 'SP' }));
} finally {
  search.close();
  database.close();
}
```

A API `buildAddressSearchIndex(database)` retorna os bytes para salvar com `Bun.write()` ou outra API de arquivos. O índice não acompanha automaticamente o pacote e não é aberto por `queryCep()`. Após atualizar a base, gere um novo índice. O construtor rejeita um índice cujo checksum da base ou quantidade de registros difere do leitor informado. A versão atual do índice é **2**; índices da versão 1 precisam ser regenerados. O formato do banco principal permanece igual.

`DneBinaryDatabaseReader.entries()` percorre os endereços em ordem de CEP sem materializar a base toda em objetos. `checksum()` retorna o SHA-256 verificado ao abrir a base. Ambos exigem um leitor aberto.

## Regras da consulta

- A normalização reutiliza `expandAddress()`, incluindo acentos, caixa, pontuação e abreviações contextuais. Os números dos nomes de ruas são preservados.
- Todas as palavras precisam ocorrer no endereço. Apenas a última palavra aceita prefixo; `rubens mei` encontra `Rubens Meireles`, mas `rub mei` não completa as duas palavras.
- As palavras podem estar em campos diferentes: `campinas rubens mei` pesquisa também o município escrito no texto.
- `uf` e `municipioCodIbge` são filtros cumulativos. UF é tipada como `UF` e normalizada com `parseUF()` em execução. Filtros inválidos ou incompatíveis retornam `[]`.
- Um CEP completo de oito dígitos, com ou sem hífen, é reconhecido quando separado de letras, outros dígitos e `_`. O marcador `CEP` e dois-pontos são opcionais. O CEP é removido do texto pesquisável e seu código IBGE restringe a consulta; ele não restringe os resultados àquela rua.
- CEP desconhecido retorna `[]`. Se vários CEPs forem encontrados, todos precisam existir e pertencer ao mesmo município, respeitando os filtros explícitos.
- Uma consulta contendo somente CEP retorna os endereços exatos correspondentes, sem duplicatas, em ordem de CEP.
- Consultas vazias, sem palavras ou compostas somente de tipos comuns de via e preposições retornam `[]`.
- `limit` aceita inteiros entre 1 e 50 e vale 10 por padrão. Texto com mais de 256 caracteres ou limite inválido lança `RangeError`.
- O ranking prioriza nome exato, sequência de palavras e correspondências fora de ordem. Tipos comuns de via podem ser omitidos ao comparar o nome exato: `paulista` prioriza `Avenida Paulista`. O logradouro tem prioridade sobre destinatário, bairro e município dentro da mesma categoria; palavras completas ajudam no desempate. CEP crescente é o desempate final.
- A primeira versão não corrige erros de digitação, não converte números escritos por extenso, não interpreta números de imóveis nem faz geocodificação. Por exemplo, `25 de março` não encontra `Rua Vinte e Cinco de Março`; use `vinte e cinco de mar` nessa base.

O construtor aceita um caminho ou `Uint8Array`. Um caminho é lido diretamente para um buffer próprio, evitando a cópia adicional; bytes fornecidos pelo chamador continuam sendo copiados para preservar o isolamento. As duas formas validam estrutura, integridade e vínculo com a base. Mudanças posteriores no arquivo não alteram o leitor aberto. `search.close()` libera o índice e os buffers de consulta, mantendo o leitor do chamador aberto. Consultas após fechar qualquer um dos dois falham, inclusive consultas vazias. SHA-256 detecta corrupção, mas não autentica o produtor dos arquivos.

## Formato do índice experimental

Inteiros são little-endian. Na versão 2, cada registro aponta para quatro sequências de palavras, na ordem `logradouro`, `nome`, `bairro`, `municipio`. Sequências iguais compartilham um ID, inclusive entre campos. A posição de cada palavra é a sua posição na sequência. O formato é independente da versão do banco principal:

| Parte | Conteúdo |
| --- | --- |
| Cabeçalho de 80 bytes | Magic da família `DNESRCH1`, versão `u32` em 8, quantidade de CEPs em 12, bytes do vocabulário em 16, quantidade de termos em 20, bytes dos postings em 24, quantidade de sequências em 28, SHA-256 da base em 32..63, quantidade total de posições em 64, quantidade de municípios em 68. Bytes 72, 73 e 74 indicam as larguras de IDs de sequência, termo e município. Bytes 75..79 são reservados e zero. |
| CEPs | Um `u32` por registro, em ordem crescente. |
| Municípios dos registros | Um ID por registro, com a largura declarada no cabeçalho. |
| Campos dos registros | Quatro IDs de sequência por registro, com a largura declarada no cabeçalho. |
| Municípios | Um código IBGE `u32` e dois bytes ASCII da UF por município. |
| Offsets das sequências | `quantidade de sequências + 1` valores `u32`, em posições de palavras. |
| Palavras das sequências | IDs de termos na ordem original, com a largura declarada no cabeçalho. |
| Offsets dos postings | `quantidade de termos + 1` valores `u32`, relativos ao início dos postings. |
| Vocabulário | Array JSON UTF-8 de termos únicos em ordem lexicográfica. Não contém listas de filtros geográficos. |
| Postings | IDs de registros crescentes, codificados como diferenças em varints de 7 bits. O predecessor inicial é `-1`. |
| Rodapé | SHA-256 de 32 bytes sobre todos os bytes anteriores. |

O leitor valida offsets, referências, posições, CEPs, municípios e todos os postings ao abrir. As consultas localizam os termos por busca binária e percorrem os postings diretamente, unindo prefixos e intersectando palavras em dois bitmaps reutilizáveis. UF e município são verificados nas colunas numéricas antes do ranking, sem expandir listas geográficas. O ranking lê IDs e posições diretamente, com pontuações em um `Uint16Array` reutilizável; apenas os resultados finais são decodificados na base principal. CEPs no texto também são resolvidos pelo índice. O limite não limita a quantidade de candidatos avaliados.

Os buffers de trabalho são alocados na primeira consulta textual com termos conhecidos e reutilizados até `close()`: `8 × ceil(registros / 32) + 2 × sequências` bytes. Na base medida, são **2,17 MB por instância**, sem listas de candidatos ou objetos por campo. As consultas são síncronas e reinicializam esses buffers a cada chamada.

## Resultado do primeiro experimento em 07/10/2026 — versão 1

Base local com **1.611.629 CEPs**, Apple M4 e Bun 1.4.2. O benchmark executou três aquecimentos e vinte medições por consulta em um processo, com limite de dez resultados. Os percentis abaixo descrevem essa pequena amostra local e excluem abertura e geração. Os [resultados completos](address-search-benchmark.json) incluem o checksum da base e exemplos dos resultados.

| Consulta | Filtro | p50 | p95 |
| --- | --- | ---: | ---: |
| `rubens mei` | Nenhum | 0,32 ms | 0,45 ms |
| `rubens mei` | UF SP | 2,86 ms | 3,12 ms |
| `rubens mei` | Município 3550308 | 0,45 ms | 0,50 ms |
| `rubens mei 01141-000` | UF SP + município inferido | 2,31 ms | 2,64 ms |
| `paulista` | UF SP | 116,36 ms | 124,29 ms |
| `paulista` | Município 3550308 | 17,55 ms | 18,02 ms |
| `joao` | Município 3550308 | 26,53 ms | 28,25 ms |
| `sao` | Município 3550308 | 657,39 ms | 740,47 ms |
| `sao` | Nenhum | 2.687,90 ms | 2.929,66 ms |

O índice ocupa **25,86 MB**, além dos 19,12 MB da base. A geração com cache de normalização de localidades levou 18,23 s em uma execução separada. A abertura do leitor principal levou 14,56 ms, e a leitura, cópia e validação do índice levaram 68,24 ms.

O RSS total do processo passou de 57,61 MB com apenas a base aberta para 141,21 MB após abrir o índice e solicitar GC; ao fim das consultas, sem novo GC, estava em 637,86 MB. RSS inclui o runtime, buffers e memória retida pelo alocador, e não corresponde ao tamanho lógico do índice nem a uma medição isolada de pico.

No primeiro experimento, consultas específicas funcionaram bem, mas buscas genéricas eram lentas. O ranking da versão 1 decodificava os candidatos antes de escolher os dez resultados. Isso motivou a classificação numérica e os filtros geográficos diretos da versão 2, medidos abaixo. Nenhuma das versões foi comparada com FTS5.

Validação: 944 testes passaram, com 100% de cobertura agregada de linhas e funções, incluindo normalização, filtros cumulativos, CEPs desconhecidos e conflitantes, ordenação, integridade do índice e reprodução pelo comando de geração. TypeScript, Biome, Oxlint, build e auditoria de dependências passaram. O exemplo de CEP no texto também foi verificado com a biblioteca compilada em `dist`.

## Segundo experimento em 07/10/2026 — versão 2

Os dois leitores foram medidos novamente em processos separados, com a mesma base, Apple M4, Bun 1.4.2 e carga de treze consultas. Cada consulta teve três aquecimentos e vinte medições; tempos de abertura foram medidos separadamente. A referência usa o commit `970fd5c`. Consulte os resultados brutos [antes](address-search-benchmark-before-v2.json) e [depois](address-search-benchmark-v2.json). São percentis de uma pequena amostra local, não uma garantia de latência em produção.

| Consulta | Filtro | p95 v1 | p95 v2 | Redução de tempo |
| --- | --- | ---: | ---: | ---: |
| `rubens mei` | UF SP | 3,20 ms | 0,16 ms | 20,0× |
| `rubens mei 01141-000` | UF SP + município inferido | 2,58 ms | 0,17 ms | 15,0× |
| `paulista` | UF SP | 123,03 ms | 4,52 ms | 27,2× |
| `paulista` | Município 3550308 | 17,29 ms | 1,29 ms | 13,4× |
| `joao` | UF SP | 252,89 ms | 7,04 ms | 35,9× |
| `sao` | Município 3550308 | 733,33 ms | 18,01 ms | 40,7× |
| `sao` | Nenhum | 2.927,50 ms | 46,20 ms | 63,4× |

O ganho tem custo de armazenamento: o índice aumentou de **25,86 MB para 58,73 MB (2,27×)**. A geração levou 19,21 s. A abertura passou de 82,49 ms para 108,08 ms. RSS após abertura e GC passou de 142,11 MB para 216,61 MB; ao fim das consultas, sem novo GC, de 617,38 MB para 702,22 MB. A redução de trabalho por consulta não resultou em redução global de memória nesta medição. RSS inclui runtime e memória retida pelo alocador; não representa pico nem somente dados vivos. Materialização de listas textuais e caches temporários de ranking continuam sendo oportunidades para reduzir alocações.

Uma comparação adicional verificou **173 consultas e 966 endereços retornados**, preservando todos os campos e a ordem em relação à versão 1. Inclui a carga fixa e consultas derivadas de quarenta endereços espaçados pela base, com prefixos, palavras em ordem inversa, filtros por UF/IBGE, limites de 3/10/50 e CEP no texto. O [registro de equivalência](address-search-equivalence-v2.json) inclui o checksum da base. Para reproduzir com uma cópia da biblioteca anterior e seu índice:

```sh
bun run bench/address-search-verify.bench.ts data/dne.bin /copia-v1/src/library.ts data/dne.search.v1.bin data/dne.search.bin
```

A suíte completa passou com **947 testes e 100% de cobertura de linhas e funções**. Os novos testes comparam pontuações numéricas ao ranking textual original, validam referências geográficas e posições corrompidas e contam chamadas a `queryCep()` para garantir exatamente uma decodificação por resultado retornado. TypeScript, lint, build e auditoria passaram.

## Terceiro experimento em 07/10/2026 — memória e CLI

A comparação usa o commit `a01e7f6` como referência, o mesmo índice v2 de **58,73 MB**, a mesma base, Apple M4 e Bun 1.4.2. O formato do arquivo não mudou; um índice v2 existente continua válido. Além dos bitmaps e do cache numérico reutilizável, a seleção dos melhores resultados deixou de criar uma função temporária por candidato. A API agora pode ler o arquivo diretamente, evitando a cópia defensiva necessária quando recebe bytes do chamador.

| RSS do processo | Referência v2, bytes | Atual, caminho | Atual, bytes |
| --- | ---: | ---: | ---: |
| Após abrir e solicitar GC | 218,61 MB | 149,08 MB | 209,73 MB |
| Ao terminar as consultas, antes de novo GC | 687,59 MB | 166,41 MB | 231,65 MB |
| Após solicitar GC novamente | 687,65 MB | 166,45 MB | 232,54 MB |

Com abertura por caminho, o RSS ao final caiu **75,8%** nesta carga; mantendo a entrada por bytes, caiu **66,3%**. RSS mede o processo inteiro, incluindo runtime, buffers e memória retida pelo alocador. O benchmark também registra o maior RSS observado após cada consulta, sem afirmar que esse valor seja o pico do processo. A geração do índice não foi otimizada para memória neste experimento.

| Consulta | Filtro | p95 referência | p95 atual, caminho |
| --- | --- | ---: | ---: |
| `rubens mei` | UF SP | 0,28 ms | 0,65 ms |
| `paulista` | UF SP | 4,58 ms | 2,51 ms |
| `joao` | UF SP | 7,26 ms | 5,26 ms |
| `sao` | Município 3550308 | 18,20 ms | 8,83 ms |
| `sao` | Nenhum | 44,77 ms | 17,70 ms |

Consultas pequenas passaram a ter o custo fixo de limpar e percorrer bitmaps e o cache; algumas ficaram mais lentas, embora abaixo de 1 ms nos casos medidos. Consultas amplas reduziram tempo e alocações. Os tempos mantêm três aquecimentos e vinte amostras por consulta em processos separados, com abertura excluída. Consulte os relatórios [de referência](address-search-memory-before.json), [com abertura por caminho](address-search-memory-after.json) e [com entrada por bytes](address-search-memory-after-bytes.json).

Para reproduzir com uma cópia do código anterior:

```sh
bun run bench/address-search.bench.ts data/dne.bin data/dne.search.bin /copia-a01e7f6/src/library.ts bytes
bun run bench/address-search.bench.ts data/dne.bin data/dne.search.bin
bun run bench/address-search.bench.ts data/dne.bin data/dne.search.bin src/library.ts bytes
```

O [teste de equivalência](address-search-memory-equivalence.json) confirmou novamente os mesmos campos e a mesma ordem em **173 consultas e 966 resultados**. A suíte passou com **951 testes e 100% de cobertura agregada de linhas e funções**, além de TypeScript, lint, build e auditoria. Os novos testes cobrem reutilização de buffers, limites entre palavras do bitmap, abertura por caminho, saída padrão e personalizada da CLI, JSON, substituição de índice, proteção da base e limpeza de temporários após falha.

O comando `build-search-index --db data/dne.bin --output data/dne.search.cli.bin --quiet --json` gerou o índice completo em **20,22 s**, com bytes idênticos ao gerador existente. Ele grava um temporário no diretório de saída e só então substitui o destino por renomeação.
