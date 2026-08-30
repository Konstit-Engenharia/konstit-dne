# CLI para e-DNE dos Correios

Crie em segundos uma base SQLite local, compacta e pronta para consultar os CEPs do Brasil com dados do e-DNE dos Correios. Depois da carga, as consultas funcionam sem servidor e sem acesso à rede.

O `@konstit/dne` recebe um diretório, um arquivo ZIP local ou o arquivo público mais recente do e-DNE. Os dados são processados em fluxo e gravados diretamente em uma única tabela `dne` indexada, sem tabelas brutas intermediárias.

Principais vantagens:

- **Rápido e compacto:** em um benchmark de 10 execuções realizado em 2026-08-30, a geração completa a partir do arquivo público levou 5,73 segundos em média, incluindo o download. A base final continha 1.605.136 registros e ocupava 125,4 MiB.
- **Consultas locais simples:** procure um CEP, consulte vários CEPs em lote ou execute SQL somente leitura diretamente no arquivo SQLite.
- **Atualizações seguras:** o modo WAL e uma única transação permitem atualizar a base sem expor dados parciais aos processos de leitura.
- **Atualizações automáticas:** registre uma agenda com `Bun.cron` para manter a base atualizada no Linux ou macOS. Cada job usa uma versão fixada do pacote, e o lock exclusivo evita cargas simultâneas.
- **Pronto para automação:** a CLI oferece saídas JSON e JSONL estáveis, códigos de saída documentados e separação entre dados e mensagens de progresso.

Nas mesmas condições do benchmark, `uvx edne-correios-loader load --database-url sqlite:///dne.db` levou 30 segundos e gerou uma base de 394 MiB sem `VACUUM`. Nessa comparação, o `@konstit/dne` foi 5,2 vezes mais rápido e usou 68,2% menos espaço em disco.

Este pacote fornece somente uma CLI. Ele não expõe uma API pública de biblioteca.

## Requisitos

- Bun 1.4 ou mais recente
- macOS ou Linux

## Início rápido

```sh
bunx @konstit/dne build --db ./dne.db
bunx @konstit/dne get 01001-000 --db ./dne.db
```

## Execução

Execute a CLI sem instalação global:

```sh
bunx @konstit/dne --version
bunx @konstit/dne --json doctor --offline
```

Os nomes de comandos, subcomandos, opções e flags permanecem em inglês. A ajuda, o progresso, os resultados textuais e as mensagens de erro são exibidos em português. O contrato JSON mantém chaves, códigos e valores de estado estáveis em inglês.

`--db` é uma opção global. Ela pode aparecer antes ou depois de um subcomando. O caminho da base segue esta ordem de precedência:

1. `--db PATH`
2. `./dne.db`

Use `--color` para forçar cores e `--no-color` para desativá-las. Sem essas opções, a CLI detecta o terminal. A presença da variável `NO_COLOR` sempre desativa as cores.

## Criar e atualizar

```sh
bunx @konstit/dne build --db ./dne.db
bunx @konstit/dne build --db ./dne.db --source ./eDNE_Basico.zip
bunx @konstit/dne build --db ./dne.db --source ./Delimitado
bunx @konstit/dne build --db ./dne.db --source https://example.com/eDNE_Basico.zip
bunx @konstit/dne build --db ./dne.db --force
bunx @konstit/dne build --db ./dne.db --check --json
```

`build` grava cada etapa e sua duração em formato compacto (`ms`, `s`, `min` ou `h`) em stderr. O resultado final é gravado em stdout. Use `--quiet` para ocultar o progresso. Use `--json` para receber o caminho da base, a quantidade de registros, o tamanho em bytes, os metadados da fonte, o tempo total em `elapsed_ms` e o estado da atualização.

