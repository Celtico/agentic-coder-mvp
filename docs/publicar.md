# Com publicar una versió

Les versions segueixen [Semantic Versioning](https://semver.org/lang/ca/):

- **pedaç** (`0.1.1`): correccions;
- **menor** (`0.2.0`): funcionalitats noves;
- **major** (`1.0.0`): canvis que trenquen el que hi havia.

## Els passos

1. **Pujar la versió** a `package.json`, al camp `version`, per exemple `0.2.0`. També es pot fer amb
   `npm version 0.2.0 --no-git-tag-version`.
2. **Actualitzar `CHANGELOG.md`:**
   - mou el que hi ha a `## [Unreleased]` a una secció nova, `## [0.2.0] - AAAA-MM-DD`;
   - afegeix l’enllaç de la versió al final del fitxer.
3. **Fer el commit:**
   ```bash
   git commit -am "versió 0.2.0"
   ```
4. **Crear el tag i pujar-lo:**
   ```bash
   git push origin main
   git tag v0.2.0
   git push origin v0.2.0
   ```

En pujar el tag, GitHub Actions (`.github/workflows/release.yml`) fa això:

1. Comprova que el tag coincideix amb la versió de `package.json`.
2. Passa les proves (al Mac).
3. Construeix l’app: un `.dmg` per a Mac amb Apple Silicon, i un `.AppImage` i un `.deb` per a Linux.
4. Crea la Release amb aquests fitxers. Les notes de la Release són la secció de la versió al `CHANGELOG.md`.

Es pot seguir a la pestanya **Actions** del repositori. La Release surt a **Releases**.

## Si falla

- **«El tag no coincideix amb la versió de package.json»:** esborra el tag i torna a fer els passos amb la
  mateixa versió als dos llocs.
  ```bash
  git tag -d v0.2.0
  git push origin :refs/tags/v0.2.0
  ```
- **«CHANGELOG.md no té cap secció»:** afegeix la secció `## [0.2.0]` i torna a crear el tag.
