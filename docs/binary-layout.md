# DNE binary database format

This document specifies version 3 of the `@konstit/dne` binary database format. It is intended for authors of readers in languages other than TypeScript. Version 3 readers do not accept version 1 or version 2 files.

The format is immutable and optimized for memory-mapped, read-only CEP lookup. It stores rows in CEP order, splits each CEP into a prefix directory and a packed suffix, interns strings in per-column dictionaries, and stores nullable low-density columns with bitmaps and rank indexes.

Version 3 files do not contain a checksum. Readers that accept files from untrusted sources must validate every offset, length, count, and identifier before dereferencing it.

## Conventions

All integers are unsigned and little-endian.

| Name | Size | Encoding |
| --- | ---: | --- |
| `u8` | 1 byte | Unsigned integer |
| `u16` | 2 bytes | Little-endian unsigned integer |
| `u24` | 3 bytes | Little-endian unsigned integer, least-significant byte first |
| `u32` | 4 bytes | Little-endian unsigned integer |
| `uint(width)` | 1 to 4 bytes | Little-endian unsigned integer using the specified width |

Offsets in this document are zero-based byte offsets. File section offsets are absolute offsets from the start of the file. Offsets inside a dictionary header are relative to the start of that dictionary section.

The following symbols are used in size formulas:

| Symbol | Meaning |
| --- | --- |
| `N` | Number of CEP rows |
| `M` | Number of municipality records |
| `B` | Number of neighborhood records, possibly zero |
| `F` | Number of neighborhood CEP intervals |
| `L` | Number of non-null district or village fallback names |
| `Wb` | Width of an internal neighborhood index, `width(B)` |
| `R` | Number of consecutive runs of equal neighborhood indexes, `1..N` |
| `q` | Number of low bits in the Elias–Fano run starts |
| `Z` | Number of zero bits in the Elias–Fano high vector, `ceil(N / 2^q)` |
| `Wo` | Width of an original neighborhood identifier |
| `Wl` | Width of an original locality identifier |
| `Rb` | Neighborhood record width, `Wo + Wl + W(bairro) + W(bairroAbreviado) + W(uf)` |
| `P` | Number of possible five-digit CEP prefixes, always `100000` |
| `C` | Number of non-null `complemento` values |
| `K` | Number of non-null `nome` values |
| `Wc` | Width of an entry in the CEP prefix directory |
| `Wm` | Width of a municipality ID |
| `Rl` | Number of consecutive runs of equal municipality ID and locality flags, `1..N` |
| `b` | Logradouro ID bit width, `max(1, ceil(log2(logradouro_count + 1)))` |
| `W(field)` | ID width declared by the dictionary for `field` |

The canonical writer chooses an integer width from the maximum value that must fit:

| Maximum value | Width |
| ---: | ---: |
| `0` through `255` | 1 byte |
| `256` through `65535` | 2 bytes |
| `65536` through `16777215` | 3 bytes |
| `16777216` through `4294967295` | 4 bytes |

Consequently, `Wc = width(N)`, `Wm = width(M)`, and each dictionary uses `width(dictionary_count)`. A dictionary with no entries still uses an ID width of 1.

## File overview

A file consists of a fixed 256-byte header followed by 27 sections in a fixed order.

```text
+---------------------------+ 0
| Header                    | 256 bytes
+---------------------------+ 256
| Metadata                  | each section begins at an 8-byte boundary
+---------------------------+
| CEP prefix offsets        |
+---------------------------+
| ...                       |
+---------------------------+
| Nome dictionary           |
+---------------------------+
| Locality indicators       | one byte per locality run
+---------------------------+
| Neighborhoods and ranges  | original identities and CEP intervals
+---------------------------+
| Locality fallback names   | bitmap, ranks, sparse dictionary IDs
+---------------------------+
| Final padding             | file size is a multiple of 8
+---------------------------+
```

Every section begins at an offset divisible by 8. Zero-filled padding may appear between sections and after the final section. Writers must zero reserved bytes and padding. Readers should ignore their contents.

The file size, all section offsets, and all section lengths are stored as `u32`, so a version 3 file cannot exceed `4294967295` bytes.

## Header

The header occupies bytes `0` through `255`.

