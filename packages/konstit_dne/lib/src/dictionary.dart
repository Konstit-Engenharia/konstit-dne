import 'dart:convert';
import 'dart:typed_data';

import 'binary.dart';

/// A front-coded UTF-8 dictionary. A lookup reconstructs at most eight entries.
final class Dictionary {
  Dictionary(this.data, {bool allowFsst = false}) {
    if (data.lengthInBytes < 32) {
      throw const FormatException('Truncated DNE dictionary');
    }
    final lengthWidth = data.getUint8(31);
    if (idWidth < 1 ||
        idWidth > 4 ||
        data.getUint8(29) != 3 ||
        !(codec == 0 && lengthWidth == 0 ||
            allowFsst &&
                codec == 2 &&
                (lengthWidth == 1 || lengthWidth == 2))) {
      throw const FormatException('Invalid DNE dictionary encoding');
    }
    if (blocks != (count + 7) ~/ 8 ||
        data.u32(8) != 32 ||
        lengths != 32 + blocks * 4 ||
        prefixes != lengths + count * encodedWidth ||
        payload != symbols + (codec == 2 ? 255 * 9 : 0) ||
        payload + data.u32(24) != data.lengthInBytes) {
      throw const FormatException('Invalid DNE dictionary offsets');
    }
  }

  final ByteData data;
  late final bytes = Uint8List.sublistView(data);
  late final count = data.u32(0);
  late final blocks = data.u32(4);
  late final lengths = data.u32(12);
  late final prefixes = data.u32(16);
  late final payload = data.u32(20);
  late final idWidth = data.getUint8(28);
  late final codec = data.getUint8(30);
  late final encodedWidth = codec == 0 ? 1 : data.getUint8(31);
  late final symbols = prefixes + count;
  final _decoded = Uint8List(255);

  String? nullable(int id) => id == 0 ? null : decode(id);

  String decode(int id) {
    if (id < 1 || id > count)
      throw FormatException('Invalid dictionary ID: $id');
    final index = id - 1;
    final block = index ~/ 8;
    var cursor = payload + data.u32(32 + block * 4);
    final blockEnd = block + 1 == blocks
        ? bytes.length
        : payload + data.u32(32 + (block + 1) * 4);
    if (cursor > blockEnd || blockEnd > bytes.length) {
      throw const FormatException('Invalid dictionary block offset');
    }

    var decodedLength = 0;
    for (var entry = block * 8; entry <= index; entry++) {
      final prefix = bytes[prefixes + entry];
      final length = data.uint(lengths + entry * encodedWidth, encodedWidth);
      final suffixBytes = codec == 0 ? length - prefix : length;
      final end = cursor + suffixBytes;
      if (prefix > decodedLength ||
          suffixBytes < 0 ||
          suffixBytes > 510 ||
          end > blockEnd) {
        throw const FormatException('Invalid front-coded dictionary entry');
      }
      if (codec == 0) {
        _decoded.setRange(prefix, length, bytes, cursor);
        decodedLength = length;
      } else {
        decodedLength = _decodeFsst(cursor, end, prefix);
      }
      cursor = end;
    }
    if ((index % 8 == 7 || id == count) && cursor != blockEnd) {
      throw const FormatException('Invalid dictionary block length');
    }
    return utf8.decode(Uint8List.sublistView(_decoded, 0, decodedLength));
  }

  int _decodeFsst(int cursor, int end, int length) {
    while (cursor < end) {
      final code = bytes[cursor++];
      if (code == 255) {
        if (cursor == end || length == 255) {
          throw const FormatException('Invalid FSST escape');
        }
        _decoded[length++] = bytes[cursor++];
      } else {
        final size = bytes[symbols + code];
        if (size < 1 || size > 8 || length + size > 255) {
          throw const FormatException('Invalid FSST symbol');
        }
        _decoded.setRange(
            length, length + size, bytes, symbols + 255 + code * 8);
        length += size;
      }
    }
    return length;
  }
}
