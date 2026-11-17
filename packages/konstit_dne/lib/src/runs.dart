import 'dart:typed_data';

import 'binary.dart';

/// Consecutive rows share a municipality ID and locality flags.
final class LocalityRuns {
  LocalityRuns(this.data, this.rowCount, this.idWidth);

  final ByteData data;
  final int rowCount;
  final int idWidth;
  late final _count = data.u32(0);
  late final _starts = 8 + 4 * ((rowCount + 255) ~/ 256 + 1);
  late final _ids = _starts + 4 * _count;

  int municipalityId(int run) => data.uint(_ids + run * idWidth, idWidth);

  int runFor(int row) {
    final directory = 8 + 4 * (row ~/ 256);
    var lo = data.u32(directory);
    final next = data.u32(directory + 4);
    var hi = next == _count ? next : next + 1;
    while (lo + 1 < hi) {
      final mid = (lo + hi) ~/ 2;
      if (data.u32(_starts + mid * 4) <= row) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}

/// Elias–Fano run starts and the corresponding one-based bairro indexes.
final class BairroRuns {
  BairroRuns(this.data, this.rowCount);

  final ByteData data;
  final int rowCount;
  late final _count = data.u32(0);
  late final _lowBits = data.getUint8(4);
  late final _width = data.getUint8(6);
  late final _bucketSize = 1 << _lowBits;
  late final _zeros = (rowCount + _bucketSize - 1) ~/ _bucketSize;
  late final _highs = 8 + (_count * _lowBits + 7) ~/ 8;
  late final _samples = _highs + (_zeros + _count + 7) ~/ 8;
  late final _ids = _samples + 4 * ((_zeros + 7) ~/ 8);

  int _selectZero(int zero) {
    var position = data.u32(_samples + (zero ~/ 8) * 4);
    var remaining = zero % 8;
    while (remaining > 0) {
      position++;
      if (data.getUint8(_highs + position ~/ 8) & (1 << (position % 8)) == 0) {
        remaining--;
      }
    }
    return position;
  }

  int indexFor(int row) {
    final bucket = row >> _lowBits;
    final lowPart = row % _bucketSize;
    // Ones before a bucket's terminating zero count all runs through that bucket.
    var lo = bucket == 0 ? 0 : _selectZero(bucket - 1) - (bucket - 1);
    var hi = _selectZero(bucket) - bucket;
    while (lo < hi) {
      final mid = (lo + hi) ~/ 2;
      if (data.packed(mid, _lowBits, start: 8) <= lowPart) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return data.uint(_ids + (lo - 1) * _width, _width);
  }
}
