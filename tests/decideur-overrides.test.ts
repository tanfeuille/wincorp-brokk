/**
 * Tests override déterministe parking FR — bug INDIGO 11/05/2026.
 * Cible : src/decideur-overrides.ts
 */

import { describe, it, expect } from "vitest";
import { appliquerOverrideParkingFR } from "../src/decideur-overrides.js";
import type { ExtractionVision, DecisionDecideur } from "../src/types.js";

const extractionParking = (
  overrides: Partial<ExtractionVision> = {},
): ExtractionVision => ({
  emetteur: { nom: "INDIGO PARKING GARE DE LYON" },
  numero_piece: "301939",
  date: "18/04/2026",
  montant_ttc_total: 13.15,
  lignes_tva: [{ taux: 20, base_ht: 10.96, montant_tva: 2.19 }],
  lignes: [{ libelle: "Stationnement 2h", montant_ttc: 13.15 }],
  indices_context: {},
  confiance_extraction: 80,
  meta: {
    modele_utilise: "haiku",
    inversion_date_appliquee: false,
    tokens_input: 0,
    tokens_output: 0,
  },
  ...overrides,
});

const decisionLLM = (
  overrides: Partial<DecisionDecideur> = {},
): DecisionDecideur => ({
  compte_charge: "60630000",
  regime_tva: "FR",
  fournisseur_fulll: "FDIVERS",
  libelle_ecriture: "INDIGO parking",
  raisonnement: "Décision LLM Haiku",
  confiance: 62,
  alertes: [],
  ...overrides,
});