| Offset | Size | Type | Field | Required value or meaning |
| ---: | ---: | --- | --- | --- |
| 0 | 8 | bytes | Magic | `44 4e 45 42 49 4e 00 00`, or `DNEBIN\0\0` |
| 8 | 2 | `u16` | Version | `3` |
| 10 | 2 | `u16` | Header size | `256` |
| 12 | 4 | `u32` | Row count | `N`, must be greater than zero |
| 16 | 4 | `u32` | File size | Exact file length, including final padding |
| 20 | 1 | `u8` | CEP prefix offset width | `Wc`, one of `1`, `2`, `3`, or `4` |
| 21 | 1 | `u8` | Municipality ID width | `Wm`, one of `1`, `2`, `3`, or `4` |
| 22 | 1 | `u8` | Sparse rank shift | `8`, meaning one rank block per 256 rows |
| 23 | 1 | `u8` | Dictionary block shift | `3`, meaning eight strings per block |
| 24 | 2 | `u16` | Section count | `27` |
| 26 | 2 | bytes | Reserved | Written as zero |
| 28 | 4 | `u32` | Municipality count | `M`, must be greater than zero |
| 32 | 216 | entries | Section directory | 27 entries of 8 bytes each |
| 248 | 8 | bytes | Reserved | Written as zero |

### Section directory

Directory entry `i` starts at `32 + i * 8`:

| Entry-relative offset | Size | Type | Meaning |
| ---: | ---: | --- | --- |
| 0 | 4 | `u32` | Absolute section offset |
| 4 | 4 | `u32` | Section length in bytes |

The entries have the following fixed order. The byte range column identifies the corresponding directory entry in the header.

| Index | Header bytes | Section | Length |
| ---: | --- | --- | --- |
| 0 | 32-39 | `metadata` | Variable |
| 1 | 40-47 | `cepPrefixOffsets` | `(P + 1) * Wc` |
| 2 | 48-55 | `cepSuffixes` | `ceil(N * 10 / 8)` |
| 3 | 56-63 | `logradouroIds` | `ceil(N * b / 8)` |
| 4 | 64-71 | `complementoBitmap` | `ceil(N / 8)` |
| 5 | 72-79 | `complementoRanks` | `(ceil(N / 256) + 1) * 4` |
| 6 | 80-87 | `complementoIds` | `C * W(complemento)` |
| 7 | 88-95 | `bairroIds` | `8 + ceil(R * q / 8) + ceil((Z + R) / 8) + 4 * ceil(Z / 8) + R * Wb` |
| 8 | 96-103 | `municipalityIds` | `8 + 4 * (ceil(N / 256) + 1) + Rl * (4 + Wm)` |
| 9 | 104-111 | `nomeBitmap` | `ceil(N / 8)` |
| 10 | 112-119 | `nomeRanks` | `(ceil(N / 256) + 1) * 4` |
| 11 | 120-127 | `nomeIds` | `K * W(nome)` |
| 12 | 128-135 | `municipalities` | `M * (3 + W(municipio) + W(uf))` |
| 13 | 136-143 | `logradouroDictionary` | Variable dictionary section |
| 14 | 144-151 | `complementoDictionary` | Variable dictionary section |
| 15 | 152-159 | `bairroDictionary` | Variable dictionary section |
| 16 | 160-167 | `municipioDictionary` | Variable dictionary section |
| 17 | 168-175 | `ufDictionary` | Variable dictionary section |
| 18 | 176-183 | `nomeDictionary` | Variable dictionary section |
| 19 | 184-191 | `localidadeFlags` | `Rl` |
| 20 | 192-199 | `bairros` | `16 + B * Rb` |
| 21 | 200-207 | `bairroFaixaOffsets` | `(B + 1) * 4` |
| 22 | 208-215 | `bairroFaixas` | `F * 8` |
| 23 | 216-223 | `bairroAbreviadoDictionary` | Variable dictionary section |
| 24 | 224-231 | `localidadeNomeBitmap` | `ceil(N / 8)` |
| 25 | 232-239 | `localidadeNomeRanks` | `(ceil(N / 256) + 1) * 4` |
| 26 | 240-247 | `localidadeNomeIds` | `L * W(bairro)` |

