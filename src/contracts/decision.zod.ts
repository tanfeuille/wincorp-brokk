/**
 * Schémas Zod du décideur LLM (Phase 2).
 * Source unique de vérité du contrat consommé par le builder Phase 3.
 */

import { z } from "zod";

/** Liste close des codes d'alertes (R18 spec). */
export const ALERTES_CODES = [
  "AVOIR",
  "ACOMPTE",
  "MONTANT_ZERO",
  "DEVISE_NON_EUR",
  "COMPTE_INVALIDE_FORMAT",
  "COMPTE_HORS_PROFIL",
  "FOURNISSEUR_HALLUCINATION",
  // Le code proposé par le LLM (ou choisi par le caller) n'est pas dans
  // agent_fournisseurs du dossier — ni dans Fulll comme provider_account
  // initial. Émise par validerFournisseur en fallback `defaut`.
  "FOURNISSEUR_DIVERS",
  // Code F-alphanum bien formé proposé par le décideur mais absent de
  // agent_fournisseurs du dossier. Signal informatif (non bloquant) : le
  // décideur peut légitimement proposer un code Fulll préexistant hors
  // liste curée (cas FCARBU, FRESTAURANT, etc. créés à d'anciens runs).
  // Le pipeline aval `resoudreOuCreerProviderImage(lookupOnly=true)` cherche
  // le code dans Fulll → use si trouvé / bascule douteuse PROVIDER_NON_TROUVE
  // si null. Réintroduit chantier B3 (01/05/2026 PM) après que le strict v1
  // a cassé le respect des codes Fulll préexistants.
  "FOURNISSEUR_EXTERNE",
  // Provider Fulll introuvable côté Fulll Image (lookupOnly post chantier
  // 01/05/2026) — le worker thor ne crée plus de provider runtime.
  // Émise par run-saisie après resoudreOuCreerProviderImage(..., {lookupOnly:true})
  // qui retourne null. Le builder bascule la facture en douteuse via
  // verifierGardeFousPreMutation (provider.id vide → ERR-BUILD-05).
  // Action user : ajouter le fournisseur dans agent_fournisseurs (UI bifrost)
  // OU créer le provider manuellement dans Fulll, puis re-run.
  "PROVIDER_NON_TROUVE",
  // Worker a forcé fournisseur_fulll = code Fulll initial parce que ce
  // dernier était non générique et le LLM proposait un code différent
  // SANS justification d'override (pas d'alerte PROVIDER_FULLL_INCORRECT).
  // Info traçabilité — le user voit dans le rapport que le décideur LLM a
  // été ignoré au profit de Fulll initial pour ce cas.
  "PROVIDER_FULLL_PRIORITAIRE",
  // Le LLM juge explicitement que le code Fulll initial est faux et
  // propose un code différent. Émise par le LLM dans `decision.alertes`
  // quand il fait l'override (cf prompt système exception OVERRIDE).
  // Le worker respecte la décision LLM au lieu de forcer Fulll initial.
  "PROVIDER_FULLL_INCORRECT",
  // Routing acompte mis en stand-by chantier 01/05/2026. Le builder bascule
  // la facture en douteuse au lieu d'appeler construirePayloadAcompteV2.
  // Le user traite manuellement Fulll en attendant un sprint dédié acomptes
  // post-base-saine.
  "ACOMPTE_NON_GERE_V1",
  "INCOHERENCE_REGIME_COMPTE_INTRACOM",
  "INCOHERENCE_REGIME_COMPTE_EXTRACOM",
  "FRANCHISE_HORS_PROFIL",
  "VAT_ETRANGER_REGIME_FR_SUSPECT",
  "CONFIANCE_INSUFFISANTE",
  "TVA_HEBERGEMENT_NON_DED",
  "MULTI_LIGNE_VENTILATION",
  "PROVIDER_RESOLU_AUTO",
  "PROVIDER_CREE_AUTO",
  "PROVIDER_COLLISION_AMBIGUE",
  "RELEVE_BANCAIRE_DETECTE",
  "FACTURE_HORS_EXERCICE",
  // TVA estimée à 20% par le builder (fallback déterministe) — alerte
  // générique émise sur tous les comptes éligibles (cf. COMPTES_FALLBACK_TVA_20
  // dans fallback-tva.ts : carburant 60617000, marchandises 60630000, voyages
  // 62560000, divers 62800000, fournitures 60631000). Émise UNIQUEMENT par le
  // builder via le canal `alertes_builder` de ResultatBuilder — le décideur
  // LLM ne l'émet jamais. Niveau info (non bloquant). Sprint A 28/04/2026 —
  // élargissement V1 (carburant uniquement) → V2 (5 comptes courants TVA 20%).
  "TVA_ESTIMEE_FALLBACK",
  // Alias rétro-compat de `TVA_ESTIMEE_FALLBACK` émis UNIQUEMENT lorsque le
  // compte appliqué est `60617000` (carburant). Permet aux dashboards et
  // scripts qui filtraient sur ce code historique (Session 2b 21/04/2026)
  // de continuer à fonctionner sans modif. Nouveaux callers : préférer
  // `TVA_ESTIMEE_FALLBACK` générique.
  "TVA_ESTIMEE_FALLBACK_CARBURANT",
  // Numéro de pièce synthétique généré par le builder quand Vision n'a pas
  // lu de `numero_piece` (cas typique : tickets carburant Leclerc / Intermarché
  // sans numéro imprimé). Format `AUTO-YYMMDD-TTC-hash4` (~20 chars). Émise
  // via `alertes_builder`. Niveau info — permet traçabilité révision.
  // Session 3 ERR-BUILD-02 (21/04/2026).
  "REFERENCE_AUTO_SYNTHESE",
  // Rejet Fulll `recordPurchaseFormMutation: Aucune période` — la facture
  // est datée d'un exercice fiscal non ouvert côté Fulll (paramétrage dossier).
  // Émise par thor (caller run-saisie) après échec mutation, reconnue via
  // regex dans classifierMessageRejet. Action user : ouvrir l'exercice côté
  // Fulll OU traiter manuellement (cas TOMETY 21/04 factures 2024 en 2025).
  "FACTURE_PERIODE_FULLL_FERMEE",
  // Rejet Fulll opaque `Internal Server Error` / `Une erreur est survenue`
  // sans détail actionnable. Tag de suivi pour investigation future (distinct
  // du bucket générique `autre`). Observé sur ELAG'RIMP 20/04 carburant
  // Leclerc. Ne flip jamais `applique=true` auto (erreur transitoire,
  // pas un pattern apprenable). Session 3 (21/04/2026).
  "ISE_FULLL_OPAQUE",
  // Sprint P0 06/05/2026 (sub-task C) — Rétrocession transport / sous-traitance
  // sans TVA légitime. Émise par le décideur LLM quand la facture est :
  //   * une rétrocession de course taxi en débours (art. 267 CGI),
  //   * ou une sous-traitance avec fournisseur en franchise TVA (art. 293 B),
  //   * ou tout autre cas légitime où l'absence de TVA déductible est attendue
  //     ET le compte est dans la famille 6041 (sous-traitance) / 60401x.
  // Le builder traite alors la facture en mode franchise-like : 1 ligne charge
  // = TTC direct, aucune ligne TVA déductible. AVANT cette alerte, ces factures
  // tombaient en `ERR-EXTRACTION-INCOMPLETE` car `lignes_tva` vide en régime FR
  // (cas G7 SA facture 28 run Spiritus Taxi 05/05). Garde-fou silent-failure
  // dans le builder : si lignes_tva contient une TVA réelle (>0) malgré cette
  // alerte → ERR-FRANCHISE-CONTRADICTION (LLM s'est trompé, perte silencieuse
  // TVA déductible évitée).
  "TVA_ABSENTE_LEGITIME_SOUS_TRAITANCE",
  // Sprint P0 06/05/2026 (sub-task E) — TVA calculée par le builder depuis un
  // taux visible sur la facture (`taux_tva_indicatif` extrait par Vision)
  // quand le bandeau "Total HT / TVA / TTC" structuré est absent. Cas typique :
  //   * facture manuscrite avec mention "TVA 10%" en marge (RESOTEL 5 facture
  //     61 run Spiritus Taxi),
  //   * facture mal rédigée avec montant TVA absent mais taux mentionné
  //     (SARL STALER LE TEMPO facture 59 — restaurant FR taux 10%).
  // Calcul : `tva = ttc × taux/(100+taux)`, `ht = ttc - tva` (formule
  // inverse standard FR). Émise UNIQUEMENT par le builder via
  // `alertes_builder` (pas par le décideur LLM). Niveau info — non bloquant.
  "TVA_CALCULEE_DEPUIS_TAUX_VISIBLE",
  // Sprint 11/05/2026 (bug INDIGO Parking — cf project_bug_decideur_indigo_parking
  // _2026_05_08). Override déterministe post-LLM sur émetteurs parking explicites
  // (INDIGO, EFFIA, Q-PARK, SAEMES, VINCI Park, APCOA, etc.) OU libellés
  // "parking/stationnement/horodateur" sans exclusion garage/réparation.
  // Force `compte_charge=62510000` (Voyages et déplacements) en régime FR.
  // Cas de référence : session #9 TRIMAT 18/04 — INDIGO PARKING GARE DE LYON
  // 13.15€ classée par erreur en 60630000 (62% confiance Haiku) alors qu'un
  // parking est par nature un déplacement, jamais des achats fournitures.
  // Émise UNIQUEMENT par `appliquerOverrideParkingFR` (cf decideur-overrides.ts).
  // Mutuellement exclusive avec les autres comptes parking — c'est un overlay
  // post-LLM, pas une alerte LLM. Niveau info (non bloquant) — traçabilité
  // audit DGFIP (art. L.102 B LPF) en complément de raisonnement enrichi.
  "COMPTE_FORCE_PARKING_62510000",
] as const;

