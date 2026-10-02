# Desempenho

[Voltar ao README](../README.md)

Estas medições usam os formatos atuais: **binário v5** e **SQLite de esquema 4**, com os leitores e geradores do projeto.

O leitor binário carrega a base integralmente em memória com `readFileSync()`. As consultas abaixo usam essa cópia, com o código atual. Esta rodada mede arquivos físicos, com caminhos explícitos para os leitores.

## Base e ambiente

Medição realizada em **02/10/2026**, em um **Apple M4 com 16 GiB de RAM**, macOS 26.6.2 e Bun 1.4.2, na revisão `5ce88fe`. A fonte local `eDNE_Basico_26092/Delimitado` produziu **1.611.629 CEPs, 84.952 bairros e 139.746 faixas de bairros**.

Os bancos foram gerados novamente com o código atual, em arquivos novos. Ambos representam a mesma fonte. Os benchmarks rodaram sequencialmente, sem profiler, com o cache de arquivos do sistema aquecido. Os resultados não medem cache frio, cargas concorrentes ou outros ambientes.

## Consultas por CEP

O leitor binário atingiu **3,62 milhões de consultas por segundo** e foi **19,2× mais rápido que o leitor SQLite** nesta carga. Seu arquivo ocupa **82,49% menos espaço**.

| Métrica | Binário v5 | SQLite, esquema 4 |
| --- | ---: | ---: |
| Mediana por 100 mil consultas | **27,63 ms** | 531,46 ms |
| Consultas por segundo, calculadas pela mediana | **3,62 milhões** | 188,2 mil |
| Intervalo das medianas dos três processos | 27,19–28,13 ms | 524,99–545,73 ms |
| p95 das 27 amostras de tempo | 32,29 ms | 554,61 ms |
| Coeficiente de variação das 27 amostras | 6,93% | 3,21% |
| Tamanho do arquivo, em MB decimais | **19,12 MB** | 109,22 MB |
| Tamanho exato do arquivo | 19.121.800 bytes | 109.215.744 bytes |

Cada formato foi medido em **três processos independentes**, usando [bench/binary-lookup.bench.ts](../bench/binary-lookup.bench.ts). Cada processo executou duas rodadas de aquecimento e nove medições de **100 mil consultas**, alternando 50 mil CEPs existentes com 50 mil ausentes. Os existentes são selecionados em intervalos regulares na base SQLite; os ausentes usam uma semente fixa e são confirmados nessa mesma base. Todos os processos encontraram os 50 mil resultados esperados.

A ordem dos processos foi SQLite/binário, binário/SQLite e SQLite/binário. A tabela usa a **mediana das três medianas por formato**; a taxa de consultas deriva desse tempo. Os tempos excluem abertura do banco, preparação dos CEPs e as coletas explícitas de lixo. São consultas repetidas após aquecimento, e a proporção de CEPs existentes influencia o resultado.

A igualdade dos registros retornados pelos dois leitores foi verificada para todos os **1.611.629 CEPs**, fora das medições de tempo.

## Memória do processo

O mesmo benchmark registra memória antes da abertura, depois da abertura e depois do primeiro lote de 100 mil consultas seguido por `Bun.gc(true)`. A referência é o processo após preparar os CEPs e executar uma coleta de lixo. A tabela mostra a **mediana dos incrementos nos três processos**, em MB decimais.

| Métrica | Binário v5 | SQLite, esquema 4 |
| --- | ---: | ---: |
| Incremento de RSS após abrir | 21,15 MB | 1,08 MB |
| Incremento de RSS após o primeiro lote e GC | 38,37 MB | 88,36 MB |
| Incremento de `ArrayBuffers` após o primeiro lote e GC | 19,12 MB | 0,00 MB |

A cópia do binário permanece em memória enquanto o leitor estiver aberto. RSS inclui memória nativa, páginas residentes, caches e reservas do runtime; esses incrementos não representam apenas objetos vivos nem medem o pico de memória. `ArrayBuffers` é a contagem reportada pelo Bun e não inclui o cache nativo do SQLite. A preparação da carga abriu a mesma fonte SQLite em todos os processos, antes da referência de memória.

