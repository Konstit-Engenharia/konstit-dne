# Referência da CLI

[Voltar ao README](../README.md)

A CLI cria, atualiza e consulta bases locais. Sem `--db`, o caminho padrão é `./dne.db`, exceto em `build --format binary`, que gera `./dne.bin`. Para consultar um binário, informe `--db ./dne.bin`. A base incluída no pacote é usada automaticamente pelo leitor da [API](api.md), e não pelos comandos da CLI.

## Execução

Execute a CLI sem instalação global:

```sh
bunx @konstit/dne --version
bunx @konstit/dne --json doctor --offline
```

Os nomes de comandos, subcomandos, opções e flags permanecem em inglês. A ajuda, o progresso, os resultados textuais e as mensagens de erro são exibidos em português. O contrato JSON mantém chaves, códigos e valores de estado estáveis em inglês.

`--db` é uma opção global. Ela pode aparecer antes ou depois de um subcomando. O caminho da base segue esta ordem de precedência:

1. `--db PATH`
2. `./dne.bin` em `build --format binary`; `./dne.db` nos demais comandos.

No build binário, a extensão do caminho é substituída por `.bin` ou adicionada quando não existe: `--db ./base.db` e `--db ./base` geram `./base.bin`. Para consultar ou inspecionar o arquivo binário, informe seu caminho com `--db ./base.bin`.

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

Cada carga grava a versão do `@konstit/dne` em `edne_metadata` (ou no cabeçalho do arquivo binário). Ao usar uma fonte remota, a CLI também grava `Last-Modified`, ETag, tamanho do conteúdo, URL da fonte e horário da carga. Todos os validadores disponíveis devem continuar iguais para a base ser considerada atual. Uma execução posterior de `build` não recria a base se a fonte não mudou e mostra o `Last-Modified` remoto na saída textual. `--check` valida a estrutura de uma fonte local ou verifica se há uma atualização remota, sem alterar a base. `--force` ignora os metadados e recria a base.

O formato binário é selecionado explicitamente com `--format binary`. Ele mantém os mesmos dez campos da consulta por CEP em um layout próprio para `mmap`: o CEP usa um diretório de prefixos e sufixos de 10 bits; município e UF são compartilhados; campos opcionais usam bitmaps; os indicadores da localidade ocupam um byte por CEP; e as strings ficam em dicionários por coluna com front-coding em blocos de oito. `get`, `status` e `schema` detectam o formato automaticamente. O comando `sql` continua disponível somente para bases SQLite.

A especificação completa para implementar leitores em outras linguagens está em [Formato binário](binary-layout.md).

Para fontes HTTP ou HTTPS, a CLI tenta obter os metadados com `HEAD`. Se o servidor não aceitar esse método, ela usa uma requisição `GET` limitada ao primeiro byte. Requisições têm timeout de 30 segundos e até duas novas tentativas para falhas transitórias, respostas 408, 425, 429 e 5xx.

As entradas do ZIP são verificadas com seus valores CRC32 durante a leitura. A carga também valida CEP, UF, código IBGE, campos obrigatórios e referências entre os arquivos. Qualquer rejeição interrompe a transação. Uma carga válida grava em `quality_report` as linhas lidas, aceitas e rejeitadas por etapa e arquivo.

## Acesso simultâneo

### Lock de importação

Cada execução de `build` que pode alterar a base adquire um lock exclusivo antes de verificar a fonte. Outra instância do `@konstit/dne` aguarda por até 30 segundos, então verifica novamente os metadados e evita uma carga duplicada se a primeira instância já atualizou a base. `build --check` não adquire esse lock.

O lock fica no diretório temporário do sistema, dentro de `konstit-dne-<uid>`. Seu nome contém um hash do caminho absoluto da base, evitando conflitos entre bases com o mesmo nome. Ele é removido quando a execução termina e também ao receber `SIGHUP`, `SIGINT` ou `SIGTERM`. Se o processo for encerrado sem executar essa limpeza, a próxima execução identifica o PID inativo e remove o lock antes de continuar. Processos que coordenam a mesma base devem usar o mesmo host e usuário do sistema.

### Leitores e transações SQLite

Uma base SQLite existente é atualizada no próprio arquivo com o modo WAL e uma única transação. Outros processos podem manter a base aberta para leitura durante a atualização. Esses processos não veem uma tabela atualizada parcialmente.

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
bunx @konstit/dne cron install --db ./dne.db --source https://example.com/eDNE_Basico.zip
bunx @konstit/dne cron install '@weekly' --db ./dne.db --dry-run
bunx @konstit/dne cron status --db ./dne.db --json
bunx @konstit/dne cron remove --db ./dne.db
```

`cron install` usa `Bun.cron` para registrar o job no agendador do sistema operacional: `crontab` no Linux e `launchd` no macOS. O título contém um hash do caminho absoluto da base. Uma nova instalação para a mesma base substitui o job existente, enquanto bases diferentes mantêm agendamentos independentes. `cron remove` usa `Bun.cron.remove`.

Cada job recebe um módulo persistente e metadados no diretório de estado do usuário. O módulo executa os caminhos absolutos do `bunx`, da base e de fontes locais. A versão atual do `@konstit/dne` e a fonte ficam fixadas no comando. Alterar somente a expressão preserva a fonte já instalada. Execute `cron install` novamente depois de atualizar o pacote para usar a nova versão. A execução usa `--quiet`, descarta a saída normal e mantém erros em stderr para o agendador do sistema. `cron status` mostra a fonte e também calcula a próxima execução com `Bun.cron.parse`.

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

`get` abre o SQLite em modo somente leitura ou mapeia o arquivo binário com `mmap`. Se o caminho da base não existir, nenhum arquivo será criado. O formato JSONL lê a entrada e grava cada resultado de forma incremental, sem manter o lote completo na memória.

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
bunx @konstit/dne sql "SELECT cep, municipio, uf FROM dne WHERE uf = 'SP' LIMIT 10" --json
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