export const RegimeTvaSchema = z.enum(["FR", "intracom", "extracom", "franchise"]);
export type RegimeTva = z.infer<typeof RegimeTvaSchema>;

export const DecisionDecideurSchema = z.strictObject({
  // Phase B fix v0.4.6 (05/05/2026) : accepte 6, 7 ou 8 chiffres pour
  // supporter les dossiers en plan comptable 6 chiffres (Spiritus Taxi,
  // EURL FLEURIET — héritage anciens clients). La normalisation effective
  // 6↔8 selon `profil.parametres.comptes_digits` est faite en aval par
  // `lookupRelayId` (cf src/lookup-relay-id.ts). Validation Zod laxiste car
  // le schéma n'a pas accès au profil dossier.
  compte_charge: z
    .string()
    .regex(/^(\d{6,8}|)$/, "compte_charge doit être 6 à 8 chiffres ou chaîne vide"),
  regime_tva: RegimeTvaSchema,
  fournisseur_fulll: z.string(),
  libelle_ecriture: z.string(),
  raisonnement: z.string(),
  confiance: z.number().min(0).max(100),
  alertes: z.array(z.enum(ALERTES_CODES)),
  // Chantier garde-fou ELAG'RIMP 20/04 : code proposé par le LLM AVANT
  // réécriture par le garde-fou post-LLM (fulll-api / run-saisie). Permet la
  // traçabilité audit DGFIP (art. L.102 B LPF — toute redirection doit être
  // justifiable) et la cohérence RAG (le RAG indexe le code effectivement
  // utilisé dans fournisseur_fulll). Absent si aucune réécriture.
  provider_original: z.string().optional(),
});

export type DecisionDecideurParsed = z.infer<typeof DecisionDecideurSchema>;

export function parseDecision(raw: unknown): DecisionDecideurParsed {
  const result = DecisionDecideurSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[contracts/decision] DecisionDecideur invalide :\n${issues}\n\nReçu : ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }
  return result.data;
}
