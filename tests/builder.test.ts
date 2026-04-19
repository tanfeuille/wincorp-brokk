/**
 * Tests Vitest pour le builder brokk — R27-R35 + EC22-EC30.
 *
 * Couvre :
 * - Court-circuit non-facture (skipped_reason, RELEVE_BANCAIRE_DETECTE, CONFIANCE_INSUFFISANTE)
 * - Routing acompte (via decision, mention_acompte, ligne Fulll body)
 * - Force 0 € → 0,01 €
 * - Calcul TVA par régime (FR / intracom / extracom / franchise)
 * - Routing avoir (permutation D/C)
 * - Équilibre payload (ajustement centime, douteux >0.01)
 * - Remontée comptes PCG
 * - Avoir + acompte combiné
 */

import { describe, it, expect } from "vitest";
import type {
  ProfilDossier,
  FactureSuivante,
  ExtractionVision,
  DecisionDecideur,
} from "../src/types.js";
import {
  construirePayloadV2,
  equilibrerPayload,
  remonterComptesPCG,
} from "../src/builder.js";

// ── Helpers de construction ───────────────────────────────────────────

function profilDidierQuentin(): ProfilDossier {
  return {
    identite: {
      raison_sociale: "TAXI DIDIER QUENTIN",
      siren: "948025986",
      forme_juridique: "SARL",
      dirigeant: "Didier Quentin",
      activite: "Taxi parisien",
      code_ape: "4932Z",
    },
    comptabilite: {
      regime_tva: "reel_normal",
      cloture: "31/12",
      logiciel: "Fulll",
      company_id: "450601",
      book_relay_id: "Qm9vazoyMTcxMDI2",
    },
    comptes_frequents: { charges: [], produits: [] },
    regles: [],
    parametres: { seuil_confiance_image: 85 },
    comptes_relay_ids: {
      "60617000": "R_60617000",
      "60702000": "R_60702000",
      "60703000": "R_60703000",
      "60740000": "R_60740000",
      "40910000": "R_40910000",
      "44566000": "R_44566000",
      "44566200": "R_44566200",
      "44520000": "R_44520000",
      "44566300": "R_44566300",
      "44571300": "R_44571300",
    },
  };
}

function profilTrimat(): ProfilDossier {
  const p = profilDidierQuentin();
  p.identite.raison_sociale = "TRIMAT";
  p.identite.siren = "928777341";
  p.comptabilite.regime_tva = "franchise_en_base";
  return p;
}

function extractionNominale(
  overrides: Partial<ExtractionVision> = {},
): ExtractionVision {
  return {
    emetteur: { nom: "TotalEnergies", siren: "542051180", pays: "FR" },
    numero_piece: "SP95E10",
    date: "16/01/2026",
    montant_ht_total: 63.4,
    montant_ttc_total: 76.08,
    lignes_tva: [{ taux: 20, base_ht: 63.4, montant_tva: 12.68 }],
    lignes: [
      {
        libelle: "SP95E10 32.37 L",
        quantite: 32.37,
        montant_ht: 63.4,
        taux_tva: 20,
        montant_ttc: 76.08,
      },
    ],
    indices_context: {
      type_transaction: "b2b",
      carburant: { type: "essence", litres: 32.37 },
    },
    confiance_extraction: 95,
    meta: {
      modele_utilise: "haiku",
      inversion_date_appliquee: false,
      tokens_input: 2500,
      tokens_output: 450,
    },
    ...overrides,
  };
}

function decisionNominale(
  overrides: Partial<DecisionDecideur> = {},
): DecisionDecideur {
  return {
    compte_charge: "60617000",
    regime_tva: "FR",
    fournisseur_fulll: "FCARBUR",
    libelle_ecriture: "TotalEnergies carburant",
    raisonnement: "Carburant station-service → 60617000 FR",
    confiance: 95,
    alertes: [],
    ...overrides,
  };
}

