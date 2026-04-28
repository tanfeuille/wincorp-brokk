/**
 * Fallback TVA déterministe quand Vision rate le bandeau TVA sur certaines
 * catégories de factures FR où le taux est quasi-certain (20%).
 *
 * V2 (Sprint A 28/04/2026) : élargissement de V1 (60617000 carburant
 * uniquement) à 5 comptes PCG courants où la TVA 20% est mécaniquement
 * applicable en régime FR :
 * - 60617000 — Carburant (V1, déjà couvert)
 * - 60630000 — Marchandises diverses
 * - 62560000 — Voyages, déplacements (taxis, péages, billets train)
 * - 62800000 — Divers gestion courante
 * - 60631000 — Fournitures consommables
 *
 * Si les conditions sont réunies (régime FR, compte éligible, lignes_tva
 * vide, TTC valide, pas d'alerte bloquante, pas de libellés multi-produits
 * hétérogènes), on synthétise une ligne TVA à 20% et on remonte l'alerte
 * `TVA_ESTIMEE_FALLBACK` (générique) pour traçabilité audit DGFIP (art.
 * L.102 B LPF). L'alias rétro-compat `TVA_ESTIMEE_FALLBACK_CARBURANT` est
 * émis en plus uniquement pour le compte historique 60617000 (côté builder,
 * pas ici — cf builder.ts).
 *
 * Désactivable par dossier via `profil.parametres.tva_fallback_carburant: false`
 * (cas des restaurateurs et gros volumes de tickets photographiés pas propres
 * où l'utilisateur préfère une revue manuelle systématique).
 *
 * Extensibilité V3 : élargir `COMPTES_FALLBACK_TVA_20` (ajouter d'autres
 * comptes 6xxx avec TVA 20% mécanique). Pour TVA 5.5%/10% (presse, livres,
 * resto), créer un module dédié `fallback-tva-reduit.ts` — la mécanique
 * d'arrondi est différente.
 */

import type { ExtractionVision, DecisionDecideur } from "./types.js";

/**
 * Comptes PCG pour lesquels le fallback TVA 20% FR s'applique.
 *
 * Liste fermée stricte — chaque ajout exige une revue métier :
 * - Le compte doit être TVA 20% mécanique (pas de variantes 5.5/10%)
 * - Le compte ne doit pas être un compte d'autoliquidation intracom/extracom
 *   (préfixes 60702x/60703x/6072x/6073x sont exclus de facto via la gate
 *   `regime_tva === "FR"`, mais éviter de les ajouter ici par défense)
 * - Le risque de faux positif sur libellés hétérogènes doit être faible
 */
export const COMPTES_FALLBACK_TVA_20: ReadonlySet<string> = new Set([
  "60617000", // Carburant (V1 — Sprint 2b 21/04/2026)
  "60630000", // Marchandises diverses (Sprint A 28/04/2026)
  "62560000", // Voyages, déplacements (taxis, péages, train) (Sprint A)
  "62800000", // Divers gestion courante (Sprint A)
  "60631000", // Fournitures consommables (Sprint A)
]);

/**
 * Comptes pour lesquels le risque de mix-taux est élevé (typique tickets
 * caisse Carrefour/Auchan/Leclerc avec produits 5.5% / 10% / 20%) — Sprint A
 * 28/04/2026. Sur ces comptes, on durcit Gate 6 : au-delà d'une seule ligne
 * Vision, on exige que TOUTES les lignes aient un taux_tva = 20 explicite
 * (Vision a su lire les taux par ligne) sinon on refuse le fallback (revue
 * manuelle obligatoire) — évite la TVA déductible fictive sur produits 5.5%
 * non détectés par la regex hétérogène.
 *
 * Les autres comptes (60617000 carburant, 62560000 voyages, 62800000 divers)
 * conservent la Gate 6 standard (regex hétérogène + length>1) qui suffit en
 * pratique : un ticket carburant ou un péage ne contient pas typiquement de
 * mix-taux silencieux.
 */
