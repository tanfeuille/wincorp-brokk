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
 * ERR-DATE-01 — Vision retourne parfois une date en MM/DD/YYYY (format US),
 * notamment sur factures UPS/FedEx en anglais. Ambiguïté résolue à la cohérence
 * avec l'exercice en cours.
 *
 * Si la date Vision tombe dans la période Fulll → on garde.
 * Sinon, on tente l'inversion JJ↔MM. Si l'inversion tombe dans la période → on
 * la prend. Sinon on garde l'originale (un autre garde-fou se déclenchera).
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
  let periodEffective = period;
  if (!periodEffective?.start || !periodEffective?.end) {
    const reconstruite = exerciceDepuisCloture(profil?.comptabilite?.cloture);
    if (reconstruite) {
      periodEffective = reconstruite;
    }
  }
  if (!periodEffective?.start || !periodEffective?.end) {
    return { dateCorrigee: dateVisionFR, inversee: false };
  }
  const [j, m, a] = dateVisionFR.split("/");
  if (!j || !m || !a) return { dateCorrigee: dateVisionFR, inversee: false };
  const ji = parseInt(j, 10);
  const mi = parseInt(m, 10);
  if (isNaN(ji) || isNaN(mi)) return { dateCorrigee: dateVisionFR, inversee: false };
  if (ji === mi || ji > 12 || mi > 12) {
    return { dateCorrigee: dateVisionFR, inversee: false };
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
    return { dateCorrigee: dateVisionFR, inversee: false };
  }
  if (dansPeriode(tsInversee)) {
    return {
      dateCorrigee: `${m.padStart(2, "0")}/${j.padStart(2, "0")}/${a}`,
      inversee: true,
    };
  }
  return { dateCorrigee: dateVisionFR, inversee: false };
}
