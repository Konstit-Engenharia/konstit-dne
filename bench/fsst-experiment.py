"""Build experimental FSST dictionaries and reader snapshots, without modifying src/.

Usage: python3 bench/fsst-experiment.py <baseline.bin> <output-directory>
Requires clang++ and downloads a pinned upstream MIT implementation into output.
Only logradouroDictionary is replaced; experimental binaries use version 65535.
"""

import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import urllib.request

REVISION = "e638d4cf8c26129d73c242a4127b42b975de5b63"
ROOT = Path(__file__).resolve().parent.parent
baseline = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
upstream = output / "fsst-upstream"
upstream.mkdir(parents=True, exist_ok=True)
for name in ("fsst.h", "libfsst.cpp", "libfsst.hpp", "fsst_avx512.cpp", "fsst_avx512.inc", "LICENSE"):
    path = upstream / name
    # Always fetch the pinned revision, including when the directory already exists.
    path.write_bytes(urllib.request.urlopen(f"https://raw.githubusercontent.com/cwida/fsst/{REVISION}/{name}").read())
(upstream / "revision.txt").write_text(REVISION + "\n")
compressor = output / "fsst-compress"
subprocess.run(["clang++", "-std=c++17", "-O3", "-DNDEBUG", f"-I{upstream}",
                str(ROOT / "bench/fsst-compress.cpp"), str(upstream / "libfsst.cpp"),
                str(upstream / "fsst_avx512.cpp"), "-o", str(compressor)], check=True)

def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]

def pack32(value):
    return struct.pack("<I", value)

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Reader source changed; cannot patch {old!r}")
    return text.replace(old, new)

binary = baseline.read_bytes()
if struct.unpack_from("<HH", binary, 8) != (3, 256):
    raise ValueError("Expected a version 3 binary with a 256-byte header")
section_count = struct.unpack_from("<H", binary, 24)[0]
if section_count != 27:
    raise ValueError("Expected the 27-section layout")
regions = [struct.unpack_from("<II", binary, 32 + index * 8) for index in range(section_count)]
dictionary_offset, dictionary_size = regions[13]
dictionary = binary[dictionary_offset:dictionary_offset + dictionary_size]
if dictionary[29:32] != bytes((3, 0, 0)):
    raise ValueError("Expected a front-coded dictionary with eight strings per block")
count, blocks, block_offsets, lengths, prefixes, payload, payload_size = struct.unpack_from("<7I", dictionary)
strings, suffixes = [], []
cursor = payload
previous = b""
for index in range(count):
    length, prefix = dictionary[lengths + index], dictionary[prefixes + index]
    suffix = dictionary[cursor:cursor + length - prefix]
    value = previous[:prefix] + suffix
    assert len(value) == length
    strings.append(value)
    suffixes.append(suffix)
    previous = value
    cursor += length - prefix
assert cursor == payload + payload_size

report = {"upstreamRevision": REVISION, "dictionaryStrings": count, "baselineBytes": len(binary),
          "baselineDictionaryBytes": dictionary_size, "rawStringBytes": sum(map(len, strings)), "variants": []}