export const COMPTES_RISQUE_MIX_TAUX: ReadonlySet<string> = new Set([
  "60630000", // Marchandises diverses (tickets caisse alimentaire)
  "60631000", // Fournitures consommables (papeterie + livres)
]);

/**
 * Libellés multi-produits qui disqualifient le fallback global (ex. station-
 * service multi-produits : gasoil + café + lavage + boutique).
 * Si une ligne d'extraction matche, on laisse la facture en douteuse plutôt
 * que d'appliquer une TVA 20% globale incorrecte.
 *
 * Word boundaries `\b` ajoutées Sprint A 28/04/2026 pour éviter les faux
 * positifs substring (`Shopify` matchait `shop`, `expressément` matchait
 * `presse`, `Eshop` matchait `shop`). Les vrais cas métier (`Café crème`,
 * `Lavage auto`, `presse la poste`, `boutique gare`) restent matchés.
 */
const REGEX_LIBELLES_HETEROGENES = /\b(caf[eé]|sandwich|lavage|boutique|presse|shop)\b/i;

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
  /**
   * Compte PCG sur lequel le fallback a été appliqué (présent ssi
   * `applique=true`). Permet au caller (builder) de pousser des alertes
   * différenciées (alias rétro-compat `_CARBURANT` ssi 60617000) et au
   * rapport observation de tracer précisément quel compte a déclenché
   * le fallback (audit DGFIP).
   */
  compteApplique?: string;
}

/**
 * Applique le fallback TVA 20% si toutes les gates sont passées.
 *
 * Immuable : ne mute ni l'extraction ni la décision en entrée.
 *
 * @param extraction sortie Vision (montant_ttc_total, lignes_tva, lignes)
 * @param decision sortie décideur (regime_tva, compte_charge, alertes)
 * @param fallbackActive flag dossier (défaut true, override via profil.parametres)
 *
 * @remarks Le nom `appliquerFallbackTvaCarburant` est conservé pour
 * rétro-compat (Sprint 2b 21/04/2026) bien que la fonction couvre désormais
 * 5 comptes (Sprint A 28/04/2026). Renommer en `appliquerFallbackTva` côté
 * appelant exigerait des modifs cross-repo (thor + tests) sans bénéfice
 * fonctionnel — repoussé.
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

  // Gate 2 : compte charge éligible (liste fermée stricte V2 = 5 comptes).
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
  // en douteuse, revue manuelle. S'applique aussi aux courses (ticket Carrefour
  // marchandises 60630000 + presse + boutique = mix taux).
  const lignes = extraction.lignes ?? [];
  if (lignes.length > 1) {
    const hasHeterogene = lignes.some(
      (l) =>
        typeof l.libelle === "string" &&
        REGEX_LIBELLES_HETEROGENES.test(l.libelle),
    );
    if (hasHeterogene) return { extraction, applique: false };
  }

  // Gate 7 (Sprint A 28/04/2026) : compte à risque mix-taux silencieux.
  // Sur 60630000 (marchandises diverses) et 60631000 (fournitures), la regex
  // hétérogène Gate 6 ne couvre PAS les vrais faux négatifs alimentaires/livres
  // (ticket Carrefour Pain/Lait/Yaourts = 3 lignes, aucune ne matche la regex,
  // mais TVA réelle = 5.5% mélangée à 20%). On exige que toutes les lignes
  // aient un taux_tva = 20 explicite Vision sinon refuse → revue manuelle.
  // Si Vision n'a pas extrait les taux par ligne (cas typique tickets caisse
  // sans bandeau TVA détaillé), on tombe en refus → audit DGFIP préservé.
  if (COMPTES_RISQUE_MIX_TAUX.has(decision.compte_charge) && lignes.length > 1) {
    const toutesLignes20 = lignes.every(
      (l) => typeof l.taux_tva === "number" && l.taux_tva === 20,
    );
    if (!toutesLignes20) return { extraction, applique: false };
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

  return {
    extraction: extractionEnrichie,
    applique: true,
    compteApplique: decision.compte_charge,
  };
}
