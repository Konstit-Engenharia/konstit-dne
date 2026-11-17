import 'dart:io';
import 'dart:typed_data';

import 'binary.dart';
import 'dictionary.dart';
import 'row.dart';
import 'runs.dart';

/// Leitor em memória de uma base binária DNE v5.
final class DneBinaryDatabaseReader {
  /// Lê o arquivo e verifica seu SHA-256 antes da primeira consulta.
  DneBinaryDatabaseReader(String path) : this._(File(path).readAsBytesSync());

  /// Copia os bytes para que alterações na origem não afetem as consultas.
  DneBinaryDatabaseReader.fromBytes(Uint8List bytes)
      : this._(Uint8List.fromList(bytes));

  DneBinaryDatabaseReader._(Uint8List bytes)
      : _database = _Database(ByteData.sublistView(bytes));

  _Database? _database;

  /// Consulta oito dígitos ASCII ou a forma XXXXX-XXX.
  /// Retorna null para um CEP inválido ou ausente.
  DneRow? queryCep(String cep) {
    final database = _database;
    if (database == null) throw StateError('DNE reader is closed');
    return database.queryCep(cep);
  }

  /// Libera a referência à base. Consultas posteriores lançam [StateError].
  void close() => _database = null;
}

final class _Database {
  _Database(this.header) : sections = readSections(header);

  final ByteData header;
  final List<ByteData> sections;
  ByteData section(Section name) => sections[name.index];

  late final _prefixWidth = header.getUint8(20);
  late final _logradouro =
      Dictionary(section(Section.logradouroDictionary), allowFsst: true);
  late final _streetBits =
      _logradouro.count == 0 ? 1 : _logradouro.count.bitLength;
  late final _complemento = Dictionary(section(Section.complementoDictionary));
  late final _bairro = Dictionary(section(Section.bairroDictionary));
  late final _municipio = Dictionary(section(Section.municipioDictionary));
  late final _uf = Dictionary(section(Section.ufDictionary));
  late final _nome = Dictionary(section(Section.nomeDictionary));
  late final _localityRuns = LocalityRuns(
      section(Section.municipalityIds), header.u32(12), header.getUint8(21));
  late final _bairroRuns =
      BairroRuns(section(Section.bairroIds), header.u32(12));
  late final _bairros = section(Section.bairros);
  late final _bairroNameOffset = _bairros.getUint8(4) + _bairros.getUint8(5);
  late final _bairroWidth = _bairroNameOffset +
      _bairro.idWidth +
      section(Section.bairroAbreviadoDictionary).getUint8(28) +
      _uf.idWidth;

  static final _cepPattern = RegExp(r'^[0-9]{5}-?[0-9]{3}$');
  static const _types = ['municipio', 'distrito', 'povoado'];
  static const _situations = [
    'sem_codificacao_por_logradouro',
    'codificada_por_logradouro',
    'inserida_na_codificacao_por_logradouro',
    'em_codificacao_por_logradouro',
  ];

  DneRow? queryCep(String cep) {
    if (!_cepPattern.hasMatch(cep)) return null;
    final digits = cep.replaceFirst('-', '');
    final number = int.parse(digits);
    final prefix = number ~/ 1000;
    final suffix = number % 1000;
    final prefixes = section(Section.cepPrefixOffsets);
    var lo = prefixes.uint(prefix * _prefixWidth, _prefixWidth);
    final end = prefixes.uint((prefix + 1) * _prefixWidth, _prefixWidth);
    final suffixes = section(Section.cepSuffixes);
    var hi = end;
    while (lo < hi) {
      final mid = (lo + hi) ~/ 2;
      if (suffixes.packed(mid, 10) < suffix) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo == end || suffixes.packed(lo, 10) != suffix) return null;
    return _readRow(lo, digits);
  }

  DneRow _readRow(int row, String cep) {
    final run = _localityRuns.runFor(row);
    final flags = section(Section.localidadeFlags).getUint8(run);
    final municipalities = section(Section.municipalities);
    final offset = (_localityRuns.municipalityId(run) - 1) *
        (3 + _municipio.idWidth + _uf.idWidth);
    final municipio = municipalities.uint(offset + 3, _municipio.idWidth);
    final uf =
        municipalities.uint(offset + 3 + _municipio.idWidth, _uf.idWidth);
    final bairro = _bairroRuns.indexFor(row);
    return DneRow(
      cep: cep,
      logradouro: _logradouro
          .nullable(section(Section.logradouroIds).packed(row, _streetBits)),
      complemento: _sparse(row, Section.complementoBitmap, _complemento),
      bairro: bairro == 0
          ? _sparse(row, Section.localidadeNomeBitmap, _bairro)
          : _bairro.decode(_bairros.uint(
              16 + (bairro - 1) * _bairroWidth + _bairroNameOffset,
              _bairro.idWidth)),
      municipio: _municipio.decode(municipio),
      municipioCodIbge: municipalities.uint(offset, 3),
      uf: _uf.decode(uf),
      nome: _sparse(row, Section.nomeBitmap, _nome),
      localidadeSituacao: _situations[flags & 3],
      localidadeTipo: _types[flags >> 2],
    );
  }

  // Each sparse column occupies three consecutive sections: bitmap, ranks, IDs.
  String? _sparse(int row, Section bitmapSection, Dictionary dictionary) {
    final bitmap = section(bitmapSection);
    final byte = row ~/ 8;
    final mask = 1 << (row % 8);
    final current = bitmap.getUint8(byte);
    if ((current & mask) == 0) return null;

    final block = row ~/ 256;
    var rank = sections[bitmapSection.index + 1].u32(block * 4);
    for (var i = block * 32; i < byte; i++) {
      rank += _popcount[bitmap.getUint8(i)];
    }
    rank += _popcount[current & (mask - 1)];
    final ids = sections[bitmapSection.index + 2];
    return dictionary
        .decode(ids.uint(rank * dictionary.idWidth, dictionary.idWidth));
  }

  static final _popcount = _buildPopcount();

  static Uint8List _buildPopcount() {
    final table = Uint8List(256);
    for (var i = 1; i < table.length; i++) {
      table[i] = table[i >> 1] + (i & 1);
    }
    return table;
  }
}
