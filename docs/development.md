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

Outros scripts de benchmark específicos estão listados em [`package.json`](../package.json). Consulte [desempenho e reprodução dos benchmarks](performance.md) para comparar os leitores e interpretar as métricas de memória.

## Distribuição do pacote

`bun run build` gera a CLI em `dist/index.js` e a biblioteca com declarações TypeScript em `dist/library.js` e `dist/library.d.ts`. `npm pack` e `bun pm pack` executam `prepack`: compilam essas entradas e geram `data/dne.bin` a partir da fonte pública dos Correios. A base completa acompanha o tarball; não há script de instalação para baixá-la. Os testes de publicação verificam a CLI e a leitura da base no pacote instalado.

Para empacotar a partir de um diretório ou ZIP local, informe `DNE_PACKAGE_SOURCE`:

```sh
DNE_PACKAGE_SOURCE=/dados/eDNE_Basico.zip npm pack
```

`bun run build:package-database` prepara somente a base incluída. Os arquivos gerados permanecem fora do Git.