Sections must appear in directory order, must not overlap, and must fit entirely inside the file. The official writer aligns every section to 8 bytes.

## Logical row model

The row index, from `0` through `N - 1`, joins all row-oriented columns. Rows are sorted by their numeric CEP and CEPs are unique.

Each result contains these fields:

| Field | Storage |
| --- | --- |
| `cep` | Reconstructed from the CEP prefix and suffix |
| `logradouro` | Dense dictionary ID; ID zero means null |
| `complemento` | Sparse dictionary ID; an unset bitmap bit means null |
| `bairro` | Neighborhood record name, or sparse locality fallback name; otherwise null |
| `municipio` | Municipality record followed by a dictionary lookup |
| `municipio_cod_ibge` | `u24` in the municipality record |
| `uf` | Municipality record followed by a dictionary lookup |
| `nome` | Sparse dictionary ID; an unset bitmap bit means null |
| `localidade_situacao` | Bits 0-1 of the row's locality byte, mapped to the descriptive status below |
| `localidade_tipo` | Bits 2-3 of the row's locality byte; `0` = `municipio`, `1` = `distrito`, `2` = `povoado` |

Dictionary IDs are one-based. ID `1` identifies dictionary entry index `0`; ID `0` represents null where null is permitted.

### Locality indicators

`localidadeFlags` contains `Rl` bytes, one per run shared with `municipalityIds`. A new run starts whenever either the municipality ID or its locality flags changes. Each byte is `(type_index << 2) | situation`. Bits 4-7 must be zero; situation must be in `0..3` and type index must be in `0..2`. Thus the valid bytes are `0..11`.