function factureMinimale(
  overrides: Partial<FactureSuivante> = {},
): FactureSuivante {
  return {
    totalCount: 1,
    documentId: "DOC123",
    documentURL: "https://example.com/doc.pdf",
    bookRelayId: "Qm9vazoyMTcxMDI2",
    provider: {
      id: "R_PROVIDER",
      name: "Fournisseur Test",
      accountNumber: "FTEST",
    },
    form: {
      date: null,
      reference: null,
      header: { label: null, credit: null, debit: null },
      period: { start: "2026-01-01", end: "2026-12-31" },
      body: [],
      accountDetails: {
        companyRegistration: null,
        intraVAT: null,
        phone: null,
        fax: null,
      },
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("construirePayloadV2 — cas nominaux FR", () => {
  it("carburant TotalEnergies : payload FR équilibré 76.08 €", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale(),
      decision: decisionNominale(),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });

    expect(resultat.decision).toBe("comptabiliser");
    expect(resultat.payload).toBeDefined();
    expect(resultat.payload!.header.credit).toBe(76.08);
    expect(resultat.payload!.header.debit).toBeNull();
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_60617000" && l.debit === 63.4,
      ),
    ).toBe(true);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_44566000" && l.debit === 12.68,
      ),
    ).toBe(true);
  });

  it("Phase 4.6 recover : SFR avec lignes_tva Vision priorisées sur lignes (TTC mal lus)", () => {
    // Cas RÉEL SFR Mobile (smoke SOAD 19/04 PM, validé avec PDF user) :
    // Détail facture liste les TTC : Forfait 45.98 / Remise -5 / Remise -8 = 32.98 (TTC global).
    // Vision met ces TTC dans `lignes[].montant_ht` (interprétation libre du LLM).
    // MAIS Vision lit aussi le bandeau TVA explicite : HT 27.48, TVA 20% 5.50, TTC 32.98.
    //
    // Avant Phase 4.5 : filter(montant_ht > 0) excluait les remises → 45.98 seul → +22€ delta.
    // Après Phase 4.5 (filter !== 0) : agrégation 45.98 - 5 - 8 = 32.98 (faux HT) → +6.60€ delta.
    // Après Phase 4.6 (lignes_tva prime) : base_ht=27.48 utilisé → TVA=5.50 → 32.98 = TTC ✓
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "SFR", pays: "FR", vat: "FR71343059564" },
        numero_piece: "B226-003564061",
        montant_ht_total: 27.48,
        montant_ttc_total: 32.98,
        // Source primaire fiable : bandeau TVA explicite de la facture
        lignes_tva: [{ taux: 20, base_ht: 27.48, montant_tva: 5.50 }],
        // Lignes individuelles : Vision a mis les TTC dans montant_ht (bug LLM)
        // Le builder doit IGNORER ces valeurs et privilégier lignes_tva
        lignes: [
          { libelle: "Forfait 150 Go 5G", montant_ht: 45.98, taux_tva: 20, montant_ttc: 45.98 },
          { libelle: "Offre fidélité", montant_ht: -5.00, taux_tva: 20, montant_ttc: -5.00 },
          { libelle: "Remise Multi", montant_ht: -8.00, taux_tva: 20, montant_ttc: -8.00 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "62620000",
        libelle_ecriture: "SFR Forfait 150 Go 5G",
        fournisseur_fulll: "FSFR",
      }),
      profil: {
        ...profilDidierQuentin(),
        comptes_relay_ids: {
          ...profilDidierQuentin().comptes_relay_ids!,
          "62620000": "R_62620000",
        },
      },
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    expect(resultat.payload).toBeDefined();
    expect(resultat.payload!.header.credit).toBe(32.98);
    // Ligne charge : HT vrai depuis lignes_tva = 27.48 (pas 32.98 ni 45.98)
    const ligneCharge = resultat.payload!.body.find(
      (l) => l.account === "R_62620000",
    );
    expect(ligneCharge).toBeDefined();
    expect(ligneCharge!.debit).toBe(27.48);
    // TVA déductible : 27.48 × 20% = 5.50 € (pile montant_tva du bandeau)
    const ligneTva = resultat.payload!.body.find(
      (l) => l.account === "R_44566000",
    );
    expect(ligneTva).toBeDefined();
    expect(ligneTva!.debit).toBe(5.50);
    // Equilibre : sum(débit) = header.credit = TTC
    const sumDebit = resultat.payload!.body.reduce(
      (s, l) => s + (l.debit ?? 0),
      0,
    );
    expect(Math.round(sumDebit * 100) / 100).toBe(32.98);
  });

  it("Phase 4.7 : lignes_tva vide en FR → douteux ERR-EXTRACTION-INCOMPLETE", () => {
    // Phase 4.7 supprime le fallback fragile sur lignes individuelles. Si
    // Vision n'a pas extrait le bandeau TVA, on rejette la facture proprement
    // pour intervention humaine (corrigible dans bifrost session correction).
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "Marchand X", pays: "FR" },
        numero_piece: "F-001",
        montant_ht_total: 100,
        montant_ttc_total: 120,
        lignes_tva: [], // vide, pas exploitable
        lignes: [
          { libelle: "Produit principal", montant_ht: 110, taux_tva: 20, montant_ttc: 132 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "60740000",
        libelle_ecriture: "Marchand X",
        fournisseur_fulll: "FDIVERS",
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.raison).toMatch(/ERR-EXTRACTION-INCOMPLETE/);
  });

  it("péage VINCI 19 € : payload FR équilibré", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "VINCI AUTOROUTES", pays: "FR" },
        numero_piece: "20260109",
        montant_ht_total: 15.83,
        montant_ttc_total: 19,
        lignes_tva: [{ taux: 20, base_ht: 15.83, montant_tva: 3.17 }],
        lignes: [
          { libelle: "Péage ST ARNOULT", montant_ht: 15.83, taux_tva: 20, montant_ttc: 19 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "62510000",
        libelle_ecriture: "Péage VINCI",
        fournisseur_fulll: "FPEAGE",
      }),
      profil: {
        ...profilDidierQuentin(),
        comptes_relay_ids: {
          ...profilDidierQuentin().comptes_relay_ids!,
          "62510000": "R_62510000",
        },
      },
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    expect(resultat.payload!.header.credit).toBe(19);
  });
});

