/**
 * Tests unitaires helpers dates : dateVersISO, exerciceDepuisCloture, corrigerDateAmbigue.
 */

import { describe, it, expect } from "vitest";
import {
  dateVersISO,
  exerciceDepuisCloture,
  corrigerDateAmbigue,
} from "../src/index.js";

describe("dateVersISO", () => {
  it("convertit JJ/MM/AAAA en ISO Fulll", () => {
    expect(dateVersISO("16/01/2026")).toBe("2026-01-16T00:00:00+00:00");
  });
  it("pad les zéros sur jour et mois", () => {
    expect(dateVersISO("5/3/2026")).toBe("2026-03-05T00:00:00+00:00");
  });
  it("retourne undefined si entrée invalide", () => {
    expect(dateVersISO(undefined)).toBeUndefined();
    expect(dateVersISO(null)).toBeUndefined();
    expect(dateVersISO("")).toBeUndefined();
    expect(dateVersISO("16-01-2026")).toBeUndefined();
    expect(dateVersISO("16/01")).toBeUndefined();
  });
});

describe("exerciceDepuisCloture", () => {
  it("clôture 31/12, ref mi-année : exercice = année civile courante", () => {
    const ref = new Date("2026-06-15T00:00:00Z");
    const r = exerciceDepuisCloture("31/12", ref);
    expect(r!.start.slice(0, 10)).toBe("2026-01-01");
    expect(r!.end.slice(0, 10)).toBe("2026-12-31");
  });

  it("clôture 30/06, ref en mars : exercice = 01/07/N-1 → 30/06/N", () => {
    const ref = new Date("2026-03-15T00:00:00Z");
    const r = exerciceDepuisCloture("30/06", ref);
    expect(r!.start.slice(0, 10)).toBe("2025-07-01");
    expect(r!.end.slice(0, 10)).toBe("2026-06-30");
  });

  it("clôture 30/06, ref en octobre : exercice = 01/07/N → 30/06/N+1", () => {
    const ref = new Date("2026-10-01T00:00:00Z");
    const r = exerciceDepuisCloture("30/06", ref);
    expect(r!.start.slice(0, 10)).toBe("2026-07-01");
    expect(r!.end.slice(0, 10)).toBe("2027-06-30");
  });

  it("format invalide → null", () => {
    expect(exerciceDepuisCloture(undefined)).toBeNull();
    expect(exerciceDepuisCloture("")).toBeNull();
    expect(exerciceDepuisCloture("abc")).toBeNull();
    expect(exerciceDepuisCloture("32/01")).toBeNull();
    expect(exerciceDepuisCloture("15/13")).toBeNull();
  });
});

describe("corrigerDateAmbigue", () => {
  const period = { start: "2026-01-01", end: "2026-12-31" };

  it("date dans la période : garde l'originale", () => {
    const r = corrigerDateAmbigue("16/01/2026", period);
    expect(r.dateCorrigee).toBe("16/01/2026");
    expect(r.inversee).toBe(false);
  });

  it("UPS 03/10/2026 exercice 01/07-30/06 : inverse en 10/03/2026", () => {
    const r = corrigerDateAmbigue("03/10/2026", {
      start: "2025-07-01",
      end: "2026-06-30",
    });
    expect(r.dateCorrigee).toBe("10/03/2026");
    expect(r.inversee).toBe(true);
  });

  it("JJ === MM : pas d'ambiguïté, pas d'inversion", () => {
    const r = corrigerDateAmbigue("05/05/2026", period);
    expect(r.inversee).toBe(false);
  });

  it("JJ > 12 : pas d'inversion possible", () => {
    const r = corrigerDateAmbigue("15/10/2025", period);
    expect(r.inversee).toBe(false);
  });

  it("période null + profil cloture : fallback reconstruit", () => {
    const profil: any = {
      comptabilite: { regime_tva: "reel_normal", cloture: "31/12", logiciel: "Fulll" },
      identite: { raison_sociale: "", siren: "", forme_juridique: "", dirigeant: "", activite: "", code_ape: "" },
      comptes_frequents: { charges: [], produits: [] },
      regles: [],
    };
    // Use a real date in the current exercise — the fallback recompute depends on Date.now()
    const today = new Date();
    const year = today.getUTCFullYear();
    const dateInExercice = `15/06/${year}`;
    const r = corrigerDateAmbigue(dateInExercice, null, profil);
    expect(r.inversee).toBe(false);
  });
});
