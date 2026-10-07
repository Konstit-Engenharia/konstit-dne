import {
  describe,
  expect,
  test,
} from 'bun:test';
import { expand } from '../src/expand.ts';

test.each([
  ['CH BRIG ED GOMES', 'CHACARA BRIGADEIRO ED GOMES'],
  ['CHAC BRIG ED GOMES', 'CHACARA BRIGADEIRO ED GOMES'],
  ['Ch. Brig. Ed. Gomes, 123', 'CHACARA BRIGADEIRO ED GOMES 123'],
  ['CHACARA BRIGADEIRO ED GOMES', 'CHACARA BRIGADEIRO ED GOMES'],
  ['CH D PEDRO', 'CHACARA DOM PEDRO'],
  ['CH BRIG EDITOR GOMES', 'CHACARA BRIGADEIRO EDITOR GOMES'],
  ['CONJ HAB J BONIFACIO', 'CONJUNTO HABITACIONAL J BONIFACIO'],
  ['CJ HAB J BONIFACIO', 'CONJUNTO HABITACIONAL J BONIFACIO'],
  ['Conj. Hab. J. Bonifácio, 123', 'CONJUNTO HABITACIONAL J BONIFACIO 123'],
  ['CONJUNTO HABITACIONAL J BONIFACIO', 'CONJUNTO HABITACIONAL J BONIFACIO'],
  ['CONJ PE M DA NOBREGA', 'CONJUNTO PADRE M DA NOBREGA'],
  ['CJ PE M DA NOBREGA', 'CONJUNTO PADRE M DA NOBREGA'],
  ['Conj. Pe. M. da Nóbrega', 'CONJUNTO PADRE M DA NOBREGA'],
  ['CONJ D PEDRO', 'CONJUNTO DOM PEDRO'],
  ['R CONJ BONIFACIO', 'RUA CONJ BONIFACIO'],
  ['PQ. AMERICA', 'PARQUE AMERICA'],
  ['PQ AMERICA', 'PARQUE AMERICA'],
  ['PRQ AMERICA', 'PARQUE AMERICA'],
  ['PARQ AMERICA', 'PARQUE AMERICA'],
  ['Pq. América, 123', 'PARQUE AMERICA 123'],
  ['R PQ AMERICA', 'RUA PQ AMERICA'],
  ['R ED GOMES', 'RUA ED GOMES'],
  ['ED GOMES', 'EDIFICIO GOMES'],
  ['R CH GOMES', 'RUA CH GOMES'],
  ['Av. Dr. João, 123', 'AVENIDA DOUTOR JOAO 123'],
])('preserves the regression for %p', (input, expected) => {
  expect(expand(input)).toBe(expected);
});

describe('expand normalization', () => {
  test.each([
    '',
    ' \t\r\n ',
    '\u00a0\u2003\u202f',
    '...---///___',
    '!@#$%^&*()[]{};:"<>?\\|',
    '\u0301\u0303',
    '.\u0301\u0303',
    '😀🏡🚏',
    '東京',
    '１２３ ١٢٣',
    '\ud800\udfff',
  ])('returns an empty string for %p', (input) => {
    expect(expand(input)).toBe('');
  });

  test.each([
    ['joão', 'JOAO'],
    ['João da Silva', 'JOAO DA SILVA'],
    ['áéíóú àâêôãõ ç ü', 'AEIOU AAEOAO C U'],
    ['a\u0301rvore', 'ARVORE'],
    ['R Sa\u0303o Jose\u0301', 'RUA SAO JOSE'],
    ['  av.\t dr.\r\njoão\u00a0123  ', 'AVENIDA DOUTOR JOAO 123'],
    ['R\u2003João\u202fSilva', 'RUA JOAO SILVA'],
    ['R\u200bJoão\u200dSilva', 'RUA JOAO SILVA'],
    ['R__João___Silva', 'RUA JOAO SILVA'],
    ['R. João D\'Ávila', 'RUA JOAO D AVILA'],
    ['R. João-da-Silva', 'RUA JOAO DA SILVA'],
    ['R. João, 001-A / 02', 'RUA JOAO 001 A 02'],
    ['R. João (fundos)', 'RUA JOAO FUNDOS'],
    ['R. João 😀 Silva', 'RUA JOAO SILVA'],
    ['R João\u0000Silva', 'RUA JOAO SILVA'],
    ['R João 12.5', 'RUA JOAO 12 5'],
    ['R São Paulo 000123B', 'RUA SAO PAULO 000123B'],
    ['0000', '0000'],
    ['0123 0045A 67B', '0123 0045A 67B'],
    ['R 15 de Novembro 001', 'RUA 15 DE NOVEMBRO 001'],
    ['R João II 123', 'RUA JOAO II 123'],
    ['R São João S/N', 'RUA SAO JOAO S N'],
    ['R 東京 João', 'RUA JOAO'],
    ['R straße', 'RUA STRA E'],
    ['R oﬃce', 'RUA O CE'],
    ['① ² Ａ ａ', ''],
    ['\u{10428}', ''],
  ])('normalizes %p to %p', (input, expected) => {
    expect(expand(input)).toBe(expected);
  });
});

