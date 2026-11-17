# Desenvolvimento

[Voltar ao README](../README.md)

Instale as dependências na raiz do repositório:

```sh
bun install
```

Para importar o ZIP remoto no desenvolvimento local, configure `EDNE_SOURCE_URL` no arquivo `.env`. O Bun carrega essa variável ao executar `build:database`, que a passa explicitamente para `--source`.

```sh
bun run build:database --db ./data/dne.db
bun run build:database --format binary --db ./data/dne.bin
```

Para usar outro diretório, ZIP ou URL, execute `bun run cli build --source CAMINHO_OU_URL`.

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

`npm pack` e `bun pm pack` executam `prepack` para compilar a CLI, a biblioteca e suas declarações. O tarball contém o código e a documentação. Cada usuário gera sua base com `build --source CAMINHO_OU_URL`.

Os testes de distribuição empacotam o projeto, instalam o tarball e usam a CLI instalada para gerar uma base a partir de uma fixture local. Também verificam consultas síncronas e pelo pool em bundles simples, bundles com chunks e executáveis compilados com assets fornecidos pela aplicação. Veja [como empacotar os dados com a aplicação](address-search.md#bundles-e-executáveis-do-bun).

Os workflows de CI e publicação usam o secret `EDNE_SOURCE_URL` como `--source` no teste do pacote instalado. Esse teste importa o ZIP remoto e consulta a base gerada.

Para gerar o tarball, execute o comando abaixo.

```sh
npm pack
```

Os arquivos de `dist` e `data` permanecem fora do Git.
