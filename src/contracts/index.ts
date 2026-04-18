/**
 * Contrats Zod v2 — point d'entrée centralisé.
 */

export {
  EmetteurSchema,
  LigneTvaSchema,
  ExtractionLigneSchema,
  IndicesContextSchema,
  ExtractionMetaSchema,
  ExtractionVisionSchema,
  parseExtraction,
  type ExtractionVisionParsed,
} from "./extraction.zod.js";

export {
  ALERTES_CODES,
  RegimeTvaSchema,
  DecisionDecideurSchema,
  parseDecision,
  type DecisionDecideurParsed,
  type RegimeTva,
} from "./decision.zod.js";

export {
  ResultatBuilderSchema,
  parseResultatBuilder,
  type ResultatBuilderParsed,
} from "./builder.zod.js";