describe('expand street prefixes', () => {
  test.each([
    ['R', 'RUA'],
    ['AV', 'AVENIDA'],
    ['AVA', 'AVENIDA'],
    ['AVE', 'AVENIDA'],
    ['AVEN', 'AVENIDA'],
    ['AL', 'ALAMEDA'],
    ['ALAM', 'ALAMEDA'],
    ['AUTOESTR', 'AUTOESTRADA'],
    ['BC', 'BECO'],
    ['BCO', 'BECO'],
    ['CC', 'CALCADA'],
    ['CCNH', 'CALCADINHA'],
    ['CAM', 'CAMINHO'],
    ['CAMNO', 'CAMINHO'],
    ['ES', 'ESTRADA'],
    ['EST', 'ESTRADA'],
    ['ESTR', 'ESTRADA'],
    ['LG', 'LARGO'],
    ['LGO', 'LARGO'],
    ['LRG', 'LARGO'],
    ['L', 'LARGO'],
    ['LD', 'LADEIRA'],
    ['LAD', 'LADEIRA'],
    ['PDA', 'PARADA'],
    ['PSG', 'PASSAGEM'],
    ['PC', 'PRACA'],
    ['PCA', 'PRACA'],
    ['PR', 'PRACA'],
    ['PCT', 'PRACETA'],
    ['PCTA', 'PRACETA'],
    ['RET', 'RETORNO'],
    ['ROD', 'RODOVIA'],
    ['RVIA', 'RODOVIA'],
    ['RDVIA', 'RODOVIA'],
    ['ROT', 'ROTUNDA'],
    ['RS', 'RUAS'],
    ['TRANSV', 'TRANSVERSAL'],
    ['TV', 'TRAVESSA'],
    ['TRAV', 'TRAVESSA'],
    ['TR', 'TRAVESSA'],
    ['TRV', 'TRAVESSA'],
    ['V', 'VIA'],
    ['VD', 'VIADUTO'],
    ['VDTO', 'VIADUTO'],
    ['VE', 'VIELA'],
    ['ACAMP', 'ACAMPAMENTO'],
    ['AER', 'AEROPORTO'],
    ['CRG', 'CORREGO'],
    ['FAZ', 'FAZENDA'],
    ['GLB', 'GLEBA'],
    ['GJA', 'GRANJA'],
    ['ETC', 'ESTACAO'],
    ['COND', 'CONDOMINIO'],
  ])('expands the leading street type %s', (prefix, expected) => {
    expect(expand(`${prefix} das Flores 123`)).toBe(`${expected} DAS FLORES 123`);
  });

  test.each([
    ['AC AV Flores', 'ACESSO A AVENIDA FLORES'],
    ['AC PED Flores', 'ACESSO DE PEDESTRE FLORES'],
    ['ALC ACES Flores', 'ALCA DE ACESSO FLORES'],
    ['AUTO ESTR Flores', 'AUTOESTRADA FLORES'],
    ['AUTO ESTRADA Flores', 'AUTOESTRADA FLORES'],
    ['AV MARG Flores', 'AVENIDA MARGINAL FLORES'],
    ['AV MARG DIR Flores', 'AVENIDA MARGINAL DIREITA FLORES'],
    ['AV MARG ESQ Flores', 'AVENIDA MARGINAL ESQUERDA FLORES'],
    ['AV MARG NORTE Flores', 'AVENIDA MARGINAL NORTE FLORES'],
    ['ESTR MARG Flores', 'ESTRADA MARGINAL FLORES'],
    ['EST MUN Flores', 'ESTRADA MUNICIPAL FLORES'],
    ['E M Flores', 'ESTRADA MUNICIPAL FLORES'],
    ['E N Flores', 'ESTRADA NACIONAL FLORES'],
    ['E R Flores', 'ESTRADA REGIONAL FLORES'],
    ['I C Flores', 'ITINERARIO COMPLEMENTAR FLORES'],
    ['I P Flores', 'ITINERARIO PRINCIPAL FLORES'],
    ['R PART Flores', 'RUA PARTICULAR FLORES'],
    ['RPART Flores', 'RUA PARTICULAR FLORES'],
    ['JD PUB Flores', 'JARDIM PUBLICO FLORES'],
    ['PRQ MUNIC Flores', 'PARQUE MUNICIPAL FLORES'],
    ['PRQ RES Flores', 'PARQUE RESIDENCIAL FLORES'],
    ['CJ RES Flores', 'CONJUNTO RESIDENCIAL FLORES'],
    ['NUC HAB Flores', 'NUCLEO HABITACIONAL FLORES'],
    ['1 TV Flores', '1 TRAVESSA FLORES'],
    ['2 AV Flores', '2 AVENIDA FLORES'],
    ['9 TV Flores', '9 TRAVESSA FLORES'],
  ])('recognizes the complete prefix in %p', (input, expected) => {
    expect(expand(input)).toBe(expected);
  });

  test.each([
    ['R AV Flores', 'RUA AV FLORES'],
    ['R PQ Flores', 'RUA PQ FLORES'],
    ['R CONJ Flores', 'RUA CONJ FLORES'],
    ['R CH Flores', 'RUA CH FLORES'],
    ['R E M Flores', 'RUA E M FLORES'],
    ['R AC AV Flores', 'RUA AC AV FLORES'],
    ['AVEIRO', 'AVEIRO'],
    ['RUA AVEIRO', 'RUA AVEIRO'],
    ['CHACAL Gomes', 'CHACAL GOMES'],
    ['AV2 Flores', 'AV2 FLORES'],
    ['R2 Flores', 'R2 FLORES'],
  ])('preserves non-prefix text in %p', (input, expected) => {
    expect(expand(input)).toBe(expected);
  });
});

