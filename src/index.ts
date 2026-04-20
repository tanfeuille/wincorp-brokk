/**
 * @tanfeuille/brokk — exports publics (namespace GitHub Packages pour user tanfeuille).
 *
 * Module partagé builder paie/factures Fulll (écosystème Yggdrasil).
 * Consommé par wincorp-thor (worker) et wincorp-bifrost (API session correction).
 */

// ── Builder principal ────────────────────────────────────────────────
export {
  construirePayloadV2,
  equilibrerPayload,
  remonterComptesPCG,
  __internals as __builderInternals,
  type ConstruirePayloadV2Params,
} from "./builder.js";

// ── Helpers TVA ──────────────────────────────────────────────────────
export { calculerLignesTVA } from "./tva.js";
export { determinerRegimeTvaDepuisCompte } from "./regimes.js";

// ── Helpers dates ────────────────────────────────────────────────────
export {
  dateVersISO,
  exerciceDepuisCloture,
  corrigerDateAmbigue,
  corrigerAnneeOcr,
} from "./dates.js";

// ── Helpers divers ──────────────────────────────────────────────────
export { similariteNomsFournisseur } from "./helpers.js";

// ── Contrats Zod ─────────────────────────────────────────────────────
export {
  EmetteurSchema,
  LigneTvaSchema,
  ExtractionLigneSchema,
  IndicesContextSchema,
  ExtractionMetaSchema,
  ExtractionVisionSchema,
  parseExtraction,
  ALERTES_CODES,
  RegimeTvaSchema,
  DecisionDecideurSchema,
  parseDecision,
  ResultatBuilderSchema,
  parseResultatBuilder,
  type ExtractionVisionParsed,
  type DecisionDecideurParsed,
  type ResultatBuilderParsed,
  type RegimeTva,
} from "./contracts/index.js";

// ── Types ────────────────────────────────────────────────────────────
export type {
  FournisseurYAML,
  FournisseursYAML,
  CompteFrequent,
  RegleDossier,
  ProfilDossier,
  LigneForm,
  FactureSuivante,
  PurchaseFormInput,
  ExtractionVision,
  ExtractionLigne,
  IndicesContext,
  DecisionDecideur,
  ResultatBuilder,
  ContextDecideur,
} from "./types.js";