Cada carga grava a versão do `@konstit/dne` em `edne_metadata`. Ao usar uma fonte remota, a CLI também grava `Last-Modified`, ETag, tamanho do conteúdo, URL da fonte e horário da carga. Uma execução posterior de `build` não recria a base se a fonte não mudou e mostra o `Last-Modified` remoto na saída textual. `--check` verifica se há uma atualização sem alterar a base e também mostra o `Last-Modified` remoto. `--force` ignora os metadados e recria a base.

Uma fonte HTTP ou HTTPS deve aceitar `HEAD`. A CLI usa essa requisição para obter o tamanho do arquivo e os metadados de atualização antes de baixar o ZIP.

As entradas do ZIP são verificadas com seus valores CRC32 durante a leitura. Se houver divergência, a carga é interrompida antes da confirmação da base.

## Acesso simultâneo

Cada execução de `build` que pode alterar a base adquire um lock exclusivo antes de verificar a fonte. Outra instância do `@konstit/dne` aguarda por até 30 segundos, então verifica novamente os metadados e evita uma carga duplicada se a primeira instância já atualizou a base. `build --check` não adquire esse lock.

O lock fica no diretório temporário do sistema, dentro de `konstit-dne-<uid>`. Seu nome contém um hash do caminho absoluto da base, evitando conflitos entre bases com o mesmo nome. Ele é removido quando a execução termina e também ao receber `SIGHUP`, `SIGINT` ou `SIGTERM`. Se o processo for encerrado sem executar essa limpeza, a próxima execução identifica o PID inativo e remove o lock antes de continuar. Processos que coordenam a mesma base devem usar o mesmo host e usuário do sistema.

Uma base existente é atualizada no próprio arquivo com o modo WAL do SQLite e uma única transação. Outros processos podem manter a base aberta para leitura durante a atualização. Esses processos não veem uma tabela atualizada parcialmente.

Um leitor com uma transação ativa continua vendo a versão anterior até o fim da transação. A próxima transação vê os dados atualizados.

O SQLite permite um escritor por vez. Se outro processo mantiver uma transação de escrita, a atualização aguarda por até 30 segundos. Depois desse período, ela falha se o bloqueio continuar ativo.

## Atualização automática

Instale uma atualização semanal para a base:

```sh
bunx @konstit/dne cron install --db ./dne.db
```

O padrão `0 0 * * 5` executa à meia-noite de sexta-feira, no fuso local do cron. Informe outra expressão como argumento quando necessário:

```sh
bunx @konstit/dne cron install '30 6 * * 5' --db ./dne.db
bunx @konstit/dne cron install '@weekly' --db ./dne.db --dry-run
bunx @konstit/dne cron status --db ./dne.db --json
bunx @konstit/dne cron remove --db ./dne.db
```

`cron install` usa `Bun.cron` para registrar o job no agendador do sistema operacional: `crontab` no Linux e `launchd` no macOS. O título contém um hash do caminho absoluto da base. Uma nova instalação para a mesma base substitui o job existente, enquanto bases diferentes mantêm agendamentos independentes. `cron remove` usa `Bun.cron.remove`.

Cada job recebe um módulo persistente e metadados no diretório de estado do usuário. O módulo executa os caminhos absolutos do `bunx` e da base. A versão atual do `@konstit/dne` fica fixada no comando. Execute `cron install` novamente depois de atualizar o pacote para usar a nova versão. A execução usa `--quiet`, descarta a saída normal e mantém erros em stderr para o agendador do sistema. `cron status` também calcula a próxima execução com `Bun.cron.parse`.

## Consultar CEPs

Consulta individual:

```sh
bunx @konstit/dne get 01001000
bunx @konstit/dne get 01001-000 --json
```

Consulta em lote:

```sh
bunx @konstit/dne get 01001000 20040002 --json
bunx @konstit/dne get --file ./ceps.txt --jsonl
printf '01001000\n20040002\n' | bunx @konstit/dne get --jsonl
```

Os formatos aceitos são `01001000` e `01001-000`. A entrada por arquivo ou stdin pode usar espaços, vírgulas ou pontos e vírgulas como separadores.

