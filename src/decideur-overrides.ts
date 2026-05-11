/**
 * Overrides déterministes post-LLM — filet de sécurité non-bypassable.
 *
 * Le décideur LLM (Haiku/Sonnet) suit un system prompt qui inclut déjà des
 * règles métier (cf wincorp-thor/scripts/v2/decideur-llm.ts ligne 372 pour
 * la règle parking/péage Sprint P0 06/05/2026). En pratique sur confiance
 * basse (Haiku < 70%) ou libellé court ambigu, le LLM peut dévier de la
 * règle malgré l'instruction.
 *
 * Ce module applique un override déterministe APRÈS la décision LLM pour
 * forcer le bon compte sur les cas métier critiques (anti-récidive cf
 * `memory/project_bug_decideur_indigo_parking_2026_05_08.md`).
 *
 * Convention :
 * - Pure function, retour immutable (pas de mutation de l'entrée)
 * - Gates de sécurité numérotées (alignement fallback-tva.ts)
 * - Alerte typée ajoutée (cf ALERTES_CODES) pour traçabilité audit DGFIP
 *   art. L.102 B LPF
 * - `raisonnement` enrichi du préfixe `[Override XXX]` pour expliciter
 *   l'override dans le rapport observation
 */

import type { ExtractionVision, DecisionDecideur } from "./types.js";

// ── Override parking FR ───────────────────────────────────────────────

/**
 * Liste fermée d'émetteurs reconnus comme opérateurs parking en France.
 *
 * Convention de matching : on cherche l'émetteur Vision normalisé (uppercase,
 * espaces préservés) avec `includes(emetteurParking)`. Donc :
 * - `"INDIGO"` matche `"INDIGO PARKING GARE DE LYON"` ✓
 * - `"Q-PARK"` matche `"Q-PARK GARE DU NORD"` ✓
 * - `"VINCI PARK"` ne matche PAS `"VINCI AUTOROUTES"` (espace + sufx différent)
 *
 * APRR / SANEF / VINCI AUTOROUTES / MOBILIS / ATMB / SAPN sont gérés par le
 * system prompt LLM (Sprint P0 06/05) en upstream et ne sont pas inclus ici
 * pour éviter double traitement. Si un péage autoroute n'a pas été classé en
 * 62510000 par le LLM, le filet libellé `\bp[ée]age\b|\bautoroute\b` le
 * rattrapera quand même via Gate 4.
 */
export const EMETTEURS_PARKING_EXPLICITES: ReadonlySet<string> = new Set([
  "INDIGO",
  "PARKINDIGO",
  "EFFIA",
  "Q-PARK",
  "QPARK",
  "SAEMES",
  "VINCI PARK",
  "VINCIPARK",
  "APCOA",
  "ONEPARK",
  "ZENPARK",
  "INTERPARKING",
  "EPARK",
  "YESPARK",
]);

/**
 * Mots-clés libellé/émetteur pour parking ou stationnement.
 *
 * Word boundaries `\b` pour éviter substring : `PARKINGOFF` ne matche pas
 * (faux positif théorique), `PARC RELAIS` matche (cas RATP/SNCF). On inclut
 * aussi `péage`/`autoroute` comme filet redondant au prompt LLM Sprint P0
 * — si le LLM a manqué la règle, le filet déterministe rattrape.
 */
const REGEX_PARKING_LIBELLE =
  /\b(parking|stationnement|horodateur|parc\s+relais|p[ée]age|autoroute)\b/i;

/**
 * Exclusions garage / réparation automobile pour éviter les faux positifs.
 *
 * Cas réel : facture garage avec mention "Place de parking n°4" pour ranger
 * le véhicule pendant réparation → le libellé matche `parking` mais le
 * compte attendu est 615500 (entretien véhicule), pas 62510000. Si on
 * détecte garage/réparation/entretien/pneu/vidange dans l'émetteur OU les
 * libellés, on refuse l'override (revue manuelle préférable).
 */
const REGEX_GARAGE_EXCLUSION =
  /\b(garage|r[ée]paration|entretien|r[ée]vision|pneu|vidange|pi[èe]ce\s+auto|carrosserie|m[ée]canique)\b/i;

/** Compte cible déterministe pour parking/péage en régime FR. */
const COMPTE_PARKING_FR = "62510000";

/** Code fournisseur générique pour parking/péage (cohérent prompt LLM). */
const FOURNISSEUR_PARKING_GENERIQUE = "FPEAGE";

/**
 * Codes fournisseurs génériques qui peuvent être remplacés par FPEAGE.
 * Si le décideur a déjà choisi un code spécifique (FINDIGOPARK, FEFFIA, etc.),
 * on respecte son choix — on ne change que la catégorie quand c'est générique.
 */
const FOURNISSEURS_GENERIQUES_REMPLACABLES: ReadonlySet<string> = new Set([
  "FDIVERS",
  "FOURNISSEUR_DIVERS",
  "",
]);