The fields preserve `LOC_IN_SIT` and `LOC_IN_TIPO_LOC` from the originating DNE locality. Situation `0` means no street-level coding, `1` means street-level coding, `2` means a district or village included in the coding, and `3` means street-level coding is in progress. Situation `3` preserves both general and street CEPs during the transition, as documented in `Delimitado/Leiautes_delimitador.doc` from the [official e-DNE archive](https://www2.correios.com.br/sistemas/edne/download/eDNE_Basico.zip). The types are municipality (`M`), district (`D`), and village (`P`). These indicators belong to each CEP's source locality, while the municipality record still identifies the parent municipality for districts and villages. They must not be deduplicated by municipality ID.

The TypeScript readers expose descriptive string unions in `DneRow`. The flag values preserve the original DNE codes; raw SQLite queries still return those codes.

| Situation bits | `LocalidadeSituacao` |
| --- | --- |
| `0` | `sem_codificacao_por_logradouro` |
| `1` | `codificada_por_logradouro` |
| `2` | `inserida_na_codificacao_por_logradouro` |
| `3` | `em_codificacao_por_logradouro` |

`LocalidadeTipo` is `municipio`, `distrito`, or `povoado`, corresponding to the stored type indexes `0`, `1`, and `2` and the original codes `M`, `D`, and `P`.

## Metadata section

The metadata section is a UTF-8 encoded JSON object with no length prefix, byte-order mark, or terminator. Its byte length comes from the section directory.

The official writer serializes the key/value metadata from the source SQLite database. Current values are strings, but a reader should at minimum validate that the top-level JSON value is an object.

## CEP index

An eight-digit CEP is interpreted as an integer in the range `0` through `99999999` and split as follows:

```text
prefix = floor(cep / 1000)   // 0 through 99999
suffix = cep % 1000          // 0 through 999
```

Leading zeros are restored when presenting the CEP by formatting the combined value as exactly eight decimal digits.

### Prefix directory

`cepPrefixOffsets` contains exactly `100001` packed integers of width `Wc`.

For prefix `p`:

```text
start = offsets[p]
end   = offsets[p + 1]
```

Rows in the half-open range `[start, end)` have prefix `p`. Empty prefixes have `start == end`. The first directory value is zero, the final value is `N`, and all values are monotonically non-decreasing.

### Packed suffixes

`cepSuffixes` is a contiguous little-endian bit stream containing one unsigned 10-bit suffix per row. There is no per-value alignment.

For row `i`:

```text
bit_offset = i * 10
byte_index = floor(bit_offset / 8)
shift      = bit_offset % 8
word       = data[byte_index] | (data[byte_index + 1] << 8)
suffix     = (word >> shift) & 0x3ff
```

The packed stream length guarantees that the two bytes needed by a valid row are present. A strict reader should reject decoded suffixes greater than `999`, even though 10 bits can represent values through `1023`.

### CEP lookup

After validating an input as either `XXXXXXXX` or `XXXXX-XXX`, remove the optional hyphen and parse the eight digits. Then:

```text
prefix = floor(cep / 1000)
wanted_suffix = cep % 1000
low = prefix_offsets[prefix]
high = prefix_offsets[prefix + 1]

while low < high:
    middle = low + floor((high - low) / 2)
    current = read_10_bit_suffix(middle)
    if current < wanted_suffix:
        low = middle + 1
    else:
        high = middle

if low == prefix_offsets[prefix + 1]:
    return not_found
if read_10_bit_suffix(low) != wanted_suffix:
    return not_found
return decode_row(low)
```

Suffixes inside each prefix range are sorted, so a binary search is sufficient.

## Packed logradouro IDs

`logradouroIds` is a contiguous little-endian bit stream with `b` bits per row. Its bit width is derived from the dictionary count, including zero for null, rather than the dictionary's byte width. Entry `i` begins at bit `i * b`; read exactly `b` bits, least-significant bit first, without reading beyond the section. Unused high bits in the final byte are zero. An ID must be zero or at most the dictionary count.

## Municipality and locality runs

`municipalityIds` groups consecutive rows with the same pair `(municipality_id, locality_flags)`. Municipality IDs use `Wm` bytes and must be in `1..M`. The corresponding flag byte is stored at the same run index in `localidadeFlags`.

The section contains these contiguous arrays, with offsets relative to its start:

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 0 | 4 | Run count `Rl`, as `u32` |
| 4 | 1 | Directory block shift, exactly `8` |
| 5 | 3 | Reserved, must be zero |
| 8 | `4 * (ceil(N / 256) + 1)` | Directory of `u32` run indexes |
| After directory | `4 * Rl` | Run start rows, as `u32` |
| After starts | `Wm * Rl` | Municipality IDs, as `uint(Wm)` |

Run starts are strictly increasing, begin at zero, and are less than `N`. Directory entry `j` is the run containing row `j * 256`; its final entry is the sentinel `Rl`. A row lookup searches for the greatest run start not exceeding the row, between directory entries `floor(row / 256)` and the next entry, inclusive when that next entry is less than `Rl`.

Readers must validate the exact directory values and the sentinel. The row's municipality and flags must be read from the same run, including when only the flags changed.

## Neighborhood run index

`bairroIds` stores one internal neighborhood index per maximal run of equal indexes in CEP row order. The start of each run is stored with Elias–Fano coding. The run indexes use `Wb = width(B)` and reference the neighborhood registry, not the string dictionary. Zero means no neighborhood.

The section begins with an eight-byte header:

| Offset | Size | Type | Meaning |
| ---: | ---: | --- | --- |
| 0 | 4 | `u32` | Number of runs, `R` |
| 4 | 1 | `u8` | Low-bit width, `q` |
| 5 | 1 | `u8` | Zero-sample shift, always `3` |
| 6 | 1 | `u8` | Neighborhood-index width, `Wb` |
| 7 | 1 | `u8` | Reserved, zero |

The header is followed, without padding, by four arrays:

1. `R` low parts of `q` bits each, packed least-significant bit first into `ceil(R * q / 8)` bytes.
2. A high bitvector of `Z + R` bits in `ceil((Z + R) / 8)` bytes. For run `i` beginning at row `s_i`, bit `floor(s_i / 2^q) + i` is set. All other bits are zero.
3. `ceil(Z / 8)` little-endian `u32` samples. Sample `j` is the bit position of zero number `8*j` in the high bitvector, with zero numbers and bit positions both starting at zero.
4. `R` neighborhood indexes, each encoded as `uint(Wb)`.

The writer selects `q = floor(log2(N / R))`. To find the index for row `r`, set `h = floor(r / 2^q)`, then use `select0(h)` to find zero number `h` in the high bitvector. The number of runs with high part at most `h` is `end = select0(h) - h`; the first run in bucket `h` is `begin = 0` when `h = 0`, otherwise `begin = select0(h - 1) - (h - 1)`. Find the last low part at most `r mod 2^q` in `[begin, end)`, or use run `begin - 1` if there is none. Its stored neighborhood index is the value for row `r`. The sampled zero positions bound the scan needed for each `select0`.

Readers must verify exactly `R` one bits and `Z` zero bits, valid samples, a first run at row zero, strictly increasing starts below `N`, indexes in `0..B`, and different indexes in adjacent runs.

## Neighborhood registry and intervals

`bairros` stores every source neighborhood, including those without a CEP row or interval. Its 16-byte header contains `B` as `u32` at offset 0, `Wo` as `u8` at offset 4, and `Wl` as `u8` at offset 5. Bytes 6 through 15 are reserved and zero. Both widths are in `1..4`, chosen from the maximum original identifier (1 byte when empty).

The header is followed by `B` packed records with no padding between fields:

| Field | Width | Meaning |
| --- | --- | --- |
| Original neighborhood ID | `Wo` | Positive `BAI_NU`, sorted strictly ascending |
| Original locality ID | `Wl` | Positive `LOC_NU` |
| Name ID | `W(bairro)` | Required name in `bairroDictionary` |
| Abbreviated name ID | `W(bairroAbreviado)` | Zero for null |
| State ID | `W(uf)` | Required state code |

The internal index in `bairroIds` is one-based: `1` selects registry record `0`. Zero means no neighborhood. The original identifiers may have gaps, and distinct neighborhoods may share a name ID. To query by original identifier, binary-search the registry. A CEP query resolves its internal index to the registry's name ID.

`bairroFaixaOffsets` contains `B + 1` values of type `u32`, measured in interval records, not bytes. For internal neighborhood index `j`, the intervals are in `[offsets[j - 1], offsets[j])`. The first offset is zero and the last is `F`. Empty intervals are allowed.

`bairroFaixas` contains `F` records of eight bytes: initial CEP as `u32`, then final CEP as `u32`. Both endpoints are inclusive and must be in `0..99999999`, with initial no greater than final. Records for each neighborhood are sorted by `(initial, final)` without duplicate pairs. Separate and overlapping intervals are preserved; do not infer membership from a combined minimum and maximum. Convert each endpoint to exactly eight decimal digits on output.

`localidadeNome` preserves the original district or village name for locality-wide CEPs. It uses the sparse layout below and shares `bairroDictionary`. A row cannot have both a neighborhood index and a locality fallback name. Fallback names require locality type `D` or `P`; they do not create neighborhood registry records. The public `bairro` field resolves to the registry name when present, otherwise to this fallback, otherwise null.

## Sparse nullable columns

`complemento`, `nome`, and `localidadeNome` use three sections each. `localidadeNome` shares `bairroDictionary`; the other columns use their own dictionaries:

1. A presence bitmap with one bit per row.
2. A rank index with one `u32` entry per 256-row block, plus a final total.
3. A dense sequence of dictionary IDs for only the rows whose bitmap bit is set.

### Bitmap encoding

Bits are stored least-significant bit first within each byte:

```text
byte_index = row_index >> 3
bit_index  = row_index & 7
present    = (bitmap[byte_index] & (1 << bit_index)) != 0
```

Unused high bits in the final bitmap byte are zero in files from the official writer.

### Rank index

There are `ceil(N / 256) + 1` little-endian `u32` rank values. `ranks[b]` is the number of set bits before row `b * 256`. The final rank value is the total number of set bits and therefore the number of entries in the sparse ID section.

To find the dense ID index for row `i`:

```text
if bitmap bit i is not set:
    return null

block = i >> 8
rank = ranks[block]
first_byte = block * 32
row_byte = i >> 3

for byte_index from first_byte through row_byte - 1:
    rank += popcount(bitmap[byte_index])

bits_before_row = bitmap[row_byte] & ((1 << (i & 7)) - 1)
rank += popcount(bits_before_row)

dense_id = read_uint(ids, rank * dictionary_id_width, dictionary_id_width)
```

The sparse ID array is in row order and contains no placeholder for null rows. Its byte length must equal `ranks[last] * dictionary_id_width`.

## Municipality section

Municipalities are deduplicated by IBGE code. The official writer sorts them by ascending IBGE code and assigns municipality IDs starting at 1.

Each fixed-width record has this layout:

| Record offset | Size | Type | Field |
| ---: | ---: | --- | --- |
| 0 | 3 | `u24` | IBGE municipality code |
| 3 | `W(municipio)` | `uint(W(municipio))` | Municipality-name dictionary ID |
| `3 + W(municipio)` | `W(uf)` | `uint(W(uf))` | State-code dictionary ID |

For municipality ID `id`, the record index is `id - 1`:

```text
record_width = 3 + W(municipio) + W(uf)
record_offset = municipalities.offset + (id - 1) * record_width
```

The municipality-name and state-code dictionary IDs are required and must not be zero. An IBGE code must fit in 24 bits.

## String dictionaries

There are six independent dictionaries: `logradouro`, `complemento`, `bairro`, `municipio`, `uf`, and `nome`. Strings are UTF-8 encoded and front-coded in blocks of eight.

The official writer deduplicates and lexicographically sorts each set of strings before assigning IDs. Dictionary order is not needed for lookup correctness; readers use the stored IDs and block metadata.

Each individual encoded string is limited to 255 bytes because its total byte length is stored as `u8`.

### Dictionary header

Every dictionary starts with a 32-byte header. Dictionary-relative offsets are measured from the first byte of this header.

| Dictionary offset | Size | Type | Field | Constraint |
| ---: | ---: | --- | --- | --- |
| 0 | 4 | `u32` | Entry count | Number of strings |
| 4 | 4 | `u32` | Block count | `ceil(entry_count / 8)` |
| 8 | 4 | `u32` | Block-offset array offset | `32` |
| 12 | 4 | `u32` | Length array offset | `32 + block_count * 4` |
| 16 | 4 | `u32` | Prefix-length array offset | `lengths_offset + entry_count` |
| 20 | 4 | `u32` | Suffix-data offset | `prefixes_offset + entry_count` |
| 24 | 4 | `u32` | Suffix-data length | Dictionary section length minus suffix-data offset |
| 28 | 1 | `u8` | Dictionary ID width | One of `1`, `2`, `3`, or `4` |
| 29 | 1 | `u8` | Block shift | `3` |
| 30 | 2 | bytes | Reserved | Written as zero |

The arrays immediately follow the header:

```text
+------------------------------+ dictionary offset 0
| Dictionary header            | 32 bytes
+------------------------------+
| Block offsets                | block_count * 4 bytes
+------------------------------+
| Total UTF-8 lengths          | entry_count bytes
+------------------------------+
| Shared prefix lengths        | entry_count bytes
+------------------------------+
| Concatenated suffix bytes    | suffix_data_length bytes
+------------------------------+
```

`blockOffsets` is an array of little-endian `u32` values. Each value is relative to the start of the suffix-data area and points to the first suffix in that block. The first block offset is zero.

`lengths[i]` is the complete UTF-8 byte length of entry `i`. `prefixes[i]` is the number of leading bytes shared with entry `i - 1`. At the start of every eight-entry block, `prefixes[i]` must be zero. A non-initial prefix length must not exceed either the previous entry length or the current entry length.

The suffix-data area concatenates `encoded_string[prefix_length:]` for every dictionary entry in ID order.

### Dictionary decoding

To decode a nonzero dictionary ID:

```text
index = id - 1
if index >= entry_count:
    fail

block = index >> 3
block_start = block << 3
cursor = suffix_data_offset + block_offsets[block]
decoded = byte_buffer_with_capacity_255
previous_length = 0

for current from block_start through index:
    length = lengths[current]
    prefix = prefixes[current]

    if current == block_start and prefix != 0:
        fail
    if prefix > previous_length or prefix > length:
        fail

    suffix_length = length - prefix
    decoded[prefix:length] = suffix_data[cursor:cursor + suffix_length]
    cursor += suffix_length
    previous_length = length

return decode_utf8(decoded[0:previous_length])
```

ID zero is decoded as null only for fields that permit null. Readers should reject IDs greater than the dictionary entry count and any suffix read outside the dictionary section.

## Reconstructing a row

Given a row index found through the CEP index:

```text
logradouro_id = read_packed_bits(logradouroIds, row, b)
logradouro = logradouroDictionary[logradouro_id]

complemento = read_sparse_value(
    complementoBitmap,
    complementoRanks,
    complementoIds,
    complementoDictionary,
    row,
)

bairro_index = read_neighborhood_run_index(row)
if bairro_index != 0:
    bairro = bairroDictionary[bairros[bairro_index - 1].nome_id]
else:
    bairro = read_sparse_value(
        localidadeNomeBitmap, localidadeNomeRanks, localidadeNomeIds,
        bairroDictionary, row,
    )

locality_run = find_locality_run(row)
municipality_id = municipality_run_ids[locality_run]
municipality_record = municipalities[municipality_id - 1]
municipio_cod_ibge = municipality_record.ibge
municipio = municipioDictionary[municipality_record.municipio_id]
uf = ufDictionary[municipality_record.uf_id]

flags = localidadeFlags[locality_run]
localidade_situacao = [
    "sem_codificacao_por_logradouro",
    "codificada_por_logradouro",
    "inserida_na_codificacao_por_logradouro",
    "em_codificacao_por_logradouro",
][flags & 3]
localidade_tipo = ["municipio", "distrito", "povoado"][flags >> 2]

nome = read_sparse_value(
    nomeBitmap,
    nomeRanks,
    nomeIds,
    nomeDictionary,
    row,
)
```

The CEP is reconstructed from the prefix used for the lookup and the row's 10-bit suffix:

```text
cep_number = prefix * 1000 + suffix
cep = decimal_string(cep_number).left_pad_with_zeroes(8)
```

## Reader validation checklist

A robust reader should perform these checks before or during lookup:

1. The file is at least 256 bytes and has the exact magic, version, and header size.
2. The declared file size equals the actual file size.
3. `N` and `M` are nonzero.
4. Integer widths are in the range 1 through 4 and their corresponding counts fit those widths.
5. The sparse rank shift is 8, the dictionary block shift is 3, and the section count is 27.
6. Every section is inside the file, appears in directory order, and does not overlap the preceding section.
7. Every fixed-size section matches the formulas in the section-directory table.
8. The CEP prefix directory begins with zero, ends with `N`, is monotonic, and contains no value greater than `N`.
9. Every decoded CEP suffix is at most 999 and suffixes are strictly increasing within each prefix range.
10. Each dictionary has a valid 32-byte header, contiguous internal arrays, valid block offsets, and an ID width capable of representing its entry count.
11. Every dense or sparse dictionary ID is zero where permitted or is no greater than its dictionary entry count.
12. The final sparse rank equals the number of sparse IDs, rank values are monotonic, and unused bitmap bits are ignored or verified as zero.
13. Every municipality ID is between 1 and `M`; required municipality-name and state-code IDs are nonzero and in range.
14. Metadata is valid UTF-8 JSON whose top-level value is an object.
15. Neighborhood original identifiers are positive and strictly increasing; every locality identifier is positive and all dictionary references are valid.
16. The neighborhood run index has valid boundaries, samples, and indexes in `0..B`; fallback names occur only with index zero and locality type `D` or `P`.
17. Range offsets start at zero, are monotonic, and end at `F`; each interval has `0 <= initial <= final <= 99999999`, and intervals per neighborhood are strictly ordered by `(initial, final)`.
18. Municipality/locality runs have strictly increasing starts beginning at zero, exact directory entries and sentinel, and the same number of IDs and flags.
19. Each locality byte has a situation in `0..3`, a type index in `0..2`, and zero reserved bits.

Bounds checks are still required at point of use, even after initial validation. A memory-mapped file must not be truncated or replaced in place while readers are using that mapping.

## Compatibility

Readers implementing this document must require version `3` and the 27-section layout above. Earlier binaries are unsupported and must be regenerated from the DNE source. The public `DneBinaryDatabaseReader` API is unchanged. A reader must reject mismatched versions, header sizes, section counts, sparse rank shifts, and dictionary block shifts rather than guessing their meaning.

There is no platform-endianness marker. The on-disk representation is always little-endian, independent of the reader's host architecture.
