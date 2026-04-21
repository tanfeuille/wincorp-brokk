/**
 * Builder code mécanique Image v2 — Phase 3.
 *
 * Consomme `ExtractionVision` (Phase 1) + `DecisionDecideur` (Phase 2) + `FactureSuivante`
 * (bookQuery Fulll) + `ProfilDossier`. Produit un `PurchaseFormInput` équilibré prêt pour
 * `comptabiliserFacture()`, ou déclare `douteux/erreur` si contraintes mécaniques non tenues.
 *
 * Aucun appel LLM, aucun accès réseau, aucune décision d'arbitrage : le builder applique
 * mécaniquement la décision Phase 2 via `calculerLignesTVA` et quelques helpers purs
 * (avoir, équilibre, 0 € → 0,01 €).
 *
 * Règles implémentées :
 * - R27 : court-circuit non-facture (skipped_reason / RELEVE_BANCAIRE_DETECTE)
 * - R28 : routing acompte (compte 40910000 OU mention_acompte OU ligne Fulll body)
 * - R29 : force 0 € → 0,01 € pour traçabilité
 * - R30 : calcul TVA + agrégation par compte TVA + recalibrage HT FR
 * - R31 : routing avoir = permutation D/C après assemblage
 * - R32 : assemblage PurchaseFormInput
 * - R33 : vérification équilibre ±0.01 € ajusté, >0.01 douteux
 * - R34 : remontée comptes PCG finaux triés
 * - R35 : propagation alertes décideur (CONFIANCE_INSUFFISANTE → douteux direct)
 */

import type {
  ProfilDossier,
  FactureSuivante,
  PurchaseFormInput,
  ExtractionVision,
  DecisionDecideur,
  ResultatBuilder,
} from "./types.js";
import { calculerLignesTVA } from "./tva.js";
import { dateVersISO as dateVersISOLib } from "./dates.js";
import { parseExtraction, parseDecision } from "./contracts/index.js";
import { appliquerFallbackTvaCarburant } from "./fallback-tva.js";
import {
  verifierGardeFousPreMutation,
  resoudreReference,
} from "./pre-mutation-guards.js";

/**
 * Wrapper local : si l'entrée n'est pas convertible (vide ou pas de "/"),
 * retourne la valeur brute telle quelle (au lieu de undefined).
 */
function dateVersISO(dateVision: string): string {
  return dateVersISOLib(dateVision) ?? dateVision;
}

// ── Paramètres ────────────────────────────────────────────────────────

export interface ConstruirePayloadV2Params {
  facture: FactureSuivante;
  extraction: ExtractionVision;
  decision: DecisionDecideur;
  profil: ProfilDossier;
  bookRelayId: string;
}

/** Tolérance équilibre débit/crédit (en euros). */
const TOLERANCE_EQUILIBRE = 0.01;

// ── Fonction principale ───────────────────────────────────────────────

