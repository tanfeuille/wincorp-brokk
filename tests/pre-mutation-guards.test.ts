/**
 * Tests garde-fous pré-mutation Fulll + synthèse de référence.
 * Cible : src/pre-mutation-guards.ts (Session 3 ERR-BUILD-02 recovery)
 */

import { describe, it, expect } from "vitest";
import {
  verifierGardeFousPreMutation,
  synthetiserReference,
  resoudreReference,
} from "../src/pre-mutation-guards.js";
import type {
  DecisionDecideur,
  ExtractionVision,
  FactureSuivante,
} from "../src/types.js";

const factureNominale = (
  overrides: Partial<FactureSuivante> = {},
): FactureSuivante => ({
  totalCount: 1,
  documentId: "doc-123",
  documentURL: "https://fulll.example/doc",
  bookRelayId: "Qm9vazoyMTcxMDI2",
  provider: {
    id: "UHJvdmlkZXI6NTAw",
    name: "TotalEnergies",
    accountNumber: "FTOTAL",
  },
  form: {
    date: null,
    reference: null,
    header: { label: null, credit: null, debit: null },
    body: [],
    accountDetails: {
      companyRegistration: null,
      intraVAT: null,
      phone: null,
      fax: null,
    },
    period: null,
  },
  ...overrides,
});

const decisionNominale = (
  overrides: Partial<DecisionDecideur> = {},
): DecisionDecideur => ({
  compte_charge: "60617000",
  regime_tva: "FR",
  fournisseur_fulll: "FTOTAL",
  libelle_ecriture: "Carburant",
  raisonnement: "test",
  confiance: 95,
  alertes: [],
  ...overrides,
});

const extractionNominale = (
  overrides: Partial<ExtractionVision> = {},
): ExtractionVision => ({
  emetteur: { nom: "TotalEnergies" },
  numero_piece: "F-2025-001",
  date: "21/04/2026",
  montant_ttc_total: 85,
  lignes_tva: [{ taux: 20, base_ht: 70.83, montant_tva: 14.17 }],
  lignes: [],
  indices_context: {},
  confiance_extraction: 95,
  meta: {
    modele_utilise: "sonnet",
    inversion_date_appliquee: false,
    tokens_input: 0,
    tokens_output: 0,
  },
  ...overrides,
});

describe("verifierGardeFousPreMutation", () => {
  it("accepte un payload nominal avec provider + label valides", () => {
    const result = verifierGardeFousPreMutation(
      factureNominale(),
      decisionNominale(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.providerRelay).toBe("UHJvdmlkZXI6NTAw");
      expect(result.data.fournisseurNom).toBe("TotalEnergies");
    }
  });

  it("refuse si provider.id vide (chaîne vide)", () => {
    const result = verifierGardeFousPreMutation(
      factureNominale({
        provider: { id: "", name: "TotalEnergies", accountNumber: "FTOTAL" },
      }),
      decisionNominale(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.raison).toContain("ERR-BUILD-05");
      expect(result.raison).toContain("Provider Fulll introuvable");
    }
  });

  it("refuse si provider.id est uniquement des espaces", () => {
    const result = verifierGardeFousPreMutation(
      factureNominale({
        provider: { id: "   ", name: "TotalEnergies", accountNumber: "FTOTAL" },
      }),
      decisionNominale(),
    );
    expect(result.ok).toBe(false);
  });

  it("fallback sur decision.fournisseur_fulll si provider.name vide", () => {
    const result = verifierGardeFousPreMutation(
      factureNominale({
        provider: { id: "UHJvdmlkZXI6NTAw", name: "", accountNumber: "FTOTAL" },
      }),
      decisionNominale({ fournisseur_fulll: "FTOTAL" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fournisseurNom).toBe("FTOTAL");
  });

  it("refuse si provider.name ET decision.fournisseur_fulll vides", () => {
    const result = verifierGardeFousPreMutation(
      factureNominale({
        provider: { id: "UHJvdmlkZXI6NTAw", name: "", accountNumber: "" },
      }),
      decisionNominale({ fournisseur_fulll: "" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raison).toContain("Libellé fournisseur manquant");
  });

  it("trim les espaces silencieux dans les labels", () => {
    const result = verifierGardeFousPreMutation(
      factureNominale({
        provider: { id: "UHJvdmlkZXI6NTAw", name: "   ", accountNumber: "FTOTAL" },
      }),
      decisionNominale({ fournisseur_fulll: "   " }),
    );
    expect(result.ok).toBe(false); // "   " trim → "" → bloqué
  });
});

describe("synthetiserReference", () => {
  it("format AUTO-YYMMDD-TTC-hash4 sur entrée nominale", () => {
    const ref = synthetiserReference("21/04/2026", 85, "doc-123");
    expect(ref).toMatch(/^AUTO-260421-8500-[0-9a-f]{4}$/);
  });

  it("hash déterministe pour même documentId", () => {
    const ref1 = synthetiserReference("21/04/2026", 85, "doc-123");
    const ref2 = synthetiserReference("21/04/2026", 85, "doc-123");
    expect(ref1).toBe(ref2);
  });

  it("hash différent pour documentId différents (unicité collision date+TTC)", () => {
    const ref1 = synthetiserReference("21/04/2026", 85, "doc-A");
    const ref2 = synthetiserReference("21/04/2026", 85, "doc-B");
    expect(ref1).not.toBe(ref2);
  });

  it("TTC en centimes (85.00 → 8500, 26.00 → 2600)", () => {
    const ref85 = synthetiserReference("21/04/2026", 85, "doc");
    const ref26 = synthetiserReference("21/04/2026", 26, "doc");
    expect(ref85).toContain("-8500-");
    expect(ref26).toContain("-2600-");
  });

  it("absolute value sur TTC négatif (avoirs)", () => {
    const ref = synthetiserReference("21/04/2026", -85, "doc");
    expect(ref).toContain("-8500-");
  });

  it("fallback YYMMDD=000000 si date invalide", () => {
    const ref = synthetiserReference("date-invalide", 85, "doc");
    expect(ref).toMatch(/^AUTO-000000-8500-/);
  });
});

describe("resoudreReference", () => {
  it("retourne numero_piece Vision si présent (pas de synthèse)", () => {
    const result = resoudreReference(
      extractionNominale({ numero_piece: "F-2025-001" }),
      factureNominale(),
      85,
    );
    expect(result.reference).toBe("F-2025-001");
    expect(result.synthetisee).toBe(false);
  });

  it("synthétise si numero_piece vide", () => {
    const result = resoudreReference(
      extractionNominale({ numero_piece: "" }),
      factureNominale({ documentId: "doc-xyz" }),
      85,
    );
    expect(result.synthetisee).toBe(true);
    expect(result.reference).toMatch(/^AUTO-260421-8500-/);
  });

  it("synthétise si numero_piece uniquement espaces", () => {
    const result = resoudreReference(
      extractionNominale({ numero_piece: "   " }),
      factureNominale(),
      85,
    );
    expect(result.synthetisee).toBe(true);
  });
});
