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
  "INCOHERENCE_REGIME_COMPTE_INTRACOM",
  "INCOHERENCE_REGIME_COMPTE_EXTRACOM",
  "FRANCHISE_HORS_PROFIL",
  "VAT_ETRANGER_REGIME_FR_SUSPECT",
  "CONFIANCE_INSUFFISANTE",
  "TVA_HEBERGEMENT_NON_DED",
  "MULTI_LIGNE_VENTILATION",
  "PROVIDER_RESOLU_AUTO",
  "PROVIDER_CREE_AUTO",
  "RELEVE_BANCAIRE_DETECTE",
  "FACTURE_HORS_EXERCICE",
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
