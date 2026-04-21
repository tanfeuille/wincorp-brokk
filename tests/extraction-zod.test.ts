/**
 * Tests Zod ExtractionVisionSchema — couvre les 5 patterns d'erreurs
 * identifiés lors du run ELAG'RIMP 20/04 (25 erreurs sur 123 factures).
 *
 * Patterns :
 * 1. taux_tva string "5.5" → number 5.5 (preprocess)
 * 2. emetteur.siren/vat = null → accepté via .nullish()
 * 3. carburant.type = "SP98" → null (catch dégrade gracieusement)
 * 4. lignes.*.quantité (FR avec accent) → champ explicite accepté
 * 5. indices_context.client : objet inconnu → accepté via z.unknown()
 */

import { describe, it, expect } from "vitest";
import { parseExtraction, ExtractionVisionSchema } from "../src/contracts/extraction.zod.js";

// Fixture minimale valide (baseline)
function extractionMinimale() {
  return {
    emetteur: { nom: "Test" },
    numero_piece: "F123",
    date: "26/04/2026",
    montant_ttc_total: 100,
    lignes_tva: [{ taux: 20, base_ht: 83.33, montant_tva: 16.67 }],
    lignes: [],
    indices_context: {},
    confiance_extraction: 95,
    meta: {
      modele_utilise: "haiku" as const,
      inversion_date_appliquee: false,
      tokens_input: 2500,
      tokens_output: 400,
    },
  };
}

describe("Pattern 1 — taux_tva string coerce", () => {
  it("LigneTvaSchema accepte taux='20' (string numérique)", () => {
    const e = extractionMinimale();
    (e.lignes_tva[0] as any).taux = "20";
    const r = parseExtraction(e);
    expect(r.lignes_tva[0]!.taux).toBe(20);
  });

  it("LigneTvaSchema accepte taux='5.5' (string décimal)", () => {
    const e = extractionMinimale();
    (e.lignes_tva[0] as any).taux = "5.5";
    (e.lignes_tva[0] as any).base_ht = "94.79";
    (e.lignes_tva[0] as any).montant_tva = "5.21";
    const r = parseExtraction(e);
    expect(r.lignes_tva[0]!.taux).toBe(5.5);
    expect(r.lignes_tva[0]!.base_ht).toBeCloseTo(94.79, 2);
    expect(r.lignes_tva[0]!.montant_tva).toBeCloseTo(5.21, 2);
  });

  it("ExtractionLigneSchema accepte taux_tva='5.5' (string)", () => {
    const e = extractionMinimale();
    e.lignes.push({
      libelle: "Produit test",
      montant_ht: "10" as any,
      taux_tva: "5.5" as any,
      montant_ttc: "10.55" as any,
    } as any);
    const r = parseExtraction(e);
    expect(r.lignes[0]!.taux_tva).toBe(5.5);
    expect(r.lignes[0]!.montant_ht).toBe(10);
  });

  it("taux_tva '20%' avec unité : parseFloat extrait 20", () => {
    const e = extractionMinimale();
    e.lignes.push({ libelle: "X", taux_tva: "20%" as any } as any);
    const r = parseExtraction(e);
    expect(r.lignes[0]!.taux_tva).toBe(20);
  });

  it("string non numérique sur champ optional : passe en undefined (tolérant)", () => {
    // Fix 20/04 soir : preprocessor renvoie undefined au lieu de string brute
    // sur parseFloat NaN. Le champ optional accepte donc silencieusement.
    // Validé sur `lignes.*.taux_tva` (ExtractionLigneSchema, optional).
    const e = extractionMinimale();
    e.lignes.push({ libelle: "Produit", taux_tva: "abc" as any } as any);
    const r = parseExtraction(e);
    expect(r.lignes[0]!.taux_tva).toBeUndefined();
  });
});