`get` abre o SQLite em modo somente leitura. Se o caminho da base não existir, nenhum arquivo será criado. O formato JSONL grava um resultado completo por linha e é adequado para lotes grandes.

## Inspecionar a base

```sh
bunx @konstit/dne status --json
bunx @konstit/dne schema --json
bunx @konstit/dne schema --expected
bunx @konstit/dne doctor --json
bunx @konstit/dne doctor --offline --json
```

`status` informa o tamanho do arquivo, a quantidade de registros, o esquema atual, a versão do pacote, o `Last-Modified` da fonte e os demais metadados da carga. A saída textual formata datas e números com a localidade `pt-BR`; a saída JSON mantém os valores originais. `schema` lê o esquema real do SQLite. `schema --expected` mostra o esquema definido pela CLI. `doctor` verifica o Bun, a configuração da base e o acesso à fonte remota. O modo offline não faz a verificação de rede.

## SQL somente leitura

```sh
bunx @konstit/dne sql 'SELECT cep, municipio, uf FROM dne WHERE uf = "SP" LIMIT 10' --json
bunx @konstit/dne sql 'PRAGMA page_size' --limit 20 --json
```

O comando `sql` abre a base em modo somente leitura. Ele aceita `SELECT`, `WITH`, `PRAGMA` e `EXPLAIN`. O valor padrão de `--limit` é 100, com limite máximo de 10.000 registros.

## Contrato JSON

`--json` grava em stdout um envelope estável:

```json
{
  "ok": true,
  "data": {}
}
```

Erros de execução e de argumentos usam este formato em stderr:

```json
{
  "ok": false,
  "error": {
    "code": "invalid-cep",
    "message": "CEP inválido 'x'. Use 01001000 ou 01001-000."
  }
}
```

O progresso e os diagnósticos são gravados em stderr. A saída JSON em stdout não inclui mensagens de progresso.

Códigos de saída:

- `0`: comando concluído
- `1`: falha na base, na fonte, na rede ou na execução
- `2`: argumentos inválidos ou CEP em formato inválido
- `3`: um ou mais CEPs válidos não foram encontrados

## Schema SQLite

```sql
CREATE TABLE "dne" (
  "cep" TEXT NOT NULL /* Contém somente os oito dígitos do CEP, sem separadores. */,
  "logradouro" TEXT,
  "complemento" TEXT,
  "bairro" TEXT,
  "municipio" TEXT NOT NULL,
  "municipio_cod_ibge" INTEGER NOT NULL,
  "uf" TEXT NOT NULL,
  "nome" TEXT,
  PRIMARY KEY ("cep")
) WITHOUT ROWID;
```

`cep` é a chave primária, sem digito separador. A tabela usa `WITHOUT ROWID` e páginas de 32 KiB para oferecer consultas diretas com menor uso de espaço.

### Drizzle ORM schema

```typescript
import { sqliteTable } from "drizzle-orm/sqlite-core";

export const dneTable = sqliteTable("dne", (t) => ({
  cep: t.text().primaryKey(),
  logradouro: t.text(),
  complemento: t.text(),
  bairro: t.text(),
  municipio: t.text().notNull(),
  municipio_cod_ibge: t.integer().notNull(),
  uf: t.text().notNull(),
  nome: t.text(),
}));
```

Este schema serve para consultar um banco criado pelo `@konstit/dne`. O Drizzle não representa `WITHOUT ROWID`; portanto, usar o Drizzle Kit para gerar ou migrar essa tabela cria uma estrutura física diferente.

## Desenvolvimento

O comando `zip` é necessário para os testes de desenvolvimento que usam fixtures e arquivos ZIP aninhados.

```sh
bun test
bun run lint
bun run fmt
bun run benchmark
bun run benchmark:download
```

Outros scripts de benchmark específicos estão listados em `package.json`.
