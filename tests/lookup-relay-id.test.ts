/**
 * Tests Phase B fix critique (05/05/2026) — lookup tolérant 6↔8 chiffres
 * pour profil.comptes_relay_ids. Couvre les 3 niveaux de fallback +
 * la normalisation pure.
 */

import { describe, it, expect } from "vitest";
import { lookupRelayId, normaliserCompte } from "../src/lookup-relay-id.js";

describe("normaliserCompte", () => {
  it("retourne tel quel si déjà au bon format", () => {
    expect(normaliserCompte("625600", 6)).toBe("625600");
    expect(normaliserCompte("62560000", 8)).toBe("62560000");
  });

  it("strip 00 traînants pour passer 8 → 6", () => {
    expect(normaliserCompte("62560000", 6)).toBe("625600");
    expect(normaliserCompte("60710000", 6)).toBe("607100");
  });

  it("pad 00 pour passer 6 → 8", () => {
    expect(normaliserCompte("625600", 8)).toBe("62560000");
    expect(normaliserCompte("607100", 8)).toBe("60710000");
  });

  it("ne strip pas si pas de 00 traînants en fin (compte 8 vraiment significatif)", () => {
    expect(normaliserCompte("60710001", 6)).toBe("60710001");
    expect(normaliserCompte("44566012", 6)).toBe("44566012");
  });

  it("retourne tel quel pour longueurs hors 6/8 (cas dégénéré)", () => {
    expect(normaliserCompte("6256", 6)).toBe("6256");
    expect(normaliserCompte("6256000000", 8)).toBe("6256000000");
  });
});

describe("lookupRelayId — Niveau 1 exact match", () => {
  it("retourne le relay_id exact", () => {
    const profil = {
      comptes_relay_ids: { "62560000": "RELAY_8" },
    };
    expect(lookupRelayId(profil, "62560000")).toBe("RELAY_8");
  });

  it("retourne undefined si compte absent", () => {
    const profil = {
      comptes_relay_ids: { "62560000": "RELAY_8" },
    };
    expect(lookupRelayId(profil, "99999999")).toBeUndefined();
  });

  it("gère profil sans comptes_relay_ids", () => {
    expect(lookupRelayId({}, "62560000")).toBeUndefined();
  });

  it("gère profil avec map vide", () => {
    expect(lookupRelayId({ comptes_relay_ids: {} }, "62560000")).toBeUndefined();
  });
});

describe("lookupRelayId — Niveau 2 normalisation comptes_digits", () => {
  it("dossier 6 chiffres : décideur propose 8 → trouve la version 6", () => {
    const profil = {
      comptes_relay_ids: { "625600": "RELAY_6" },
      parametres: { comptes_digits: 6 as const },
    };
    // Cas Spiritus Taxi : décideur propose 62560000, profil a 625600
    expect(lookupRelayId(profil, "62560000")).toBe("RELAY_6");
  });

  it("dossier 8 chiffres : décideur propose 6 → trouve la version 8", () => {
    const profil = {
      comptes_relay_ids: { "62560000": "RELAY_8" },
      parametres: { comptes_digits: 8 as const },
    };
    expect(lookupRelayId(profil, "625600")).toBe("RELAY_8");
  });

  it("priorité à l'exact match avant normalisation", () => {
    const profil = {
      comptes_relay_ids: { "62560000": "RELAY_8", "625600": "RELAY_6" },
      parametres: { comptes_digits: 6 as const },
    };
    expect(lookupRelayId(profil, "62560000")).toBe("RELAY_8");
    expect(lookupRelayId(profil, "625600")).toBe("RELAY_6");
  });

  it("dossier 6 chiffres mais compte significatif 8 chiffres (non strippable) → pas de match", () => {
    const profil = {
      comptes_relay_ids: { "60710001": "RELAY_X" },
      parametres: { comptes_digits: 6 as const },
    };
    // 60710001 n'a pas "00" à la fin, donc pas de strip → cherche 60710001 exact (qui existe)
    expect(lookupRelayId(profil, "60710001")).toBe("RELAY_X");
  });
});

describe("lookupRelayId — Niveau 3 fallback aveugle (sans comptes_digits)", () => {
  it("compte 8 finissant par 00 → fallback vers 6", () => {
    const profil = {
      comptes_relay_ids: { "625600": "RELAY_6" },
      // pas de parametres.comptes_digits
    };
    expect(lookupRelayId(profil, "62560000")).toBe("RELAY_6");
  });

  it("compte 6 → fallback vers 8 par padding", () => {
    const profil = {
      comptes_relay_ids: { "62560000": "RELAY_8" },
    };
    expect(lookupRelayId(profil, "625600")).toBe("RELAY_8");
  });

  it("compte 8 sans 00 traînants → pas de fallback", () => {
    const profil = {
      comptes_relay_ids: { "60710001": "RELAY_X" },
    };
    expect(lookupRelayId(profil, "60710002")).toBeUndefined();
  });
});

describe("lookupRelayId — Cas Spiritus Taxi run du matin (régression directe)", () => {
  it("simule les 7 comptes critiques du run raté du 05/05", () => {
    // Profil reconstruit depuis l'audit Supabase 05/05 19:30
    const profil = {
      comptes_relay_ids: {
        "215400": "R_215400",
        "625100": "R_625100",
        "625600": "R_625600",
        "626200": "R_626200",
        "627800": "R_627800",
        "627810": "R_627810",
        "645500": "R_645500",
      },
      parametres: { comptes_digits: 6 as const },
    };
    // Le décideur propose tous ces comptes en 8 chiffres (format PCG standard)
    expect(lookupRelayId(profil, "21540000")).toBe("R_215400");
    expect(lookupRelayId(profil, "62510000")).toBe("R_625100");
    expect(lookupRelayId(profil, "62560000")).toBe("R_625600");
    expect(lookupRelayId(profil, "62620000")).toBe("R_626200");
    expect(lookupRelayId(profil, "62780000")).toBe("R_627800");
    expect(lookupRelayId(profil, "64550000")).toBe("R_645500");
  });
});
