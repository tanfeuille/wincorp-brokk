/**
 * Détermine le régime TVA d'une ligne à partir du compte de charge PCG.
 *
 * - 60702xxx / 6072xxxx → achats intracommunautaires (autoliquidation)
 * - 60703xxx / 6073xxxx → achats extracommunautaires (importation hors UE)
 * - autres              → régime France (TVA déductible classique)
 *
 * Cette règle est dérivée du préfixe compte uniquement (ERR-TVA-01). En pratique,
 * elle est une inférence de dernier recours : la hiérarchie ERR-TVA-04 définit
 * Fulll bookQuery > config client > Vision > préfixe compte.
 */
export function determinerRegimeTvaDepuisCompte(
  compte: string,
): "FR" | "intracom" | "extracom" {
  if (!compte) return "FR";
  if (compte.startsWith("60702") || compte.startsWith("6072")) return "intracom";
  if (compte.startsWith("60703") || compte.startsWith("6073")) return "extracom";
  return "FR";
}
