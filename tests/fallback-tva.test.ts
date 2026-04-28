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

    it("n'applique pas sur compte non éligible (61560000 entretien)", () => {
      // Sprint A 28/04 : 60640000 a longtemps été le contre-exemple V1, mais
      // il n'est volontairement pas dans la liste V2 (TVA mécanique 20% pas
      // garantie sur fournitures bureau diverses — peut être 5.5% si livres).
      // Pour le test "compte non éligible" on prend un compte clairement hors
      // périmètre du fallback (entretien 61560000).
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ compte_charge: "61560000" }),
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

  describe("exports (Sprint A V2 — 5 comptes)", () => {
    it("COMPTES_FALLBACK_TVA_20 contient les 5 comptes V2 (Sprint A 28/04)", () => {
      expect(COMPTES_FALLBACK_TVA_20.has("60617000")).toBe(true); // carburant V1
      expect(COMPTES_FALLBACK_TVA_20.has("60630000")).toBe(true); // marchandises diverses
      expect(COMPTES_FALLBACK_TVA_20.has("62560000")).toBe(true); // voyages, déplacements
      expect(COMPTES_FALLBACK_TVA_20.has("62800000")).toBe(true); // divers gestion courante
      expect(COMPTES_FALLBACK_TVA_20.has("60631000")).toBe(true); // fournitures consommables
      expect(COMPTES_FALLBACK_TVA_20.size).toBe(5);
    });
  });

  describe("Sprint A — 4 nouveaux comptes V2 (28/04/2026)", () => {
    it("applique sur 60630000 (marchandises diverses) en FR avec lignes_tva vide", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 47.5,
        lignes: [{ libelle: "Marchandises diverses", montant_ttc: 47.5 }],
      });
      const decision = decisionNominale({ compte_charge: "60630000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("60630000");
      // 47.50 × 20/120 = 7.9166... → round2 = 7.92, ht = 39.58
      expect(result.extraction.lignes_tva[0]).toEqual({
        taux: 20,
        base_ht: 39.58,
        montant_tva: 7.92,
      });
    });

    it("applique sur 62560000 (voyages, taxis, péages) — cas Spiritus Taxi", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 12,
        lignes: [{ libelle: "Péage A6 Paris-Lyon", montant_ttc: 12 }],
      });
      const decision = decisionNominale({ compte_charge: "62560000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("62560000");
      expect(result.extraction.lignes_tva[0]?.montant_tva).toBe(2);
      expect(result.extraction.lignes_tva[0]?.base_ht).toBe(10);
    });

    it("applique sur 62800000 (divers gestion courante)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 60,
        lignes: [{ libelle: "Frais administratifs", montant_ttc: 60 }],
      });
      const decision = decisionNominale({ compte_charge: "62800000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("62800000");
      expect(result.extraction.lignes_tva[0]?.montant_tva).toBe(10);
      expect(result.extraction.lignes_tva[0]?.base_ht).toBe(50);
    });

    it("applique sur 60631000 (fournitures consommables)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 18,
        lignes: [{ libelle: "Cartouches encre", montant_ttc: 18 }],
      });
      const decision = decisionNominale({ compte_charge: "60631000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("60631000");
      expect(result.extraction.lignes_tva[0]?.montant_tva).toBe(3);
      expect(result.extraction.lignes_tva[0]?.base_ht).toBe(15);
    });
  });

  describe("Sprint A — usages métier réels (tickets caisse <50€)", () => {
    it("ticket caisse 23,50€ marchandises → fallback applique (cas Cold-line)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 23.5,
        lignes: [{ libelle: "Achat divers", montant_ttc: 23.5 }],
      });
      const decision = decisionNominale({ compte_charge: "60630000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("60630000");
      // 23.5 × 20/120 = 3.9166... → round2 = 3.92, ht = 19.58
      expect(result.extraction.lignes_tva[0]?.montant_tva).toBe(3.92);
      expect(result.extraction.lignes_tva[0]?.base_ht).toBe(19.58);
    });

    it("ticket taxi 8.40€ péage → fallback applique sur 62560000", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 8.4,
        lignes: [{ libelle: "Taxi G7 Gare Lyon → Bercy", montant_ttc: 8.4 }],
      });
      const decision = decisionNominale({ compte_charge: "62560000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);

      expect(result.applique).toBe(true);
      // 8.40 × 20/120 = 1.40, ht = 7.00
      expect(result.extraction.lignes_tva[0]?.montant_tva).toBe(1.4);
      expect(result.extraction.lignes_tva[0]?.base_ht).toBe(7);
    });

    it("invariant arithmétique stable sur les 5 comptes (TTC 0.50..500€)", () => {
      const ttcValues = [0.5, 5.99, 23.5, 47.5, 99.99, 500];
      const comptes = ["60617000", "60630000", "62560000", "62800000", "60631000"];

      for (const compte of comptes) {
        for (const ttc of ttcValues) {
          const result = appliquerFallbackTvaCarburant(
            extractionNominale({ montant_ttc_total: ttc }),
            decisionNominale({ compte_charge: compte }),
          );
          expect(result.applique, `compte=${compte} TTC=${ttc}`).toBe(true);
          const [ligne] = result.extraction.lignes_tva;
          expect(ligne).toBeDefined();
          const sum =
            Math.round((ligne!.base_ht + ligne!.montant_tva) * 100) / 100;
          expect(sum, `compte=${compte} TTC=${ttc}`).toBe(ttc);
        }
      }
    });
  });

  describe("Sprint A — faux positifs (le fallback ne doit pas s'appliquer)", () => {
    it("60630000 marchandises avec libellé hétérogène (presse) → pas de fallback", () => {
      // Mix marchandises + presse (5.5%) sur un même ticket Carrefour →
      // appliquer 20% globale serait faux. Revue manuelle obligatoire.
      const extraction = extractionNominale({
        montant_ttc_total: 30,
        lignes: [
          { libelle: "Cartouches encre", montant_ttc: 25 },
          { libelle: "Le Monde quotidien presse", montant_ttc: 5 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "60630000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false);
      expect(result.compteApplique).toBeUndefined();
    });

    it("62560000 voyages + boutique gare → pas de fallback (mix taux)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 25,
        lignes: [
          { libelle: "Billet TER Paris-Orléans", montant_ttc: 18 },
          { libelle: "Boutique gare - sandwich", montant_ttc: 7 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "62560000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false);
    });

    it("60631000 fournitures avec lignes_tva déjà peuplé → pas de fallback (préserve Vision)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 18,
        lignes_tva: [{ taux: 20, base_ht: 15, montant_tva: 3 }],
      });
      const decision = decisionNominale({ compte_charge: "60631000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false);
    });

    it("62800000 divers + alerte VAT_ETRANGER_REGIME_FR_SUSPECT → pas de fallback", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({
          compte_charge: "62800000",
          alertes: ["VAT_ETRANGER_REGIME_FR_SUSPECT"],
        }),
      );
      expect(result.applique).toBe(false);
    });

    it("60630000 marchandises en intracom → pas de fallback (gate régime FR)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ compte_charge: "60630000", regime_tva: "intracom" }),
      );
      expect(result.applique).toBe(false);
    });
  });

  describe("Sprint A — EC-1 word boundaries regex (faux positifs substring)", () => {
    it("EC-1a: 'Shopify abonnement' (compte 62800000) ne doit PAS matcher 'shop'", () => {
      // Avant Sprint A : regex /shop/ matchait 'Shopify' substring → fallback refusé
      // alors que Shopify est un SaaS B2B TVA 20% mécanique légitime.
      const extraction = extractionNominale({
        montant_ttc_total: 89,
        lignes: [
          { libelle: "Shopify Plus abonnement mensuel", montant_ttc: 30 },
          { libelle: "Frais transaction", montant_ttc: 59 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "62800000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("62800000");
    });

    it("EC-1b: 'expressément' ne doit PAS matcher 'presse' substring", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 50,
        lignes: [
          { libelle: "Service expressément demandé", montant_ttc: 30 },
          { libelle: "Frais administratifs divers", montant_ttc: 20 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "62800000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(true);
    });

    it("EC-1c: 'presse la poste' (mot complet) doit matcher 'presse' (vrai cas métier)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 50,
        lignes: [
          { libelle: "Carburant SP95", montant_ttc: 40 },
          { libelle: "presse la poste journal", montant_ttc: 10 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "60617000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false); // mix carburant + presse → refusé
    });

    it("EC-1d: 'boutique gare' (mot complet) reste bloqué (rétro-compat V1)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 30,
        lignes: [
          { libelle: "SP95", montant_ttc: 25 },
          { libelle: "boutique gare snack", montant_ttc: 5 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "60617000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false);
    });
  });

  describe("Sprint A — EC-2 garde-fou mix-taux silencieux (60630000/60631000)", () => {
    it("EC-2a: 60630000 ticket caisse 3 lignes alimentaire sans taux_tva → REFUSÉ (Gate 7)", () => {
      // Cas critique perte fiscale : Vision lit Pain/Lait/Yaourts sans extraire
      // les taux par ligne. Avant Sprint A Gate 7 : fallback applique 20% globale
      // → TVA déductible fictive 3.92€ sur ticket 23.50€ → DGFIP redresse.
      const extraction = extractionNominale({
        montant_ttc_total: 23.5,
        lignes: [
          { libelle: "Pain de mie", montant_ttc: 1.2 },
          { libelle: "Lait demi-écrémé", montant_ttc: 0.95 },
          { libelle: "Yaourts nature x4", montant_ttc: 3.5 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "60630000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false);
      expect(result.compteApplique).toBeUndefined();
    });

    it("EC-2b: 60631000 fournitures 2 lignes sans taux_tva → REFUSÉ (Gate 7)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 35,
        lignes: [
          { libelle: "Cartouches encre HP", montant_ttc: 25 },
          { libelle: "Livre formation TVA 5.5%", montant_ttc: 10 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "60631000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(false);
    });

    it("EC-2c: 60630000 monoligne reste OK (Gate 7 ne s'active qu'à length>1)", () => {
      const extraction = extractionNominale({
        montant_ttc_total: 47.5,
        lignes: [{ libelle: "Marchandises diverses lot", montant_ttc: 47.5 }],
      });
      const decision = decisionNominale({ compte_charge: "60630000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(true);
    });

    it("EC-2d: 60630000 multi-lignes avec taux_tva=20 explicite → fallback APPLIQUÉ", () => {
      // Cas où Vision a su lire les taux par ligne (bandeau détaillé) : on
      // accepte le fallback car le risque mix-taux est confirmé absent.
      const extraction = extractionNominale({
        montant_ttc_total: 48,
        lignes: [
          { libelle: "Article A", montant_ttc: 24, taux_tva: 20 },
          { libelle: "Article B", montant_ttc: 24, taux_tva: 20 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "60630000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("60630000");
    });

    it("EC-2e: 62560000 (voyages, hors COMPTES_RISQUE_MIX_TAUX) avec multi-lignes sans taux → reste OK", () => {
      // Voyages/péages ne sont pas dans la liste à risque : Gate 7 inerte.
      // Gate 6 standard suffit (regex hétérogène).
      const extraction = extractionNominale({
        montant_ttc_total: 30,
        lignes: [
          { libelle: "Péage A6 Paris-Lyon", montant_ttc: 15 },
          { libelle: "Péage A7 Lyon-Marseille", montant_ttc: 15 },
        ],
      });
      const decision = decisionNominale({ compte_charge: "62560000" });

      const result = appliquerFallbackTvaCarburant(extraction, decision);
      expect(result.applique).toBe(true);
    });
  });

  describe("Sprint A — EC-3 EC-6 entrées pathologiques (defensive)", () => {
    it("EC-3: compte_charge='' (chaîne vide légale Zod) ne déclenche jamais le fallback", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ compte_charge: "" }),
      );
      expect(result.applique).toBe(false);
    });

    it("EC-6a: TTC strictement négatif (avoir non détecté upstream) → REFUSÉ", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: -50 }),
        decisionNominale({ compte_charge: "62560000" }),
      );
      expect(result.applique).toBe(false);
    });

    it("EC-6b: TTC = 0 → REFUSÉ (gate 3 ttc < 0.01)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: 0 }),
        decisionNominale({ compte_charge: "60617000" }),
      );
      expect(result.applique).toBe(false);
    });

    it("EC-6c: TTC = NaN (input pathologique) → REFUSÉ", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: NaN }),
        decisionNominale({ compte_charge: "60617000" }),
      );
      expect(result.applique).toBe(false);
    });

    it("EC-6d: TTC = Infinity → REFUSÉ (gate 3 Number.isFinite)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale({ montant_ttc_total: Infinity }),
        decisionNominale({ compte_charge: "60617000" }),
      );
      expect(result.applique).toBe(false);
    });
  });

  describe("Sprint A — compteApplique tracé pour audit DGFIP", () => {
    it("compteApplique présent ssi applique=true (60617000)", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ compte_charge: "60617000" }),
      );
      expect(result.applique).toBe(true);
      expect(result.compteApplique).toBe("60617000");
    });

    it("compteApplique absent quand applique=false", () => {
      const result = appliquerFallbackTvaCarburant(
        extractionNominale(),
        decisionNominale({ compte_charge: "61560000" }),
      );
      expect(result.applique).toBe(false);
      expect(result.compteApplique).toBeUndefined();
    });
  });
});
