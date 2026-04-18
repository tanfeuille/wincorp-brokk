/**
 * Helpers utilitaires purs partagés entre thor et bifrost.
 */

/**
 * Similarité normalisée 0-1 entre deux noms de fournisseur.
 *
 * Calcul minimaliste : ratio des caractères alphanumériques communs dans l'ordre
 * (LCS simplifié). Seuil recommandé : 0.5 (en dessous → mismatch).
 */
export function similariteNomsFournisseur(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  const [court, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(court)) return court.length / long.length;
  let i = 0;
  let matched = 0;
  for (const c of long) {
    if (c === court[i]) {
      matched++;
      i++;
      if (i >= court.length) break;
    }
  }
  return matched / Math.max(na.length, nb.length);
}
