import {
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildSchema,
  getTableFilesGlob,
} from '../src/schema.ts';

const outDir = Bun.argv[2];
const size = Number(Bun.argv[3] ?? '5000');

if (!outDir) {
  console.error('Usage: bun run scripts/create-benchmark-dne.ts <output-dir> [size]');
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
const delimited = join(outDir, 'Delimitado');
await mkdir(delimited, { recursive: true });

for (const table of buildSchema()) {
  const glob = getTableFilesGlob(table);
  if (!glob) {
    continue;
  }
  if (glob === 'LOG_LOGRADOURO_*.TXT') {
    await writeFile(join(delimited, 'LOG_LOGRADOURO_SP.TXT'), '');
    await writeFile(join(delimited, 'LOG_LOGRADOURO_BA.TXT'), '');
  } else {
    await writeFile(join(delimited, glob), '');
  }
}

const localidades: string[][] = [];
const bairros: string[][] = [];
const logradourosSp: string[][] = [];
const logradourosBa: string[][] = [];
const cpcs: string[][] = [];
const grandesUsuarios: string[][] = [];
const unidadesOperacionais: string[][] = [];
const faixaLocalidade: string[][] = [];
const varLoc: string[][] = [];
const faixaBairro: string[][] = [];
const faixaCpc: string[][] = [];
const varBai: string[][] = [];
const varLog: string[][] = [];
const numSec: string[][] = [];
const faixaUop: string[][] = [];

for (let index = 1; index <= size; index++) {
  const uf = index % 2 === 0 ? 'SP' : 'BA';
  const locNu = 100000 + index;
  const baiNu = 200000 + index;
  const logNu = 300000 + index;
  const localityCep = index % 50 === 0 ? cep(10000000 + index) : '';

  localidades.push([
    String(locNu),
    uf,
    `Municipio ${index}`,
    localityCep,
    '1',
    'M',
    '',
    `Mun ${index}`,
    String(3500000 + index),
  ]);

  if (index % 100 === 0) {
    localidades.push([
      String(900000 + index),
      uf,
      `Distrito ${index}`,
      cep(11000000 + index),
      '0',
      'D',
      String(locNu),
      `Dist ${index}`,
      '',
    ]);
  }

  bairros.push([String(baiNu), uf, String(locNu), `Bairro ${index}`, `B ${index}`]);
  if (index === 1) {
    faixaLocalidade.push([String(locNu), '30000000', '39999999', 'T']);
    varLoc.push([String(locNu), '1', `Municipio Alternativo ${index}`]);
    faixaBairro.push([String(baiNu), '30000000', '39999999']);
    varBai.push([String(baiNu), '1', `Bairro Alternativo ${index}`]);
  }

  const logradouro = [
    String(logNu),
    uf,
    String(locNu),
    String(baiNu),
    '',
    `Endereco ${index}`,
    '',
    cep(30000000 + index),
    index % 3 === 0 ? 'Avenida' : 'Rua',
    index % 5 === 0 ? 'N' : 'S',
    `End ${index}`,
  ];

  if (uf === 'SP') {
    logradourosSp.push(logradouro);
  } else {
    logradourosBa.push(logradouro);
  }

  if (index === 1) {
    varLog.push([String(logNu), '1', 'Rua', `Endereco Alternativo ${index}`]);
    numSec.push([String(logNu), '1', '999', 'A']);
  }

  if (index === 1 || index % 20 === 0) {
    cpcs.push([
      String(400000 + index),
      uf,
      String(locNu),
      `CPC ${index}`,
      `Rua CPC ${index}, sala ${index}`,
      cep(40000000 + index),
    ]);
    if (index === 1) {
      faixaCpc.push([String(400000 + index), '000001', '000999']);
    }
  }

  if (index === 1 || index % 25 === 0) {
    grandesUsuarios.push([
      String(500000 + index),
      uf,
      String(locNu),
      String(baiNu),
      String(logNu),
      `Grande Usuario ${index}`,
      `Rua Usuario ${index}, bloco ${index}`,
      cep(50000000 + index),
      `GU ${index}`,
    ]);
  }

  if (index === 1 || index % 30 === 0) {
    unidadesOperacionais.push([
      String(600000 + index),
      uf,
      String(locNu),
      String(baiNu),
      String(logNu),
      `Unidade ${index}`,
      `Rua Unidade ${index}, posto ${index}`,
      cep(60000000 + index),
      'S',
      `UOP ${index}`,
    ]);
    if (index === 1) {
      faixaUop.push([String(600000 + index), '1', '999']);
    }
  }
}

await writeRows('LOG_FAIXA_UF.TXT', [
  ['SP', '01000000', '19999999'],
  ['BA', '40000000', '48999999'],
]);
await writeRows('LOG_LOCALIDADE.TXT', localidades);
await writeRows('LOG_VAR_LOC.TXT', varLoc);
await writeRows('LOG_FAIXA_LOCALIDADE.TXT', faixaLocalidade);
await writeRows('LOG_BAIRRO.TXT', bairros);
await writeRows('LOG_VAR_BAI.TXT', varBai);
await writeRows('LOG_FAIXA_BAIRRO.TXT', faixaBairro);
await writeRows('LOG_LOGRADOURO_SP.TXT', logradourosSp);
await writeRows('LOG_LOGRADOURO_BA.TXT', logradourosBa);
await writeRows('LOG_VAR_LOG.TXT', varLog);
await writeRows('LOG_NUM_SEC.TXT', numSec);
await writeRows('LOG_CPC.TXT', cpcs);
await writeRows('LOG_FAIXA_CPC.TXT', faixaCpc);
await writeRows('LOG_GRANDE_USUARIO.TXT', grandesUsuarios);
await writeRows('LOG_UNID_OPER.TXT', unidadesOperacionais);
await writeRows('LOG_FAIXA_UOP.TXT', faixaUop);
await writeRows('ECT_PAIS.TXT', [['BR', 'BRA', 'Brasil', 'Brazil', 'Bresil', 'BR']]);

console.log(`Created benchmark DNE fixture at ${delimited}`);

async function writeRows(file: string, rows: string[][]) {
  await writeFile(join(delimited, file), rows.map((row) => row.join('@')).join('\n'), { encoding: 'latin1' });
}

function cep(value: number) {
  return String(value).padStart(8, '0').slice(-8);
}
