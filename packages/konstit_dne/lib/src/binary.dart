import 'dart:typed_data';

import 'package:crypto/crypto.dart';

// Directory order in the v5 header.
enum Section {
  metadata,
  cepPrefixOffsets,
  cepSuffixes,
  logradouroIds,
  complementoBitmap,
  complementoRanks,
  complementoIds,
  bairroIds,
  municipalityIds,
  nomeBitmap,
  nomeRanks,
  nomeIds,
  municipalities,
  logradouroDictionary,
  complementoDictionary,
  bairroDictionary,
  municipioDictionary,
  ufDictionary,
  nomeDictionary,
  localidadeFlags,
  bairros,
  bairroFaixaOffsets,
  bairroFaixas,
  bairroAbreviadoDictionary,
  localidadeNomeBitmap,
  localidadeNomeRanks,
  localidadeNomeIds,
}

extension BinaryData on ByteData {
  int u32(int offset) => getUint32(offset, Endian.little);

  int uint(int offset, int width) => switch (width) {
        1 => getUint8(offset),
        2 => getUint16(offset, Endian.little),
        3 => getUint16(offset, Endian.little) | (getUint8(offset + 2) << 16),
        4 => u32(offset),
        _ => throw FormatException('Invalid integer width: $width'),
      };

  int packed(int index, int width, {int start = 0}) {
    final firstBit = index * width;
    var offset = start + firstBit ~/ 8;
    var skip = firstBit % 8;
    var result = 0;
    for (var written = 0; written < width;) {
      final remaining = width - written;
      final take = remaining < 8 - skip ? remaining : 8 - skip;
      final bits = (getUint8(offset++) >> skip) & ((1 << take) - 1);
      result |= bits << written;
      written += take;
      skip = 0;
    }
    return result;
  }
}

List<ByteData> readSections(ByteData file) {
  const headerSize = 256;
  const magic = [0x44, 0x4e, 0x45, 0x42, 0x49, 0x4e, 0, 0];
  final footer = file.lengthInBytes - 32;
  if (footer < headerSize) throw const FormatException('Truncated DNE file');
  for (var i = 0; i < magic.length; i++) {
    if (file.getUint8(i) != magic[i]) {
      throw const FormatException('Invalid DNE signature');
    }
  }
  final version = file.getUint16(8, Endian.little);
  if (version != 5) throw FormatException('Unsupported DNE version: $version');
  if (file.getUint16(10, Endian.little) != headerSize ||
      file.u32(16) != file.lengthInBytes) {
    throw const FormatException('Invalid DNE header or file size');
  }

  final digest = sha256.convert(Uint8List.sublistView(file, 0, footer)).bytes;
  for (var i = 0; i < digest.length; i++) {
    if (file.getUint8(footer + i) != digest[i]) {
      throw const FormatException('DNE SHA-256 checksum mismatch');
    }
  }
  if (file.getUint16(24, Endian.little) != Section.values.length ||
      file.getUint8(22) != 8 ||
      file.getUint8(23) != 3 ||
      file.getUint8(20) < 1 ||
      file.getUint8(20) > 4 ||
      file.getUint8(21) < 1 ||
      file.getUint8(21) > 4 ||
      file.u32(12) == 0 ||
      file.u32(28) == 0) {
    throw const FormatException('Invalid DNE v5 layout');
  }

  final sections = <ByteData>[];
  var previousEnd = headerSize;
  for (final section in Section.values) {
    final entry = 32 + section.index * 8;
    final start = file.u32(entry);
    final end = start + file.u32(entry + 4);
    if (start < previousEnd || start % 8 != 0 || end > footer) {
      throw FormatException('Invalid DNE section: ${section.name}');
    }
    sections.add(ByteData.sublistView(file, start, end));
    previousEnd = end;
  }
  if ((previousEnd + 7) ~/ 8 * 8 != footer) {
    throw const FormatException('Invalid DNE footer position');
  }
  return sections;
}
