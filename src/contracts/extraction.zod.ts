/**
 * Schémas Zod miroirs des interfaces v2 — source unique de vérité des contrats
 * entre extracteur (Phase 1), décideur (Phase 2) et builder (Phase 3).
 *
 * Usage :
 * - Sortie extracteur : `ExtractionVisionSchema.parse(raw)` avant retour
 * - Entrée décideur/builder : idem au top de la fonction
 */

import { z } from "zod";

export const EmetteurSchema = z.strictObject({
  nom: z.string(),
  siren: z.string().optional(),
  vat: z.string().optional(),
  pays: z.string().optional(),
});

export const LigneTvaSchema = z.strictObject({
  taux: z.number(),
  base_ht: z.number(),
  montant_tva: z.number(),
});

export const ExtractionLigneSchema = z.strictObject({
  libelle: z.string(),
  quantite: z.number().optional(),
  montant_ht: z.number().optional(),
  taux_tva: z.number().optional(),
  montant_ttc: z.number().optional(),
});

export const IndicesContextSchema = z.strictObject({
  nb_couverts: z.number().optional(),
  mention_invites: z.boolean().optional(),
  type_transaction: z.enum(["b2b", "b2c", "inconnu"]).optional(),
  items_top: z.array(z.string()).optional(),
  carburant: z
    .strictObject({
      type: z.enum(["diesel", "essence", "gpl"]).nullable(),
      litres: z.number().optional(),
    })
    .optional(),
  vehicule_immat: z.string().optional(),
  est_ticket_caisse: z.boolean().optional(),
  est_avoir: z.boolean().optional(),
  mention_acompte: z.boolean().optional(),
});

export const ExtractionMetaSchema = z.strictObject({
  modele_utilise: z.enum(["haiku", "sonnet", "skipped"]),
  inversion_date_appliquee: z.boolean(),
  tokens_input: z.number(),
  tokens_output: z.number(),
  skipped_reason: z.enum(["releve_bancaire", "hors_exercice"]).optional(),
});

export const ExtractionVisionSchema = z.strictObject({
  emetteur: EmetteurSchema,
  numero_piece: z.string(),
  date: z.string(),
  montant_ht_total: z.number().optional(),
  montant_ttc_total: z.number(),
  lignes_tva: z.array(LigneTvaSchema),
  lignes: z.array(ExtractionLigneSchema),
  indices_context: IndicesContextSchema,
  confiance_extraction: z.number(),
  meta: ExtractionMetaSchema,
});

export type ExtractionVisionParsed = z.infer<typeof ExtractionVisionSchema>;

export function parseExtraction(raw: unknown): ExtractionVisionParsed {
  const result = ExtractionVisionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[contracts/extraction] ExtractionVision invalide :\n${issues}\n\nReçu : ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }
  return result.data;
}