describe("appliquerOverrideParkingFR", () => {
  describe("happy path — émetteur explicite", () => {
    it("override INDIGO PARKING GARE DE LYON → 62510000 (cas bug session #9)", () => {
      const result = appliquerOverrideParkingFR(extractionParking(), decisionLLM());

      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
      expect(result.decision.fournisseur_fulll).toBe("FPEAGE");
      expect(result.decision.alertes).toContain("COMPTE_FORCE_PARKING_62510000");
      expect(result.decision.raisonnement).toMatch(/\[Override parking FR : 60630000 → 62510000\]/);
      expect(result.raisonOverride).toMatch(/INDIGO/);
    });

    it("override EFFIA → 62510000", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "EFFIA STATIONNEMENT" } }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });

    it("override Q-PARK → 62510000", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "Q-PARK Gare du Nord" } }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });

    it("override SAEMES → 62510000", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "SAEMES Champs Elysées" } }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });

    it("override VINCI PARK → 62510000 (pas Vinci Autoroutes)", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "VINCI PARK SAS" } }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });

    it("override APCOA / ONEPARK / YESPARK", () => {
      for (const emetteur of ["APCOA Parking", "ONEPARK", "YESPARK app"]) {
        const result = appliquerOverrideParkingFR(
          extractionParking({ emetteur: { nom: emetteur } }),
          decisionLLM(),
        );
        expect(result.applique, `${emetteur} non override`).toBe(true);
        expect(result.decision.compte_charge).toBe("62510000");
      }
    });
  });

  describe("happy path — libellé sans émetteur explicite", () => {
    it("override libellé 'Stationnement' avec émetteur générique", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "Mairie de Paris" },
          lignes: [{ libelle: "Stationnement zone résidentielle" }],
        }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
      expect(result.raisonOverride).toMatch(/Libellé/);
    });

    it("override libellé 'Horodateur'", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "Ville de Lyon" },
          lignes: [{ libelle: "Horodateur secteur Bellecour" }],
        }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });

    it("filet libellé 'péage' (redondant prompt LLM Sprint P0)", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "SOCIETE PROVENCALE AUTOROUTES" },
          lignes: [{ libelle: "Péage A8 Nice-Aix" }],
        }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });
  });

  describe("no-op", () => {
    it("compte déjà 62510000 → no-op silencieux", () => {
      const dec = decisionLLM({ compte_charge: "62510000" });
      const result = appliquerOverrideParkingFR(extractionParking(), dec);
      expect(result.applique).toBe(false);
      expect(result.decision).toBe(dec); // référence identique = pas de copie
    });

    it("régime intracom → no-op (cas rare, revue humaine)", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "Q-PARK Köln Hauptbahnhof" } }),
        decisionLLM({ regime_tva: "intracom" }),
      );
      expect(result.applique).toBe(false);
    });

    it("régime franchise → no-op", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking(),
        decisionLLM({ regime_tva: "franchise" }),
      );
      expect(result.applique).toBe(false);
    });

    it("pas de match émetteur ni libellé → no-op", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "AMAZON FR" },
          lignes: [{ libelle: "Câble USB-C" }],
        }),
        decisionLLM({ compte_charge: "60630000" }),
      );
      expect(result.applique).toBe(false);
      expect(result.decision.compte_charge).toBe("60630000");
    });
  });

  describe("exclusion garage / réparation auto", () => {
    it("garage avec libellé 'parking véhicule en réparation' → no-op (exclusion)", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "GARAGE DUPONT MECANIQUE" },
          lignes: [{ libelle: "Parking véhicule pendant révision" }],
        }),
        decisionLLM({ compte_charge: "615500" }),
      );
      expect(result.applique).toBe(false);
    });

    it("garage carrosserie avec mention parking → no-op", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "CARROSSERIE LYON SUD" },
          lignes: [{ libelle: "Stationnement véhicule + vidange" }],
        }),
        decisionLLM({ compte_charge: "615500" }),
      );
      expect(result.applique).toBe(false);
    });

    it("INDIGO PARKING avec libellé contenant 'pneu' (faux positif) → override quand même (émetteur prime)", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({
          emetteur: { nom: "INDIGO PARKING GARE DU NORD" },
          lignes: [{ libelle: "Stationnement nuit (pneu sport autorisé)" }],
        }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });
  });

  describe("préservation curation LLM", () => {
    it("fournisseur spécifique LLM (FINDIGOPARK) préservé, seul compte changé", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking(),
        decisionLLM({ fournisseur_fulll: "FINDIGOPARK" }),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
      expect(result.decision.fournisseur_fulll).toBe("FINDIGOPARK"); // pas remplacé
    });

    it("fournisseur générique FDIVERS → remplacé par FPEAGE", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking(),
        decisionLLM({ fournisseur_fulll: "FDIVERS" }),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.fournisseur_fulll).toBe("FPEAGE");
    });

    it("fournisseur vide → remplacé par FPEAGE", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking(),
        decisionLLM({ fournisseur_fulll: "" }),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.fournisseur_fulll).toBe("FPEAGE");
    });
  });

  describe("traçabilité audit DGFIP", () => {
    it("alerte idempotente — pas de doublon si déjà présente", () => {
      const dec = decisionLLM({
        alertes: ["COMPTE_FORCE_PARKING_62510000"],
      });
      const result = appliquerOverrideParkingFR(extractionParking(), dec);
      expect(result.applique).toBe(true);
      expect(
        result.decision.alertes.filter((a) => a === "COMPTE_FORCE_PARKING_62510000"),
      ).toHaveLength(1);
    });

    it("provider_original préservé (chantier garde-fou ELAG'RIMP)", () => {
      const dec = decisionLLM({ provider_original: "FINDIGOPARK_V2" });
      const result = appliquerOverrideParkingFR(extractionParking(), dec);
      expect(result.applique).toBe(true);
      expect(result.decision.provider_original).toBe("FINDIGOPARK_V2");
    });

    it("raisonnement préfixé pour audit DGFIP", () => {
      const result = appliquerOverrideParkingFR(extractionParking(), decisionLLM());
      expect(result.decision.raisonnement).toMatch(
        /^\[Override parking FR : 60630000 → 62510000\] Décision LLM Haiku$/,
      );
    });

    it("immuabilité — extraction et decision originales pas mutées", () => {
      const extOrig = extractionParking();
      const decOrig = decisionLLM();
      const extSnapshot = JSON.stringify(extOrig);
      const decSnapshot = JSON.stringify(decOrig);

      appliquerOverrideParkingFR(extOrig, decOrig);

      expect(JSON.stringify(extOrig)).toBe(extSnapshot);
      expect(JSON.stringify(decOrig)).toBe(decSnapshot);
    });
  });

  describe("variantes branding", () => {
    it("PARKINDIGO (variante branding INDIGO) → override", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "PARKINDIGO Lyon Part-Dieu" } }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
      expect(result.decision.compte_charge).toBe("62510000");
    });

    it("INTERPARKING (opérateur belge présent en France) → override", () => {
      const result = appliquerOverrideParkingFR(
        extractionParking({ emetteur: { nom: "INTERPARKING France SAS" } }),
        decisionLLM(),
      );
      expect(result.applique).toBe(true);
    });
  });
});