describe("construirePayloadV2 — régimes TVA", () => {
  it("intracom : autoliquidation 44566200/44520000", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "SoloMidocean", vat: "NL123456789", pays: "NL" },
        numero_piece: "SM-001",
        montant_ht_total: 100,
        montant_ttc_total: 100,
        lignes_tva: [{ taux: 20, base_ht: 100, montant_tva: 20 }],
        lignes: [
          { libelle: "Marchandise", montant_ht: 100, taux_tva: 20, montant_ttc: 100 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "60702000",
        regime_tva: "intracom",
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    const body = resultat.payload!.body;
    expect(body.some((l) => l.account === "R_60702000" && l.debit === 100)).toBe(
      true,
    );
    expect(body.some((l) => l.account === "R_44566200" && l.debit === 20)).toBe(
      true,
    );
    expect(body.some((l) => l.account === "R_44520000" && l.credit === 20)).toBe(
      true,
    );
  });

  it("extracom : autoliquidation 44566300/44571300", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "RJP International UK", pays: "GB" },
        numero_piece: "RJP-42",
        montant_ht_total: 200,
        montant_ttc_total: 200,
        lignes_tva: [{ taux: 20, base_ht: 200, montant_tva: 40 }],
        lignes: [
          { libelle: "Extracom", montant_ht: 200, taux_tva: 20, montant_ttc: 200 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "60703000",
        regime_tva: "extracom",
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    const body = resultat.payload!.body;
    expect(body.some((l) => l.account === "R_44566300" && l.debit === 40)).toBe(
      true,
    );
    expect(body.some((l) => l.account === "R_44571300" && l.credit === 40)).toBe(
      true,
    );
  });

  it("franchise TVA (TRIMAT) : pas de ligne TVA, débit charge = TTC", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        montant_ht_total: 50,
        montant_ttc_total: 50,
        lignes_tva: [],
        lignes: [
          { libelle: "Service", montant_ht: 50, taux_tva: 0, montant_ttc: 50 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "60740000",
        regime_tva: "franchise",
      }),
      profil: profilTrimat(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    const body = resultat.payload!.body;
    expect(body.some((l) => l.account === "R_60740000" && l.debit === 50)).toBe(
      true,
    );
    expect(
      body.every(
        (l) => !["R_44566000", "R_44566200", "R_44566300"].includes(l.account),
      ),
    ).toBe(true);
  });
});

