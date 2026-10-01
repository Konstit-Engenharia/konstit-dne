# DNE binary database format

This document specifies version 5 of the `@konstit/dne` binary database format. It is intended for authors of readers in languages other than TypeScript. Version 5 readers do not accept version 1, version 2, version 3, or version 4 files.

The format is an immutable artifact produced by a trusted generation process and is optimized for memory-mapped, read-only CEP lookup. It stores rows in CEP order, splits each CEP into a prefix directory and a packed suffix, interns strings in per-column dictionaries, and stores nullable low-density columns with bitmaps and rank indexes.

Every version 5 file ends with a 32-byte raw SHA-256 digest. The digest covers every preceding byte, including the header and alignment padding, and excludes the digest itself. The canonical writer validates the complete serialized byte sequence before computing the digest. Under the trusted-producer and immutability contract, an opening reader checks the minimum header, version, declared size, actual size, and digest before using the layout; it does not need to rescan every section, ID, offset, or relationship. Queries validate their input and decode the selected row directly. SHA-256 verifies integrity against the stored digest; it does not authenticate the producer, since an actor able to rewrite the file and digest can create another internally consistent artifact outside this contract.

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

A file consists of a fixed 256-byte header, 27 sections in a fixed order, alignment padding, and a 32-byte SHA-256 footer.

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
| Final padding             | to the next 8-byte boundary
+---------------------------+
| SHA-256 footer            | 32 raw digest bytes
+---------------------------+
```

Every section begins at an offset divisible by 8. Zero-filled padding may appear between sections and before the footer. Writers must zero reserved bytes and padding. Readers should ignore their contents. The footer is not a section-directory entry and starts immediately after the aligned end of the final section.

The file size, all section offsets, and all section lengths are stored as `u32`, so a version 5 file cannot exceed `4294967295` bytes.

## Header

The header occupies bytes `0` through `255`.

| Offset | Size | Type | Field | Required value or meaning |
| ---: | ---: | --- | --- | --- |
| 0 | 8 | bytes | Magic | `44 4e 45 42 49 4e 00 00`, or `DNEBIN\0\0` |
| 8 | 2 | `u16` | Version | `5` |
| 10 | 2 | `u16` | Header size | `256` |
| 12 | 4 | `u32` | Row count | `N`, must be greater than zero |
| 16 | 4 | `u32` | File size | Exact file length, including final alignment padding and the 32-byte footer |
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

Sections must appear in directory order, must not overlap, and must fit before the footer. The official writer aligns every section to 8 bytes.

### Footer

The footer is not listed in the section directory. Let `end` be the end offset of the final section and let `footer_offset = ceil(end / 8) * 8`. The writer fills the bytes from `end` through `footer_offset - 1` with zeroes, then writes the 32-byte raw SHA-256 digest at `footer_offset`:

```text
digest = SHA-256(file[0:footer_offset])
file[footer_offset:footer_offset + 32] = digest
file_size = footer_offset + 32
```

The digest input includes the header, every section, and all alignment padding. It excludes the footer itself. The declared `File size` field must equal `file_size`, and no bytes may follow the footer.

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

The official writer serializes the key/value metadata from the source SQLite database. Current values are strings, and the generation validator requires the UTF-8 JSON value to be an object.

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

The packed stream length guarantees that the two bytes needed by a valid row are present. The generation validator rejects decoded suffixes greater than `999`, even though 10 bits can represent values through `1023`. A trusted reader can rely on this validated invariant during direct lookup.

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

The generation validator checks the exact directory values and the sentinel. The row's municipality and flags must be read from the same run, including when only the flags changed. A trusted reader can use those validated boundaries directly.

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

The generation validator verifies exactly `R` one bits and `Z` zero bits, valid samples, a first run at row zero, strictly increasing starts below `N`, indexes in `0..B`, and different indexes in adjacent runs. A trusted reader can decode the run index without repeating this full scan at open time.

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

There are seven independent dictionaries: `logradouro`, `complemento`, `bairro`, `bairroAbreviado`, `municipio`, `uf`, and `nome`. Strings are UTF-8 encoded and front-coded in blocks of eight.

The official writer deduplicates and sorts each set of strings in JavaScript lexicographic order (UTF-16 code units) before assigning IDs. The generation validator checks the decoded entries against that order. Dictionary order is not needed for lookup correctness; readers use the stored IDs and block metadata.

Plain dictionaries store each decoded UTF-8 string in at most 255 bytes. The `logradouro` dictionary may use the FSST codec for the bytes after its front-coded prefix. FSST entries are also limited to 255 decoded bytes; one entry's encoded code payload is limited to 510 bytes.

The writer chooses the plain representation when the complete FSST dictionary section is not smaller. Other dictionaries always use the plain representation.

### Dictionary header

Every dictionary starts with a 32-byte header. Dictionary-relative offsets are measured from the first byte of this header.

| Dictionary offset | Size | Type | Field | Constraint |
| ---: | ---: | --- | --- | --- |
| 0 | 4 | `u32` | Entry count | Number of strings |
| 4 | 4 | `u32` | Block count | `ceil(entry_count / 8)` |
| 8 | 4 | `u32` | Block-offset array offset | `32` |
| 12 | 4 | `u32` | Length array offset | `32 + block_count * 4` |
| 16 | 4 | `u32` | Prefix-length array offset | `lengths_offset + entry_count * length_width` |
| 20 | 4 | `u32` | Suffix-data offset | `prefixes_offset + entry_count + symbol_table_size` |
| 24 | 4 | `u32` | Suffix-data length | Dictionary section length minus suffix-data offset |
| 28 | 1 | `u8` | Dictionary ID width | One of `1`, `2`, `3`, or `4` |
| 29 | 1 | `u8` | Block shift | `3` |
| 30 | 1 | `u8` | Codec | `0` = plain; `2` = FSST, only for `logradouro` |
| 31 | 1 | `u8` | Encoded-length width | `0` for plain; `1` or `2` for FSST |

For a plain dictionary, `length_width = 1` and `symbol_table_size = 0`, but the length array contains one `u8` per entry and byte 31 must be zero. For an FSST `logradouro` dictionary, `length_width` is the value in byte 31 and `symbol_table_size` is `255 * 9 = 2295` bytes. Any other codec or length-width combination is invalid.

The arrays immediately follow the header. In the plain representation:

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

In the FSST representation, the arrays after the block offsets are laid out as follows:

```text
+------------------------------+
| Compressed suffix lengths   | entry_count * length_width bytes
+------------------------------+
| Shared decoded-prefix lengths| entry_count bytes
+------------------------------+
| FSST symbol lengths          | 255 bytes
+------------------------------+
| FSST symbol slots            | 255 * 8 bytes, little-endian
+------------------------------+
| FSST code payload            | suffix_data_length bytes
+------------------------------+
```

`blockOffsets` is an array of little-endian `u32` values. Each value is relative to the start of the suffix-data area and points to the first suffix or code payload in that block. The first block offset is zero; subsequent offsets and the final suffix-data length bound each block.

For a plain dictionary, `lengths[i]` is the complete UTF-8 byte length of entry `i`. For FSST, it is the compressed code-payload length of the decoded suffix for entry `i`, using the one- or two-byte little-endian width selected in byte 31. In both representations, `prefixes[i]` is the number of leading decoded UTF-8 bytes shared with entry `i - 1`. At the start of every eight-entry block, `prefixes[i]` must be zero. A non-initial prefix length must not exceed the previous decoded entry length or the current decoded entry length.

The plain suffix-data area concatenates `encoded_string[prefix_length:]` for every dictionary entry in ID order. The FSST code-payload area concatenates the encoded form of the same decoded suffixes. Its codes are bytes `0..254` for symbols and `255` for an escape followed by one literal byte.

The FSST symbol table contains 255 one-byte lengths followed by 255 fixed eight-byte slots. A length of zero marks an unused symbol; a used symbol length must be `1..8`. Each slot is a little-endian eight-byte value, and only the first `length` bytes are copied to the decoded output. Bytes after `length` must be zero, including the entire slot of an unused symbol. The generation validator validates all 255 symbol-table lengths, slots, and code-payload entries. A trusted reader can use the validated table after the file digest has been verified.

### Dictionary decoding

ID zero is decoded as null only for fields that permit null. The generation validator rejects IDs greater than the dictionary entry count. It also validates the block count, block shift, ID width, codec and length-width combination, contiguous array offsets, and FSST symbol table against the dictionary section length. A trusted reader can use these values directly after the digest check instead of rescanning every dictionary at open time. Code payload bounds and symbol references are therefore already covered by generation validation when a query selects an ID.

To decode a nonzero plain dictionary ID:

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
    if cursor + suffix_length > suffix_data_end:
        fail
    decoded[prefix:length] = suffix_data[cursor:cursor + suffix_length]
    cursor += suffix_length
    previous_length = length

return decode_utf8(decoded[0:previous_length])
```