describe("Fix 20/04 soir — cas prod ELAG'RIMP smoke", () => {
  it("lignes.0.montant_ttc = null → undefined (pas d'erreur Zod)", () => {
    const e = extractionMinimale();
    e.lignes.push({
      libelle: "Ligne avec TTC null",
      montant_ht: 10,
      taux_tva: 20,
      montant_ttc: null as any,
    } as any);
    const r = parseExtraction(e);
    expect(r.lignes[0]!.montant_ttc).toBeUndefined();
  });

  it("lignes.0.taux_tva = '' (string vide) → undefined", () => {
    const e = extractionMinimale();
    e.lignes.push({
      libelle: "Ligne sans TVA",
      taux_tva: "" as any,
    } as any);
    const r = parseExtraction(e);
    expect(r.lignes[0]!.taux_tva).toBeUndefined();
  });

  it("lignes_tva.0.base_ht omis → LigneTvaSchema accepte (optional post-fix)", () => {
    const e = extractionMinimale();
    // Ligne TVA avec seulement taux + montant_tva, base_ht manquant
    e.lignes_tva = [
      { taux: 20, montant_tva: 4.17 } as any,
    ];
    const r = parseExtraction(e);
    expect(r.lignes_tva[0]!.base_ht).toBeUndefined();
    expect(r.lignes_tva[0]!.taux).toBe(20);
  });

  it("lignes_tva.0.montant_tva = null → accepté comme undefined", () => {
    const e = extractionMinimale();
    e.lignes_tva = [{ taux: 20, base_ht: 83.33, montant_tva: null } as any];
    const r = parseExtraction(e);
    expect(r.lignes_tva[0]!.montant_tva).toBeUndefined();
  });

  it("montant_ttc_total = null sur racine → toujours required → fail", () => {
    // Garde-fou : le total racine reste obligatoire, null → fail
    const e = extractionMinimale();
    (e as any).montant_ttc_total = null;
    expect(() => parseExtraction(e)).toThrow(/ExtractionVision invalide/);
  });
});

describe("Pattern 2 — siren/vat null accepté (nullish)", () => {
  it("siren = null (ticket caisse) : accepté", () => {
    const e = extractionMinimale();
    (e.emetteur as any).siren = null;
    const r = parseExtraction(e);
    expect(r.emetteur.siren).toBeNull();
  });

  it("vat = null (facture étrangère sans TVA) : accepté", () => {
    const e = extractionMinimale();
    (e.emetteur as any).vat = null;
    const r = parseExtraction(e);
    expect(r.emetteur.vat).toBeNull();
  });

  it("pays = null : accepté", () => {
    const e = extractionMinimale();
    (e.emetteur as any).pays = null;
    const r = parseExtraction(e);
    expect(r.emetteur.pays).toBeNull();
  });

  it("siren + vat + pays simultanément null : accepté", () => {
    const e = extractionMinimale();
    (e.emetteur as any).siren = null;
    (e.emetteur as any).vat = null;
    (e.emetteur as any).pays = null;
    const r = parseExtraction(e);
    expect(r.emetteur.nom).toBe("Test");
  });

  it("siren undefined (non fourni) : accepté", () => {
    const e = extractionMinimale();
    delete (e.emetteur as any).siren;
    const r = parseExtraction(e);
    expect(r.emetteur.siren).toBeUndefined();
  });
});

describe("Pattern 3 — carburant.type enum avec catch(null)", () => {
  it("type valide 'diesel' : conservé", () => {
    const e = extractionMinimale();
    (e.indices_context as any).carburant = { type: "diesel", litres: 50 };
    const r = parseExtraction(e);
    expect(r.indices_context.carburant?.type).toBe("diesel");
  });

  it("type 'SP98' hors enum : dégradé en null sans throw", () => {
    const e = extractionMinimale();
    (e.indices_context as any).carburant = { type: "SP98", litres: 40 };
    const r = parseExtraction(e);
    expect(r.indices_context.carburant?.type).toBeNull();
    // litres toujours lu
    expect(r.indices_context.carburant?.litres).toBe(40);
  });

  it("type 'gazole' hors enum : dégradé en null", () => {
    const e = extractionMinimale();
    (e.indices_context as any).carburant = { type: "gazole" };
    const r = parseExtraction(e);
    expect(r.indices_context.carburant?.type).toBeNull();
  });

  it("type null explicite : accepté tel quel", () => {
    const e = extractionMinimale();
    (e.indices_context as any).carburant = { type: null };
    const r = parseExtraction(e);
    expect(r.indices_context.carburant?.type).toBeNull();
  });
});

describe("Pattern 4 — lignes.*.quantité (accent FR) accepté", () => {
  it("quantité (avec accent) : champ explicite accepté", () => {
    const e = extractionMinimale();
    e.lignes.push({
      libelle: "Gazole",
      "quantité": 60,
      montant_ht: 100,
    } as any);
    const r = parseExtraction(e);
    expect((r.lignes[0] as any)["quantité"]).toBe(60);
  });

  it("quantite (sans accent) : toujours accepté", () => {
    const e = extractionMinimale();
    e.lignes.push({
      libelle: "Gazole",
      quantite: 60,
      montant_ht: 100,
    } as any);
    const r = parseExtraction(e);
    expect(r.lignes[0]!.quantite).toBe(60);
  });

  it("clé complètement inconnue : toujours rejetée (strictObject conservé)", () => {
    const e = extractionMinimale();
    e.lignes.push({
      libelle: "Test",
      champInconnuHallucineParLlm: "valeur",
    } as any);
    expect(() => parseExtraction(e)).toThrow(/ExtractionVision invalide/);
  });
});

