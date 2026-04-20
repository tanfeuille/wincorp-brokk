/**
 * Helpers de date partagés entre extracteur, décideur et builder.
 */

import type { ProfilDossier } from "./types.js";

/**
 * Convertit une date FR (JJ/MM/AAAA) en ISO Fulll (AAAA-MM-JJTHH:00:00+00:00).
 *
 * @param dateVision date au format JJ/MM/AAAA, peut être undefined/null/vide
 * @returns date ISO ou undefined si entrée invalide
 */
export function dateVersISO(
  dateVision: string | undefined | null,
): string | undefined {
  if (!dateVision || typeof dateVision !== "string" || !dateVision.includes("/")) {
    return undefined;
  }
  const parts = dateVision.split("/");
  if (parts.length !== 3) return undefined;
  const [j, m, a] = parts;
  if (!j || !m || !a) return undefined;
  return `${a.padStart(4, "0")}-${m.padStart(2, "0")}-${j.padStart(2, "0")}T00:00:00+00:00`;
}

/**
 * Reconstruit la période d'exercice courante depuis `profil.comptabilite.cloture`.
 *
 * Format cloture attendu : "JJ/MM" (ex: "30/06" pour 30 juin) ou "JJ/MM/AAAA".
 * Retourne { start, end } ISO ou null si format invalide.
 */
export function exerciceDepuisCloture(
  cloture: string | undefined,
  refDate: Date = new Date(),
): { start: string; end: string } | null {
  if (!cloture) return null;
  const parts = cloture.split("/");
  if (parts.length < 2) return null;
  const j = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(j) || isNaN(m) || j < 1 || j > 31 || m < 1 || m > 12) return null;
  const refY = refDate.getUTCFullYear();
  const clotureCetteAnnee = new Date(Date.UTC(refY, m - 1, j, 23, 59, 59));
  const clotureFin =
    refDate.getTime() <= clotureCetteAnnee.getTime()
      ? clotureCetteAnnee
      : new Date(Date.UTC(refY + 1, m - 1, j, 23, 59, 59));
  const ouverture = new Date(clotureFin);
  ouverture.setUTCFullYear(ouverture.getUTCFullYear() - 1);
  ouverture.setUTCDate(ouverture.getUTCDate() + 1);
  ouverture.setUTCHours(0, 0, 0, 0);
  return { start: ouverture.toISOString(), end: clotureFin.toISOString() };
}

/**
 * M-1 (run ELAG'RIMP 20/04) — corrige les erreurs OCR sur l'année.
 *
 * Deux cas traités :
 * 1. Année à 2 chiffres ("26/04/26" tickets caisse) → padding siècle courant
 *    ("26/04/2026" si année système = 2026).
 * 2. Année OCR "1926" au lieu de "2026" → +100 UNIQUEMENT si la date corrigée
 *    tombe dans la plage glissante [anneeCourante-2, anneeCourante+1] (évite
 *    1999+100=2099 absurde).
 *
 * Ne touche pas les années > 2000 (déjà correctes) ni les années < 1900
 * (corruption majeure à signaler en douteux via filet exercice).
 *
 * Les règles reviewer préservées :
 * - La garde `ji > 12 || mi > 12` de `corrigerDateAmbigue` est conservée
 *   telle quelle. Cette fonction s'applique AVANT, sur la chaîne, pour
 *   remplacer uniquement le segment année.
 * - Le filtre exercice fiscal de `run-saisie.ts` reste le dernier filet si
 *   cette correction ne suffit pas.
 */
export function corrigerAnneeOcr(
  dateVisionFR: string,
  refDate: Date = new Date(),
): { dateCorrigee: string; anneeCorrigee: boolean } {
  if (!dateVisionFR || typeof dateVisionFR !== "string") {
    return { dateCorrigee: dateVisionFR, anneeCorrigee: false };
  }
  const parts = dateVisionFR.split("/");
  if (parts.length !== 3) return { dateCorrigee: dateVisionFR, anneeCorrigee: false };
  const [j, m, a] = parts;
  if (!j || !m || !a) return { dateCorrigee: dateVisionFR, anneeCorrigee: false };
  const anneeCourante = refDate.getUTCFullYear();

  // Cas 1 : année à 2 chiffres
  if (a.length === 2 && /^\d{2}$/.test(a)) {
    // Padding siècle courant : "26" → "2026". Utilise les 2 premiers chars
    // de l'année système (robuste au passage 2099 → 2100).
    const siecle = String(anneeCourante).slice(0, 2);
    return { dateCorrigee: `${j}/${m}/${siecle}${a}`, anneeCorrigee: true };
  }

  // Cas 2 : année à 4 chiffres < 2000 (probable OCR 1926 vs 2026)
  if (a.length === 4 && /^\d{4}$/.test(a)) {
    const anneeN = parseInt(a, 10);
    if (anneeN < 2000) {
      const anneeCorrige = anneeN + 100;
      // Plage glissante stricte : accepte uniquement si la correction tombe
      // dans [anneeCourante-2, anneeCourante+1]. Écarte 1900→2000 absurde
      // ou 1999→2099 absurde.
      if (
        anneeCorrige >= anneeCourante - 2 &&
        anneeCorrige <= anneeCourante + 1
      ) {
        return {
          dateCorrigee: `${j}/${m}/${anneeCorrige}`,
          anneeCorrigee: true,
        };
      }
    }
  }

  return { dateCorrigee: dateVisionFR, anneeCorrigee: false };
}

