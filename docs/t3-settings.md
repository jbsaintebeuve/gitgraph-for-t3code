# Intégration T3 Code : schéma exact et import

Vérifié en lecture seule dans le bundle **T3 Code (Nightly)** installé (`app.asar`, `binCli-*.mjs` et assets client).
Le schéma peut changer d'une nightly à l'autre : revérifier si un réglage cesse de fonctionner.

## Deux niveaux de configuration

| Niveau | Où | Portée |
| --- | --- | --- |
| `t3.json` | racine du dépôt (`gitgraph init`) | un projet, partageable via git |
| `defaultProjectScripts` | réglages T3 (`settings.json` serveur) | tous les projets |

## Schéma d'un script dans les réglages (`ProjectScript`)

| Clé | Type | Obligatoire |
| --- | --- | --- |
| `id` | string non vide | oui (absent du `t3.json`) |
| `name` | string non vide | oui |
| `command` | string non vide | oui |
| `icon` | `"play" \| "test" \| "lint" \| "configure" \| "build" \| "debug"` | oui |
| `runOnWorktreeCreate` | boolean | oui |
| `runOnSettle`, `async` | boolean | non |
| `previewUrl` | string | non (build desktop uniquement) |
| `autoOpenPreview` | boolean | non |

Clés de réglages concernées :

- `defaultProjectScripts`: tableau de `ProjectScript` (défaut `[]`), appliqué à tous les projets.
- `projectScriptOverrides`: `Record<ProjectId, ProjectScript[] | null>` (legacy, dérivé de `projectSettingsOverrides[<id>].defaultProjectScripts`). Une entrée **remplace** la liste du projet; `null` revient aux scripts par défaut.

Précédence côté client (fonction de résolution du bundle) : override du projet, sinon scripts propres au projet (ceux déjà importés), sinon `defaultProjectScripts`. Conséquence : un projet qui possède déjà ses propres scripts **ne voit pas** les scripts par défaut.

### Exemple (`gitgraph init --global-snippet` l'affiche)

```json
{
  "defaultProjectScripts": [
    {
      "id": "git-graph",
      "name": "Git Graph",
      "command": "gitgraph --repo .",
      "icon": "debug",
      "previewUrl": "http://127.0.0.1:4777",
      "autoOpenPreview": true,
      "runOnWorktreeCreate": false
    }
  ]
}
```

Fusionner cette clé dans le fichier de réglages de T3 (sur macOS : `~/.t3/userdata/settings.json`; sur Ubuntu, le dossier `userdata` de votre installation T3, à vérifier : le chemin dépend du build). Fermer T3 avant d'éditer, ou passer par l'interface (Réglages, Projets, Actions) plutôt que par le fichier. Ce dépôt ne modifie jamais ce fichier.

## `t3.json` : lecture et import

- T3 lit `t3.json` à la racine du projet (`T3_PROJECT_FILE_NAME`), validé par le schéma `https://t3.codes/schema/t3.json` : `scripts` (max 50), chaque script avec `name`, `command`, `icon`, `runOnWorktreeCreate`, `runOnSettle`, `async`, `previewUrl`, `autoOpenPreview`.
- **Les scripts de `t3.json` ne sont pas activés automatiquement.** Dans la version actuelle, les scripts s'appellent des **actions**. Pour les importer, une fois par projet : **Réglages → Projects → le projet → "Import scripts" ("Import from t3.json")**, ou le menu du bouton **"+" ("Add action")** en haut d'un fil, section **"From t3.json"**. Ces entrées n'apparaissent que pour les scripts pas encore importés, et si `t3.json` est valide et à la racine du dossier du projet.
- L'import copie le script dans les réglages du projet (`previewUrl`/`autoOpenPreview` conservés, `autoOpenPreview` forcé à `false` sans `previewUrl`). Les doublons (même `command` ou même nom, sans tenir compte de la casse) sont filtrés.
- Les autres clés (`iconPath`, `defaultThreadEnvMode`, `worktreeSubmodules`) sont lues directement depuis le fichier.

## Limites

- `previewUrl` n'est honoré que par le **build desktop** de T3 (pas en mode web).
- Un `previewUrl` est statique : tous les projets pointent vers le même serveur partagé `127.0.0.1:4777`.
- Les builds Nightly changent : le schéma ci-dessus est celui observé sur cette machine, pas une garantie.