describe('expand places and institutions', () => {
  test.each([
    ['B', 'BAIRRO'],
    ['BO', 'BAIRRO'],
    ['BR', 'BAIRRO'],
    ['BRO', 'BAIRRO'],
    ['CH', 'CHACARA'],
    ['CHAC', 'CHACARA'],
    ['CJ', 'CONJUNTO'],
    ['CONJ', 'CONJUNTO'],
    ['LUG', 'LUGAR'],
    ['PQ', 'PARQUE'],
    ['PRQ', 'PARQUE'],
    ['PARQ', 'PARQUE'],
    ['QU', 'QUINTA'],
    ['QTA', 'QUINTA'],
    ['SIT', 'SITIO'],
    ['URB', 'URBANIZACAO'],
    ['VL', 'VILA'],
    ['VLA', 'VILA'],
    ['ZN', 'ZONA'],
    ['CM', 'CAMARA MUNICIPAL'],
    ['C M', 'CAMARA MUNICIPAL'],
    ['ED', 'EDIFICIO'],
  ])('expands the leading place or institution %s', (prefix, expected) => {
    expect(expand(`${prefix} São José`)).toBe(`${expected} SAO JOSE`);
  });
});

describe('expand titles', () => {
  test.each([
    ['DR', 'DOUTOR'],
    ['DRA', 'DOUTORA'],
    ['PROF', 'PROFESSOR'],
    ['PROFA', 'PROFESSORA'],
    ['PROFAS', 'PROFESSORAS'],
    ['PROFS', 'PROFESSORES'],
    ['PE', 'PADRE'],
    ['PDE', 'PADRE'],
    ['PR', 'PASTOR'],
    ['BRIG', 'BRIGADEIRO'],
    ['BRG', 'BRIGADEIRO'],
    ['CAP', 'CAPITAO'],
    ['CAPT', 'CAPITAO'],
    ['CEL', 'CORONEL'],
    ['COR', 'CORONEL'],
    ['TEN', 'TENENTE'],
    ['TTE', 'TENENTE'],
    ['SGT', 'SARGENTO'],
    ['SARG', 'SARGENTO'],
    ['MAJ', 'MAJOR'],
    ['GAL', 'GENERAL'],
    ['GEN', 'GENERAL'],
    ['MAL', 'MARECHAL'],
    ['MAR', 'MARECHAL'],
    ['ENG', 'ENGENHEIRO'],
    ['ARQ', 'ARQUITETO'],
    ['ENF', 'ENFERMEIRO'],
    ['MED', 'MEDICO'],
    ['ADV.O', 'ADVOGADO'],
    ['DEP', 'DEPUTADO'],
    ['DES', 'DESEMBARGADOR'],
    ['DESA', 'DESEMBARGADORA'],
    ['GOV', 'GOVERNADOR'],
    ['PREF', 'PREFEITO'],
    ['PRES', 'PRESIDENTE'],
    ['SEN', 'SENADOR'],
    ['VER', 'VEREADOR'],
    ['MIN', 'MINISTRO'],
    ['CONS', 'CONSELHEIRO'],
    ['MONS', 'MONSENHOR'],
    ['VIG', 'VIGARIO'],
    ['FR', 'FREI'],
    ['BAR', 'BARAO'],
    ['CDE', 'CONDE'],
    ['VISC', 'VISCONDE'],
    ['VDE', 'VISCONDE'],
    ['SR', 'SENHOR'],
    ['SRA', 'SENHORA'],
    ['STO', 'SANTO'],
    ['STA', 'SANTA'],
    ['ALF', 'ALFERES'],
    ['ALM', 'ALMIRANTE'],
    ['CMDT', 'COMANDANTE'],
    ['EMB', 'EMBAIXADOR'],
    ['JZ', 'JUIZ'],
  ])('expands the title %s before a name', (title, expected) => {
    expect(expand(`R ${title} Silva`)).toBe(`RUA ${expected} SILVA`);
  });

  test.each([
    ['Dª', 'DONA'],
    ['D.ª', 'DONA'],
    ['D.A', 'DONA'],
    ['DRª', 'DOUTORA'],
    ['D.Rª', 'DOUTORA'],
    ['D.RA', 'DOUTORA'],
    ['DES.A', 'DESEMBARGADORA'],
    ['PROFª', 'PROFESSORA'],
    ['PROF.ª', 'PROFESSORA'],
    ['PROF.A', 'PROFESSORA'],
    ['PROFº', 'PROFESSOR'],
    ['PROF°', 'PROFESSOR'],
    ['ENGª', 'ENGENHEIRA'],
    ['ENG.A', 'ENGENHEIRA'],
    ['ENG.ª', 'ENGENHEIRA'],
    ['ENGº', 'ENGENHEIRO'],
    ['ENG°', 'ENGENHEIRO'],
    ['ENG.º', 'ENGENHEIRO'],
    ['ENG.°', 'ENGENHEIRO'],
    ['ENFª', 'ENFERMEIRA'],
    ['ENF.A', 'ENFERMEIRA'],
    ['ENFº', 'ENFERMEIRO'],
    ['ENF.°', 'ENFERMEIRO'],
    ['IMª', 'IRMA'],
    ['IMº', 'IRMAO'],
    ['Sª', 'SENHORA'],
    ['SR.ª', 'SENHORA'],
    ['S.RA', 'SENHORA'],
    ['S.Rª', 'SENHORA'],
    ['S.R', 'SENHOR'],
    ['STª', 'SANTA'],
    ['ST.A', 'SANTA'],
    ['ST.º', 'SANTO'],
    ['ST.°', 'SANTO'],
    ['G.AL', 'GENERAL'],
    ['M.AL', 'MARECHAL'],
    ['GOV.DOR', 'GOVERNADOR'],
    ['COM.OR', 'COMENDADOR'],
    ['P.E', 'PADRE'],
    ['T.TE', 'TENENTE'],
    ['V.DE', 'VISCONDE'],
  ])('recognizes the punctuated or gendered title %s', (title, expected) => {
    expect(expand(`R. ${title.toLowerCase()}. Silva`)).toBe(`RUA ${expected} SILVA`);
  });

  test.each([
    ['CAP CORV', 'CAPITAO DE CORVETA'],
    ['CAP FRAG', 'CAPITAO DE FRAGATA'],
    ['CAP M G', 'CAPITAO DE MAR E GUERRA'],
    ['CAP MG', 'CAPITAO DE MAR E GUERRA'],
    ['CAP TEN', 'CAPITAO TENENTE'],
    ['CAP TTE', 'CAPITAO TENENTE'],
    ['TEN CEL', 'TENENTE CORONEL'],
    ['TTE CEL', 'TENENTE CORONEL'],
    ['TEN C.EL', 'TENENTE CORONEL'],
    ['T.TE C.EL', 'TENENTE CORONEL'],
    ['TEN CEL PM', 'TENENTE CORONEL POLICIA MILITAR'],
    ['TEN CEL AV', 'TENENTE CORONEL AVIADOR'],
    ['MAJ BRIG', 'MAJOR BRIGADEIRO'],
    ['MAJ BRG AR', 'MAJOR BRIGADEIRO DO AR'],
    ['SARG AJ.TE', 'SARGENTO AJUDANTE'],
    ['C ALM', 'CONTRA ALMIRANTE'],
    ['V ALM', 'VICE ALMIRANTE'],
    ['PRES DR', 'PRESIDENTE DOUTOR'],
  ])('recognizes the complete title %s', (title, expected) => {
    expect(expand(`R ${title} Silva`)).toBe(`RUA ${expected} SILVA`);
  });

  test.each([
    ['R NSRA Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R NSA Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R N SRA Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R Nª Sª Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R Nª SRª Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R N.S.A. Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R NS Jesus', 'RUA NOSSO SENHOR JESUS'],
    ['R N.S. Jesus', 'RUA NOSSO SENHOR JESUS'],
    ['R N S Jesus', 'RUA NOSSO SENHOR JESUS'],
    ['R N SR Jesus', 'RUA NOSSO SENHOR JESUS'],
    ['R Nossa Senhora Aparecida', 'RUA NOSSA SENHORA APARECIDA'],
    ['R Tenente Coronel Silva', 'RUA TENENTE CORONEL SILVA'],
    ['R DRACENA', 'RUA DRACENA'],
    ['R DR10 Silva', 'RUA DR10 SILVA'],
    ['R N SRAAPARECIDA', 'RUA N SRAAPARECIDA'],
  ])('respects title spelling and word boundaries in %p', (input, expected) => {
    expect(expand(input)).toBe(expected);
  });
});