To decode an FSST `logradouro` ID, use the same front-coding traversal, but use the compressed length and block boundary:

```text
index = id - 1
block = index >> 3
block_start = block << 3
relative = block_offsets[block]
next_relative = block_offsets[block + 1] if block + 1 < block_count else suffix_data_length
if relative > next_relative or next_relative > suffix_data_length:
    fail

cursor = suffix_data_offset + relative
block_end = suffix_data_offset + next_relative
previous_length = 0

for current from block_start through index:
    encoded_length = read_uint(lengths, current, length_width)
    if encoded_length > 510 or cursor + encoded_length > block_end:
        fail
    prefix = prefixes[current]
    if prefix > previous_length:
        fail
    end = cursor + encoded_length
    offset = prefix
    while cursor < end:
        code = code_payload[cursor++]
        if code == 255:
            if cursor == end or offset == 255:
                fail
            decoded[offset++] = code_payload[cursor++]
        else:
            symbol_length = symbol_lengths[code]
            if symbol_length == 0 or symbol_length > 8 or offset + symbol_length > 255:
                fail
            copy symbol_slots[code][0:symbol_length] to decoded[offset:]
            offset += symbol_length
    previous_length = offset

if current is the final entry of its block and cursor != block_end:
    fail
return decode_utf8(decoded[0:previous_length])
```

