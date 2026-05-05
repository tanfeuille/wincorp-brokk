/**
 * Lookup tolérant 6/8 chiffres pour `profil.comptes_relay_ids`.
 *
 * Phase B fix critique (05/05/2026) — bug Spiritus Taxi :
 * - Le décideur LLM propose `compte_charge: "62560000"` (format PCG 8 chiffres
 *   standard, comme dans les guides comptables et les exemples FEC).
 * - Le dossier Spiritus Taxi (et EURL FLEURIET) est en plan comptable
 *   **6 chiffres** (héritage ancien client). `agent_comptes` contient `625600`
 *   avec son relay_id — mais pas `62560000`.
 * - Conséquence : lookup direct `profil.comptes_relay_ids["62560000"]` retourne
 *   undefined → builder rejette en `ERR-BUILD-04 Relay ID manquant` alors que
 *   le compte EXISTE en `625600` avec un relay_id parfaitement valide.
 *
 * Le builder doit donc faire un lookup tolérant qui essaie aussi les variantes
 * 6↔8 chiffres (strip ou pad de "00" traînants).
 *
 * Convention `comptes_digits` : déclaré dans `profil.parametres.comptes_digits`
 * (6 ou 8). Si fourni, on normalise prioritairement vers ce format. Sinon, on
 * essaie les deux variantes en fallback.
 *
 * @see wincorp-thor/scripts/v2/lib/normaliser-compte.ts pour la version
 *   « audit / migration » qui throw si conversion ambiguë. Ici on est tolérant
 *   au runtime : si aucune variante ne match, on retourne undefined et le
 *   caller bascule la facture en douteuse — comportement existant.
 */

interface ProfilLookup {
  comptes_relay_ids?: Record<string, string>;
  parametres?: { comptes_digits?: 6 | 8 };
}

/**
 * Normalise un compte PCG vers `digits` chiffres si possible.
 *
 * - `digits=6, compte 8 chiffres se terminant par "00"` : strip → 6 chiffres
 *   (ex. `62560000` → `625600`)
 * - `digits=8, compte 6 chiffres` : pad avec "00" → 8 chiffres
 *   (ex. `625600` → `62560000`)
 * - Sinon : retourne le compte tel quel (impossible à normaliser sans perte)
 */
export function normaliserCompte(compte: string, digits: 6 | 8): string {
  if (compte.length === digits) return compte;
  if (digits === 6 && compte.length === 8 && compte.endsWith("00")) {
    return compte.slice(0, 6);
  }
  if (digits === 8 && compte.length === 6) {
    return compte + "00";
  }
  return compte;
}

/**
 * Lookup `profil.comptes_relay_ids[compte]` avec fallback de normalisation
 * 6↔8 chiffres. Retourne `undefined` si aucune variante ne matche.
 *
 * Ordre de tentatives :
 * 1. Exact match du `compte` tel que reçu
 * 2. Si `parametres.comptes_digits` fourni : normaliser vers ce format et
 *    lookup la variante normalisée
 * 3. Fallback aveugle : essayer les 2 variantes principales (8→6 strip si "00"
 *    traînants, 6→8 pad)
 *
 * Cas où ça retourne `undefined` : le compte n'existe ni en exact ni en
 * variante normalisée → vraie erreur "compte absent de la config dossier".
 * Le caller doit traiter ça comme avant (ERR-BUILD-04 ou équivalent).
 */
export function lookupRelayId(profil: ProfilLookup, compte: string): string | undefined {
  const map = profil.comptes_relay_ids ?? {};
  // 1. Exact
  const exact = map[compte];
  if (exact) return exact;
  // 2. Normalisation selon comptes_digits dossier
  const digits = profil.parametres?.comptes_digits;
  if (digits) {
    const normalise = normaliserCompte(compte, digits);
    if (normalise !== compte) {
      const found = map[normalise];
      if (found) return found;
    }
  }
  // 3. Fallback aveugle 6↔8
  if (compte.length === 8 && compte.endsWith("00")) {
    const v6 = compte.slice(0, 6);
    const found = map[v6];
    if (found) return found;
  }
  if (compte.length === 6) {
    const v8 = compte + "00";
    const found = map[v8];
    if (found) return found;
  }
  return undefined;
}
