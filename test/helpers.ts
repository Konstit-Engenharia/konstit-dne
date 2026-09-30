import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  join,
} from 'node:path';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';

export function run(command: string, args: string[], cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr.toString()}`);
  }
}

export function createFixture(directory: string, rows: number) {
  run('bun', ['run', 'bench/create-dne.bench.ts', directory, String(rows)]);
}

export function createLocalityFixture(directory: string) {
  const delimited = join(directory, 'Delimitado');
  mkdirSync(delimited, { recursive: true });
  const files: Record<string, string[]> = {
    'LOG_LOCALIDADE.TXT': [
      '1@SP@Municipio Codificado@@1@M@@@3500001',
      '2@SP@Municipio Unico@10000000@0@M@@@3500002',
      '3@SP@Distrito Unico@11000000@0@D@6@@',
      '4@SP@Povoado Integrado@@2@P@1@@',
      '5@SP@Distrito Codificado@@1@D@1@@',
      '6@SP@Municipio em Codificacao@12000000@3@M@@@3500006',
      '7@SP@Distrito em Codificacao@13000000@3@D@6@@',
      '8@SP@Povoado em Codificacao@14000000@3@P@6@@',
    ],
    'LOG_BAIRRO.TXT': [
      '11@SP@1@Centro@Ctr',
      '12@SP@2@Centro',
      '14@SP@4@Povoado',
      '15@SP@5@Vila',
      '16@SP@6@Centro',
      '17@SP@7@Distrito',
      '18@SP@8@Povoado',
    ],
    'LOG_FAIXA_BAIRRO.TXT': [
      '11@01000000@01000010',
      '11@21000000@21000000',
      '14@24000000@24000099',
    ],
    'LOG_LOGRADOURO_SP.TXT': [
      '21@SP@1@11@@Principal@@21000000@Rua@S',
      '24@SP@4@14@@do Povoado@@24000000@Rua@S',
      '25@SP@5@15@@do Distrito@@25000000@Rua@S',
      '26@SP@6@16@@do Municipio em Codificacao@@26000000@Rua@S',
      '27@SP@7@17@@do Distrito em Codificacao@@27000000@Rua@S',
      '28@SP@8@18@@do Povoado em Codificacao@@28000000@Rua@S',
    ],
    'LOG_CPC.TXT': [
      '41@SP@1@CPC Centro@Rua Principal, 1@41000000',
      '42@SP@2@CPC Unico@Rua Central, 2@42000000',
      '44@SP@4@CPC Povoado@Rua do Povoado, 4@44000000',
      '46@SP@6@CPC em Codificacao@Rua Central, 6@46000000',
    ],
    'LOG_GRANDE_USUARIO.TXT': [
      '52@SP@2@12@@Empresa@Rua Central, 2@52000000',
      '57@SP@7@17@@Empresa em Codificacao@Rua do Distrito, 7@57000000',
    ],
    'LOG_UNID_OPER.TXT': [
      '62@SP@2@12@@Agencia Unico@Rua Central, 2@62000000',
      '64@SP@4@14@@Agencia Povoado@Rua do Povoado, 4@64000000',
      '68@SP@8@18@@Agencia em Codificacao@Rua do Povoado, 8@68000000',
    ],
  };
  for (const [name, lines,] of Object.entries(files)) {
    writeFileSync(join(delimited, name), lines.join('\n'), 'latin1');
  }
}

export function createNestedZipFixture(directory: string, rows: number) {
  const dneDirectory = join(directory, 'dne');
  const innerZip = join(directory, 'eDNE_Basico_12345.zip');
  const outerZip = join(directory, 'eDNE_Basico.zip');

  createFixture(dneDirectory, rows);
  run('zip', ['-qr', innerZip, 'Delimitado'], dneDirectory);
  run('zip', ['-q', outerZip, basename(innerZip)], directory);
  return outerZip;
}

export function fetchDatabase(databasePath: string, sourcePath: string) {
  run('bun', ['run', 'src/index.ts', 'build', '--db', databasePath, '--source', sourcePath]);
}

export function rowCount(db: Database) {
  const statement = db.prepare(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`);
  try {
    return (
      statement.get() as {
        count: number;
      }
    ).count;
  } finally {
    statement.finalize();
  }
}

export async function expectRejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch {
    return;
  }

  throw new Error('Expected promise to reject');
}
