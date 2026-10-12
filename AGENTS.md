# AGENTS.md — maintenir gitgraph-for-t3code

Consignes pour un agent (Claude Code, Codex…) ou un humain qui modifie ce dépôt, en particulier
après une mise à jour de T3 Code qui casse l'intégration.

## Principe

gitgraph **ne modifie jamais T3 Code**. C'est une application compagnon : un serveur local
(`127.0.0.1:4777`) et une interface React, affichés dans le panneau Preview de T3 grâce à un
script de `t3.json` (`previewUrl` + `autoOpenPreview`). C'est ce qui le rend persistant aux
mises à jour : ne pas proposer de patcher `app.asar`, de re-signer l'app ni d'injecter du code
dans T3.

Le seul contrat avec T3 :

| Élément | Où | Vérifié par |
|---|---|---|
| Champs `previewUrl` et `autoOpenPreview` d'un script `t3.json` | schéma `https://t3.codes/schema/t3.json`, client web du bundle | `gitgraph compat --online`, CI `t3-compat.yml` |
| Import des scripts (« Import scripts » / « From t3.json ») | Réglages → Projects, ou menu « + Add action » d'un fil | manuel |
| Champs requis de `defaultProjectScripts` (`id`, `name`, `command`, `icon`, `runOnWorktreeCreate`) | réglages T3 | manuel, voir `docs/t3-settings.md` |
| Refs internes `refs/t3/**` (checkpoints) | dépôts git | `src/server/graph.ts` les exclut |

## Carte du code

- `src/server/cli.ts` : entrée CLI (`serve`, `init`, `doctor`, `compat`), élection du serveur unique par port.
- `src/server/app.ts` : routes Hono, authentification par jeton, vérification Host et Origin.
- `src/server/graph.ts`, `actions.ts`, `watcher.ts`, `repos.ts`, `git.ts` : accès git et temps réel.
- `src/server/t3compat.ts` : lecture d'`app.asar` et du schéma public, pour vérifier la compatibilité.
- `src/server/commands.ts` : `init`, `doctor`, `compat`.
- `src/shared/` : types et `layout.ts` (placement du graphe), partagés avec l'UI.
- `src/web/` : interface React.

## Invariants à ne jamais casser

1. **Sécurité** : écoute sur `127.0.0.1` uniquement ; jeton obligatoire sur `/api/*` sauf `/api/ping` ; Host et Origin vérifiés ; `execFile("git", …)` sans shell ; `--end-of-options` avant toute ref venant de l'utilisateur ; noms de refs validés.
2. **Jamais `--all`** dans les commandes git : il inclurait `refs/t3/**`.
3. **Mac et Ubuntu** : Node ≥ 20, aucune dépendance native, aucune commande dépendante du shell dans `t3.json`, chemins portables. Le watcher utilise le récursif natif sur macOS et le polling sur Linux.
4. **Licence** : aucun code repris de l'extension VS Code Git Graph (mhutchie, licence restrictive).
5. **Tests** : ne jamais supprimer, affaiblir ou marquer « skip » un test pour obtenir un résultat vert. Si un comportement change volontairement, modifier le test dans le même commit et l'expliquer.

## Valider une modification

```sh
npm run typecheck && npm test && npm run build
node bin/gitgraph.js doctor
node bin/gitgraph.js compat --online
scripts/test-linux.sh        # Ubuntu 22.04 et 24.04 dans Docker (Docker requis)
```

## Si T3 Code casse l'intégration

Symptômes : `gitgraph compat` échoue, la CI `T3 Code compatibility` est rouge, gitgraph affiche
un avertissement au démarrage, ou le Preview ne s'ouvre plus.

1. **Contournement immédiat** : ouvrir `http://127.0.0.1:4777` à la main dans le Preview de T3 ou dans un navigateur. Le serveur fonctionne indépendamment de T3.
2. **Constater** : `node bin/gitgraph.js compat --online --json`. La sortie donne la version et le commit de T3 (`t3codeCommitHash`) ainsi que les champs manquants.
3. **Trouver le remplaçant** :
   - lire le schéma public, `curl -s https://t3.codes/schema/t3.json`, et chercher sous `properties.scripts.items.properties` un champ équivalent (renommé, déplacé) ;
   - si besoin, lire le code source de T3 Code au commit indiqué par `compat` (dépôt public `pingdotgg/t3code`) ;
   - consulter les notes de version de la nightly.
4. **Adapter, au plus petit périmètre** :
   - `REQUIRED_SCRIPT_FIELDS` dans `src/server/t3compat.ts` ;
   - `gitGraphScript()` dans `src/server/commands.ts` (ce qu'écrit `gitgraph init`) ;
   - `t3.json` à la racine du dépôt, `README.md`, `docs/t3-settings.md` ;
   - les tests correspondants (`commands`, `t3compat`).
5. **Valider** avec les commandes ci-dessus, puis dans le vrai T3 : réimporter le script (Réglages → Projects → Import scripts), le lancer, vérifier que le Preview affiche le graphe.
6. **Si T3 retire toute possibilité d'ouvrir une URL locale dans le Preview** : ne pas patcher T3. Documenter le contournement (navigateur) dans le README et signaler le besoin à l'équipe T3 Code.

## Conventions

- Code et commentaires en anglais ; README et docs utilisateur en français.
- Commits courts, au présent, un sujet par commit.
- Mettre à jour le README quand une commande ou une option change.
