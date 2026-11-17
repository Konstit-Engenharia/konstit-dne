import 'dart:io';
import 'dart:typed_data';

import 'package:konstit_dne/konstit_dne.dart';
import 'package:test/test.dart';

// Both fixtures were serialized with buildBinaryDatabase from @konstit/dne 0.2.0.
// Gzip keeps the mostly empty five-digit prefix directories small in the repo.
Uint8List fixture(String name) => Uint8List.fromList(
      gzip.decode(File('test/fixtures/$name.bin.gz').readAsBytesSync()),
    );

void main() {
  late DneBinaryDatabaseReader reader;
  late Uint8List bytes;

  setUp(() {
    bytes = fixture('localities');
    reader = DneBinaryDatabaseReader.fromBytes(bytes);
  });
  tearDown(() => reader.close());

  test('queryCep restores all fields and preserves leading zeroes', () {
    const expected = {
      'cep': '01001000',
      'logradouro': 'Praça da Sé',
      'complemento': null,
      'bairro': 'Centro',
      'municipio': 'Municipio Codificado',
      'municipio_cod_ibge': 3500001,
      'uf': 'SP',
      'nome': null,
      'localidade_situacao': 'codificada_por_logradouro',
      'localidade_tipo': 'municipio',
    };
    for (final cep in ['01001-000', '01001000']) {
      expect(reader.queryCep(cep)?.toJson(), expected);
    }
  });

  test('invalid inputs and absent CEPs return null', () {
    for (final cep in [
      '',
      ' 01001000',
      '01001000 ',
      '01001000\n',
      '010-01000',
      '01001--000',
      '+1001000',
      '０１００１０００',
      '0x001000',
      '1001000',
      '001001000',
      '01001001',
      '00000000',
      '99999-999',
    ]) {
      expect(reader.queryCep(cep), isNull, reason: cep);
    }
  });

  test('uses the originating locality and the fallback bairro name', () {
    final distrito = reader.queryCep('11000000')!;
    expect(distrito.bairro, 'Distrito Unico');
    expect(distrito.localidadeTipo, 'distrito');
    expect(distrito.localidadeSituacao, 'sem_codificacao_por_logradouro');
    expect(distrito.municipio, 'Municipio em Codificacao');
    expect(distrito.logradouro, isNull);
    expect(reader.queryCep('12000000')!.bairro, isNull);

    final povoado = reader.queryCep('14000000')!;
    expect(povoado.bairro, 'Povoado em Codificacao');
    expect(povoado.localidadeTipo, 'povoado');
    expect(povoado.localidadeSituacao, 'em_codificacao_por_logradouro');
    expect(reader.queryCep('64000000')!.localidadeSituacao,
        'inserida_na_codificacao_por_logradouro');
  });

  test('decodes FSST, sparse ranks and runs across block boundaries', () {
    final blocks = DneBinaryDatabaseReader.fromBytes(fixture('blocks'));
    addTearDown(blocks.close);
    for (var i = 1; i <= 300; i++) {
      final cep = (30000000 + i).toString();
      final row = blocks.queryCep(cep)!;
      expect(row.logradouro, '$cep – Travessa João Gonçalves, São José');
      expect(row.complemento, i % 3 == 0 ? null : 'sala $cep');
      expect(row.nome, isNull);
      expect(row.bairro, 'Bairro $i');
      expect(row.municipio, 'Municipio $i');
      expect(row.municipioCodIbge, (i.isEven ? 3500000 : 2900000) + i);
      expect(row.uf, i.isEven ? 'SP' : 'BA');
    }
    final last = blocks.queryCep('60000300')!;
    expect(last.nome, 'Unidade 300');
    expect(last.complemento, 'posto 300');
    expect(blocks.queryCep('30000000'), isNull);
    expect(blocks.queryCep('30000301'), isNull);
  });

  test('reads a binary file by path', () {
    final temp = Directory.systemTemp.createTempSync('konstit-dne-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final file = File('${temp.path}/dne.bin')..writeAsBytesSync(bytes);
    final fromFile = DneBinaryDatabaseReader(file.path);
    addTearDown(fromFile.close);
    expect(fromFile.queryCep('01001-000')!.logradouro, 'Praça da Sé');
    expect(() => DneBinaryDatabaseReader('${temp.path}/missing.bin'),
        throwsA(isA<FileSystemException>()));
  });

  test('owns its bytes and rejects queries after close', () {
    bytes.fillRange(0, bytes.length, 0);
    expect(reader.queryCep('01001-000')!.logradouro, 'Praça da Sé');
    reader.close();
    reader.close();
    expect(() => reader.queryCep('01001000'), throwsStateError);
    expect(() => reader.queryCep('invalid'), throwsStateError);
  });

  test('rejects truncated, incompatible and damaged files', () {
    expect(() => DneBinaryDatabaseReader.fromBytes(Uint8List(12)),
        throwsFormatException);
    for (final offset in [0, 8, 10, 16, 256, bytes.length - 1]) {
      final damaged = Uint8List.fromList(bytes);
      damaged[offset] ^= 1;
      expect(() => DneBinaryDatabaseReader.fromBytes(damaged),
          throwsFormatException,
          reason: 'changed byte $offset');
    }
  });
}
