/// Endereço de um CEP na base e-DNE.
final class DneRow {
  const DneRow({
    required this.cep,
    required this.logradouro,
    required this.complemento,
    required this.bairro,
    required this.municipio,
    required this.municipioCodIbge,
    required this.uf,
    required this.nome,
    required this.localidadeSituacao,
    required this.localidadeTipo,
  });

  final String cep;
  final String? logradouro;
  final String? complemento;
  final String? bairro;
  final String municipio;
  final int municipioCodIbge;
  final String uf;
  final String? nome;
  final String localidadeSituacao;
  final String localidadeTipo;

  /// Usa os mesmos nomes de campos de `@konstit/dne`.
  Map<String, Object?> toJson() => {
        'bairro': bairro,
        'cep': cep,
        'complemento': complemento,
        'localidade_situacao': localidadeSituacao,
        'localidade_tipo': localidadeTipo,
        'logradouro': logradouro,
        'municipio': municipio,
        'municipio_cod_ibge': municipioCodIbge,
        'nome': nome,
        'uf': uf,
      };
}
