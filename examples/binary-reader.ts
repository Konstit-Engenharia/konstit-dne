/** Run: DNE_DATABASE=./data/dne.bin bun examples/binary-reader.ts 01001-000 */
import {
  DneBinaryDatabaseReader,
  type DneBairro,
  type DneFaixaCep,
  type DneRow,
  type LoadMetadata,
  type LocalidadeSituacao,
  type LocalidadeTipo,
} from '../src/library.ts';

// Omitting DNE_DATABASE uses the binary database bundled with the package.
const reader = new DneBinaryDatabaseReader(process.env['DNE_DATABASE']);
try {
  const metadata: Readonly<LoadMetadata> = reader.metadata();
  console.log({ rows: reader.rowCount(), checksum: reader.checksum(), metadata });

  const cep = process.argv[2] ?? '01001-000';
  const address: DneRow | undefined = reader.queryCep(cep);
  console.log({ address });
  if (address !== undefined) {
    const type: LocalidadeTipo = address.localidade_tipo;
    const status: LocalidadeSituacao = address.localidade_situacao;
    console.log({ type, status, municipality: reader.queryMunicipality(address.municipio_cod_ibge) });
  }
  console.log({ municipalityCodesInSP: reader.queryMunicipalityCodesByUf('SP') });

  const neighborhood: DneBairro | undefined = reader.queryNeighborhoodByCep(cep);
  console.log({ neighborhood });
  if (neighborhood !== undefined) {
    const ranges: DneFaixaCep[] = reader.queryNeighborhoodCepRanges(neighborhood.bairro_id);
    console.log({ byId: reader.queryNeighborhood(neighborhood.bairro_id), ranges });
  }

  // Stop early instead of materializing the entire database as an array.
  let shown = 0;
  for (const row of reader.entries()) {
    console.log({ sample: row });
    if (++shown === 3) {
      break;
    }
  }
} finally {
  reader.close();
}
// Only cached metadata and row count remain available after close().
console.log({ rowsAfterClose: reader.rowCount(), metadataAfterClose: reader.metadata() });
