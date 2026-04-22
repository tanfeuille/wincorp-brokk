# wincorp-brokk

**Yggdrasil** : Brokk — nain forgeron légendaire. Forge les écritures comptables propres à partir des données Vision/Decideur. Branche Midgard (comptabilité).

## Identité

Module partagé TypeScript **builder paie/factures Fulll**. Prend les sorties du décideur LLM + extraction Vision et construit les écritures comptables finales (lignes, TVA, agrégations) selon les contrats Zod stricts.

**Consommateur** : `wincorp-thor` (pipeline Image v2 + Achats).

## Règles locales

- **Contrats Zod stricts** : jamais d'ajout de clé hors schéma. Tout schéma partagé vit dans `src/contracts/`.
- **Pas de LLM direct** : Brokk reçoit la décision du décideur, il ne décide pas. Il calcule.
- **Tests exhaustifs** : le builder est critique (génère les vraies écritures Fulll). TDD obligatoire.
- **Publication** : future GitHub Packages `npm.pkg.github.com/@tanfeuille/brokk` (actuellement `file:../wincorp-brokk` en dev).

## Dépendance

- Consommateur : `wincorp-thor` (builder pipeline saisie factures).
- Références : alertes + contrats dans `src/contracts/` (PROVIDER_COLLISION_AMBIGUE, FOURNISSEUR_EXTERNE, etc.).

## Documentation

Voir `README.md` pour usage et historique des phases (4.5, 4.6, 4.7 livrées 19/04/2026).

## Convention commits

Conventional Commits FR. 1 commit = 1 changement logique.