export interface OverrideParkingResult {
  /** Décision finale (avec override appliqué ou décision originale). */
  decision: DecisionDecideur;
  /** True si l'override a été appliqué, false sinon. */
  applique: boolean;
  /**
   * Trace courte du motif d'override (vide si non appliqué). Format :
   * `"Émetteur parking reconnu: <NOM>"` ou `"Libellé parking détecté"`.
   * Utilisé pour log/rapport observation. Évite de re-parser le raisonnement.
   */
  raisonOverride?: string;
}

/**
 * Force `compte_charge=62510000` si l'extraction matche un opérateur parking
 * OU un libellé parking/péage en régime FR.
 *
 * Pure function — ne mute pas l'entrée. Retourne une nouvelle décision si
 * override appliqué, sinon la décision originale telle quelle.
 *
 * Gates :
 * 1. Régime FR uniquement (parking intracom/extracom = cas exceptionnel,
 *    laissé à la revue humaine)
 * 2. Compte ≠ déjà 62510000 (sinon no-op silencieux)
 * 3. Pas d'exclusion garage/réparation auto (faux positif "place de parking
 *    pour véhicule en réparation")
 * 4. Match émetteur explicite OU libellé parking/stationnement/horodateur
 *
 * Si toutes gates passent → nouvelle décision avec :
 * - `compte_charge` = 62510000
 * - `fournisseur_fulll` = FPEAGE (uniquement si générique avant, sinon
 *   préservé pour respecter la curation spécifique du LLM ou caller)
 * - `alertes` += `COMPTE_FORCE_PARKING_62510000` (idempotent)
 * - `raisonnement` préfixé `[Override parking FR : <ancien> → 62510000]`
 * - `provider_original` préservé pour traçabilité (audit DGFIP)
 */
export function appliquerOverrideParkingFR(
  extraction: ExtractionVision,
  decision: DecisionDecideur,
): OverrideParkingResult {
  // Gate 1 : régime FR uniquement
  if (decision.regime_tva !== "FR") {
    return { decision, applique: false };
  }

  // Gate 2 : compte déjà correct → no-op silencieux
  if (decision.compte_charge === COMPTE_PARKING_FR) {
    return { decision, applique: false };
  }

  // Concaténation texte normalisé pour scan
  const emetteurNorm = (extraction.emetteur?.nom ?? "").toUpperCase();
  const lignesText = (extraction.lignes ?? [])
    .map((l) => (l.libelle ?? "").toUpperCase())
    .join(" | ");
  const texteCombine = `${emetteurNorm} | ${lignesText}`;

  // Gate 3 : exclusion garage / réparation auto (anti faux positif)
  // On exclut UNIQUEMENT si pas de match émetteur explicite — un INDIGO
  // PARKING avec un libellé "pneu réservé" reste prioritaire à l'émetteur.
  const matchEmetteurExplicite = [...EMETTEURS_PARKING_EXPLICITES].some((e) =>
    emetteurNorm.includes(e),
  );

  if (!matchEmetteurExplicite && REGEX_GARAGE_EXCLUSION.test(texteCombine)) {
    return { decision, applique: false };
  }

  // Gate 4 : match libellé parking/péage (si pas déjà match émetteur)
  const matchLibelle = REGEX_PARKING_LIBELLE.test(texteCombine);

  if (!matchEmetteurExplicite && !matchLibelle) {
    return { decision, applique: false };
  }

  // ── Override appliqué ────────────────────────────────────────────────

  // Trace courte pour rapport/log
  const raisonOverride = matchEmetteurExplicite
    ? `Émetteur parking reconnu: ${emetteurNorm.slice(0, 60).trim()}`
    : "Libellé parking/péage détecté";

  // Fournisseur Fulll : on remplace SEULEMENT si générique (FDIVERS/vide).
  // Si le LLM a choisi un code spécifique (FINDIGOPARK, FEFFIA, etc.), on
  // respecte sa curation — le seul correctif est le compte_charge.
  const fournisseurFulllNouveau = FOURNISSEURS_GENERIQUES_REMPLACABLES.has(
    decision.fournisseur_fulll,
  )
    ? FOURNISSEUR_PARKING_GENERIQUE
    : decision.fournisseur_fulll;

  // Alertes idempotentes (pas de doublon si déjà présente)
  const alertesNouvelles = decision.alertes.includes(
    "COMPTE_FORCE_PARKING_62510000",
  )
    ? decision.alertes
    : [...decision.alertes, "COMPTE_FORCE_PARKING_62510000" as const];

  const decisionOverridee: DecisionDecideur = {
    ...decision,
    compte_charge: COMPTE_PARKING_FR,
    fournisseur_fulll: fournisseurFulllNouveau,
    raisonnement: `[Override parking FR : ${decision.compte_charge} → ${COMPTE_PARKING_FR}] ${decision.raisonnement}`,
    alertes: alertesNouvelles,
  };

  return {
    decision: decisionOverridee,
    applique: true,
    raisonOverride,
  };
}
