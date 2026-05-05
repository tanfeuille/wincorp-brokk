---
name: Brokk — Plan amont SDD Niveau 2
description: Plan amont obligatoire avant spec SDD Niveau 2 (module npm @tanfeuille/brokk publié, consommé thor + bifrost en prod). Rétro-spec d'un module mature (162 tests verts, 7 fichiers tests, v0.4.4). Date 2026-05-05.
type: project
date: 2026-05-05
pc: PC-TAN-PHI (tanph)
---

# Brokk — Plan amont SDD

**Module** : `brokk`
**Repo** : `wincorp-brokk` (existant, npm `@tanfeuille/brokk` v0.4.4 publié)
**Niveau SDD** : 2 (standard — module durable cross-file, importé par `wincorp-thor` ET `wincorp-bifrost`, exécuté > 1× quotidien en prod via Achats/Image, métier réglementé indirectement compta/TVA)
**Date** : 2026-05-05
**Auteur** : Claude Code session quick wins H4 (post H5 + B ERR-C01)
**Storage** : `wincorp-brokk/specs/brokk.plan.md` (immédiat, pas de dump mémoire — repo existant)
**Type** : **rétro-spec** (le code existe + 162 tests verts, on documente le contrat actuel)

---

## 1. Grep feedbacks mémoire effectué

**Commande exécutée** :

```bash
SLUG="C--Users-tanph-Documents-wincorp-workspace"
MEMDIR="$HOME/.claude/projects/$SLUG/memory"
find "$MEMDIR" -maxdepth 1 -name "feedback_*.md" | xargs -I {} basename {} .md | grep -iE \
  "robust|build|test|tva|builder|fallback|spec|sdd|module|rigueur|pcg|comptes|format|verify|fix|production|contract|hardcode|alpha2|architecture" \
  | sort
```

**Output verbatim (19 feedbacks pertinents)** :

```
feedback_agent_rigueur
feedback_alpha2_strategy_relay_ids
feedback_api_fulll_tva
feedback_architecture_thinking
feedback_contract_change_audit
feedback_diag_avant_fix
feedback_docker_build_runtime_diverge
feedback_fix_durable_no_rustine
feedback_format_comptes_pcg_vs_providers
feedback_hookify_pythonpath_fix
feedback_no_rm_rf_without_inspect
feedback_opus_build_prefere_sonnet
feedback_pas_de_hardcode_dossier_test
feedback_plan_amont_spec_sdd
feedback_post_fix_verification_incomplete
feedback_rebuild_on_significant_gain
feedback_robust_over_temporary
feedback_skill_fix_at_source
feedback_verify_memory_before_proposing
```

## 2. Patterns références (path:line cliquables)

- [feedback_robust_over_temporary.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_robust_over_temporary.md:1) — ligne directrice "robust v1.0, pas d'appoint" appliquée au choix Niveau 2 (vs Niveau 1 quick) malgré que ça soit une rétro-spec
- [feedback_plan_amont_spec_sdd.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_plan_amont_spec_sdd.md:1) — contrat méta-règle imposant ce plan amont avant spec Niveau ≥ 2
- [feedback_contract_change_audit.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_contract_change_audit.md:1) — règle "audit multi-agent après changement contrat" → applicable au futur changement de schéma Zod brokk (toute modif sera audit obligatoire)
- [feedback_format_comptes_pcg_vs_providers.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_format_comptes_pcg_vs_providers.md:1) — pattern PCG 8 chiffres, à valider dans `remonterComptesPCG`
- [feedback_alpha2_strategy_relay_ids.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_alpha2_strategy_relay_ids.md:1) — pattern "schéma interne avec champ obligatoire pour caller" → applicable au design des contrats Zod brokk
- [feedback_pas_de_hardcode_dossier_test.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_pas_de_hardcode_dossier_test.md:1) — vérifier qu'aucun test brokk ne hardcode un dossier client SPINEX
- [feedback_api_fulll_tva.md:1](../../../.claude/projects/C--Users-tanph-Documents-wincorp-workspace/memory/feedback_api_fulll_tva.md:1) — règle Fulll : payload TVA explicite, pas calculé auto → motive l'existence de `calculerLignesTVA` dans brokk

## 3. Décisions structurantes