The final-entry check applies to every block, including the final partial block. It ensures that a valid lookup consumes exactly the selected block's payload; the `next_relative` boundary prevents a lookup from reading the next block. Symbol, escape, prefix, decoded-length, encoded-length, and payload-end errors must be reported as format errors.

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

## Generation validation checklist

The canonical writer must apply the following checks to the complete serialized byte sequence before computing the footer digest.

1. The file is at least 288 bytes and has the exact magic, version `5`, and header size.
2. The declared file size equals the actual file size, the footer starts at the aligned end of the final section, and the file reserves exactly 32 bytes for the digest. The digest is computed only after these checks complete.
3. `N` and `M` are nonzero.
4. Integer widths are the minimum widths in the table above for their corresponding counts or maximum identifiers.
5. The sparse rank shift is 8, the dictionary block shift is 3, and the section count is 27.
6. Every section is before the footer, appears in directory order, and does not overlap the preceding section.
7. Every fixed-size section matches the formulas in the section-directory table.
8. The CEP prefix directory begins with zero, ends with `N`, is monotonic, and contains no value greater than `N`.
9. Every decoded CEP suffix is at most 999 and suffixes are strictly increasing within each prefix range.
10. Each dictionary has a valid 32-byte header, contiguous internal arrays, valid block offsets, and an ID width capable of representing its entry count. Plain dictionaries use codec `0` and header byte 31 equal to `0`; only `logradouro` may use codec `2` with header byte 31 equal to `1` or `2`.
11. Every decoded dictionary entry is strict UTF-8, obeys the maximum decoded length, reconstructs its front-coded prefix, and appears in the canonical lexicographic order. The corresponding suffix and code-payload lengths consume each dictionary section exactly.
12. An FSST symbol table has exactly 255 lengths in `0..8`, 255 eight-byte little-endian slots, and a code payload after the table. Every block has valid next-block bounds; each compressed entry has a length at most `510`, valid symbols and escapes, decoded output at most `255` bytes, and a final entry that consumes its block exactly.
13. Every dense or sparse dictionary ID is zero where permitted or is no greater than its dictionary entry count.
14. Every sparse rank entry equals the exact popcount before its 256-row block, rank values are monotonic, the final rank equals the number of sparse IDs, and unused bitmap bits are zero.
15. Every municipality ID is between 1 and `M`; municipality records are sorted by ascending seven-digit IBGE code stored in 24 bits, required municipality-name and state-code IDs are nonzero and in range, and each code's first two digits match its UF's IBGE state code. Every UF dictionary entry is a canonical uppercase abbreviation, including unused entries.
16. Metadata is valid strict UTF-8 JSON without a BOM, whose top-level value is an object with string values.
17. Neighborhood original identifiers are positive and strictly increasing; every locality identifier is positive, every neighborhood UF reference is valid, required names are nonempty, and all dictionary references are valid. Each row's neighborhood and municipality have the same UF.
18. The neighborhood run index has valid boundaries, samples, exact one- and zero-bit counts, and indexes in `0..B`; fallback names occur only with index zero and locality type `D` or `P`.
19. Range offsets start at zero, are monotonic, and end at `F`; each interval has `0 <= initial <= final <= 99999999`, and intervals per neighborhood are strictly ordered by `(initial, final)`.
20. Municipality/locality runs have strictly increasing starts beginning at zero, exact directory entries and sentinel, the same number of IDs and flags, and distinct adjacent `(municipality ID, flags)` pairs.
21. Each locality byte has a situation in `0..3`, a type index in `0..2`, and zero reserved bits; locality fallback and neighborhood relationships agree with those indicators.

## Opening and query contract

The trusted reader opens a file in this order:

1. Check that the mapped input contains the fixed header, then read the magic, version, header size, and declared file size.
2. Reject a version other than `5`, a header other than `256`, or a declared size that differs from the actual file length or cannot contain the footer.
3. Treat the final 32 bytes as the footer and compare its raw value with SHA-256 of all preceding bytes.
4. After the digest matches, parse the section directory and dictionaries using the generation invariants above; the trusted layout places the footer after the aligned end of the final section. Do not rescan every ID, offset, string, or relationship at open time.

Queries retain invalid-input handling and the closed-reader check, then decode the requested row directly from the trusted layout. The public reader continues to report I/O, unsupported-version, size, checksum, and closed-reader errors. The trusted supplier and immutability contract requires that a memory-mapped file is not truncated or replaced in place while readers use it. A SHA-256 match alone does not establish producer authenticity.

## Compatibility

Readers implementing this document must require version `5` and the 27-section layout above. Earlier binaries, including versions `1`, `2`, `3`, and `4`, are unsupported and must be regenerated from the DNE source. The public `DneBinaryDatabaseReader` API is unchanged. The generator must reject mismatched header constants, section counts, sparse rank shifts, dictionary block shifts, and dictionary codec fields rather than guessing their meaning. A trusted reader checks the minimum header, version, declared size, and checksum, then relies on the validated immutable layout.

There is no platform-endianness marker. The on-disk representation is always little-endian, independent of the reader's host architecture.
