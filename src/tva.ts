/**
 * Helper calcul lignes TVA — source unique de vérité pour ERR-TVA-01.
 *
 * Génère les lignes débit/crédit TVA d'un payload Fulll selon le régime du compte :
 *
 * - FR (compte hors intracom/extracom) : débit 44566000 (TVA déductible)
 * - intracom (60702x / 6072x) : débit 44566200 + crédit 44520000 (autoliquidation)
 * - extracom (60703x / 6073x) : débit 44566300 + crédit 44571300 (autoliquidation)
 * - franchise TVA ou taux 0 : aucune ligne (HT = TTC)
 *
 * @throws Error si un relay_id manque pour un compte TVA requis.
 */

import type { ProfilDossier } from "./types.js";
import { determinerRegimeTvaDepuisCompte } from "./regimes.js";

export function calculerLignesTVA(params: {
  compteCharge: string;
  montantHT: number;
  tauxTva: number;
  profil: ProfilDossier;
}): {
  debitsTva: Array<{ compte: string; relay_id: string; montant: number }>;
  creditsTva: Array<{ compte: string; relay_id: string; montant: number }>;
  montantTva: number;
} {
  const { compteCharge, montantHT, tauxTva, profil } = params;

  if (tauxTva === 0 || profil.comptabilite.regime_tva === "franchise_en_base") {
    return { debitsTva: [], creditsTva: [], montantTva: 0 };
  }

  const regime = determinerRegimeTvaDepuisCompte(compteCharge);
  const montantTva = Math.round(montantHT * tauxTva * 100) / 100;

  const getRelay = (compte: string) => {
    const relay = profil.comptes_relay_ids?.[compte];
    if (!relay) {
      throw new Error(
        `Relay ID manquant pour compte TVA ${compte} — ERR-RELAY-TVA`,
      );
    }
    return relay;
  };

  if (regime === "FR") {
    return {
      debitsTva: [
        { compte: "44566000", relay_id: getRelay("44566000"), montant: montantTva },
      ],
      creditsTva: [],
      montantTva,
    };
  }

  if (regime === "intracom") {
    return {
      debitsTva: [
        { compte: "44566200", relay_id: getRelay("44566200"), montant: montantTva },
      ],
      creditsTva: [
        { compte: "44520000", relay_id: getRelay("44520000"), montant: montantTva },
      ],
      montantTva,
    };
  }

  return {
    debitsTva: [
      { compte: "44566300", relay_id: getRelay("44566300"), montant: montantTva },
    ],
    creditsTva: [
      { compte: "44571300", relay_id: getRelay("44571300"), montant: montantTva },
    ],
    montantTva,
  };
}