describe("construirePayloadV2 — court-circuits", () => {
  it("relevé bancaire via skipped_reason → douteux", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        meta: {
          modele_utilise: "skipped",
          inversion_date_appliquee: false,
          tokens_input: 0,
          tokens_output: 0,
          skipped_reason: "releve_bancaire",
        },
      }),
      decision: decisionNominale(),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.raison).toContain("releve_bancaire");
  });

  it("RELEVE_BANCAIRE_DETECTE dans alertes décideur → douteux", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale(),
      decision: decisionNominale({ alertes: ["RELEVE_BANCAIRE_DETECTE"] }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.raison).toContain("RELEVE_BANCAIRE");
  });

  it("CONFIANCE_INSUFFISANTE dans alertes → douteux direct", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale(),
      decision: decisionNominale({
        confiance: 70,
        alertes: ["CONFIANCE_INSUFFISANTE"],
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.confiance).toBe(70);
  });

  it("relay_id manquant pour compte charge → douteux", () => {
    const profil = profilDidierQuentin();
    delete profil.comptes_relay_ids!["60617000"];
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale(),
      decision: decisionNominale(),
      profil,
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.raison).toContain("Relay ID manquant");
    expect(resultat.raison).toContain("60617000");
  });

  it("avoir + acompte combiné → douteux (cas complexe)", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        indices_context: {
          type_transaction: "b2b",
          est_avoir: true,
          mention_acompte: true,
        },
      }),
      decision: decisionNominale(),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.raison).toContain("Avoir + acompte");
  });
});

describe("construirePayloadV2 — routing avoir (R31)", () => {
  it("avoir intracom : permutation débit/crédit sur header + body", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        montant_ht_total: 100,
        montant_ttc_total: 100,
        lignes_tva: [],
        lignes: [
          { libelle: "Avoir SoloMidocean", montant_ht: 100, taux_tva: 0, montant_ttc: 100 },
        ],
        indices_context: { type_transaction: "b2b", est_avoir: true },
      }),
      decision: decisionNominale({
        compte_charge: "60702000",
        regime_tva: "intracom",
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    expect(resultat.payload!.header.debit).toBe(100);
    expect(resultat.payload!.header.credit).toBe(0);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_60702000" && l.credit === 100,
      ),
    ).toBe(true);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_44566200" && l.credit === 20,
      ),
    ).toBe(true);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_44520000" && l.debit === 20,
      ),
    ).toBe(true);
  });
});

describe("construirePayloadV2 — force 0 € → 0,01 € (R29)", () => {
  it("facture 0 € produit 1 ligne 0,01 + header.credit = 0,01", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        montant_ht_total: 0,
        montant_ttc_total: 0,
        lignes_tva: [],
        lignes: [],
      }),
      decision: decisionNominale({ alertes: [] }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    expect(resultat.payload!.header.credit).toBe(0.01);
  });
});