/**
 * ERR-DATE-01 — Vision retourne parfois une date en MM/DD/YYYY (format US),
 * notamment sur factures UPS/FedEx en anglais. Ambiguïté résolue à la cohérence
 * avec l'exercice en cours.
 *
 * Si la date Vision tombe dans la période Fulll → on garde.
 * Sinon, on tente l'inversion JJ↔MM. Si l'inversion tombe dans la période → on
 * la prend. Sinon on garde l'originale (un autre garde-fou se déclenchera).
 *
 * Pre-processing M-1 : correction OCR année appliquée AVANT l'inversion
 * JJ↔MM. Si l'année a été corrigée, `inversee` peut quand même basculer à
 * true si une inversion supplémentaire est nécessaire après correction année.
 *
 * Source de vérité période :
 * 1. `period` passé en argument (Fulll bookQuery) — si non null
 * 2. `profil.comptabilite.cloture` (fallback) — reconstruction exercice glissant
 */
export function corrigerDateAmbigue(
  dateVisionFR: string,
  period: { start: string | null; end: string | null } | null,
  profil?: ProfilDossier,
): { dateCorrigee: string; inversee: boolean } {
  // M-1 : correction année AVANT toute autre logique
  const { dateCorrigee: datePreCorrigee, anneeCorrigee } =
    corrigerAnneeOcr(dateVisionFR);
  const dateTravail = anneeCorrigee ? datePreCorrigee : dateVisionFR;

  let periodEffective = period;
  if (!periodEffective?.start || !periodEffective?.end) {
    const reconstruite = exerciceDepuisCloture(profil?.comptabilite?.cloture);
    if (reconstruite) {
      periodEffective = reconstruite;
    }
  }
  if (!periodEffective?.start || !periodEffective?.end) {
    // Pas de période pour arbitrer l'inversion JJ↔MM, mais la correction
    // année peut avoir été appliquée — on remonte la date pré-corrigée.
    return { dateCorrigee: dateTravail, inversee: false };
  }
  const [j, m, a] = dateTravail.split("/");
  if (!j || !m || !a) return { dateCorrigee: dateTravail, inversee: false };
  const ji = parseInt(j, 10);
  const mi = parseInt(m, 10);
  if (isNaN(ji) || isNaN(mi)) return { dateCorrigee: dateTravail, inversee: false };
  // Garde conservée intentionnellement (reviewer #4 "ne pas perdre") :
  // si JJ > 12 OU MM > 12, pas d'ambiguïté JJ↔MM possible, on ne tente
  // pas l'inversion. Elle s'applique SUR la date déjà corrigée année.
  if (ji === mi || ji > 12 || mi > 12) {
    return { dateCorrigee: dateTravail, inversee: false };
  }
  const tsOriginal = new Date(
    `${a}-${m.padStart(2, "0")}-${j.padStart(2, "0")}`,
  ).getTime();
  const tsInversee = new Date(
    `${a}-${j.padStart(2, "0")}-${m.padStart(2, "0")}`,
  ).getTime();
  const tsStart = new Date(periodEffective.start).getTime();
  const tsEnd = new Date(periodEffective.end).getTime();
  const dansPeriode = (ts: number) => ts >= tsStart && ts <= tsEnd;
  if (dansPeriode(tsOriginal)) {
    return { dateCorrigee: dateTravail, inversee: false };
  }
  if (dansPeriode(tsInversee)) {
    return {
      dateCorrigee: `${m.padStart(2, "0")}/${j.padStart(2, "0")}/${a}`,
      inversee: true,
    };
  }
  return { dateCorrigee: dateTravail, inversee: false };
}
