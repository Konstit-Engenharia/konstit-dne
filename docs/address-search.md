# Autocomplete de endereços

O autocomplete usa um índice invertido opcional associado à base binária. Pesquisa palavras de `logradouro`, `bairro`, `municipio` e `nome`, mantendo um resultado por CEP e preservando os campos originais, inclusive `complemento`.

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

## Pool assíncrono de workers

`DneAddressSearchPool` executa o mesmo buscador síncrono em threads persistentes usando a API nativa `Worker` do Bun, mantendo o event loop da aplicação disponível. A API síncrona `DneAddressSearch` não mudou. O primeiro worker carrega a base e o índice uma única vez em dois `SharedArrayBuffer`; todos os workers consultam esses mesmos bytes, com validação na abertura e buffers temporários privados.

```typescript
import { DneAddressSearchPool } from '@konstit/dne';

const search = await DneAddressSearchPool.open({
  databasePath: './dne.bin',
  indexPath: './dne.search.bin',
  workers: 2,
  maxQueue: 64,
});

try {
  const addresses = await search.searchAddresses('rubens mei', {
    municipioCodIbge: 3550308,
    limit: 10,
    signal: AbortSignal.timeout(1_000),
  });
  console.log(addresses);
} finally {
  await search.close();
}
```

Em um servidor, crie o pool na inicialização, reutilize-o em todas as requisições e feche-o no encerramento. O [`examples/address-search-server.ts`](../examples/address-search-server.ts) contém um endpoint completo com `Bun.serve`; o [guia do exemplo](../examples/README.md) documenta execução, configuração e respostas HTTP.

### Configuração e métodos

`DneAddressSearchPool.open(options): Promise<DneAddressSearchPool>` aceita `AddressSearchPoolOptions`:

| Opção | Padrão | Regra |
| --- | --- | --- |
| `databasePath` | Base incluída no pacote | Caminho opcional e não vazio. |
| `indexPath` | Obrigatório | Caminho não vazio do índice já gerado para essa base. |
| `workers` | `1` | Inteiro positivo e seguro. |
| `maxQueue` | `64` | Inteiro seguro maior ou igual a zero. Conta apenas consultas aguardando; `0` admite somente consultas que possam iniciar imediatamente. |

Caminhos relativos são resolvidos a partir do diretório atual em `open()`. O índice não acompanha automaticamente o pacote. `open()` só resolve quando todos os workers estão prontos. O primeiro worker publica o snapshot depois de validar o par; os demais recebem os buffers e também validam suas views, sem reler os arquivos. Se houver erro de criação ou carregamento, aguarda o evento de fechamento dos workers criados antes de rejeitar. Mantenha os arquivos imutáveis durante a leitura inicial. Para atualizar os dados, abra outro pool com o novo par de arquivos e drene o anterior.

`searchAddresses(text, options): Promise<DneRow[]>` aceita `AddressSearchAsyncOptions`: os mesmos filtros e limite de `AddressSearchOptions`, mais `signal?: AbortSignal`. Os resultados, campos e ranking são os mesmos do buscador síncrono. Opções são copiadas ao admitir a consulta. Todas as falhas são rejeições da promessa, inclusive pool fechado e fila cheia. Erros de consulta, como `RangeError` para limite inválido, não inutilizam o worker.

Consultas aguardam em ordem de chegada e são distribuídas conforme os workers ficam disponíveis. Com vários workers, a ordem de conclusão pode ser diferente da ordem de envio. O limite de trabalho admitido é `workers + maxQueue`.

`close(): Promise<void>` interrompe imediatamente a admissão, conclui as consultas já aceitas e aguarda a saída de todos os workers. Chamadas repetidas retornam a mesma promessa. Um pool aberto mantém o processo vivo; sempre feche-o ao encerrar a aplicação.

### Cancelamento e falhas

- Um sinal já abortado rejeita imediatamente com `signal.reason`, sem ocupar a fila.
- Cancelar uma consulta pendente remove-a da fila e libera a vaga.
- Cancelar uma consulta em execução rejeita a promessa, mas o cálculo síncrono continua no worker. O resultado é descartado, e a vaga só é liberada quando o cálculo termina. `close()` também aguarda esses cálculos.
- O sinal é tratado na thread chamadora e não é enviado ao worker. Um prazo com `AbortSignal.timeout()` inclui o tempo na fila; não constitui um limite rígido de CPU.
- Falha inesperada de qualquer worker rejeita as consultas pendentes e em execução e encerra todo o pool. Não há reinício nem repetição automática. A aplicação pode abrir um novo pool após tratar a causa.

Os erros públicos permitem tratamento com `instanceof` ou `code`:

| Classe | `code` | Significado |
| --- | --- | --- |
| `DneAddressSearchQueueFullError` | `SEARCH_QUEUE_FULL` | Todos os workers estão ocupados e a fila atingiu o limite. |
| `DneAddressSearchPoolClosedError` | `SEARCH_POOL_CLOSED` | A aplicação chamou `close()` e tentou enviar outra consulta. |
| `DneAddressSearchWorkerError` | `SEARCH_WORKER_FAILED` | Inicialização, comunicação ou execução do worker falhou; `cause` contém o diagnóstico. Consultas posteriores também rejeitam com esse erro. |

