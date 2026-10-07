# Autocomplete de endereços

O autocomplete experimental usa um índice invertido opcional associado à base binária. Pesquisa palavras de `logradouro`, `bairro`, `municipio` e `nome`, mantendo um resultado por CEP e preservando os campos originais, inclusive `complemento`.

## Gerar e consultar

Gere o índice a partir da base que será consultada. A geração não modifica `dne.bin`:

```sh
bun run build:search-index data/dne.bin data/dne.search.bin
bun run benchmark:search data/dne.bin data/dne.search.bin
```

```typescript
import { readFileSync } from 'node:fs';
import { DneAddressSearch, DneBinaryDatabaseReader } from '@konstit/dne';

const database = new DneBinaryDatabaseReader();
const search = new DneAddressSearch(database, readFileSync('data/dne.search.bin'));

try {
  console.log(search.searchAddresses('rubens mei', { uf: 'SP', limit: 10 }));
  console.log(search.searchAddresses('rubens mei', { municipioCodIbge: 3550308 }));
  console.log(search.searchAddresses('rubens mei CEP: 01141-000', { uf: 'SP' }));
} finally {
  search.close();
  database.close();
}
```

A API `buildAddressSearchIndex(database)` retorna os bytes para salvar com `Bun.write()` ou outra API de arquivos. O índice não acompanha automaticamente o pacote e não é aberto por `queryCep()`. Após atualizar a base, gere um novo índice. O construtor rejeita um índice cujo checksum da base ou quantidade de registros difere do leitor informado.

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

O construtor copia os bytes do índice e valida sua estrutura, integridade e vínculo com a base. `search.close()` libera o índice e mantém o leitor do chamador aberto. Consultas após fechar qualquer um dos dois falham, inclusive consultas vazias. SHA-256 detecta corrupção, mas não autentica o produtor dos arquivos.

## Formato do índice experimental

Inteiros são little-endian. O formato é independente da versão do banco principal:

| Parte | Conteúdo |
| --- | --- |
| Cabeçalho de 64 bytes | Magic `DNESRCH1`, versão `u32` em 8, quantidade de CEPs em 12, tamanho do vocabulário em 16, quantidade de termos em 20, tamanho dos postings em 24, reservado zero em 28, SHA-256 da base em 32..63. |
| CEPs | Um `u32` por registro, em ordem crescente. |
| Offsets dos postings | `quantidade de termos + 1` valores `u32`, relativos ao início dos postings. |
| Vocabulário | Array JSON UTF-8 de termos únicos em ordem lexicográfica, incluindo filtros `#uf:XX` e `#municipio:NNNNNNN`. |
| Postings | IDs de registros crescentes, codificados como diferenças em varints de 7 bits. O predecessor inicial é `-1`. |
| Rodapé | SHA-256 de 32 bytes sobre todos os bytes anteriores. |

O leitor valida offsets, CEPs e todos os postings ao abrir. As consultas localizam os termos por busca binária, unem os termos de um prefixo, intersectam as listas a partir da menor e classificam os candidatos. O limite de resultados não limita a quantidade de candidatos avaliados; consultas amplas exigem medição na carga da aplicação.

## Resultado do experimento em 07/10/2026

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

As consultas específicas funcionaram bem neste experimento. **A implementação ainda não está adequada para autocomplete irrestrito com termos genéricos**, especialmente porque palavras de município como `sao` selecionam muitos endereços. O ranking ainda decodifica os candidatos antes de escolher os dez resultados. Uma próxima otimização deve classificar usando informações de campo e posição no índice e decodificar somente os resultados finais, além de evitar materializar listas grandes para filtros geográficos. Esta versão não foi comparada com FTS5.

Validação: 944 testes passaram, com 100% de cobertura agregada de linhas e funções, incluindo normalização, filtros cumulativos, CEPs desconhecidos e conflitantes, ordenação, integridade do índice e reprodução pelo comando de geração. TypeScript, Biome, Oxlint, build e auditoria de dependências passaram. O exemplo de CEP no texto também foi verificado com a biblioteca compilada em `dist`.