describe('expand qualifiers', () => {
  test.each([
    ['DTO', 'DIREITO'],
    ['DT', 'DIREITO'],
    ['ESQ', 'ESQUERDO'],
    ['FT', 'FRENTE'],
    ['PART', 'PARTICULAR'],
    ['PTO', 'PONTO'],
    ['PNTO', 'PONTO'],
    ['PROJ', 'PROJECTADA'],
    ['PROLNG', 'PROLONGAMENTO'],
    ['PRL', 'PROLONGAMENTO'],
  ])('expands %s both inside and at the end of an address', (alias, expected) => {
    expect(expand(`R ${alias} Flores`)).toBe(`RUA ${expected} FLORES`);
    expect(expand(`R Flores ${alias}`)).toBe(`RUA FLORES ${expected}`);
    expect(expand(alias)).toBe(expected);
  });
});

describe('expand ambiguous names and positions', () => {
  test.each([
    ['R S João', 'RUA S JOAO'],
    ['R IM João', 'RUA IM JOAO'],
    ['R ME João', 'RUA ME JOAO'],
    ['R ED Gomes', 'RUA ED GOMES'],
    ['R Ed. Gomes', 'RUA ED GOMES'],
    ['R MIN João', 'RUA MINISTRO JOAO'],
    ['R PR João', 'RUA PASTOR JOAO'],
    ['PR João', 'PRACA JOAO'],
    ['R DA Silva', 'RUA DA SILVA'],
    ['R DE Sá', 'RUA DE SA'],
    ['R DO Carmo', 'RUA DO CARMO'],
    ['R DOS Santos', 'RUA DOS SANTOS'],
    ['R DAS Flores', 'RUA DAS FLORES'],
    ['R. J. A. Silva', 'RUA J A SILVA'],
    ['R. J.A. Silva', 'RUA J A SILVA'],
    ['R. S.A. Silva', 'RUA S A SILVA'],
    ['R J Gomes', 'RUA J GOMES'],
    ['R M Gomes', 'RUA M GOMES'],
    ['R Q Gomes', 'RUA Q GOMES'],
    ['R XYZ Gomes', 'RUA XYZ GOMES'],
    ['D Pedro', 'DOM PEDRO'],
    ['D. Pedro', 'DOM PEDRO'],
    ['R D Pedro', 'RUA DOM PEDRO'],
    ['Rua D Pedro', 'RUA DOM PEDRO'],
    ['PQ D Pedro', 'PARQUE DOM PEDRO'],
    ['R João D Silva', 'RUA JOAO D SILVA'],
    ['R Dr D Silva', 'RUA DOUTOR D SILVA'],
    ['João D Silva', 'JOAO D SILVA'],
    ['R D', 'RUA D'],
    ['R Dr', 'RUA DR'],
    ['R Pe', 'RUA PE'],
    ['R Prof', 'RUA PROF'],
    ['R PR', 'RUA PR'],
    ['R TEN CEL', 'RUA TEN CEL'],
    ['R João ED', 'RUA JOAO ED'],
    ['R João M', 'RUA JOAO M'],
  ])('preserves the intended interpretation of %p', (input, expected) => {
    expect(expand(input)).toBe(expected);
  });

  test.each(['R', 'AV', 'PR', 'CH', 'PQ', 'ED', 'D', 'DR', 'PE', 'PROF', 'J', 'M', 'XYZ'])(
    'preserves the isolated token %s',
    (input) => {
      expect(expand(input)).toBe(input);
    },
  );

  // Removing the apostrophe currently makes the surname's D look like the title Dom.
  test.failing.each(['R. D\'Ávila', 'R. D’Ávila'])('preserves the surname in %p', (input) => {
    expect(expand(input)).toBe('RUA D AVILA');
  });
});

