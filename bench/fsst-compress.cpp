// Experimental bridge to the upstream FSST encoder; not a runtime dependency.
#include "fsst.h"
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <vector>

static uint32_t read32(std::istream &input) {
  unsigned char bytes[4];
  if (!input.read(reinterpret_cast<char *>(bytes), 4)) throw std::runtime_error("Truncated input");
  return uint32_t(bytes[0]) | (uint32_t(bytes[1]) << 8) | (uint32_t(bytes[2]) << 16) | (uint32_t(bytes[3]) << 24);
}

static void write32(std::ostream &output, uint32_t value) {
  unsigned char bytes[] = {static_cast<unsigned char>(value), static_cast<unsigned char>(value >> 8),
                          static_cast<unsigned char>(value >> 16), static_cast<unsigned char>(value >> 24)};
  output.write(reinterpret_cast<char *>(bytes), 4);
}

int main(int argc, char **argv) {
  if (argc != 3) throw std::runtime_error("Usage: fsst-compress input output");
  std::ifstream input(argv[1], std::ios::binary);
  const auto count = read32(input);
  std::vector<std::vector<unsigned char>> strings(count);
  std::vector<size_t> lengths(count), compressedLengths(count);
  std::vector<const unsigned char *> pointers(count);
  std::vector<unsigned char *> compressedPointers(count);
  size_t total = 0;
  for (size_t index = 0; index < count; index++) {
    lengths[index] = read32(input);
    strings[index].resize(lengths[index] + 8);
    if (!input.read(reinterpret_cast<char *>(strings[index].data()), lengths[index])) throw std::runtime_error("Truncated string");
    pointers[index] = strings[index].data();
    total += lengths[index];
  }
  auto *encoder = fsst_create(count, lengths.data(), pointers.data(), 0);
  std::vector<unsigned char> compressed(2 * total + 8 * count + 4096);
  if (fsst_compress(encoder, count, lengths.data(), pointers.data(), compressed.size(), compressed.data(),
                    compressedLengths.data(), compressedPointers.data()) != count) throw std::runtime_error("Incomplete compression");
  const auto decoder = fsst_decoder(encoder);
  std::ofstream output(argv[2], std::ios::binary);
  write32(output, count);
  output.write(reinterpret_cast<const char *>(decoder.len), 255);
  output.write(reinterpret_cast<const char *>(decoder.symbol), 255 * 8);
  for (const auto length : compressedLengths) write32(output, length);
  for (size_t index = 0; index < count; index++) {
    std::vector<unsigned char> restored(lengths[index] + 8);
    const auto size = fsst_decompress(&decoder, compressedLengths[index], compressedPointers[index], restored.size(), restored.data());
    if (size != lengths[index] || std::memcmp(restored.data(), pointers[index], size)) throw std::runtime_error("FSST round trip mismatch");
    output.write(reinterpret_cast<const char *>(compressedPointers[index]), compressedLengths[index]);
  }
  if (!output) throw std::runtime_error("Output write failed");
  fsst_destroy(encoder);
}
