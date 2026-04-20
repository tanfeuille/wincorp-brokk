/**
 * Schémas Zod miroirs des interfaces v2 — source unique de vérité des contrats
 * entre extracteur (Phase 1), décideur (Phase 2) et builder (Phase 3).
 *
 * Usage :
 * - Sortie extracteur : `ExtractionVisionSchema.parse(raw)` avant retour
 * - Entrée décideur/builder : idem au top de la fonction
 */

import { z } from "zod";

/**
 * Préprocesseur pour champs numériques que Vision retourne parfois en string.
 * Accepte: number natif | string numérique ("5.5", "20") | string avec unité ("20%"
 * via parseFloat qui garde la partie numérique). Rejette: "", "abc", null.
 * Appliqué sur tous les champs monétaires et taux pour tolérer Haiku moins strict.
 */
const nombreDepuisVision = z.preprocess((v) => {
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? v : n; // renvoie v brut si parseFloat échoue → Zod throw cohérent
  }
  return v;
}, z.number());

export const EmetteurSchema = z.strictObject({
  nom: z.string(),
  // Fix S-2 : Vision retourne parfois `null` explicitement (pas undefined)
  // pour SIREN/VAT absents sur tickets de caisse légitimes. `.nullish()`
  // tolère null + undefined.
  siren: z.string().nullish(),
  vat: z.string().nullish(),
  pays: z.string().nullish(),
});

/**
 * Taux TVA borné [0..100]. Évite qu'un "200%" ou "-5%" pathologique passe
 * silencieusement via `nombreDepuisVision.parseFloat` (reviewer MF-1).
 * Max 100 couvre les taux standard FR (0 / 5.5 / 10 / 20) et exotiques (DOM).
 */
const tauxTvaBorne = nombreDepuisVision.pipe(z.number().min(0).max(100));

export const LigneTvaSchema = z.strictObject({
  // Fix S-1 : Vision Haiku retourne parfois "5.5" au lieu de 5.5 sur tickets
  // multi-lignes. Préprocesseur coerce string numérique sans casser Zod.
  taux: tauxTvaBorne,
  base_ht: nombreDepuisVision,
  montant_tva: nombreDepuisVision,
});

export const ExtractionLigneSchema = z.strictObject({
  libelle: z.string(),
  quantite: nombreDepuisVision.optional(),
  // Alias FR observé en prod ELAG'RIMP 20/04 (Vision utilise "quantité" au
  // lieu de "quantite" sur certains prompts). Ajouté explicitement plutôt
  // que relâcher le strictObject — meilleure traçabilité.
  quantité: nombreDepuisVision.optional(),
  montant_ht: nombreDepuisVision.optional(),
  taux_tva: tauxTvaBorne.optional(),
  montant_ttc: nombreDepuisVision.optional(),
});

export const IndicesContextSchema = z.strictObject({
  nb_couverts: nombreDepuisVision.optional(),
  mention_invites: z.boolean().optional(),
  type_transaction: z.enum(["b2b", "b2c", "inconnu"]).optional(),
  items_top: z.array(z.string()).optional(),
  carburant: z
    .strictObject({
      // Fix S-3 : Vision retourne parfois "SP95", "SP98", "gazole", "e10"
      // — valeurs non mappées. `.catch(null)` dégrade gracieusement en null
      // (le décideur n'utilise ce champ que pour le log). Pas de perte
      // comptable : le compte 60617000 est identique pour tous les carburants.
      type: z.enum(["diesel", "essence", "gpl"]).nullable().catch(null),
      litres: nombreDepuisVision.optional(),
    })
    .optional(),
  vehicule_immat: z.string().optional(),
  est_ticket_caisse: z.boolean().optional(),
  est_avoir: z.boolean().optional(),
  mention_acompte: z.boolean().optional(),
  // Clé observée en prod ELAG'RIMP 20/04 (Vision ajoute un objet `client`
  // sur factures B2B professionnelles — nom, adresse, SIREN du destinataire).
  // Ajouté en passthrough (`z.unknown()`) pour ne pas casser sur les
  // variations de structure LLM. StrictObject parent conservé.
  client: z.unknown().optional(),
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
  montant_ht_total: nombreDepuisVision.optional(),
  montant_ttc_total: nombreDepuisVision,
  lignes_tva: z.array(LigneTvaSchema),
  lignes: z.array(ExtractionLigneSchema),
  indices_context: IndicesContextSchema,
  // Vision retourne confiance sous forme number mais Haiku a déjà sorti des
  // strings "85" en prod. Borne [0, 100] conservée (max/min Zod).
  confiance_extraction: nombreDepuisVision.pipe(z.number().min(0).max(100)),
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