export function construirePayloadV2(params: ConstruirePayloadV2Params): ResultatBuilder {
  parseExtraction(params.extraction);
  parseDecision(params.decision);

  const { facture, extraction, decision, profil, bookRelayId } = params;

  // ── R27 : court-circuit non-facture ────────────────────────────────
  if (extraction.meta?.skipped_reason) {
    return {
      decision: "douteux",
      raison: `Pièce non-facture : ${extraction.meta.skipped_reason}`,
      confiance: 0,
      comptesFinaux: [],
    };
  }
  if (decision.alertes.includes("RELEVE_BANCAIRE_DETECTE")) {
    return {
      decision: "douteux",
      raison: "Pièce non-facture (RELEVE_BANCAIRE_DETECTE côté décideur)",
      confiance: 0,
      comptesFinaux: [],
    };
  }

  // ── R35 : CONFIANCE_INSUFFISANTE → douteux direct ──────────────────
  if (decision.alertes.includes("CONFIANCE_INSUFFISANTE")) {
    return {
      decision: "douteux",
      raison: `Confiance décideur insuffisante (${decision.confiance}%)`,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  // ── EC29 : avoir + acompte combiné → douteux (cas complexe) ────────
  if (
    extraction.indices_context.est_avoir &&
    extraction.indices_context.mention_acompte
  ) {
    return {
      decision: "douteux",
      raison: "Avoir + acompte combiné : cas complexe à traiter manuellement",
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  // ── R28 : routing acompte ──────────────────────────────────────────
  const ligneAcompteFulll = facture.form?.body?.find(
    (l) => l.accountNumber === "40910000",
  );
  const declencheurAcompte =
    decision.compte_charge === "40910000" ||
    extraction.indices_context.mention_acompte === true ||
    ligneAcompteFulll !== undefined;

  if (declencheurAcompte) {
    return construirePayloadAcompteV2({
      facture,
      extraction,
      decision,
      profil,
      bookRelayId,
      ligneAcompteFulll,
    });
  }

  // ── R29 : force 0 € → 0,01 € ───────────────────────────────────────
  const { ttcEffectif, lignesEffectives } = appliquerForceCentime(extraction);

  // ── R36 : fallback TVA carburant (ERR-BUILD-02 recovery) ───────────
  // Si Vision a raté le bandeau TVA sur un ticket carburant FR régime normal
  // (compte 60617000), on synthétise une ligne TVA 20% déterministe. Toggle
  // par dossier via `profil.parametres.tva_fallback_carburant` (défaut true).
  const fallbackActive = profil.parametres?.tva_fallback_carburant !== false;
  const fallbackResult = appliquerFallbackTvaCarburant(
    extraction,
    decision,
    fallbackActive,
  );
  const extractionFinale = fallbackResult.extraction;
  const alertesBuilder: string[] = [];
  if (fallbackResult.applique) {
    alertesBuilder.push("TVA_ESTIMEE_FALLBACK_CARBURANT");
  }

  // ── Validation relay_id compte charge ──────────────────────────────
  const relayCharge = profil.comptes_relay_ids?.[decision.compte_charge];
  if (!relayCharge) {
    return {
      decision: "douteux",
      raison: `Relay ID manquant pour compte charge ${decision.compte_charge} — ERR-BUILD-04`,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  // ── Garde-fous pré-mutation (Session 3 ERR-BUILD-05) ───────────────
  // Empêche l'envoi d'un payload avec champ critique vide qui ferait
  // rejeter Fulll silencieusement (ISE opaque). Vérifie provider + label.
  const gardes = verifierGardeFousPreMutation(facture, decision);
  if (!gardes.ok) {
    return {
      decision: "douteux",
      raison: gardes.raison,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }
  const fournisseurNom = gardes.data.fournisseurNom;
  const providerRelay = gardes.data.providerRelay;

  // Référence synthétique si numero_piece vide (tickets carburant sans n°)
  const refInfo = resoudreReference(extractionFinale, facture, ttcEffectif);
  if (refInfo.synthetisee) {
    alertesBuilder.push("REFERENCE_AUTO_SYNTHESE");
  }

  // ── R30 : calcul lignes TVA mécanique ─────────────────────────────
  let lignesCharge: PurchaseFormInput["body"];
  let lignesTvaDebit: PurchaseFormInput["body"];
  let lignesTvaCredit: PurchaseFormInput["body"];
  try {
    const resultatTva = calculerLignesTvaAgregees({
      compteCharge: decision.compte_charge,
      relayCharge,
      regime: decision.regime_tva,
      lignesTva: extractionFinale.lignes_tva,
      montantTtcTotal: ttcEffectif,
      profil,
      fournisseurNom,
    });
    lignesCharge = resultatTva.lignesCharge;
    lignesTvaDebit = resultatTva.lignesTvaDebit;
    lignesTvaCredit = resultatTva.lignesTvaCredit;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      decision: "douteux",
      raison: `ERR-BUILD-02 : ${msg}`,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  // ── R32 : assemblage PurchaseFormInput ────────────────────────────
  const formAccountDetails = facture.form?.accountDetails ?? {
    companyRegistration: null,
    intraVAT: null,
    phone: null,
    fax: null,
  };
  let payload: PurchaseFormInput = {
    book: bookRelayId,
    document: facture.documentId ?? "",
    date: dateVersISO(extraction.date),
    currency: null,
    period: null,
    provider: providerRelay,
    dueDate: null,
    balance: null,
    payment: null,
    total: null,
    accountDetails: {
      companyRegistration: formAccountDetails.companyRegistration ?? null,
      intraVAT: formAccountDetails.intraVAT ?? null,
      phone: formAccountDetails.phone ?? null,
      fax: formAccountDetails.fax ?? null,
    },
    header: {
      reference: refInfo.reference,
      label: fournisseurNom,
      debit: null,
      credit: ttcEffectif,
      analytic: null,
      vat: null,
    },
    body: [...lignesCharge, ...lignesTvaDebit, ...lignesTvaCredit],
    footer: [],
  };

  // ── R31 : routing avoir (permutation D/C) ─────────────────────────
  if (extraction.indices_context.est_avoir) {
    payload = appliquerAvoir(payload);
  }

  // ── R33 : vérification équilibre ──────────────────────────────────
  const equilibre = equilibrerPayload(payload);
  if (!equilibre.ok) {
    return {
      decision: "douteux",
      raison: `ERR-BUILD-03 : payload non équilibré, delta=${equilibre.delta.toFixed(2)} €`,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  // ── R34 : remontée comptes finaux ─────────────────────────────────
  const comptesFinaux = remonterComptesPCG(payload, facture, profil);

  return {
    decision: "comptabiliser",
    payload,
    confiance: decision.confiance,
    comptesFinaux,
    ...(alertesBuilder.length > 0 ? { alertes_builder: alertesBuilder } : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * R29 — Force 0 € → 0,01 € pour traçabilité SPINEX.
 */
function appliquerForceCentime(extraction: ExtractionVision): {
  ttcEffectif: number;
  lignesEffectives: ExtractionVision["lignes"];
} {
  if (extraction.montant_ttc_total > 0) {
    return {
      ttcEffectif: extraction.montant_ttc_total,
      lignesEffectives: extraction.lignes,
    };
  }
  const premiereLigneValide = extraction.lignes.find(
    (l) => (l.montant_ht ?? 0) > 0 || (l.montant_ttc ?? 0) > 0,
  );
  if (premiereLigneValide) {
    return { ttcEffectif: 0.01, lignesEffectives: extraction.lignes };
  }
  return {
    ttcEffectif: 0.01,
    lignesEffectives: [
      {
        libelle: "Facture 0 € tracée",
        quantite: 1,
        montant_ht: 0.01,
        taux_tva: 0,
        montant_ttc: 0.01,
      },
    ],
  };
}

/**
 * R30 — Phase 4.7 (19/04/2026) : approche directe basée sur lignes_tva Vision.
 *
 * Source unique de vérité : `extraction.lignes_tva` (bandeau TVA pré-calculé
 * par le fournisseur, lu par Vision depuis "Total HT / Total TVA / Total TTC").
 * Pas de re-agrégation des lignes individuelles, pas de recalibrage avec
 * tolérance %. L'équilibre est garanti par construction.
 *
 * Stratégie :
 * - Franchise → 1 ligne charge = `montant_ttc_total` direct (BUG-1 fix : ne
 *   plus reconstruire depuis lignes individuelles qui peuvent contenir des TTC).
 * - Autoliquidation intracom/extracom → HT = TTC (le fournisseur étranger ne
 *   facture pas TVA), TVA artificielle 20% débit + crédit (autoliq équilibrée).
 * - FR : `lignes_tva` obligatoire, sinon douteux ERR-EXTRACTION-INCOMPLETE.
 *   Vérif cohérence `sumBaseHt + sumTVA = TTC` :
 *     • cohérent (delta ≤ 0.01) → htFinal = sumBaseHt direct
 *     • incohérent < 10% TTC → htFinal = TTC - sumTVA (ajustement par
 *       soustraction, équilibre exact ; cas écocontribution ALTADIF non lue)
 *     • incohérent ≥ 10% TTC → douteux ERR-EXTRACTION-INCOHERENTE
 *   TVA = sum(montant_tva) Vision direct (jamais recalcul × taux).
 *   Multi-taux : tous les taux mappent au même compte 44566000 (TVA
 *   déductible unique en FR), donc 1 ligne TVA agrégée.
 *
 * Tolerance équilibre payload : 0.01€ (arrondi centime, géré par
 * equilibrerPayload R33). Plus de tolérance % opaque.
 */
function calculerLignesTvaAgregees(params: {
  compteCharge: string;
  relayCharge: string;
  regime: DecisionDecideur["regime_tva"];
  lignesTva: ExtractionVision["lignes_tva"];
  montantTtcTotal: number;
  profil: ProfilDossier;
  fournisseurNom: string;
}): {
  lignesCharge: PurchaseFormInput["body"];
  lignesTvaDebit: PurchaseFormInput["body"];
  lignesTvaCredit: PurchaseFormInput["body"];
} {
  const {
    compteCharge: _compteCharge,
    relayCharge,
    regime,
    lignesTva,
    montantTtcTotal,
    profil,
    fournisseurNom,
  } = params;
  const labelCharge = fournisseurNom || "Charge";
  const isFranchise =
    regime === "franchise" ||
    profil.comptabilite.regime_tva === "franchise_en_base";

  // ── Franchise : 1 ligne charge = TTC, pas de TVA (fix BUG-1) ─────────
  if (isFranchise) {
    return {
      lignesCharge: [makeLigneDebit(relayCharge, labelCharge, montantTtcTotal)],
      lignesTvaDebit: [],
      lignesTvaCredit: [],
    };
  }

  // ── Cas force centime R29 : facture 0 € tracée à 0,01 € ─────────────
  // Vision n'a rien à extraire (lignes_tva vide), on génère quand même
  // 1 ligne charge minimaliste pour la traçabilité comptable SPINEX.
  if (montantTtcTotal === 0.01 && (!lignesTva || lignesTva.length === 0)) {
    return {
      lignesCharge: [makeLigneDebit(relayCharge, labelCharge, 0.01)],
      lignesTvaDebit: [],
      lignesTvaCredit: [],
    };
  }

  // ── Autoliquidation intracom/extracom : HT = TTC, TVA artificielle 20% ─
  // Le fournisseur étranger ne facture pas TVA. On simule TVA déductible
  // débit + crédit du même montant pour équilibrer (autoliquidation).
  if (regime === "intracom" || regime === "extracom") {
    const ht = montantTtcTotal;
    const tva = round2(ht * 0.20);
    const compteTvaD = regime === "intracom" ? "44566200" : "44566300";
    const compteTvaC = regime === "intracom" ? "44520000" : "44571300";
    return {
      lignesCharge: [makeLigneDebit(relayCharge, labelCharge, ht)],
      lignesTvaDebit: [
        makeLigneDebit(getRelayObligatoire(profil, compteTvaD), fournisseurNom, tva),
      ],
      lignesTvaCredit: [
        makeLigneCredit(getRelayObligatoire(profil, compteTvaC), fournisseurNom, tva),
      ],
    };
  }

  // ── FR : lignes_tva obligatoire ──────────────────────────────────────
  const lignesUtilisables = (lignesTva ?? []).filter(
    (t) =>
      typeof t.base_ht === "number" &&
      t.base_ht > 0 &&
      typeof t.taux === "number" &&
      typeof t.montant_tva === "number",
  );
  if (lignesUtilisables.length === 0) {
    throw new Error(
      `ERR-EXTRACTION-INCOMPLETE : lignes_tva vide ou non exploitable ` +
        `(TTC ${montantTtcTotal} €) — Vision n'a pas extrait le bandeau TVA, ` +
        `impossible de ventiler la TVA déductible`,
    );
  }

  // ── Vérif cohérence sumBaseHt + sumTVA vs TTC ────────────────────────
  const sumBaseHt = round2(
    lignesUtilisables.reduce((s, t) => s + t.base_ht, 0),
  );
  const sumTva = round2(
    lignesUtilisables.reduce((s, t) => s + t.montant_tva, 0),
  );
  const ttcReconstruit = round2(sumBaseHt + sumTva);
  const delta = round2(montantTtcTotal - ttcReconstruit);

  let htFinal: number;
  if (Math.abs(delta) <= 0.01) {
    // Cohérent : facture lue parfaitement, on prend le HT Vision direct
    htFinal = sumBaseHt;
  } else if (Math.abs(delta) / montantTtcTotal < 0.10) {
    // Incohérent récupérable (cas écocontribution ALTADIF, ligne non lue) :
    // HT absorbe l'écart, TVA Vision conservée → équilibre exact garanti.
    htFinal = round2(montantTtcTotal - sumTva);
  } else {
    throw new Error(
      `ERR-EXTRACTION-INCOHERENTE : delta ${delta} € entre TTC ` +
        `(${montantTtcTotal} €) et reconstruit (${ttcReconstruit} €) ` +
        `> 10% du TTC — extraction Vision suspecte, douteux pour vérification`,
    );
  }

  // ── Lignes payload : 1 charge + 1 TVA déductible 44566000 ────────────
  // En FR, tous les taux (5.5/10/20) mappent au même compte 44566000
  // (TVA déductible unique). Pas besoin de déagréger par taux.
  return {
    lignesCharge: [makeLigneDebit(relayCharge, labelCharge, htFinal)],
    lignesTvaDebit: [
      makeLigneDebit(getRelayObligatoire(profil, "44566000"), fournisseurNom, sumTva),
    ],
    lignesTvaCredit: [],
  };
}

// ── Helpers internes Phase 4.7 ─────────────────────────────────────────

function makeLigneDebit(
  account: string,
  label: string,
  montant: number,
): PurchaseFormInput["body"][number] {
  return {
    account,
    label,
    debit: montant,
    credit: null,
    vat: null,
    quantity: null,
    analytic: null,
  };
}

function makeLigneCredit(
  account: string,
  label: string,
  montant: number,
): PurchaseFormInput["body"][number] {
  return {
    account,
    label,
    debit: null,
    credit: montant,
    vat: null,
    quantity: null,
    analytic: null,
  };
}

function getRelayObligatoire(profil: ProfilDossier, compte: string): string {
  const relay = profil.comptes_relay_ids?.[compte];
  if (!relay) {
    throw new Error(`Relay ID manquant pour compte TVA ${compte} — ERR-RELAY-TVA`);
  }
  return relay;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * R31 — Inverse débit/crédit sur header + body pour les avoirs.
 * Les montants sont déjà Math.abs (Phase 1 normaliserAvoir).
 */
function appliquerAvoir(payload: PurchaseFormInput): PurchaseFormInput {
  return {
    ...payload,
    header: {
      ...payload.header,
      debit: payload.header.credit,
      credit: payload.header.debit ?? 0,
    },
    body: payload.body.map((l) => ({
      ...l,
      debit: l.credit,
      credit: l.debit,
    })),
  };
}

/**
 * R33 — Vérifie l'équilibre débits/crédits, ajuste le dernier débit charge si écart ≤ 0.01.
 */
export function equilibrerPayload(
  payload: PurchaseFormInput,
): { ok: boolean; delta: number } {
  const sommeDebits =
    (payload.header.debit ?? 0) +
    payload.body.reduce((s, l) => s + (l.debit ?? 0), 0);
  const sommeCredits =
    payload.header.credit +
    payload.body.reduce((s, l) => s + (l.credit ?? 0), 0);
  const delta = Math.round((sommeDebits - sommeCredits) * 100) / 100;

  if (Math.abs(delta) === 0) return { ok: true, delta: 0 };

  if (Math.abs(delta) <= TOLERANCE_EQUILIBRE) {
    const dernierDebitIdx = [...payload.body]
      .reverse()
      .findIndex((l) => (l.debit ?? 0) > 0 && (l.account ?? "").length > 0);
    if (dernierDebitIdx !== -1) {
      const idxReel = payload.body.length - 1 - dernierDebitIdx;
      const ligne = payload.body[idxReel];
      payload.body[idxReel] = {
        ...ligne,
        debit: Math.round(((ligne.debit ?? 0) - delta) * 100) / 100,
      };
      return { ok: true, delta: 0 };
    }
  }
  return { ok: false, delta };
}

/**
 * R34 — Reverse-lookup relay_id → compte PCG 8 chiffres.
 * Source : `facture.form.body` (bookQuery) puis fallback `profil.comptes_relay_ids`.
 * Trié charges/produits (6/7) avant TVA/tiers (4) avant capital/exploitant (1).
 */
export function remonterComptesPCG(
  payload: PurchaseFormInput,
  facture: FactureSuivante,
  profil: ProfilDossier,
): string[] {
  const relayToCompte = new Map<string, string>();
  for (const b of facture.form?.body ?? []) {
    if (b.accountNumber && b.accountId)
      relayToCompte.set(b.accountId, b.accountNumber);
  }
  for (const [compte, relay] of Object.entries(profil.comptes_relay_ids ?? {})) {
    relayToCompte.set(relay, compte);
  }
  const comptes = new Set<string>();
  for (const ligne of payload.body) {
    const compte = relayToCompte.get(ligne.account);
    if (compte) comptes.add(compte);
  }
  const ordre = (c: string) => {
    const d = c[0];
    if (d === "6" || d === "7") return 0;
    if (d === "4") return 1;
    if (d === "1") return 2;
    return 3;
  };
  return Array.from(comptes).sort(
    (a, b) => ordre(a) - ordre(b) || a.localeCompare(b),
  );
}

/**
 * R28 — Routing acompte. Utilise facture.form.body pour les charges HT,
 * ajoute crédit 40910000 + header.credit = TTC - acompte (reste dû).
 */
function construirePayloadAcompteV2(params: {
  facture: FactureSuivante;
  extraction: ExtractionVision;
  decision: DecisionDecideur;
  profil: ProfilDossier;
  bookRelayId: string;
  ligneAcompteFulll?: { accountId: string; debit: number | null; credit: number | null };
}): ResultatBuilder {
  const { facture, extraction, decision, profil, bookRelayId, ligneAcompteFulll } =
    params;

  const ttcEffectif = extraction.montant_ttc_total;
  const bodyFulll = facture.form?.body ?? [];

  const acompteRelay =
    ligneAcompteFulll?.accountId ??
    profil.comptes_relay_ids?.["40910000"] ??
    "";
  const montantAcompte =
    ligneAcompteFulll?.credit ?? ligneAcompteFulll?.debit ?? 0;

  if (!acompteRelay || montantAcompte <= 0) {
    return {
      decision: "douteux",
      raison: "Acompte détecté mais relay 40910000 ou montant acompte absent",
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  // ── Garde-fous pré-mutation (Session 3 ERR-BUILD-05) — branche acompte
  const gardes = verifierGardeFousPreMutation(facture, decision);
  if (!gardes.ok) {
    return {
      decision: "douteux",
      raison: gardes.raison,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }
  const fournisseurNom = gardes.data.fournisseurNom;
  const providerRelay = gardes.data.providerRelay;
  const alertesBuilder: string[] = [];

  // Référence synthétique si numero_piece vide (tickets acompte sans n°)
  const refInfo = resoudreReference(extraction, facture, ttcEffectif);
  if (refInfo.synthetisee) {
    alertesBuilder.push("REFERENCE_AUTO_SYNTHESE");
  }
  const chargesFulll = bodyFulll.filter(
    (l) => l.accountNumber !== "40910000",
  );
  let totalHT = 0;
  let compteChargePrincipal = "";
  const lignesCharge: PurchaseFormInput["body"] = [];
  for (const charge of chargesFulll) {
    const montantHT = Math.abs(charge.debit ?? 0);
    if (montantHT === 0) continue;
    totalHT += montantHT;
    if (!compteChargePrincipal)
      compteChargePrincipal = charge.accountNumber || decision.compte_charge;
    lignesCharge.push({
      account: charge.accountId,
      label: fournisseurNom,
      debit: Math.round(montantHT * 100) / 100,
      credit: null,
      vat: null,
      quantity: null,
      analytic: null,
    });
  }

  if (lignesCharge.length === 0 || totalHT === 0) {
    return {
      decision: "douteux",
      raison: "Acompte : aucune charge HT exploitable dans Fulll body",
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  const tauxTva =
    profil.comptabilite.regime_tva === "franchise_en_base" ? 0 : 0.20;
  const lignesTvaDebit: PurchaseFormInput["body"] = [];
  const lignesTvaCredit: PurchaseFormInput["body"] = [];
  if (tauxTva > 0) {
    try {
      const tvaResult = calculerLignesTVA({
        compteCharge: compteChargePrincipal,
        montantHT: totalHT,
        tauxTva,
        profil,
      });
      for (const d of tvaResult.debitsTva) {
        lignesTvaDebit.push({
          account: d.relay_id,
          label: fournisseurNom,
          debit: d.montant,
          credit: null,
          vat: null,
          quantity: null,
          analytic: null,
        });
      }
      for (const c of tvaResult.creditsTva) {
        lignesTvaCredit.push({
          account: c.relay_id,
          label: fournisseurNom,
          debit: null,
          credit: c.montant,
          vat: null,
          quantity: null,
          analytic: null,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        decision: "douteux",
        raison: `ERR-BUILD-02 (acompte) : ${msg}`,
        confiance: decision.confiance,
        comptesFinaux: [],
      };
    }
  }

  const resteDu = Math.round((ttcEffectif - montantAcompte) * 100) / 100;
  const ligneAcompteCredit: PurchaseFormInput["body"][number] = {
    account: acompteRelay,
    label: fournisseurNom,
    debit: null,
    credit: Math.round(montantAcompte * 100) / 100,
    vat: null,
    quantity: null,
    analytic: null,
  };

  const formAccountDetails = facture.form?.accountDetails ?? {
    companyRegistration: null,
    intraVAT: null,
    phone: null,
    fax: null,
  };
  const payload: PurchaseFormInput = {
    book: bookRelayId,
    document: facture.documentId ?? "",
    date: dateVersISO(extraction.date),
    currency: null,
    period: null,
    provider: providerRelay,
    dueDate: null,
    balance: null,
    payment: null,
    total: null,
    accountDetails: {
      companyRegistration: formAccountDetails.companyRegistration ?? null,
      intraVAT: formAccountDetails.intraVAT ?? null,
      phone: formAccountDetails.phone ?? null,
      fax: formAccountDetails.fax ?? null,
    },
    header: {
      reference: refInfo.reference,
      label: fournisseurNom,
      debit: null,
      credit: resteDu > 0 ? resteDu : ttcEffectif,
      analytic: null,
      vat: null,
    },
    body: [
      ...lignesCharge,
      ...lignesTvaDebit,
      ...lignesTvaCredit,
      ligneAcompteCredit,
    ],
    footer: [],
  };

  const equilibre = equilibrerPayload(payload);
  if (!equilibre.ok) {
    return {
      decision: "douteux",
      raison: `ERR-BUILD-03 (acompte) : delta=${equilibre.delta.toFixed(2)} €`,
      confiance: decision.confiance,
      comptesFinaux: [],
    };
  }

  return {
    decision: "comptabiliser",
    payload,
    confiance: decision.confiance,
    comptesFinaux: remonterComptesPCG(payload, facture, profil),
    ...(alertesBuilder.length > 0 ? { alertes_builder: alertesBuilder } : {}),
  };
}

// ── Exports internes pour tests ──────────────────────────────────────

export const __internals = {
  appliquerForceCentime,
  calculerLignesTvaAgregees,
  appliquerAvoir,
  construirePayloadAcompteV2,
};
