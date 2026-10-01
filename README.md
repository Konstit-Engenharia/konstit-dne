# @konstit/dne: CEPs do Brasil

Consulte CEPs do Brasil localmente em aplicações Bun, com uma base compacta incluída no pacote e dados do e-DNE dos Correios. As consultas funcionam offline, sem servidor. A CLI também permite criar e atualizar bases próprias em SQLite ou formato binário.

Consulte os [benchmarks de leitura e importação](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/performance.md) para os resultados medidos em cada formato.

## Requisitos

- Bun 1.4 ou mais recente
- macOS ou Linux

## Início rápido: consultar a base incluída

Instale o pacote:

```sh
bun add @konstit/dne
```

Salve como `consulta.ts`:

```typescript
import { DneBinaryDatabaseReader } from '@konstit/dne';

const db = new DneBinaryDatabaseReader();
try {
  console.log(JSON.stringify(db.queryCep('01141-000'), null, 2));
} finally {
  db.close();
}
```

Execute com `bun consulta.ts`. Saída para a base usada neste exemplo:

```json
{
  "bairro": "Várzea da Barra Funda",
  "cep": "01141000",
  "complemento": null,
  "localidade_situacao": "codificada_por_logradouro",
  "localidade_tipo": "municipio",
  "logradouro": "Rua Rubens Meireles",
  "municipio": "São Paulo",
  "municipio_cod_ibge": 3550308,
  "nome": null,
  "uf": "SP"
}
```

O leitor abre a base incluída no pacote, independentemente do diretório de trabalho, sem baixar dados adicionais. Ela representa a fonte usada no empacotamento daquela versão: atualize o pacote para receber outra cópia ou informe o caminho de uma base própria ao construtor.

`queryCep()` aceita `01141000` ou `01141-000` e retorna `undefined` para CEPs inválidos ou ausentes. Consulte a [referência da API](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/api.md) para consultas de bairros e faixas de CEP, tipos e tratamento de erros.

## Qual formato usar?

| Necessidade                                    | Formato | Como usar                       |
| ---------------------------------------------- | ------- | ------------------------------- |
| Consultar a base incluída no pacote            | Binário | `new DneBinaryDatabaseReader()` |
| Gerar uma base compacta para consultas por CEP | Binário | `build --format binary`         |
| Executar SQL ou integrar ferramentas SQLite    | SQLite  | `build --db ./dne.db`           |

Os dois leitores oferecem consultas por CEP, bairro e faixas de CEP. Para abrir arquivos próprios na API, use `new DneBinaryDatabaseReader('/dados/dne.bin')` ou `new DneDatabaseReader('/dados/dne.db')`, importados de `@konstit/dne`.

O formato binário atual é a versão 4. Ele mantém a API do leitor e pode usar FSST para compactar os sufixos do dicionário de logradouros; os demais dicionários continuam no formato simples. O encoder e o decoder FSST são escritos em TypeScript e executados pelo Bun. A especificação do layout está em [Formato binário](docs/binary-layout.md).

## CLI: criar e consultar sua própria base

Execute sem instalação global. Para criar uma base SQLite a partir do arquivo público do e-DNE e consultar um CEP:

```sh
bunx @konstit/dne build --db ./dne.db
bunx @konstit/dne get 01001-000 --db ./dne.db --json
```

Para gerar e consultar uma base binária:

```sh
bunx @konstit/dne build --format binary --db ./dne.bin
bunx @konstit/dne get 01001-000 --db ./dne.bin --json
```

A CLI usa `./dne.db` por padrão; `build --format binary` gera `./dne.bin` por padrão. A CLI não seleciona automaticamente a base incluída no pacote: informe `--db` para consultar outro arquivo. `get`, `status` e `schema` detectam o formato do arquivo informado. O comando `sql` exige SQLite.

### Criar e atualizar

`build` aceita a fonte pública, um ZIP local ou um diretório com os arquivos do e-DNE. Ao usar uma fonte remota, repetir o comando atualiza a base somente quando necessário. `--check` verifica a fonte sem alterar a base.

```sh
bunx @konstit/dne build --db ./dne.db --source ./eDNE_Basico.zip
bunx @konstit/dne build --db ./dne.db --check --json
bunx @konstit/dne status --db ./dne.db --json
```

Para agendar a atualização semanal de uma base SQLite no Linux ou macOS:

```sh
bunx @konstit/dne cron install --db ./dne.db
```

O agendamento padrão executa à meia-noite de sexta-feira e fixa a versão atual do pacote. Consulte [atualização automática](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/cli.md#atualização-automática) para alterar a agenda, verificar o job ou removê-lo.

### Consultar em lote ou executar SQL

```sh
bunx @konstit/dne get 01001000 20040002 --db ./dne.db --json
bunx @konstit/dne get --file ./ceps.txt --db ./dne.db --jsonl
bunx @konstit/dne sql "SELECT cep, municipio, uf FROM dne WHERE uf = 'SP' LIMIT 10" --db ./dne.db --json
```

As consultas abrem a base somente para leitura. `--json` grava os dados em stdout e os erros em stderr; o progresso também fica em stderr. A [referência da CLI](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/cli.md) detalha opções, JSON/JSONL, códigos de saída, diagnóstico e acesso simultâneo.

## Desempenho

No benchmark de **30/09/2026**, em um **Apple M4 com Bun 1.4.2**, o leitor binário foi **30,6× mais rápido que o leitor SQLite** da biblioteca na mesma carga:

| Métrica                                        |          Binário |    SQLite |
| ---------------------------------------------- | ---------------: | --------: |
| Mediana por 100 mil consultas                  |     **32,16 ms** | 984,34 ms |
| Consultas por segundo, calculadas pela mediana | **3,11 milhões** | 101,6 mil |
| Tamanho da base                                |      **32,2 MB** |  109,2 MB |

A base continha 1.611.629 CEPs. Cada rodada consultou 50 mil CEPs existentes e 50 mil ausentes, com duas rodadas de aquecimento e nove medições. Os tempos excluem a abertura da base; os tamanhos estão em MB decimais.

Esta medição histórica usou o formato binário v1 e não representa o formato v4 atual. A investigação e os resultados disponíveis estão em [desempenho](docs/performance.md).

Veja a [metodologia, os comandos de reprodução e os resultados de importação](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/performance.md). O benchmark de importação usa outra base e está documentado separadamente.

## Documentação

| Referência                                                                                           | Conteúdo                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [API](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/api.md)                       | Leitores, bairros, faixas de CEP, tipos e exceções.                    |
| [CLI](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/cli.md)                       | Comandos, fontes, atualização automática, JSON e concorrência.         |
| [SQLite e Drizzle](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/sqlite.md)       | Tabelas, views, indicadores de localidade e migração de bases.         |
| [Formato binário](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/binary-layout.md) | Especificação para implementar leitores em outras linguagens.          |
| [Desempenho](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/performance.md)        | Benchmarks de consulta e importação, reprodução e métricas de memória. |
| [Desenvolvimento](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/development.md)   | Organização do código, validação e distribuição do pacote.             |

## Desenvolvimento

Na raiz do repositório:

```sh
bun install
bun test
bun run lint
```

Os testes também usam `zip`, `npm` e `tar`. Consulte o [guia de desenvolvimento](https://github.com/Konstit-Engenharia/konstit-dne/blob/main/docs/development.md) para cobertura, formatação, benchmarks e empacotamento.

## Licença

O código é distribuído sob a [licença MIT](LICENSE).
