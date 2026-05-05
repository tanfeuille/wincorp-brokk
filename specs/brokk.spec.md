# Brokk — Specification

> **Statut :** IMPLEMENTED
> **Version :** 1.0
> **Niveau :** 2 (standard — module npm publié, consommé thor + bifrost)
> **Auteur :** Claude Code (rétro-spec H4 2026-05-05)
> **Date de création :** 2026-05-05
> **Plan amont :** [brokk.plan.md](./brokk.plan.md)

---

## 1. Objectif

`@tanfeuille/brokk` est un module npm TypeScript qui **forge les écritures comptables Fulll** à partir des sorties d'un décideur LLM et d'une extraction Vision. C'est un **builder déterministe sans appel LLM** : il calcule, il ne décide pas.

**Position Yggdrasil** : Tronc transverse. Consommé par :
- `wincorp-thor` (worker Playwright + Vision pour pipeline Achats/Image saisie factures)
- `wincorp-bifrost` (API session correction écritures Supabase)

**Garantie clé** : tout shape entrant/sortant est validé via Zod strict. Aucune mutation Fulll ne peut être déclenchée sans que le payload ait été construit + équilibré + validé contractuellement par brokk.

---

## 2. Périmètre

### IN — Ce que le module fait

- **Construit le payload Fulll** (factures achats) depuis (décision décideur + extraction Vision + profil dossier)
- **Calcule les lignes TVA** ventilées par taux (20%, 10%, 5.5%, 2.1%, 0%, autoliquidation)
- **Équilibre le payload** : somme débits = somme crédits ± 0,01 €
- **Remonte les comptes PCG** au niveau dossier (formats 6 ou 8 chiffres selon `comptesDigits`)
- **Détermine le régime TVA** depuis le compte (FR / intracom / extracom / franchise)
- **Applique des fallbacks TVA 20%** sur 5 comptes à risque mix-taux (carburant, marchandises, voyages, divers, fournitures)
- **Vérifie les garde-fous pré-mutation** : aucune référence vide, aucune date >2026, aucun compte interdit, alertes critiques bloquantes
- **Synthétise / résout des références** factures (numéro, date, fournisseur)
- **Corrige les dates** : ISO normalisée, exercice depuis clôture, années ambiguës OCR
- **Parse + valide Zod** les contrats Extraction, Decision, ResultatBuilder

### OUT — Ce que le module ne fait PAS