| # | Décision | Justification |
|---|----------|---------------|
| **D1** | **Niveau 2** (vs Niveau 1) | Module npm publié + consommé en prod par 2 repos + métier réglementé. Critère SDD `dependance cross-file` ET `execute >1×` ET `metier reglementee` ET `manipule donnees clients production` — 4 cases sur 5. Pas de doute. |
| **D2** | **Rétro-spec** (vs spec greenfield) | Le code existe et tourne en prod (162 tests verts). Documentation du contrat actuel, pas de design ex-nihilo. Cohérent règle SDD "Retro-spec de X" |
| **D3** | **Périmètre IN = exports publics `src/index.ts`** | L'interface publique = ce qui est exporté. Les internals (`__internals`, helpers privés) sont OUT scope spec mais documentés en section "Implementation notes" |
| **D4** | **Contrats Zod = source de vérité du shape** | Les schemas dans `src/contracts/` sont la définition normative. La spec les référence sans les redupliquer (DRY) |
| **D5** | **Règles métier extraites des `describe()` tests** | Les blocs `describe("R28")` ou `describe("R31")` etc. dans tests/ encodent déjà les règles fiscales. La spec les énumère (R28, R29, R31, R33, R34) avec ref test |
| **D6** | **Pas de modification du code/tests dans cette session** | Rétro-spec pure : on documente l'existant. Si la spec révèle des écarts (TODO), ils sont marqués `## 9. TODO` pour Phase ultérieure |
| **D7** | **`@spec specs/brokk.spec.md v1.0` ajouté en tête de `src/index.ts` uniquement** | L'entry point publique. Les fichiers internes (builder.ts, tva.ts, etc.) ont une référence indirecte via index.ts. Évite churn massif sur ~10 fichiers. |
| **D8** | **Niveau d'ALERTES_CODES verrouillé** | Liste fermée 25 codes (`src/contracts/decision.zod.ts:9-95`). Toute modification = breaking change = audit contract obligatoire (cf D8 + feedback_contract_change_audit) |

## 4. Périmètre spec v1.0

### IN
- 4 fonctions principales : `construirePayloadV2`, `equilibrerPayload`, `remonterComptesPCG`, `calculerLignesTVA`
- 4 helpers TVA/régime : `determinerRegimeTvaDepuisCompte`, `appliquerFallbackTvaCarburant` (alias `appliquerFallbackTva`), `verifierGardeFousPreMutation`
- 4 helpers dates/divers : `dateVersISO`, `exerciceDepuisCloture`, `corrigerDateAmbigue`, `corrigerAnneeOcr`, `similariteNomsFournisseur`
- 3 fonctions parse Zod : `parseExtraction`, `parseDecision`, `parseResultatBuilder`
- Constants : `ALERTES_CODES` (25 codes), `COMPTES_FALLBACK_TVA_20`, `COMPTES_RISQUE_MIX_TAUX`, `RegimeTvaSchema` enum (4)

### OUT (différé spec future)
- Implementation détaillée des 837 lignes de `builder.ts` (extraite si besoin futur — la spec v1.0 décrit le contrat, pas l'algo)
- `__internals` (alias `__builderInternals`) exposé pour les tests, hors contrat public
- TypeScript types (`PurchaseFormInput`, `LigneForm`, etc.) — référencés mais non spécifiés exhaustivement (les types sont la doc TS native)

## 5. Validation user requise

Plan amont autosuffisant pour démarrer la rédaction spec niveau 2. **Pas de point bloquant utilisateur** identifié — rétro-spec d'un module mature sans changement de contrat.

## 6. Autorisation rédaction spec

**Auto-validation H4 quick win** : la skill `/spec-plan-amont` recommande validation user explicite. Ici je suis en auto mode (consigne explicite session 2026-05-05), je procède. Si l'utilisateur veut auditer, le plan + spec seront livrés dans le même commit.

---

## Conformité hook block-spec-without-plan-amont

5 conditions cumulées vérifiées :

1. ✓ Section "Grep feedbacks mémoire effectué" présente (section 1)
2. ✓ ≥ 2 occurrences `feedback_<nom>` (19 référencés section 1, 7 référencés section 2)
3. ✓ Chaque `feedback_<nom>` référencé existe dans `memory/feedback_*.md` (vérifié par `find`)
4. ✓ ≥ 1 référence format `feedback_<nom>.md:LN` (7 path:line section 2)
5. ✓ Section "Décisions structurantes" présente (section 3, 8 décisions)
