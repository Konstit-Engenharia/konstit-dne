import type { UF } from './types.ts';

/** A neighborhood from `LOG_BAIRRO.TXT`, identified independently of its name. */
export type DneBairro = {
  /** Original positive `BAI_NU` identifier from the DNE source. */
  bairro_id: number;
  /** Original `LOC_NU` identifier of the neighborhood's locality. */
  localidade_id: number;
  /** Full neighborhood name. Names are not globally unique. */
  nome: string;
  /** Abbreviated source name, or null when no abbreviation is supplied. */
  nome_abreviado: string | null;
  /** Two-letter Brazilian state abbreviation. */
  uf: UF;
};

/** One inclusive CEP interval assigned to a neighborhood by the DNE source. */
export type DneFaixaCep = {
  /** Inclusive lower bound, preserving all eight digits and leading zeroes. */
  cep_inicial: string;
  /** Inclusive upper bound, preserving all eight digits and leading zeroes. */
  cep_final: string;
};

/**
 * Checks whether a value can represent an original DNE neighborhood identifier.
 * @param value - Candidate identifier; names and stringified identifiers are not accepted.
 * @returns True for a positive unsigned 32-bit integer.
 */
export function isBairroId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}