## Geração dos bancos

| Operação | Mediana | Intervalo das sete medições | Coeficiente de variação |
| --- | ---: | ---: | ---: |
| Importação do diretório DNE para SQLite, esquema 4 | **4,110 s** | 4,036–4,229 s | 1,47% |
| Exportação do SQLite para binário v5 | **3,119 s** | 3,101–3,148 s | 0,53% |

A importação usa o `data.elapsed_ms` reportado pela CLI, com **duas execuções de aquecimento e sete medições**, sempre com um destino novo. A fonte já estava extraída: os tempos excluem download, extração do ZIP e inicialização do processo. As sete importações produziram bancos de 109.215.744 bytes. Atualizar um SQLite existente pode deixar páginas livres e alterar seu tamanho; essa operação não foi medida nesta tabela.

A exportação usa [bench/binary-build.bench.ts](../bench/binary-build.bench.ts), com **duas execuções de aquecimento e sete medições em processos separados**, sempre a partir do mesmo SQLite e com arquivos novos. O tempo inclui geração, validação integral, checksum SHA-256 e escrita do binário. Exclui a importação do módulo e o hash adicional calculado pelo benchmark para registrar o arquivo. Todos os binários tiveram o mesmo tamanho e SHA-256. O digest do rodapé também foi conferido independentemente com `node:crypto`.

As duas linhas medem etapas distintas: gerar um binário a partir do DNE também exige a importação para SQLite.

## Arquivos medidos

As consultas usaram o primeiro SQLite e o primeiro binário das rodadas medidas. Estes SHA-256 identificam os arquivos completos, incluindo seus metadados:

| Arquivo | SHA-256 |
| --- | --- |
| SQLite | `375a50e1308ab0698e5eec84b0228157c83c9dc06d510c550457f1d89f070a94` |
| Binário | `aa0634f4f7dcc590cb2ab01347175d29c00009d48afcfdfce77ae43201c45d9b` |

Datas e caminhos gravados nos metadados podem alterar os hashes em uma nova geração, mesmo com a mesma fonte DNE.

## Reprodução

Execute os comandos na raiz do repositório, com as dependências instaladas. Use um diretório de saída novo e defina `DNE_SOURCE` como o caminho para a mesma fonte DNE já extraída:

```sh
DNE_SOURCE='/caminho/eDNE_Basico_26092/Delimitado'
mkdir -p outputs/performance-current

# Duas importações de aquecimento, seguidas por sete arquivos novos.
for run in 1 2; do
  bun run src/index.ts build --format sqlite --source "$DNE_SOURCE" --db "outputs/performance-current/warmup-$run.db" --quiet --json
done
for run in 1 2 3 4 5 6 7; do
  bun run src/index.ts build --format sqlite --source "$DNE_SOURCE" --db "outputs/performance-current/import-$run.db" --quiet --json
done

# Duas exportações de aquecimento, seguidas por sete arquivos novos.
for run in 1 2; do
  bun bench/binary-build.bench.ts outputs/performance-current/import-1.db src/binary-db-writer.ts "outputs/performance-current/warmup-export-$run.bin"
done
for run in 1 2 3 4 5 6 7; do
  bun bench/binary-build.bench.ts outputs/performance-current/import-1.db src/binary-db-writer.ts "outputs/performance-current/export-$run.bin"
done
```

Para as consultas, execute os dois comandos abaixo três vezes, em processos sequenciais. Inverta a ordem na segunda repetição:

```sh
bun bench/binary-lookup.bench.ts outputs/performance-current/import-1.db 100000 outputs/performance-current/import-1.db
bun bench/binary-lookup.bench.ts outputs/performance-current/export-1.bin 100000 outputs/performance-current/import-1.db
```

O último argumento fornece a base usada para selecionar os CEPs da carga mista. Gere o binário a partir desse mesmo SQLite. A saída JSON contém as nove amostras após aquecimento, mediana, p95, coeficiente de variação e registros de memória de cada processo. Alterações no DNE, hardware ou runtime podem mudar os resultados; os hashes registrados identificam os arquivos efetivamente medidos.