Contagens inválidas em `open()` geram `RangeError`; caminhos vazios geram `TypeError`. Falhas de leitura e validação nos workers são encapsuladas em `DneAddressSearchWorkerError`, sem garantia de preservar o protótipo dos erros do leitor em `cause`.

### Memória e distribuição

Os bytes da base e do índice são compartilhados dentro de cada pool. Vocabulário decodificado, mapas, caches, buffers de candidatos e pontuação e o heap JavaScript continuam privados de cada worker. Aumentar `workers` ainda tem custo adicional de memória e comunicação; não garante uma consulta individual mais rápida.

Os buffers compartilhados são internos e não são expostos pela API pública. O pool termina todas as escritas antes de publicá-los e nunca os altera depois; `SharedArrayBuffer` não oferece proteção de somente leitura. As consultas não precisam de locks nem de operações atômicas. Fechar um leitor libera apenas suas referências e caches, sem invalidar os outros workers. Na API síncrona, fornecer um `Uint8Array` continua criando uma cópia defensiva. Cada pool possui seu próprio snapshot; pools e processos diferentes não compartilham esses buffers automaticamente.

O [guia de medição HTTP do autocomplete](address-search-http.md) explica como medir latência, vazão, RSS e resposta de outra rota usando a API síncrona e pools de workers sob requisições concorrentes.

### Bundles e executáveis do Bun

O pool cria workers a partir de Blob URLs. O JavaScript do worker e suas dependências são compilados previamente e incorporados à biblioteca como uma string; a aplicação não precisa distribuir um arquivo separado do worker nem compilá-lo em tempo de execução. As URLs são revogadas quando os workers fecham ou quando sua criação falha. A API de `open()`, busca e fechamento permanece igual.

O pacote instalado, bundles ESM simples, bundles com `--splitting` e executáveis `--compile` são suportados. Não é necessário usar `--external @konstit/dne` nem fornecer o worker como um segundo entrypoint. Um bundle JavaScript ainda precisa do Bun para executar. Os arquivos de dados seguem as regras abaixo:

- Caminhos fornecidos como strings em `databasePath` e `indexPath` apontam para arquivos externos. Use caminhos absolutos ou distribua esses arquivos em relação ao diretório de execução.
- A base padrão do pacote é resolvida no processo principal, antes de iniciar o primeiro worker. O bundler do Bun inclui esse asset no build.
- Para incorporar o índice, importe-o com `with { type: 'file' }` e resolva seu caminho a partir de `import.meta.url`. O índice precisa corresponder à base.
- Em bundles JavaScript, distribua todo o diretório de saída, incluindo os arquivos `.bin` e eventuais chunks. Em um executável, os assets importados ficam embutidos no próprio arquivo.

Exemplo de `app.ts` usando a base padrão e um índice já gerado para ela:

```typescript
import { fileURLToPath } from 'node:url';
import { DneAddressSearchPool } from '@konstit/dne';
import indexAsset from './data/dne.search.bin' with { type: 'file' };

const pool = await DneAddressSearchPool.open({
  indexPath: fileURLToPath(new URL(indexAsset, import.meta.url)),
  workers: 2,
});
try {
  console.log(await pool.searchAddresses('rubens mei', { uf: 'SP', limit: 10 }));
} finally {
  await pool.close();
}
```

```sh
# JavaScript e assets no diretório build/.
bun build ./app.ts --target=bun --outdir ./build
bun ./build/app.js

# Um executável contendo runtime, código, base padrão e índice importado.
bun build ./app.ts --compile --outfile ./address-search
./address-search
```

Uma base personalizada também pode ser importada como asset de um arquivo próprio da aplicação e passada por `databasePath`; seu índice deve ser gerado a partir dessa mesma base. Para projetos TypeScript, declare `module '*.bin'` com um export default do tipo `string`, se necessário.

Arquivos externos são lidos diretamente nas alocações compartilhadas. Para assets embutidos que não oferecem um descritor de arquivo nativo no Bun, a carga inicial usa `readFileSync` e uma cópia para `SharedArrayBuffer`. Isso pode aumentar a memória transitória na inicialização; os demais workers continuam recebendo os mesmos buffers, sem uma cópia da base e do índice por worker.

No desenvolvimento da biblioteca, `bun run build:worker` regenera `src/address-search-worker-source.ts` a partir do worker e de suas dependências. Esse arquivo gerado é versionado para permitir o uso direto dos fontes. `bun run build` o atualiza automaticamente; os testes verificam que ele está sincronizado. Após alterar código usado pelo worker, regenere-o antes de rodar os testes. A aplicação consumidora não precisa dessa etapa.

## Formato do índice

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

Os buffers de trabalho são alocados na primeira consulta textual com termos conhecidos e reutilizados até `close()`: `8 × ceil(registros / 32) + 2 × sequências` bytes, sem listas de candidatos ou objetos por campo. As consultas são síncronas e reinicializam esses buffers a cada chamada.
