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
