/**
 * Garde-fous pré-mutation Fulll + synthèse de référence.
 *
 * Session 3 ERR-BUILD-02 (21/04/2026) — fix contre les rejets silencieux
 * côté `recordPurchaseFormMutation` quand le payload part avec un champ
 * critique vide (provider ID, header.label). Le builder refuse désormais
 * de construire un payload incomplet et remonte un message douteux clair.
 *
 * Complément : quand `extraction.numero_piece` est vide (cas typique tickets
 * carburant Leclerc / Intermarché sans n° imprimé), on synthétise un
 * `header.reference` unique et traçable au format `AUTO-YYMMDD-TTC-hash4`
 * plutôt que d'envoyer `""`.
 */

import { createHash } from "node:crypto";
import type { ExtractionVision, DecisionDecideur, FactureSuivante } from "./types.js";
import { dateVersISO as dateVersISOLib } from "./dates.js";

export interface GardeFousResult {
  /** Fournisseur verifié (trim() appliqué, jamais vide si ok=true) */
  fournisseurNom: string;
  /** Provider relay ID Fulll vérifié non vide */
  providerRelay: string;
}

/**
 * Vérifie que les champs critiques du payload Fulll sont présents avant
 * d'engager l'assemblage. Renvoie `{ ok:false, raison }` si un champ
 * bloquant est vide — le caller utilise cette raison pour retourner
 * `ResultatBuilder douteux`.
 *
 * Champs vérifiés :
 * - `facture.provider.id` — Fulll exige un provider resolu. Si vide,
 *   `resoudreOuCreerProviderImage` n'a pas muté `factureCourante.provider`
 *   correctement (race condition ou échec silencieux). Douteux immédiat.
 * - `fournisseurNom` (fallback cascade `provider.name` → `decision.fournisseur_fulll`)
 *   — label obligatoire Fulll. Trim pour éviter les strings `"   "` silencieuses.
 *
 * Le `numero_piece` n'est PAS bloquant ici — géré par `synthetiserReference`
 * qui fournit un fallback synthétique traçable.
 */
export function verifierGardeFousPreMutation(
  facture: FactureSuivante,
  decision: DecisionDecideur,
): { ok: true; data: GardeFousResult } | { ok: false; raison: string } {
  const providerRelay = facture.provider?.id?.trim() ?? "";
  if (providerRelay === "") {
    return {
      ok: false,
      raison:
        "ERR-BUILD-05 : Provider Fulll introuvable (provider.id vide) — resoudreOuCreerProviderImage n'a pas muté la facture",
    };
  }

  const fournisseurNom = (
    facture.provider?.name?.trim() ||
    decision.fournisseur_fulll?.trim() ||
    ""
  );
  if (fournisseurNom === "") {
    return {
      ok: false,
      raison:
        "ERR-BUILD-05 : Libellé fournisseur manquant (provider.name + decision.fournisseur_fulll tous vides)",
    };
  }

  return { ok: true, data: { fournisseurNom, providerRelay } };
}

/**
 * Synthétise un `header.reference` unique et traçable quand Vision n'a pas
 * lu de `numero_piece` (cas tickets carburant sans n° imprimé).
 *
 * Format : `AUTO-YYMMDD-TTC-hash4` (~20 chars).
 * Exemple : `AUTO-260421-8500-a3f2` pour une facture du 21/04/2026 à 85.00€.
 *
 * - `YYMMDD` depuis la date Vision (6 chars)
 * - `TTC` en centimes (85.00€ → 8500, absolute value pour avoirs)
 * - `hash4` = 4 premiers chars md5 du `documentId` Fulll (unicité garantie
 *   même sur collision date+TTC, car documentId est unique côté Fulll)
 *
 * Si `documentId` vide (ne devrait jamais arriver en prod), fallback sur
 * un hash de `date+ttc+random` pour garantir unicité.
 */
export function synthetiserReference(
  dateVision: string,
  ttcEffectif: number,
  documentId: string,
): string {
  const dateIso = dateVersISOLib(dateVision) ?? "";
  const match = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const yymmdd = match
    ? `${match[1]!.slice(2)}${match[2]!}${match[3]!}`
    : "000000";

  const ttcInt = Math.round(Math.abs(ttcEffectif) * 100);

  const hashSeed =
    documentId && documentId.length > 0
      ? documentId
      : `${dateIso}-${ttcInt}-${Math.random().toString(36).slice(2)}`;
  const hash4 = createHash("md5").update(hashSeed).digest("hex").slice(0, 4);

  return `AUTO-${yymmdd}-${ttcInt}-${hash4}`;
}

/**
 * Résout `header.reference` final : le `numero_piece` Vision si présent,
 * sinon la synthèse. Retourne aussi un flag pour savoir si on doit remonter
 * l'alerte `REFERENCE_AUTO_SYNTHESE`.
 */
export function resoudreReference(
  extraction: ExtractionVision,
  facture: FactureSuivante,
  ttcEffectif: number,
): { reference: string; synthetisee: boolean } {
  const numeroVision = extraction.numero_piece?.trim() ?? "";
  if (numeroVision !== "") {
    return { reference: numeroVision, synthetisee: false };
  }
  const reference = synthetiserReference(
    extraction.date,
    ttcEffectif,
    facture.documentId ?? "",
  );
  return { reference, synthetisee: true };
}
