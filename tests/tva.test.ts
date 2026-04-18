/**
 * Tests unitaires dédiés `calculerLignesTVA` et `determinerRegimeTvaDepuisCompte`.
 */

import { describe, it, expect } from "vitest";
import type { ProfilDossier } from "../src/types.js";
import { calculerLignesTVA, determinerRegimeTvaDepuisCompte } from "../src/index.js";

function profil(overrides: Partial<ProfilDossier> = {}): ProfilDossier {
  return {
    identite: {
      raison_sociale: "Test",
      siren: "000000000",
      forme_juridique: "SARL",
      dirigeant: "",
      activite: "",
      code_ape: "",
    },
    comptabilite: {
      regime_tva: "reel_normal",
      cloture: "31/12",
      logiciel: "Fulll",
    },
    comptes_frequents: { charges: [], produits: [] },
    regles: [],
    comptes_relay_ids: {
      "44566000": "R_44566000",
      "44566200": "R_44566200",
      "44520000": "R_44520000",
      "44566300": "R_44566300",
      "44571300": "R_44571300",
    },
    ...overrides,
  };
}

describe("determinerRegimeTvaDepuisCompte", () => {
  it("préfixe 60702 → intracom", () => {
    expect(determinerRegimeTvaDepuisCompte("60702000")).toBe("intracom");
  });
  it("préfixe 6072 → intracom", () => {
    expect(determinerRegimeTvaDepuisCompte("60720000")).toBe("intracom");
  });
  it("préfixe 60703 → extracom", () => {
    expect(determinerRegimeTvaDepuisCompte("60703000")).toBe("extracom");
  });
  it("préfixe 6073 → extracom", () => {
    expect(determinerRegimeTvaDepuisCompte("60730000")).toBe("extracom");
  });
  it("autres préfixes → FR", () => {
    expect(determinerRegimeTvaDepuisCompte("60740000")).toBe("FR");
    expect(determinerRegimeTvaDepuisCompte("62560000")).toBe("FR");
    expect(determinerRegimeTvaDepuisCompte("")).toBe("FR");
  });
});

describe("calculerLignesTVA", () => {
  it("FR standard : débit 44566000 = HT × taux", () => {
    const r = calculerLignesTVA({
      compteCharge: "60740000",
      montantHT: 100,
      tauxTva: 0.20,
      profil: profil(),
    });
    expect(r.debitsTva).toEqual([
      { compte: "44566000", relay_id: "R_44566000", montant: 20 },
    ]);
    expect(r.creditsTva).toEqual([]);
    expect(r.montantTva).toBe(20);
  });

  it("intracom : autoliquidation 44566200 débit + 44520000 crédit", () => {
    const r = calculerLignesTVA({
      compteCharge: "60702000",
      montantHT: 500,
      tauxTva: 0.20,
      profil: profil(),
    });
    expect(r.debitsTva[0]).toMatchObject({ compte: "44566200", montant: 100 });
    expect(r.creditsTva[0]).toMatchObject({ compte: "44520000", montant: 100 });
  });

  it("extracom : autoliquidation 44566300 débit + 44571300 crédit", () => {
    const r = calculerLignesTVA({
      compteCharge: "60703000",
      montantHT: 200,
      tauxTva: 0.20,
      profil: profil(),
    });
    expect(r.debitsTva[0]).toMatchObject({ compte: "44566300", montant: 40 });
    expect(r.creditsTva[0]).toMatchObject({ compte: "44571300", montant: 40 });
  });

  it("taux 0 : aucune ligne TVA", () => {
    const r = calculerLignesTVA({
      compteCharge: "60740000",
      montantHT: 100,
      tauxTva: 0,
      profil: profil(),
    });
    expect(r.debitsTva).toEqual([]);
    expect(r.creditsTva).toEqual([]);
    expect(r.montantTva).toBe(0);
  });

  it("franchise_en_base : aucune ligne TVA même avec taux > 0", () => {
    const p = profil();
    p.comptabilite.regime_tva = "franchise_en_base";
    const r = calculerLignesTVA({
      compteCharge: "60740000",
      montantHT: 100,
      tauxTva: 0.20,
      profil: p,
    });
    expect(r.debitsTva).toEqual([]);
    expect(r.creditsTva).toEqual([]);
  });

  it("throw ERR-RELAY-TVA si relay_id compte TVA manquant", () => {
    const p = profil({ comptes_relay_ids: {} });
    expect(() =>
      calculerLignesTVA({
        compteCharge: "60740000",
        montantHT: 100,
        tauxTva: 0.20,
        profil: p,
      }),
    ).toThrow(/Relay ID manquant/);
  });

  it("arrondi centime : TVA sur 33.33 × 20% = 6.67 (pas 6.666)", () => {
    const r = calculerLignesTVA({
      compteCharge: "60740000",
      montantHT: 33.33,
      tauxTva: 0.20,
      profil: profil(),
    });
    expect(r.montantTva).toBe(6.67);
  });
});
