/**
 * Tests unitaires helpers divers (similarité fournisseurs).
 */

import { describe, it, expect } from "vitest";
import { similariteNomsFournisseur } from "../src/index.js";

describe("similariteNomsFournisseur", () => {
  it("identique → 1.0", () => {
    expect(similariteNomsFournisseur("Spinex", "Spinex")).toBe(1);
  });
  it("insensible à la casse", () => {
    expect(similariteNomsFournisseur("SPINEX", "spinex")).toBe(1);
  });
  it("insensible aux accents", () => {
    expect(similariteNomsFournisseur("Café", "Cafe")).toBe(1);
  });
  it("inclusion stricte : court / long", () => {
    const s = similariteNomsFournisseur("Spi", "Spinex");
    expect(s).toBeCloseTo(3 / 6, 2);
  });
  it("différents : score faible", () => {
    const s = similariteNomsFournisseur("Spinex", "Fulll");
    expect(s).toBeLessThan(0.3);
  });
  it("chaîne vide → 0", () => {
    expect(similariteNomsFournisseur("", "Spinex")).toBe(0);
    expect(similariteNomsFournisseur("Spinex", "")).toBe(0);
  });
});