describe("construirePayloadV2 — routing acompte (R28)", () => {
  it("ligne Fulll 40910000 → short-circuit construirePayloadAcompteV2", () => {
    const facture = factureMinimale({
      form: {
        date: null,
        reference: null,
        header: { label: null, credit: null, debit: null },
        period: null,
        body: [
          {
            accountId: "R_60740000",
            accountNumber: "60740000",
            accountName: null,
            debit: 820,
            credit: null,
            label: "Marchandise",
          },
          {
            accountId: "R_40910000",
            accountNumber: "40910000",
            accountName: null,
            debit: null,
            credit: 492,
            label: "Acompte",
          },
        ],
        accountDetails: {
          companyRegistration: null,
          intraVAT: null,
          phone: null,
          fax: null,
        },
      },
    });
    const resultat = construirePayloadV2({
      facture,
      extraction: extractionNominale({
        numero_piece: "F-STUDIO-0475",
        montant_ht_total: 820,
        montant_ttc_total: 984,
        lignes_tva: [{ taux: 20, base_ht: 820, montant_tva: 164 }],
        lignes: [
          { libelle: "Marchandise", montant_ht: 820, taux_tva: 20, montant_ttc: 984 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "60740000",
        libelle_ecriture: "Studio by Hindbag",
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    expect(resultat.payload!.header.credit).toBe(492);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_40910000" && l.credit === 492,
      ),
    ).toBe(true);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_60740000" && l.debit === 820,
      ),
    ).toBe(true);
    expect(
      resultat.payload!.body.some(
        (l) => l.account === "R_44566000" && l.debit === 164,
      ),
    ).toBe(true);
  });
});

describe("equilibrerPayload — R33", () => {
  it("ajuste le dernier débit charge si delta ≤ 0.01", () => {
    const simple: any = {
      book: "b",
      document: "d",
      date: "01/01/2026",
      provider: "P",
      header: { reference: "R", label: "L", debit: null, credit: 100 },
      body: [
        { account: "R_60617000", label: "c1", debit: 99.99, credit: null },
      ],
      footer: [],
    };
    const res = equilibrerPayload(simple);
    expect(res.ok).toBe(true);
    expect(simple.body[0].debit).toBe(100);
  });

  it("déclare non équilibré si delta > 0.01", () => {
    const payload: any = {
      book: "b",
      document: "d",
      date: "01/01/2026",
      provider: "P",
      header: { reference: "R", label: "L", debit: null, credit: 100 },
      body: [{ account: "R_X", label: "c1", debit: 50, credit: null }],
      footer: [],
    };
    const res = equilibrerPayload(payload);
    expect(res.ok).toBe(false);
    expect(Math.abs(res.delta)).toBeGreaterThan(0.01);
  });
});

describe("ERR-BUILD-03 — agrégation TVA + recalibrage HT", () => {
  it("mono-taux FR avec écocontribution : recale HT sur TTC (ex ALTADIF)", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "ALTADIF", pays: "FR" },
        numero_piece: "F180754",
        montant_ht_total: 733.4,
        montant_ttc_total: 884.96,
        lignes_tva: [{ taux: 20, base_ht: 733.4, montant_tva: 146.68 }],
        lignes: [
          { libelle: "Marchandise", montant_ht: 733.4, taux_tva: 20, montant_ttc: 880.08 },
        ],
      }),
      decision: decisionNominale({ compte_charge: "60740000" }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    // Phase 4.7 : ALTADIF — delta 4.88€ < 10% TTC → ajustement par soustraction
    // htFinal = TTC - sumTVAVision = 884.96 - 146.68 = 738.28 (exact, pas approx)
    // TVA Vision conservée = 146.68. Sum débit = 738.28 + 146.68 = 884.96 = TTC pile.
    expect(resultat.decision).toBe("comptabiliser");
    const ligneCharge = resultat.payload!.body.find(
      (l) => l.account === "R_60740000",
    );
    expect(ligneCharge).toBeDefined();
    expect(ligneCharge!.debit).toBe(738.28);
    expect(resultat.payload!.header.credit).toBe(884.96);
    const ligneTva = resultat.payload!.body.find(
      (l) => l.account === "R_44566000",
    );
    expect(ligneTva!.debit).toBe(146.68);
    const totalDebits = resultat.payload!.body.reduce(
      (s, l) => s + (l.debit ?? 0),
      0,
    );
    expect(totalDebits).toBe(884.96);
  });

  it("multi-taux ticket caisse (5.5 + 20) : agrégation par taux sans dérive arrondi", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "Intermarché", pays: "FR" },
        numero_piece: "TICKET-42",
        montant_ht_total: 42,
        montant_ttc_total: 48.66,
        lignes_tva: [
          { taux: 5.5, base_ht: 12, montant_tva: 0.66 },
          { taux: 20, base_ht: 30, montant_tva: 6 },
        ],
        lignes: [
          { libelle: "Alimentaire", montant_ht: 12, taux_tva: 5.5, montant_ttc: 12.66 },
          { libelle: "Autre", montant_ht: 30, taux_tva: 20, montant_ttc: 36 },
        ],
      }),
      decision: decisionNominale({ compte_charge: "60617000" }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    const ligneCharge = resultat.payload!.body.find(
      (l) => l.account === "R_60617000",
    );
    expect(ligneCharge!.debit).toBe(42);
    const ligneTva = resultat.payload!.body.find(
      (l) => l.account === "R_44566000",
    );
    expect(ligneTva!.debit).toBe(6.66);
  });

  it("mono-taux FR écart > 10% : douteux ERR-EXTRACTION-INCOHERENTE (Vision suspecte)", () => {
    // Phase 4.7 : delta 140€ entre TTC 200€ et reconstruit 60€ = 70% > 10%
    // → douteux avec message explicite (avant: ERR-BUILD-03 recalibrage refusé)
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "Aberration", pays: "FR" },
        numero_piece: "F-ABERR",
        montant_ht_total: 50,
        montant_ttc_total: 200,
        lignes_tva: [{ taux: 20, base_ht: 50, montant_tva: 10 }],
        lignes: [{ libelle: "X", montant_ht: 50, taux_tva: 20, montant_ttc: 60 }],
      }),
      decision: decisionNominale({ compte_charge: "60740000" }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("douteux");
    expect(resultat.raison).toMatch(/ERR-EXTRACTION-INCOHERENTE/);
  });

  it("intracom autoliq : pas de recalibrage HT (facture étrangère sans TVA)", () => {
    const resultat = construirePayloadV2({
      facture: factureMinimale(),
      extraction: extractionNominale({
        emetteur: { nom: "Stricker Portugal", vat: "PT123", pays: "PT" },
        numero_piece: "PT-2026-0078",
        montant_ht_total: 500,
        montant_ttc_total: 500,
        lignes_tva: [],
        lignes: [
          { libelle: "Marchandise intracom", montant_ht: 500, taux_tva: 0, montant_ttc: 500 },
        ],
      }),
      decision: decisionNominale({
        compte_charge: "60702000",
        regime_tva: "intracom",
      }),
      profil: profilDidierQuentin(),
      bookRelayId: "Qm9vazoyMTcxMDI2",
    });
    expect(resultat.decision).toBe("comptabiliser");
    const ligneCharge = resultat.payload!.body.find(
      (l) => l.account === "R_60702000",
    );
    expect(ligneCharge!.debit).toBe(500);
    const debitTva = resultat.payload!.body.find(
      (l) => l.account === "R_44566200",
    );
    expect(debitTva!.debit).toBe(100);
    const creditTva = resultat.payload!.body.find(
      (l) => l.account === "R_44520000",
    );
    expect(creditTva!.credit).toBe(100);
  });
});