for mode, name, values in ((1, "full", strings), (2, "suffix", suffixes)):
    input_path, encoded_path = output / f"fsst-{name}.input", output / f"fsst-{name}.encoded"
    with input_path.open("wb") as file:
        file.write(pack32(count))
        for value in values:
            file.write(pack32(len(value)))
            file.write(value)
    subprocess.run([str(compressor), str(input_path), str(encoded_path)], check=True)
    encoded = encoded_path.read_bytes()
    assert u32(encoded, 0) == count
    table = encoded[4:4 + 2295]
    compressed_lengths = [u32(encoded, 4 + 2295 + index * 4) for index in range(count)]
    if max(compressed_lengths) > 255:
        raise ValueError("This experiment only supports compressed lengths up to 255 bytes")
    codes = encoded[4 + 2295 + 4 * count:]
    assert sum(compressed_lengths) == len(codes)
    offsets = bytearray()
    cursor = 0
    for index, length in enumerate(compressed_lengths):
        if index % 8 == 0:
            offsets += pack32(cursor)
        cursor += length
    prefix_values = dictionary[prefixes:prefixes + count] if mode == 2 else b""
    encoded_payload = prefixes + len(prefix_values) + len(table)
    replacement = bytearray(dictionary[:32])
    struct.pack_into("<II", replacement, 20, encoded_payload, len(codes))
    replacement[30] = mode
    replacement += offsets + bytes(compressed_lengths) + prefix_values + table + codes
    rebuilt = bytearray(binary[:256])
    struct.pack_into("<H", rebuilt, 8, 65535)
    for index, (offset, length) in enumerate(regions):
        rebuilt += bytes(-len(rebuilt) % 8)
        section = replacement if index == 13 else binary[offset:offset + length]
        struct.pack_into("<II", rebuilt, 32 + index * 8, len(rebuilt), len(section))
        rebuilt += section
    rebuilt += bytes(-len(rebuilt) % 8)
    struct.pack_into("<I", rebuilt, 16, len(rebuilt))
    (output / f"fsst-{name}.bin").write_bytes(rebuilt)
    report["variants"].append({"name": name, "fileBytes": len(rebuilt), "dictionaryBytes": len(replacement),
                               "compressedBytes": len(codes), "symbolTableBytes": len(table),
                               "maxCompressedLength": max(compressed_lengths)})

snapshot = output / "fsst-source/src"
shutil.copytree(ROOT / "src", snapshot, dirs_exist_ok=True)
shutil.copyfile(ROOT / "bench/fsst-decoder.ts", snapshot / "fsst-decoder.ts")
format_path = snapshot / "binary-db-format.ts"
format_path.write_text(replace_once(format_path.read_text(), "BINARY_DATABASE_VERSION = 3", "BINARY_DATABASE_VERSION = 65535"))
reader_path = snapshot / "binary-db-reader.ts"
reader = "import { readFsstString } from './fsst-decoder.ts';\n" + reader_path.read_text()
reader = replace_once(reader, "type BinaryDictionary = {", "type BinaryDictionary = {\n  fsstMode: number;")
reader = replace_once(reader, "  private readDictionaryString(dictionary: BinaryDictionary, id: number) {",
                      "  private readDictionaryString(dictionary: BinaryDictionary, id: number) {\n"
                      "    if (dictionary.fsstMode) return readFsstString(this.requireMapped(), this.requireData(), dictionary, id, this.decodeScratch);")
reader = replace_once(reader, "  const count = data.getUint32(region.offset, true);\n  const blockCount",
                      "  const fsstMode = data.getUint8(region.offset + 30);\n  const count = data.getUint32(region.offset, true);\n  const blockCount")
reader = replace_once(reader, "    || suffixDataRelative !== prefixesRelative + count",
                      "    || suffixDataRelative !== prefixesRelative + (fsstMode === 1 ? 0 : count) + (fsstMode ? 2295 : 0)")
reader = replace_once(reader, "  const dictionary = {\n    blockCount,", "  const dictionary = {\n    fsstMode,\n    blockCount,")
reader_path.write_text(reader)
optimized_snapshot = output / "fsst-ts-source/src"
shutil.copytree(snapshot, optimized_snapshot, dirs_exist_ok=True)
shutil.copyfile(ROOT / "bench/fsst-ts-optimized.ts", optimized_snapshot / "fsst-decoder.ts")
for variant in ("native", "neon"):
    native_snapshot = output / f"fsst-{variant}-source/src"
    shutil.copytree(snapshot, native_snapshot, dirs_exist_ok=True)
    wrapper = (ROOT / "bench/fsst-native-decoder.ts").read_text()
    if variant == "neon":
        wrapper = replace_once(wrapper, "FSST_NEON: Bun.env['DNE_FSST_NEON'] === '1' ? '1' : '0'", "FSST_NEON: '1'")
    (native_snapshot / "fsst-decoder.ts").write_text(wrapper)
    shutil.copyfile(ROOT / "bench/fsst-native.c", native_snapshot / "fsst-native.c")
(output / "fsst-size-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
