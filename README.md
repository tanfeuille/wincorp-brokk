# @tanfeuille/brokk

**Brokk** — module partagé builder paie/factures Fulll (écosystème Yggdrasil).

Fournit la logique de construction de payload Fulll (`PurchaseFormInput`) équilibré,
le calcul des lignes TVA par régime (FR / intracom / extracom / franchise), les
helpers de date et les contrats Zod associés. Consommé par :

- **wincorp-thor** (worker Playwright, pipeline `run-saisie.ts --v2`)
- **wincorp-bifrost** (API session correction, endpoint `batch-commit`)

## Installation

Le package est publié sur GitHub Packages (registry privé `npm.pkg.github.com`).

Dans le projet consommateur :

```bash
# .npmrc (racine du projet)
@tanfeuille:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

```bash
npm install @tanfeuille/brokk
```

Le token `NPM_TOKEN` doit avoir le scope `read:packages` (Vercel env var ou secret GitHub Actions).

## Exports

```ts
import {
  construirePayloadV2,
  equilibrerPayload,
  remonterComptesPCG,
  calculerLignesTVA,
  determinerRegimeTvaDepuisCompte,
  corrigerDateAmbigue,
  exerciceDepuisCloture,
  dateVersISO,
  similariteNomsFournisseur,
  parseExtraction,
  parseDecision,
  parseResultatBuilder,
} from "@tanfeuille/brokk";

import type {
  ProfilDossier,
  FournisseurYAML,
  CompteFrequent,
  RegleDossier,
  PurchaseFormInput,
  LigneForm,
  FactureSuivante,
  ExtractionVision,
  DecisionDecideur,
  ResultatBuilder,
  ContextDecideur,
  IndicesContext,
  ExtractionLigne,
} from "@tanfeuille/brokk";
```

## Développement

```bash
npm ci
npm run build
npm test
```

## Release

Tag semver (`vX.Y.Z`) + push → workflow GitHub Actions `.github/workflows/publish.yml`
publie automatiquement sur GitHub Packages.

```bash
npm version patch   # 0.1.0 → 0.1.1
git push --follow-tags
```

## Conventions

Source unique de vérité pour :
- `construirePayloadV2` (règles R27-R35 de `wincorp-thor/specs/image-v2-builder.spec.md`)
- `calculerLignesTVA` (règles ERR-TVA-01, ERR-TVA-04)
- `determinerRegimeTvaDepuisCompte` (préfixes 60702x/6072x/60703x/6073x)
- Contrats Zod v2 (extraction, decision, builder)

Toute modification de ces règles doit être accompagnée d'un bump semver + changelog.