describe('expand consistency', () => {
  const addresses: [string, string][] = [];
  for (
    const [prefix, expandedPrefix,] of [
      ['R.', 'RUA'],
      ['Av.', 'AVENIDA'],
      ['Conj.', 'CONJUNTO'],
      ['Pq.', 'PARQUE'],
    ] as const
  ) {
    for (
      const [title, expandedTitle,] of [
        ['Dr.', 'DOUTOR'],
        ['Pe.', 'PADRE'],
        ['Brig.', 'BRIGADEIRO'],
        ['Prof.ª', 'PROFESSORA'],
      ] as const
    ) {
      for (
        const [name, expandedName,] of [
          ['João da Silva', 'JOAO DA SILVA'],
          ['José Bonifácio', 'JOSE BONIFACIO'],
          ['M. da Nóbrega', 'M DA NOBREGA'],
          ['J. A. Gomes', 'J A GOMES'],
        ] as const
      ) {
        addresses.push([
          `${prefix} ${title} ${name}, 001A`,
          `${expandedPrefix} ${expandedTitle} ${expandedName} 001A`,
        ]);
      }
    }
  }

  test.each(addresses)('handles equivalent forms of %p consistently', (input, expected) => {
    for (
      const variant of [
        input,
        input.toLowerCase(),
        input.toUpperCase(),
        input.normalize('NFD'),
        ` \t${input.replaceAll(' ', '\t\n')}\r\n`,
      ]
    ) {
      expect(expand(variant)).toBe(expected);
    }
    const result = expand(input);
    expect(expand(result)).toBe(result);
    expect(result.normalize('NFC')).toBe(result);
    expect(result).toMatch(/^[A-Z0-9]+(?: [A-Z0-9]+)*$/);
  });

  test('does not retain regular expression state between calls', () => {
    const inputs = ['R. Dr. João', '', 'PQ. AMERICA', 'CONJ PE M DA NOBREGA', '...'];
    const expected = ['RUA DOUTOR JOAO', '', 'PARQUE AMERICA', 'CONJUNTO PADRE M DA NOBREGA', ''];
    for (let repeat = 0; repeat < 10; repeat++) {
      expect(inputs.map(expand)).toEqual(expected);
    }
  });

  test('does not truncate a long address', () => {
    const names = Array.from({ length: 2_048 }, () => 'João');
    expect(expand(`R. ${names.join(' ')} 0001`)).toBe(`RUA ${'JOAO '.repeat(names.length)}0001`);
  });
});
