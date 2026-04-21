/**
 * Fallback TVA déterministe quand Vision rate le bandeau TVA sur certaines
 * catégories de factures FR où le taux est quasi-certain.
 *
 * V1 : carburant FR régime normal uniquement (compte 60617000). Si les conditions
 * sont réunies (régime FR, compte éligible, lignes_tva vide, TTC valide, pas
 * d'alerte bloquante, pas de libellés multi-produits hétérogènes), on synthétise
 * une ligne TVA à 20% et on remonte l'alerte `TVA_ESTIMEE_FALLBACK_CARBURANT`
 * pour traçabilité audit DGFIP (art. L.102 B LPF).
 *
 * Désactivable par dossier via `profil.parametres.tva_fallback_carburant: false`
 * (cas des restaurateurs et gros volumes de tickets photographiés pas propres
 * où l'utilisateur préfère une revue manuelle systématique).
 *
 * Extensibilité V2 : ajouter d'autres comptes à `COMPTES_FALLBACK_TVA_20` (ex.
 * fournitures bureau 60640000) + potentiellement d'autres préfixes d'alerte
 * (`TVA_ESTIMEE_FALLBACK_FOURNITURES`, `_TRANSPORT`…).
 */

import type { ExtractionVision, DecisionDecideur } from "./types.js";

/** Comptes PCG pour lesquels le fallback TVA 20% carburant FR s'applique. */
export const COMPTES_FALLBACK_TVA_20: ReadonlySet<string> = new Set(["60617000"]);

/**
 * Libellés multi-produits qui disqualifient le fallback global (ex. station-
 * service multi-produits : gasoil + café + lavage + boutique).
 * Si une ligne d'extraction matche, on laisse la facture en douteuse plutôt
 * que d'appliquer une TVA 20% globale incorrecte.
 */
const REGEX_LIBELLES_HETEROGENES = /caf[eé]|sandwich|lavage|boutique|presse|shop/i;

/** Alertes décideur qui bloquent l'application du fallback. */
const ALERTES_BLOQUANTES_FALLBACK: ReadonlySet<string> = new Set([
  "VAT_ETRANGER_REGIME_FR_SUSPECT",
  "COMPTE_HORS_PROFIL",
]);

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface FallbackTvaResult {
  /** Extraction avec `lignes_tva` synthétique injecté si fallback appliqué. */
  extraction: ExtractionVision;
  /** True si le fallback a été appliqué — le caller doit remonter l'alerte. */
  applique: boolean;
}

/**
 * Applique le fallback TVA 20% si toutes les gates sont passées.
 *
 * Immuable : ne mute ni l'extraction ni la décision en entrée.
 *
 * @param extraction sortie Vision (montant_ttc_total, lignes_tva, lignes)
 * @param decision sortie décideur (regime_tva, compte_charge, alertes)
 * @param fallbackActive flag dossier (défaut true, override via profil.parametres)
 */
export function appliquerFallbackTvaCarburant(
  extraction: ExtractionVision,
  decision: DecisionDecideur,
  fallbackActive: boolean = true,
): FallbackTvaResult {
  if (!fallbackActive) return { extraction, applique: false };

  // Gate 1 : régime FR uniquement (intracom/extracom/franchise ont leurs
  // propres chemins et ne doivent pas être touchés).
  if (decision.regime_tva !== "FR") return { extraction, applique: false };

  // Gate 2 : compte charge éligible (liste fermée stricte V1).
  if (!COMPTES_FALLBACK_TVA_20.has(decision.compte_charge)) {
    return { extraction, applique: false };
  }

  // Gate 3 : TTC valide (>= 0.01 €).
  const ttc = extraction.montant_ttc_total;
  if (typeof ttc !== "number" || !Number.isFinite(ttc) || ttc < 0.01) {
    return { extraction, applique: false };
  }

  // Gate 4 : pas de ligne TVA utilisable déjà présente (le fallback ne
  // surécrit jamais une extraction Vision réussie).
  const lignesUtilisables = (extraction.lignes_tva ?? []).filter(
    (l) =>
      typeof l.base_ht === "number" &&
      l.base_ht > 0 &&
      typeof l.montant_tva === "number" &&
      typeof l.taux === "number",
  );
  if (lignesUtilisables.length > 0) return { extraction, applique: false };

  // Gate 5 : alertes décideur bloquantes (TVA étrangère suspecte, compte
  // hors profil). Ces signaux indiquent que le décideur n'était pas confiant
  // → on préfère la revue humaine au fallback aveugle.
  if (decision.alertes.some((a) => ALERTES_BLOQUANTES_FALLBACK.has(a))) {
    return { extraction, applique: false };
  }

  // Gate 6 : multi-lignes hétérogènes (café/sandwich/lavage/boutique).
  // Exemple : ticket station-service avec carburant + café + lavage → la TVA
  // 20% globale serait fausse car le café est à 10%. On laisse la facture
  // en douteuse, revue manuelle.
  const lignes = extraction.lignes ?? [];
  if (lignes.length > 1) {
    const hasHeterogene = lignes.some(
      (l) =>
        typeof l.libelle === "string" &&
        REGEX_LIBELLES_HETEROGENES.test(l.libelle),
    );
    if (hasHeterogene) return { extraction, applique: false };
  }

  // Calcul TVA 20% FR : formule `tva = ttc × 20/120`, puis `ht = ttc - tva`
  // (absorbe l'arrondi résiduel pour garantir ht + tva === ttc à 0.01 près).
  const tva = round2((ttc * 20) / 120);
  const ht = round2(ttc - tva);

  // Invariant : ht + tva doit re-donner ttc (safety net, jamais échoue
  // hors bug arithmétique JS).
  if (round2(ht + tva) !== round2(ttc)) {
    return { extraction, applique: false };
  }

  // Si la TVA calculée est < 0.01 € (cas TTC forcé 0.01 par R29), on
  // n'injecte pas de ligne (éviterait une ligne à 0 qui fait échouer Fulll).
  if (tva < 0.01) {
    return { extraction, applique: false };
  }

  const extractionEnrichie: ExtractionVision = {
    ...extraction,
    lignes_tva: [
      {
        taux: 20,
        base_ht: ht,
        montant_tva: tva,
      },
    ],
  };

  return { extraction: extractionEnrichie, applique: true };
}
