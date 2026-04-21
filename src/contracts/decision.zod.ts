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
  "FOURNISSEUR_DIVERS",
  // Code fournisseur F-alphanum bien formé proposé par le décideur mais absent
  // de la config `agent_fournisseurs` du dossier. Signal informatif (non bloquant) :
  // le pipeline aval (resoudreOuCreerProviderImage) cherche le code dans Fulll
  // et le crée si absent. Permet au décideur de réutiliser les providers Fulll
  // préexistants du dossier sans pollution FDIVERS (fix Session 1 21/04 — bug
  // TOMETY où IKEA/Orange/Amazon étaient écrasés en FDIVERS).
  "FOURNISSEUR_EXTERNE",
  // Sous-alerte trace : FOURNISSEUR_EXTERNE émis alors que le cache garde-fou
  // canonical est vide ou quasi-vide (<3 entries). Signale un dossier fraîchement
  // onboardé où le risque de pollution par création de providers hallucinés est
  // plus élevé. Non bloquant, sert à l'audit post-run et à la priorisation
  // d'une revue humaine du rapport.
  "FOURNISSEUR_EXTERNE_COLD_START",
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
  // TVA estimée à 20% par le builder (fallback déterministe) quand Vision a
  // raté le bandeau TVA sur un ticket carburant FR régime normal (compte
  // 60617000). Émise UNIQUEMENT par le builder via le canal `alertes_builder`
  // de ResultatBuilder — le décideur LLM ne l'émet jamais. Niveau info
  // (non bloquant). Fix ERR-BUILD-02 fallback carburant (21/04/2026).
  // Préfixe `_CARBURANT` en prévision d'extensions futures (_FOURNITURES,
  // _TRANSPORT) vers d'autres comptes où TVA 20% est quasi-certain.
  "TVA_ESTIMEE_FALLBACK_CARBURANT",
] as const;

export const RegimeTvaSchema = z.enum(["FR", "intracom", "extracom", "franchise"]);
export type RegimeTva = z.infer<typeof RegimeTvaSchema>;

export const DecisionDecideurSchema = z.strictObject({
  compte_charge: z
    .string()
    .regex(/^(\d{8}|)$/, "compte_charge doit être 8 chiffres ou chaîne vide"),
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
