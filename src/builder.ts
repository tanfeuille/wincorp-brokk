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

  // ── R30 : calcul lignes TVA mécanique ─────────────────────────────
  const fournisseurNom =
    facture.provider?.name ?? decision.fournisseur_fulll ?? "";
  let lignesCharge: PurchaseFormInput["body"];
  let lignesTvaDebit: PurchaseFormInput["body"];
  let lignesTvaCredit: PurchaseFormInput["body"];
  try {
    const resultatTva = calculerLignesTvaAgregees({
      compteCharge: decision.compte_charge,
      relayCharge,
      regime: decision.regime_tva,
      lignesExtraction: lignesEffectives,
      profil,
      fallbackTtc: ttcEffectif,
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
  const providerRelay = facture.provider?.id ?? "";
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
      reference: extraction.numero_piece || "",
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
 * R30 — Calcule les lignes charge + TVA pour l'ensemble des lignes Vision.
 *
 * Pipeline (refonte 18/04/2026 pour fix ERR-BUILD-03) :
 * 1. Agrégation HT par taux TVA (élimine dérive arrondi ligne-par-ligne).
 * 2. Recalibrage HT sur TTC en régime FR si écart Vision < 10 % du TTC.
 * 3. Calcul TVA une fois par taux sur le HT agrégé (précision maximale).
 * 4. Agrégation TVA par compte (ex: 2 lignes 20 % → 1 seul débit 44566000).
 *
 * Régime franchise : skip génération TVA, charges = HT tel quel (qui vaut TTC).
 */
function calculerLignesTvaAgregees(params: {
  compteCharge: string;
  relayCharge: string;
  regime: DecisionDecideur["regime_tva"];
  lignesExtraction: ExtractionVision["lignes"];
  profil: ProfilDossier;
  fallbackTtc: number;
  fournisseurNom: string;
}): {
  lignesCharge: PurchaseFormInput["body"];
  lignesTvaDebit: PurchaseFormInput["body"];
  lignesTvaCredit: PurchaseFormInput["body"];
} {
  const {
    compteCharge,
    relayCharge,
    regime,
    lignesExtraction,
    profil,
    fallbackTtc,
    fournisseurNom,
  } = params;

  const lignesCharge: PurchaseFormInput["body"] = [];
  // Phase 4.5 recover (19/04/2026) : on inclut les lignes négatives (remises
  // commerciales sur factures positives, ex SFR "Promotion Fibre -4.46€") pour
  // qu'elles soient soustraites lors de l'agrégation HT par taux. Avant ce
  // fix : `l.montant_ht > 0` excluait les remises → HT agrégé surévalué →
  // ERR-BUILD-03 systématique sur factures télécom multi-lignes (delta +22€
  // observé sur smoke SOAD 19:38).
  const lignesNonVides = lignesExtraction.filter(
    (l) => typeof l.montant_ht === "number" && l.montant_ht !== 0,
  );
  const libelleCharge = fournisseurNom || "Charge";
  const isFranchise =
    regime === "franchise" ||
    profil.comptabilite.regime_tva === "franchise_en_base";

  // ── Fallback : aucune ligne HT exploitable ────────────────────────────
  if (lignesNonVides.length === 0) {
    const htEstime = isFranchise
      ? fallbackTtc
      : Math.round((fallbackTtc / 1.20) * 100) / 100;
    lignesCharge.push({
      account: relayCharge,
      label: libelleCharge,
      debit: htEstime,
      credit: null,
      vat: null,
      quantity: null,
      analytic: null,
    });
    if (isFranchise) return { lignesCharge, lignesTvaDebit: [], lignesTvaCredit: [] };
    const tvaResult = calculerLignesTVA({
      compteCharge,
      montantHT: htEstime,
      tauxTva: 0.20,
      profil,
    });
    return buildLignesTVAResult(tvaResult, lignesCharge, fournisseurNom);
  }

  // ── Franchise : pas de ligne TVA, HT = TTC ────────────────────────────
  if (isFranchise) {
    const totalHT =
      Math.round(
        lignesNonVides.reduce((s, l) => s + (l.montant_ht ?? 0), 0) * 100,
      ) / 100;
    lignesCharge.push({
      account: relayCharge,
      label: libelleCharge,
      debit: totalHT,
      credit: null,
      vat: null,
      quantity: null,
      analytic: null,
    });
    return { lignesCharge, lignesTvaDebit: [], lignesTvaCredit: [] };
  }

  // ── Étape 1 — Agrégation HT par taux TVA ──────────────────────────────
  const forceAutoliquidation = regime === "intracom" || regime === "extracom";
  const htParTaux = new Map<number, number>();
  for (const ligne of lignesNonVides) {
    const tauxVision = typeof ligne.taux_tva === "number" ? ligne.taux_tva : 0;
    const tauxEffectif =
      forceAutoliquidation && tauxVision === 0 ? 20 : tauxVision;
    htParTaux.set(
      tauxEffectif,
      (htParTaux.get(tauxEffectif) ?? 0) + (ligne.montant_ht ?? 0),
    );
  }
  for (const [taux, ht] of htParTaux) {
    htParTaux.set(taux, Math.round(ht * 100) / 100);
  }

  // ── Étape 2 — Recalibrage HT sur TTC (FR uniquement) ─────────────────
  const TOLERANCE_RECALIBRAGE = 0.10;
  if (regime === "FR" && !forceAutoliquidation) {
    const tauxNonZero = Array.from(htParTaux.keys()).filter((t) => t > 0);
    if (tauxNonZero.length > 0) {
      const totalHTbrut = Array.from(htParTaux.values()).reduce(
        (s, v) => s + v,
        0,
      );
      let tvaCalcTotal = 0;
      for (const t of tauxNonZero) {
        tvaCalcTotal +=
          Math.round((htParTaux.get(t) ?? 0) * (t / 100) * 100) / 100;
      }
      const ttcReconstruit = totalHTbrut + tvaCalcTotal;
      const ecartTotal =
        Math.round((fallbackTtc - ttcReconstruit) * 100) / 100;
      if (
        Math.abs(ecartTotal) > 0.01 &&
        Math.abs(ecartTotal) / fallbackTtc < TOLERANCE_RECALIBRAGE
      ) {
        const htTauxNonZero = tauxNonZero.reduce(
          (s, t) => s + (htParTaux.get(t) ?? 0),
          0,
        );
        if (htTauxNonZero > 0) {
          for (const t of tauxNonZero) {
            const htActuel = htParTaux.get(t) ?? 0;
            const partHT = htActuel / htTauxNonZero;
            const ajustementHT = (ecartTotal * partHT) / (1 + t / 100);
            htParTaux.set(
              t,
              Math.round((htActuel + ajustementHT) * 100) / 100,
            );
          }
        }
      }
    }
  }

  // ── Étape 3 — Ligne charge agrégée ───────────────────────────────────
  const totalHtFinal =
    Math.round(
      Array.from(htParTaux.values()).reduce((s, v) => s + v, 0) * 100,
    ) / 100;
  lignesCharge.push({
    account: relayCharge,
    label: libelleCharge,
    debit: totalHtFinal,
    credit: null,
    vat: null,
    quantity: null,
    analytic: null,
  });

  // ── Étape 4 — Calcul TVA par taux + agrégation par compte ─────────────
  const debitTvaParCompte = new Map<string, { relay: string; montant: number }>();
  const creditTvaParCompte = new Map<string, { relay: string; montant: number }>();

  for (const [tauxEffectif, totalHTtaux] of htParTaux) {
    if (tauxEffectif === 0) continue;
    const tvaResult = calculerLignesTVA({
      compteCharge,
      montantHT: totalHTtaux,
      tauxTva: tauxEffectif / 100,
      profil,
    });
    for (const d of tvaResult.debitsTva) {
      const agg = debitTvaParCompte.get(d.compte) ?? {
        relay: d.relay_id,
        montant: 0,
      };
      agg.montant = Math.round((agg.montant + d.montant) * 100) / 100;
      debitTvaParCompte.set(d.compte, agg);
    }
    for (const c of tvaResult.creditsTva) {
      const agg = creditTvaParCompte.get(c.compte) ?? {
        relay: c.relay_id,
        montant: 0,
      };
      agg.montant = Math.round((agg.montant + c.montant) * 100) / 100;
      creditTvaParCompte.set(c.compte, agg);
    }
  }

  const lignesTvaDebit: PurchaseFormInput["body"] = Array.from(
    debitTvaParCompte.entries(),
  ).map(([, { relay, montant }]) => ({
    account: relay,
    label: fournisseurNom,
    debit: montant,
    credit: null,
    vat: null,
    quantity: null,
    analytic: null,
  }));
  const lignesTvaCredit: PurchaseFormInput["body"] = Array.from(
    creditTvaParCompte.entries(),
  ).map(([, { relay, montant }]) => ({
    account: relay,
    label: fournisseurNom,
    debit: null,
    credit: montant,
    vat: null,
    quantity: null,
    analytic: null,
  }));

  return { lignesCharge, lignesTvaDebit, lignesTvaCredit };
}

/**
 * Helper interne : transforme un `tvaResult` en lignes body débit/crédit.
 */
function buildLignesTVAResult(
  tvaResult: ReturnType<typeof calculerLignesTVA>,
  lignesCharge: PurchaseFormInput["body"],
  fournisseurNom: string,
): {
  lignesCharge: PurchaseFormInput["body"];
  lignesTvaDebit: PurchaseFormInput["body"];
  lignesTvaCredit: PurchaseFormInput["body"];
} {
  const lignesTvaDebit: PurchaseFormInput["body"] = tvaResult.debitsTva.map(
    (d) => ({
      account: d.relay_id,
      label: fournisseurNom,
      debit: d.montant,
      credit: null,
      vat: null,
      quantity: null,
      analytic: null,
    }),
  );
  const lignesTvaCredit: PurchaseFormInput["body"] = tvaResult.creditsTva.map(
    (c) => ({
      account: c.relay_id,
      label: fournisseurNom,
      debit: null,
      credit: c.montant,
      vat: null,
      quantity: null,
      analytic: null,
    }),
  );
  return { lignesCharge, lignesTvaDebit, lignesTvaCredit };
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

  const fournisseurNom =
    facture.provider?.name ?? decision.fournisseur_fulll ?? "";
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

  const providerRelay = facture.provider?.id ?? "";
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
      reference: extraction.numero_piece || "",
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
  };
}

// ── Exports internes pour tests ──────────────────────────────────────

export const __internals = {
  appliquerForceCentime,
  calculerLignesTvaAgregees,
  appliquerAvoir,
  construirePayloadAcompteV2,
};
