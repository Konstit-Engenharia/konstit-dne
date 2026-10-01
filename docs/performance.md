# Desempenho

[Voltar ao README](../README.md)

Estas medições usam os formatos atuais: **binário v5** e **SQLite de esquema 4**, com os leitores e geradores do projeto.

## Base e ambiente

Medição realizada em **01/10/2026**, em um **Apple M4 com 16 GiB de RAM**, macOS 26.6.2 e Bun 1.4.2. A fonte local `eDNE_Basico_26092/Delimitado` produziu **1.611.629 CEPs, 84.952 bairros e 139.746 faixas de bairros**.

Os bancos foram gerados novamente com o código atual, em arquivos novos. Ambos representam a mesma fonte. Os benchmarks rodaram sequencialmente, sem profiler, com o cache de arquivos do sistema aquecido. Os resultados não medem cache frio, cargas concorrentes ou outros ambientes.

## Consultas por CEP

O leitor binário atingiu **3,60 milhões de consultas por segundo** e foi **19,7× mais rápido que o leitor SQLite** nesta carga. Seu arquivo ocupa **82,49% menos espaço**.

| Métrica | Binário v5 | SQLite, esquema 4 |
| --- | ---: | ---: |
| Mediana por 100 mil consultas | **27,76 ms** | 546,45 ms |
| Consultas por segundo, calculadas pela mediana | **3,60 milhões** | 183,0 mil |
| Intervalo das medianas dos três processos | 26,75–29,69 ms | 546,40–582,31 ms |
| Tamanho do arquivo, em MB decimais | **19,12 MB** | 109,22 MB |
| Tamanho exato do arquivo | 19.121.800 bytes | 109.215.744 bytes |

Cada formato foi medido em **três processos independentes**, usando [bench/binary-lookup.bench.ts](../bench/binary-lookup.bench.ts). Cada processo executou duas rodadas de aquecimento e nove medições de **100 mil consultas**, alternando 50 mil CEPs existentes com 50 mil ausentes. Os existentes são selecionados em intervalos regulares na base SQLite; os ausentes usam uma semente fixa e são confirmados nessa mesma base. Todos os processos encontraram os 50 mil resultados esperados.

A ordem dos processos foi SQLite/binário, binário/SQLite e SQLite/binário. A tabela usa a **mediana das três medianas por formato**; a taxa de consultas deriva desse tempo. Os tempos excluem abertura do banco, preparação dos CEPs e coleta de lixo. São consultas repetidas após aquecimento, e a proporção de CEPs existentes influencia o resultado.

A igualdade dos registros retornados pelos dois leitores foi verificada para todos os **1.611.629 CEPs**, fora das medições de tempo.

## Geração dos bancos

| Operação | Execução 1 | Execução 2 | Execução 3 | Mediana |
| --- | ---: | ---: | ---: | ---: |
| Importação do diretório DNE para SQLite, esquema 4 | 4,195 s | 4,123 s | 4,150 s | **4,150 s** |
| Exportação do SQLite para binário v5 | 3,275 s | 3,226 s | 3,222 s | **3,226 s** |

A importação usa o `elapsed_ms` reportado pela CLI, após uma execução de aquecimento, com um destino novo por medição. A fonte já estava extraída: os tempos excluem download, extração do ZIP e inicialização do processo. As três importações produziram bancos de 109.215.744 bytes. Atualizar um SQLite existente pode deixar páginas livres e alterar seu tamanho; essa operação não foi medida nesta tabela.

A exportação usa [bench/binary-build.bench.ts](../bench/binary-build.bench.ts), em três processos, sempre a partir do mesmo SQLite. O tempo inclui geração, validação integral, checksum SHA-256 e escrita do binário. Exclui a importação do módulo e o hash adicional calculado pelo benchmark para registrar o arquivo. Os três binários tiveram o mesmo tamanho e SHA-256. O digest do rodapé também foi conferido independentemente com `node:crypto`.

As duas linhas medem etapas distintas: gerar um binário a partir do DNE também exige a importação para SQLite.

## Reprodução

Execute os comandos na raiz do repositório, com as dependências instaladas. Use um diretório de saída novo e defina `DNE_SOURCE` como o caminho para a mesma fonte DNE já extraída:

```sh
DNE_SOURCE='/caminho/eDNE_Basico_26092/Delimitado'
mkdir -p outputs/performance-current

# Aquecimento da importação, seguido por três arquivos novos.
bun run src/index.ts build --format sqlite --source "$DNE_SOURCE" --db outputs/performance-current/warmup.db --quiet --json
for run in 1 2 3; do
  bun run src/index.ts build --format sqlite --source "$DNE_SOURCE" --db "outputs/performance-current/import-$run.db" --quiet --json
done

# Três exportações do mesmo SQLite pelo writer atual.
for run in 1 2 3; do
  bun bench/binary-build.bench.ts outputs/performance-current/import-1.db src/binary-db-writer.ts outputs/performance-current/dne.bin
done
```

Para as consultas, execute os dois comandos abaixo três vezes, em processos sequenciais. Inverta a ordem na segunda repetição:

```sh
bun bench/binary-lookup.bench.ts outputs/performance-current/import-1.db 100000 outputs/performance-current/import-1.db
bun bench/binary-lookup.bench.ts outputs/performance-current/dne.bin 100000 outputs/performance-current/import-1.db
```

O último argumento fornece a base usada para selecionar os CEPs da carga mista. Gere o binário a partir desse mesmo SQLite. A saída JSON contém as nove amostras após aquecimento e a mediana de cada processo. Alterações no DNE, hardware ou runtime podem mudar os resultados; os hashes registrados identificam os arquivos efetivamente medidos.
