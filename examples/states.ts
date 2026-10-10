/** Run: bun examples/states.ts ' sp ' */
import {
  ALL_UFS,
  parseUF,
  stateCodeToUF,
  stateNameToUF,
  ufToStateCode,
  ufToStateName,
  type UF,
} from '../src/library.ts';

const uf: UF | undefined = parseUF(process.argv[2] ?? ' sp ');
console.log({ uf, name: uf === undefined ? undefined : ufToStateName(uf) });
console.log({ fromName: stateNameToUF('sao paulo'), fromCode: stateCodeToUF(35) });
console.log({ invalidUf: parseUF('XX'), invalidCode: stateCodeToUF(0) });

console.table(ALL_UFS.map((state) => ({
  uf: state,
  name: ufToStateName(state),
  ibgeCode: ufToStateCode(state),
})));
