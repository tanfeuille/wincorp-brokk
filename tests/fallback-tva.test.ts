/**
 * Tests fallback TVA déterministe carburant (ERR-BUILD-02 recovery).
 * Cible : src/fallback-tva.ts
 */

import { describe, it, expect } from "vitest";
import {
  appliquerFallbackTvaCarburant,
  COMPTES_FALLBACK_TVA_20,
} from "../src/fallback-tva.js";
import type { ExtractionVision, DecisionDecideur } from "../src/types.js";

const extractionNominale = (
  overrides: Partial<ExtractionVision> = {},
): ExtractionVision => ({
  emetteur: { nom: "TotalEnergies" },
  numero_piece: "2025-001",
  date: "21/04/2026",
  montant_ttc_total: 85,
  lignes_tva: [],
  lignes: [
    {
      libelle: "SP95 E10 42.37L",
      quantite: 42.37,
      montant_ht: 70.83,
      taux_tva: 20,
      montant_ttc: 85,
    },
  ],
  indices_context: {
    carburant: { type: "essence", litres: 42.37 },
  },
  confiance_extraction: 95,
  meta: {
    modele_utilise: "sonnet",
    inversion_date_appliquee: false,
    tokens_input: 0,
    tokens_output: 0,
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

describe("appliquerFallbackTvaCarburant", () => {
  describe("happy path", () => {
    it("applique le fallback sur carburant 60617000 FR avec lignes_tva vide", () => {
      const extraction = extractionNominale({ montant_ttc_total: 85 });
      const decision = decisionNominale();

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      expect(result.extraction.lignes_tva).toHaveLength(1);
      expect(result.extraction.lignes_tva[0]).toEqual({
        taux: 20,
        base_ht: 70.83,
        montant_tva: 14.17,
      });
    });

    it("calcule correctement sur TTC 26.00 (Super U carburant)", () => {
      const extraction = extractionNominale({ montant_ttc_total: 26 });
      const decision = decisionNominale();

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      // 26 × 20/120 = 4.3333... → round2 = 4.33
      expect(result.extraction.lignes_tva[0]?.montant_tva).toBe(4.33);
      expect(result.extraction.lignes_tva[0]?.base_ht).toBe(21.67);
    });

    it("invariant arithmétique ht + tva === ttc sur une plage de valeurs", () => {
      const ttcValues = [0.5, 1.0, 5.99, 10.0, 85.0, 99.99, 123.45, 500.0];
      for (const ttc of ttcValues) {
        const result = appliquerFallbackTvaCarburant(
          extractionNominale({ montant_ttc_total: ttc }),
          decisionNominale(),
        );
        expect(result.applique, `TTC=${ttc}`).toBe(true);
        const [ligne] = result.extraction.lignes_tva;
        expect(ligne).toBeDefined();
        const sum = Math.round((ligne!.base_ht + ligne!.montant_tva) * 100) / 100;
        expect(sum, `TTC=${ttc}`).toBe(ttc);
      }
    });

    it("n'applique rien quand fallbackActive=false (toggle dossier OFF)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: 85 }),
        decisionNominale(),
        false,
      );
      expect(result.applique).toBe(false);
      expect(result.extraction.lignes_tva).toEqual([]);
    });
  });

  describe("gates bloquantes", () => {
    it("n'applique pas sur régime intracom", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ regime_tva: "intracom" }),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas sur régime extracom", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ regime_tva: "extracom" }),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas sur régime franchise", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ regime_tva: "franchise" }),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas sur compte non éligible (60640000 fournitures)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ compte_charge: "60640000" }),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas si lignes_tva déjà peuplées (préserve Vision)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({
          montant_ttc_total: 85,
          lignes_tva: [{ taux: 20, base_ht: 70.83, montant_tva: 14.17 }],
        }),
        decisionNominale(),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas si TTC < 0.01", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: 0 }),
        decisionNominale(),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas si la TVA calculée serait < 0.01 (évite ligne 0)", () => {
      // TTC 0.01 → TVA = 0.00 → pas de ligne (éviterait échec Fulll)
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: 0.01 }),
        decisionNominale(),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas si alerte VAT_ETRANGER_REGIME_FR_SUSPECT présente", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ alertes: ["VAT_ETRANGER_REGIME_FR_SUSPECT"] }),
      );
      expect(result.applique).toBe(false);
    });

    it("n'applique pas si alerte COMPTE_HORS_PROFIL présente", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ alertes: ["COMPTE_HORS_PROFIL"] }),
      );
      expect(result.applique).toBe(false);
    });
  });

  describe("multi-lignes hétérogènes", () => {
    it("n'applique pas si une ligne matche 'café'", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 92,
        lignes: [
          { libelle: "Gasoil 60L", montant_ttc: 85 },
          { libelle: "Café expresso", montant_ttc: 3 },
          { libelle: "Lavage auto", montant_ttc: 4 },
        ],
      });
      const result = appliquerFallbackTvaCarburant(extraction, decisionNominale());
      expect(result.applique).toBe(false);
    });

    it("n'applique pas si une ligne matche 'boutique'", () => {
      const extraction = extractionNominale({
        lignes: [
          { libelle: "SP95", montant_ttc: 50 },
          { libelle: "Boutique - snack", montant_ttc: 5 },
        ],
      });
      const result = appliquerFallbackTvaCarburant(extraction, decisionNominale());
      expect(result.applique).toBe(false);
    });

    it("applique si une seule ligne même avec libellé non-carburant", () => {
      // Ticket mono-ligne (ex. "Paiement carburant" générique) → OK fallback
      const extraction = extractionNominale({
        lignes: [{ libelle: "Paiement en station", montant_ttc: 50 }],
      });
      const result = appliquerFallbackTvaCarburant(extraction, decisionNominale());
      expect(result.applique).toBe(true);
    });
  });

  describe("exports", () => {
    it("COMPTES_FALLBACK_TVA_20 contient 60617000 uniquement (V1)", () => {
      expect(COMPTES_FALLBACK_TVA_20.has("60617000")).toBe(true);
      expect(COMPTES_FALLBACK_TVA_20.size).toBe(1);
    });
  });
});