- ❌ Pas d'appel LLM direct (le décideur tourne ailleurs — wincorp-thor ou wincorp-bifrost)
- ❌ Pas d'I/O réseau (pas de fetch Fulll, le caller exécute la mutation)
- ❌ Pas de persistance (pas d'écriture base Supabase, le caller persiste)
- ❌ Pas de logique de sélection providers/comptes/fournisseurs en mode "création" (cf [feedback_decideur_selecteur_strict] — le décideur sélectionne strict, brokk consomme la sélection)
- ❌ Pas de Vision OCR (l'extraction est consommée déjà parsée)
- ❌ Pas de calcul fiscal (IR/IS/etc. — c'est wincorp-mimir)

---

## 3. Interface publique

Définie par `src/index.ts`. Tout consommateur **doit** importer depuis `@tanfeuille/brokk`, jamais depuis un sous-chemin (`./src/builder` interdit en runtime — module compilé en `dist/index.js`).

### Builder principal

```ts
construirePayloadV2(params: ConstruirePayloadV2Params): ResultatBuilder
equilibrerPayload(payload: ...): EquilibrePayloadResult
remonterComptesPCG(payload: ..., facture: ..., profil: ProfilDossier): ComptesFinaux
```

### Helpers TVA / Régimes

```ts
calculerLignesTVA(...): LigneTVA[]
determinerRegimeTvaDepuisCompte(compte: string): RegimeTva
appliquerFallbackTvaCarburant(...): FallbackTvaResult  // alias appliquerFallbackTva
COMPTES_FALLBACK_TVA_20: readonly string[]
COMPTES_RISQUE_MIX_TAUX: readonly string[]
```

### Garde-fous pré-mutation

```ts
verifierGardeFousPreMutation(...): GardeFousResult
synthetiserReference(...): string
resoudreReference(...): string | null
```

### Helpers dates

```ts
dateVersISO(input: string): string
exerciceDepuisCloture(date: string, clotureFiscale: string): number
corrigerDateAmbigue(...): string
corrigerAnneeOcr(...): string
```

### Contrats Zod

```ts
ExtractionVisionSchema, parseExtraction(): ExtractionVisionParsed
DecisionDecideurSchema, parseDecision(): DecisionDecideurParsed
ResultatBuilderSchema, parseResultatBuilder(): ResultatBuilderParsed
RegimeTvaSchema = z.enum(["FR", "intracom", "extracom", "franchise"])
ALERTES_CODES = readonly tuple<25 codes>  // cf 4.7
```

### Helpers divers

```ts
similariteNomsFournisseur(a: string, b: string): number  // 0..1
```

---

## 4. Règles métier

### 4.1 Construction du payload — `construirePayloadV2`

- **R1** : Le payload résultant respecte le schéma `ResultatBuilderSchema` (Zod strict). Toute clé hors schéma = erreur de parse côté caller.
- **R2** : Tous les montants sont en `string` représentant des Decimals au format FR (`"1234,56"`). Pas de `number` (perte de précision).
- **R3** : Si `decision.alertes` contient un code bloquant (cf 4.7), `construirePayloadV2` propage l'alerte mais NE BLOQUE PAS le retour (le caller décide). Le décideur reste seul juge.
- **R4** : Le payload contient toujours au moins 1 ligne TVA si HT > 0 (sinon warning interne).

### 4.2 Équilibre — `equilibrerPayload`

- **R33** : Somme débits − somme crédits = 0 ± 0,01 €. Si écart > 0,01 €, `equilibrerPayload` ajuste la dernière ligne via la "remontée d'écart" (regroupée sur le compte de plus grand poids). Aucune tolérance % opaque.
- **R33-bis** : Si l'écart à compenser dépasse 1 € (signe d'un bug amont), retour avec `alerte: "EQUILIBRE_DESEQUILIBRE_GRAND"` mais le payload est quand même équilibré (pas de short-circuit).

### 4.3 Remontée comptes PCG — `remonterComptesPCG`

- **R34** : Les comptes du payload sont remontés au format dominant du dossier (`profil.parametres.comptes_digits`, valeur `6` ou `8`).
- **R34-bis** : Format 8 chiffres = padding zéros à droite (`625600` → `62560000`). Format 6 chiffres = troncature ou rejet selon le compte. Cf [feedback_format_comptes_pcg_vs_providers.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_format_comptes_pcg_vs_providers.md:1).
- **R34-ter** : Comptes 79x SUPPRIMÉS dans PCG 2022-06 → rejet strict (cf wincorp-mimir/specs/pcg.spec.md).

### 4.4 Routing avoirs — R31

- **R31** : Si `decision.flux === "avoir"` ou si HT TTC < 0, le payload route en `comptes_avoir` avec inversion débit/crédit. Tests : `tests/builder.test.ts:describe("construirePayloadV2 — routing avoir (R31)")`.

### 4.5 Force 0 € → 0,01 € — R29

- **R29** : Si HT = 0 € et TTC = 0 €, brokk force le payload à 0,01 € (Fulll refuse les payloads strictement nuls). Petit lot de tests dédié.

### 4.6 Routing acompte — R28

- **R28** : Si `decision.flux === "acompte"`, le payload utilise comptes acompte spécifiques (avances, comptes 4091 typiquement). Tests `tests/builder.test.ts:describe("construirePayloadV2 — routing acompte (R28)")`.

### 4.7 ALERTES_CODES — liste fermée 25 codes

Définie dans `src/contracts/decision.zod.ts:9-95`. Liste verrouillée — ajout = breaking change → audit obligatoire (cf [feedback_contract_change_audit.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_contract_change_audit.md:1)).

Codes critiques bloquants (le caller décide de bloquer la mutation) : `FOURNISSEUR_EXTERNE`, `PROVIDER_COLLISION_AMBIGUE`, autres documentés inline dans le fichier `decision.zod.ts`.

### 4.8 Régimes TVA — RegimeTvaSchema

- **R35** : 4 régimes uniques `["FR", "intracom", "extracom", "franchise"]`. Toute valeur hors énum = erreur Zod.
- **R36** : `determinerRegimeTvaDepuisCompte(compte)` : 
  - 4456xxxx → "FR"
  - 4452xxxx → "intracom" 
  - 4458xxxx → "extracom" (autoliquidation)
  - défaut/franchise → "franchise"

### 4.9 Fallback TVA 20% — `appliquerFallbackTvaCarburant`

- **R37** : Si l'extraction Vision n'a pas extrait de `lignes_tva` mais que le compte est dans `COMPTES_FALLBACK_TVA_20` (5 comptes : carburant, marchandises, voyages, divers, fournitures), brokk applique fallback TVA 20% sur le HT total.
- **R37-bis** : Si compte est dans `COMPTES_RISQUE_MIX_TAUX`, le fallback est appliqué MAIS `result.alerte_mix_taux = true` pour signaler au caller un possible recalcul humain (Sprint A 28/04/2026).
- **R38** : Pas de fallback si Vision a fourni des lignes_tva non vides — la décision Vision prime.

### 4.10 Garde-fous pré-mutation — `verifierGardeFousPreMutation`

- **R39** : Bloque si `payload.reference === ""` ou `null`.
- **R40** : Bloque si une date du payload > 2026 (défense anti-hallucination Vision).
- **R41** : Bloque si le payload contient un compte 79x (PCG 2022-06).
- **R42** : Bloque si `decision.alertes` inclut un code critique listé `bloquants_critiques`.

### 4.11 Dates — `dateVersISO`, `exerciceDepuisCloture`, `corrigerDateAmbigue`, `corrigerAnneeOcr`

- **R43** : `dateVersISO("31/12/2024")` → `"2024-12-31"`. Formats supportés : DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD/MM/YY (avec heuristique siècle).
- **R44** : `exerciceDepuisCloture(date, cloture)` retourne l'année fiscale à laquelle la date appartient selon la clôture du dossier (ex : clôture 30/06 → exercice = annee si date>cloture, annee-1 sinon).
- **R45** : `corrigerAnneeOcr` détecte les patterns OCR courants (`2O24` → `2024`, etc.).

### 4.12 Similarité noms fournisseur — `similariteNomsFournisseur`

- **R46** : Retour entre 0 et 1. Algorithme actuel = Levenshtein normalisé sur strings normalisées (lowercase + suppression accents + suppression ponctuation).

---

## 5. Edge cases

- **EC1** : Extraction Vision avec `lignes` vides → builder retourne payload minimal avec ligne par défaut au compte profil par défaut.
- **EC2** : Décision décideur avec `alertes` non-array → erreur Zod parse stricte.
- **EC3** : Profil dossier sans `parametres.comptes_digits` → défaut `8` (cohérent Fulll moderne).
- **EC4** : HT et TTC tous deux 0 → payload forcé 0,01 € (R29).
- **EC5** : Avoir avec HT > 0 (signe positif mais flux="avoir") → traité comme avoir, signe inversé interne (R31).
- **EC6** : Régime TVA inconnu (ex: compte exotique) → fallback "FR" silencieux + alerte interne.
- **EC7** : Date OCR ambiguë (ex: `01/02/03`) → priorité DD/MM/YY siècle 21e (`2003-02-01`).
- **EC8** : `COMPTES_FALLBACK_TVA_20` ET `COMPTES_RISQUE_MIX_TAUX` overlap → fallback s'applique + `alerte_mix_taux: true`.

---

## 6. Erreurs possibles

| Erreur | Cause | Comportement |
|--------|-------|--------------|
| `ZodError` | Shape entrant/sortant invalide | Lancée par `parseExtraction` / `parseDecision` / `parseResultatBuilder` — caller catch |
| `TypeError` | Types TS forcés à mauvais en JS pur | Possible si caller pas TS — la spec recommande TS strict |
| Payload déséquilibré > 1 € | Bug amont décideur ou Vision | Retourne `alerte: "EQUILIBRE_DESEQUILIBRE_GRAND"`, payload équilibré quand même |
| Garde-fou bloquant | Référence vide / date >2026 / compte 79x / alerte critique | `GardeFousResult.bloquant: true` + raison — caller décide |

---

## 7. Dépendances & contraintes

### Runtime
- `zod ^4.3.6` (seule dépendance npm runtime)
- Node 20+ ESM modules

### Dev
- `typescript ^5.7.0` (build dist)
- `vitest ^4.1.2` (tests)

### Importeurs
- `wincorp-thor` : worker Playwright Fulll (pipeline Achats + Image v2)
- `wincorp-bifrost` : API session correction (Next.js 14 + Supabase)

### Versionnage
- SemVer strict. Toute modification de `src/index.ts` exports OU de `src/contracts/*.zod.ts` schemas = breaking change min `MAJOR` bump.
- Publication via `.github/workflows/publish.yml` sur GitHub Packages `@tanfeuille/brokk`.

---

## 8. Mapping tests existants

162 tests verts répartis en 7 fichiers (vitest 4.1.4) :

| Fichier | Tests | Couverture règles |
|---------|-------|-------------------|
| `tests/builder.test.ts` | 25 | R1-R4, R28, R29, R31, R33, R34 |
| `tests/dates.test.ts` | 26 | R43, R44, R45 |
| `tests/extraction-zod.test.ts` | 33 | Schémas Zod extraction (parsing, strict, edge cases) |
| `tests/fallback-tva.test.ts` | 45 | R37, R37-bis, R38 + matrices comptes/montants |
| `tests/helpers.test.ts` | 6 | R46 (similarité fournisseur) |
| `tests/pre-mutation-guards.test.ts` | 15 | R39, R40, R41, R42 |
| `tests/tva.test.ts` | 12 | calcul lignes TVA + R35, R36 |

Couverture par règle : R1, R2, R3, R4, R28, R29, R31, R33, R34, R35, R36, R37, R37-bis, R38, R39, R40, R41, R42, R43, R44, R45, R46 — **22 règles métier testées explicitement**.

---

## 9. TODO (écarts identifiés en rétro-spec)

| # | TODO | Priorité |
|---|------|----------|
| 1 | Ajouter `@spec specs/brokk.spec.md v1.0` en tête de `src/index.ts` | basse (cosmétique) |
| 2 | Documenter exhaustivement les 25 ALERTES_CODES (hors scope v1.0) | basse |
| 3 | Détailler R34-bis algorithme remontée 6/8 chiffres avec exemples vérifiables | moyenne |
| 4 | Tests pour edge cases EC6, EC7, EC8 manquants en explicite (existence à confirmer) | basse |
| 5 | `R3` (alertes propagées non bloquantes côté brokk) à confirmer côté thor : caller bien fait son boulot ? | moyenne |
| 6 | Spec future séparée `specs/contracts.spec.md` pour les schemas Zod détaillés (extraction, decision, builder) | basse, à arbitrer si besoin |

---

## 10. Changelog

| Version | Date | Modification |
|---------|------|--------------|
| 1.0 | 2026-05-05 | Création initiale (rétro-spec H4 quick win 2026-05-05). Module npm `@tanfeuille/brokk` v0.4.4 publié + 162 tests verts. Spec extraite des `describe()` tests + `src/contracts/*.zod.ts` schemas. Pas de modification du code/tests dans cette session — pure documentation du contrat actuel. |
