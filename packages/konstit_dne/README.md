# konstit_dne

Pacote Dart para consultar CEPs offline em arquivos `dne.bin` do
[formato binário v5 do konstit-dne](https://github.com/Konstit-Engenharia/konstit-dne/blob/39693c4521c5d3589a4c9ef1ddb7a1176c7c7ec4/docs/binary-layout.md).

Em um projeto com Dart 3.4 ou superior, adicione a dependência pelo caminho do pacote.

```sh
dart pub add 'konstit_dne:{path: /caminho/para/konstit-cli/packages/konstit_dne}'
```

Informe o caminho de uma base gerada pelo `konstit-dne` ou use o arquivo
`data/dne.bin` distribuído no pacote npm `@konstit/dne`. O leitor Dart carrega
o arquivo em memória e verifica seu SHA-256 uma vez na abertura.

```dart
import 'package:konstit_dne/konstit_dne.dart';

void main() {
  final db = DneBinaryDatabaseReader('dne.bin');
  try {
    final endereco = db.queryCep('01141-000');
    if (endereco != null) {
      print('${endereco.logradouro}, ${endereco.municipio}/${endereco.uf}');
    }
  } finally {
    db.close();
  }
}
```

`queryCep(String)` retorna `DneRow?`. Aceita oito dígitos ASCII com hífen opcional
após o quinto dígito. Um CEP inválido ou ausente retorna `null`.
`DneRow.toJson()` fornece os dez campos com os nomes do leitor original.

Para abrir uma base já carregada, use `DneBinaryDatabaseReader.fromBytes(bytes)`
com um `Uint8List`. O leitor mantém sua própria cópia. A abertura lança
`FormatException` para versão incompatível, tamanho incorreto ou falha de
integridade. Uma consulta após `close()` lança `StateError`.
