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
 * Préprocesseur REQUIRED : coerce string numérique → number, rejette non-parsable.
 * Utilisé pour les champs obligatoires où l'absence est une vraie erreur
 * (ex: `montant_ttc_total` racine).
 *
 * Accepte : number | string parsable ("5.5", "20%", "  42  ").
 * Rejette : null, undefined, string vide, string non numérique.
 */
const nombreDepuisVision = z.preprocess((v) => {
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return v; // laisse fail z.number avec "expected number received string"
    const n = parseFloat(trimmed);
    return Number.isNaN(n) ? v : n;
  }
  return v;
}, z.number());

/**
 * Préprocesseur OPTIONAL tolérant : Vision peut omettre, retourner null,
 * string vide ou string non parsable — tous convertis en undefined qui est
 * accepté par `z.number().optional()`. Pas d'erreur remontée.
 *
 * Fix 20/04 soir (smoke ELAG'RIMP) : 5 factures échouaient sur
 *   - lignes.*.taux_tva = "" ou null
 *   - lignes.*.montant_ttc = null
 *   - lignes_tva.*.base_ht absent
 *
 * Le `.optional()` est intégré DANS le pipe : sans ça, `.optional()` appliqué
 * APRÈS le pipe z.number() ne rattrape pas (optional n'active que si l'input
 * INITIAL est undefined, pas si le preprocess produit undefined ensuite).
 *
 * Le builder downstream gère l'absence (line skip, fallback, ou bascule douteuse
 * métier — plus jamais une erreur extraction pure).
 */
const nombreOptionnelTolerant = z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const n = parseFloat(trimmed);
    return Number.isNaN(n) ? undefined : n;
  }
  return v;
}, z.number().optional());

/**
 * Variante OPTIONAL tolérante avec borne [0..100] pour taux TVA.
 * Si la valeur coercée est hors borne, on la laisse passer (optional) comme
 * undefined — preferable à une erreur qui bloque le run entier.
 */
const tauxTvaOptionnelTolerant = z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const n = parseFloat(trimmed);
    if (Number.isNaN(n)) return undefined;
    return n;
  }
  if (typeof v === "number") {
    return v;
  }
  return undefined;
}, z.number().min(0).max(100).optional());

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
  // Fix S-1 + 20/04 soir : Vision Haiku retourne parfois "5.5" au lieu de 5.5,
  // ou null, ou omet le champ sur tickets multi-taux incohérents. Helpers
  // `*OptionnelTolerant` convertissent tout en undefined (accepté par optional).
  taux: tauxTvaOptionnelTolerant,
  base_ht: nombreOptionnelTolerant,
  montant_tva: nombreOptionnelTolerant,
});

export const ExtractionLigneSchema = z.strictObject({
  libelle: z.string(),
  quantite: nombreOptionnelTolerant,
  // Alias FR observé en prod ELAG'RIMP 20/04 (Vision utilise "quantité" au
  // lieu de "quantite" sur certains prompts). Ajouté explicitement plutôt
  // que relâcher le strictObject — meilleure traçabilité.
  quantité: nombreOptionnelTolerant,
  montant_ht: nombreOptionnelTolerant,
  taux_tva: tauxTvaOptionnelTolerant,
  montant_ttc: nombreOptionnelTolerant,
});

/**
 * `indices_context` est un bag de signaux contextuels que Vision enrichit
 * librement. Smoke TOMETY 21/04 après-midi (session 4) a révélé une nouvelle
 * variante `est_facture_telecom` — différente de `est_facture_abonnement`
 * qui venait d'être fixée le même jour. Pattern whack-a-mole confirmé.
 *
 * Décision 21/04 : passer de `z.strictObject` à `z.looseObject` sur cette
 * clé spécifiquement — accepte toute clé `est_*` ou autre flag contextuel
 * inventé par le LLM sans rejet. Les clés explicitement listées ci-dessous
 * restent typées (le décideur peut lire `est_avoir`, `mention_acompte`,
 * etc. en type-safe). Les clés non listées sont préservées en passthrough
 * sans validation.
 *
 * Les autres schémas du contrat (EmetteurSchema, LigneTvaSchema,
 * ExtractionLigneSchema, ExtractionVisionSchema) RESTENT strict — seul
 * `indices_context` est un bag permissif car c'est sa nature.
 */
export const IndicesContextSchema = z.looseObject({
  nb_couverts: nombreOptionnelTolerant,
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
      litres: nombreOptionnelTolerant,
    })
    .optional(),
  vehicule_immat: z.string().optional(),
  est_ticket_caisse: z.boolean().optional(),
  est_avoir: z.boolean().optional(),
  mention_acompte: z.boolean().optional(),
  // Clé observée en prod TOMETY 21/04 (Vision ajoute ce flag sur factures
  // de syndic / copropriété — MA RESIDENCE, OPAC, Loiselet & Daigremont).
  // Signal utile pour le décideur : un appel de fonds n'est pas une facture
  // classique d'achat (routing possible vers compte 614 charges locatives
  // ou 615 entretien selon nature). Schéma strict → ajout explicite sinon
  // rejet (2 erreurs ERR-EXTRACTION session 33+35 smoke TOMETY).
  est_appel_de_fonds_copropriete: z.boolean().optional(),
  // Clé observée en prod TOMETY 21/04 matin (Vision ajoute ce flag sur
  // factures d'abonnement télécom récurrent — Orange, SFR, Bouygues, Free).
  // Signal métier : facture d'abonnement récurrent → préférer un F-code dédié
  // plutôt que FDIVERS (complémentaire aux ancrages canoniques 21/04).
  // Schéma strict → ajout explicite sinon rejet (1 erreur ERR-EXTRACTION
  // session 12 smoke TOMETY 21/04).
  est_facture_abonnement: z.boolean().optional(),
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
  montant_ht_total: nombreOptionnelTolerant,
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