describe("remonterComptesPCG — R34", () => {
  it("retourne les comptes 8 chiffres triés charges/TVA/tiers", () => {
    const facture = factureMinimale({
      form: {
        date: null,
        reference: null,
        header: { label: null, credit: null, debit: null },
        period: null,
        body: [
          {
            accountId: "R_P",
            accountNumber: "40110000",
            accountName: null,
            debit: null,
            credit: 76.08,
            label: "Fournisseur",
          },
        ],
        accountDetails: {
          companyRegistration: null,
          intraVAT: null,
          phone: null,
          fax: null,
        },
      },
    });
    const profil = profilDidierQuentin();
    const payload: any = {
      book: "b",
      document: "d",
      date: "01/01/2026",
      provider: "R_P",
      header: { reference: "", label: "", debit: null, credit: 76.08 },
      body: [
        { account: "R_60617000", label: "", debit: 63.4, credit: null },
        { account: "R_44566000", label: "", debit: 12.68, credit: null },
        { account: "R_P", label: "", debit: null, credit: 76.08 },
      ],
      footer: [],
    };
    const comptes = remonterComptesPCG(payload, facture, profil);
    expect(comptes[0]).toBe("60617000");
    expect(comptes.slice(1).sort()).toEqual(["40110000", "44566000"]);
  });
});
