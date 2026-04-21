/**
 * Schéma Zod de la sortie du builder (Phase 3).
 * Le `payload` Fulll est laissé en `z.unknown()` — validé par le contrat GraphQL
 * Fulll au moment de la mutation `recordPurchaseFormMutation`.
 */

import { z } from "zod";

export const ResultatBuilderSchema = z.strictObject({
  decision: z.enum(["comptabiliser", "douteux", "erreur"]),
  payload: z.unknown().optional(),
  raison: z.string().optional(),
  confiance: z.number().min(0).max(100),
  comptesFinaux: z.array(z.string()),
  /**
   * Alertes émises par le builder (distinctes de `decision.alertes` qui
   * viennent du décideur LLM). Permet au builder de remonter des signaux
   * propres (ex. `TVA_ESTIMEE_FALLBACK_CARBURANT`) sans muter la décision.
   * Le caller (thor) concatène `decision.alertes` + `resultat.alertes_builder`
   * lors du persist ou du commit Fulll. Absent ou vide = aucune alerte builder.
   */
  alertes_builder: z.array(z.string()).optional(),
});

export type ResultatBuilderParsed = z.infer<typeof ResultatBuilderSchema>;

export function parseResultatBuilder(raw: unknown): ResultatBuilderParsed {
  const result = ResultatBuilderSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[contracts/builder] ResultatBuilder invalide :\n${issues}\n\nReçu : ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }
  return result.data;
}
