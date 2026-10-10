# Desenvolvimento

[Voltar ao README](../README.md)

Instale as dependências na raiz do repositório:

```sh
bun install
```

Os dados são processados em fluxo. No SQLite, a carga grava nas tabelas `dne`, `bairros` e `bairro_faixas`, sem tabelas brutas intermediárias.

## Organização do código

A implementação SQLite segue a separação entre leitura e escrita usada pelo formato binário:

| Arquivo                     | Responsabilidade                                              |
| --------------------------- | ------------------------------------------------------------- |
| `src/sqlite-db-reader.ts`   | Consultas, metadados e inspeção de arquivos SQLite.           |
| `src/sqlite-db-errors.ts`   | Exceções tipadas do leitor.                                   |
| `src/sqlite-db-writer.ts`   | Importação, validação dos registros e transações.             |
| `src/sqlite-db-insert.ts`   | Inserção de endereços em lotes e reutilização de statements.  |
| `src/sqlite-db-schema.ts`   | Geração de SQL, tabelas, views e identificadores.             |
| `src/dne-source-parser.ts`  | Leitura dos arquivos delimitados e seleção de campos.         |
| `src/dne-source-quality.ts` | Contadores, motivos de rejeição e relatório de qualidade.     |
| `src/db.ts`                 | Reexportações para compatibilidade com os imports existentes. |

## Validação

O comando `zip` é necessário para os testes com arquivos ZIP aninhados. Os testes de distribuição também usam `npm` e `tar` para empacotar e instalar uma fixture isolada, sem baixar os dados reais.

```sh
bun test
bun run coverage
bun run lint
bun run fmt
bun run benchmark
bun run benchmark:download
```

Consulte [desempenho e reprodução dos benchmarks](performance.md) para comparar os leitores e interpretar as métricas de memória.

## Distribuição do pacote

`bun run build` gera a CLI em `dist/index.js` e a biblioteca com declarações TypeScript em `dist/library.js` e `dist/library.d.ts`. Antes dessas etapas, `build:worker` empacota o worker e suas dependências em uma string JavaScript em `src/address-search-worker-source.ts`. Esse módulo gerado é versionado para permitir executar o pool diretamente do código-fonte; o pool usa a string para criar uma Blob URL por worker e a revoga no encerramento. Após alterar o worker ou suas dependências, execute `bun run build:worker` antes dos testes. O teste de distribuição executa `bun run scripts/build-address-search-worker.ts --check` para detectar uma versão desatualizada.

`npm pack` e `bun pm pack` executam `prepack`: compilam essas entradas e geram `data/dne.bin` a partir da fonte pública dos Correios. A base completa acompanha o tarball; não há script de instalação para baixá-la. Os testes de publicação verificam a CLI e a leitura da base no pacote instalado.

O módulo `src/bundled-database.ts` declara a base como asset com `with { type: 'file' }`. O leitor ou o processo principal do pool carrega esse módulo somente quando nenhum caminho é informado, permitindo importar a biblioteca e gerar bases próprias antes de existir uma base do pacote. O worker recebe o caminho absoluto já resolvido e não depende de assets relativos à Blob URL. A compilação da CLI mantém esse asset externo porque seus comandos sempre recebem um caminho de banco; a biblioteca emitida por TypeScript preserva a dependência para o build da aplicação consumidora. Os testes de publicação executam buscas síncronas e pelo pool em bundles simples, bundles com chunks e executáveis compilados após mover somente a saída e ocultar o pacote instalado. Veja [como empacotar os dados com a aplicação](address-search.md#bundles-e-executáveis-do-bun).

Para empacotar a partir de um diretório ou ZIP local, informe `DNE_PACKAGE_SOURCE`:

```sh
DNE_PACKAGE_SOURCE=/dados/eDNE_Basico.zip npm pack
```

`bun run build:package-database` prepara somente a base incluída. Os arquivos de `dist` e `data` permanecem fora do Git.
