# Identité Régis

Logo « Présence » : trois disques concentriques. La couleur du noyau traduit l'état de l'assistant.

| Fichier | Usage |
|---|---|
| `regis-icon.svg` | Source des icônes d'app (`src-tauri/icons/`) |
| `regis-state-*.svg` | États : `idle`, `listening`, `thinking`, `approval`, `recording` (composant `PresenceMark` dans l'UI) |
| `regis-tray-dark.svg` / `regis-tray-light.svg` | Tray mono : glyphe sombre pour barre claire, glyphe blanc pour barre sombre |

Régénération (depuis `apps/desktop`) :

```bash
npx tauri icon ../../docs/design/brand/regis-icon.svg -o <dossier-temporaire>
npx tauri icon ../../docs/design/brand/regis-tray-dark.svg -o <dossier-temporaire> -p 32
```

Copier ensuite uniquement les fichiers listés dans `bundle.icon` de `tauri.conf.json`, et les PNG 32 px du tray dans `src-tauri/icons/tray/`.
Le `identifier` (`io.github.chwazy.regis`) et le service keyring `regis` fixent le dossier de données et le coffre : les changer rend les données et les secrets existants introuvables.