describe("Pattern 5 — indices_context.client (objet B2B)", () => {
  it("client = objet : accepté via z.unknown()", () => {
    const e = extractionMinimale();
    (e.indices_context as any).client = {
      nom: "ELAG'RIMP",
      adresse: "123 rue du paysage",
      siren: "891456980",
    };
    const r = parseExtraction(e);
    expect((r.indices_context as any).client).toBeDefined();
  });

  it("client = string : accepté", () => {
    const e = extractionMinimale();
    (e.indices_context as any).client = "Client pro";
    const r = parseExtraction(e);
    expect((r.indices_context as any).client).toBe("Client pro");
  });

  it("client absent : accepté (optional)", () => {
    const e = extractionMinimale();
    const r = parseExtraction(e);
    expect((r.indices_context as any).client).toBeUndefined();
  });

  it("clé parent inconnue : toujours rejetée (strictObject conservé)", () => {
    const e = extractionMinimale();
    (e.indices_context as any).autreCleInconnue = "test";
    expect(() => parseExtraction(e)).toThrow(/ExtractionVision invalide/);
  });
});

describe("Flags contextuels Vision (TOMETY 21/04)", () => {
  it("est_appel_de_fonds_copropriete = true : accepté", () => {
    const e = extractionMinimale();
    (e.indices_context as any).est_appel_de_fonds_copropriete = true;
    const r = parseExtraction(e);
    expect(r.indices_context.est_appel_de_fonds_copropriete).toBe(true);
  });

  it("est_facture_abonnement = true : accepté (télécom récurrent Orange/SFR/Bouygues/Free)", () => {
    const e = extractionMinimale();
    (e.indices_context as any).est_facture_abonnement = true;
    const r = parseExtraction(e);
    expect(r.indices_context.est_facture_abonnement).toBe(true);
  });

  it("flags contextuels absents : accepté (optional)", () => {
    const e = extractionMinimale();
    const r = parseExtraction(e);
    expect(r.indices_context.est_appel_de_fonds_copropriete).toBeUndefined();
    expect(r.indices_context.est_facture_abonnement).toBeUndefined();
  });
});

describe("ExtractionVision global — borne confiance", () => {
  it("confiance 101 : rejetée (max 100)", () => {
    const e = extractionMinimale();
    e.confiance_extraction = 101;
    expect(() => parseExtraction(e)).toThrow();
  });

  it("confiance -5 : rejetée (min 0)", () => {
    const e = extractionMinimale();
    e.confiance_extraction = -5;
    expect(() => parseExtraction(e)).toThrow();
  });

  it("confiance string '85' : coerce en number 85", () => {
    const e = extractionMinimale();
    (e as any).confiance_extraction = "85";
    const r = parseExtraction(e);
    expect(r.confiance_extraction).toBe(85);
  });
});

describe("ExtractionVision — cas prod ELAG'RIMP run 20/04", () => {
  it("ticket caisse sans SIREN + carburant SP95 + taux string : OK", () => {
    // Reproduit un cas typique qui aurait échoué avant les fix
    const e = {
      emetteur: { nom: "E.LECLERC STATION", siren: null, vat: null, pays: "FR" },
      numero_piece: "T-98765",
      date: "15/04/2026",
      montant_ttc_total: "78.29",
      lignes_tva: [
        { taux: "20", base_ht: "65.24", montant_tva: "13.05" },
      ],
      lignes: [
        {
          libelle: "SP95",
          "quantité": "49.06",
          montant_ht: "65.24",
          taux_tva: "20",
          montant_ttc: "78.29",
        },
      ],
      indices_context: {
        type_transaction: "b2c",
        est_ticket_caisse: true,
        carburant: { type: "SP95", litres: "49.06" },
      },
      confiance_extraction: "95",
      meta: {
        modele_utilise: "haiku",
        inversion_date_appliquee: false,
        tokens_input: 2500,
        tokens_output: 420,
      },
    };
    const r = parseExtraction(e);
    expect(r.montant_ttc_total).toBe(78.29);
    expect(r.lignes_tva[0]!.taux).toBe(20);
    expect(r.indices_context.carburant?.type).toBeNull(); // SP95 → null gracieux
    expect(r.emetteur.siren).toBeNull();
    expect(r.confiance_extraction).toBe(95);
  });
});
