# Com publicar una versió

Les versions es numeren igual que a GesProd. El número és la quantitat de commits de la branca `main`:
`v322`, `v323`… Puja tot sol a cada commit i no s'ha de tocar enlloc.

- L'app el mostra sota el logo. Si hi passes per sobre, mostra el commit.
- Des del repositori, el llegeix de git cada vegada que s'obre.
- L'app instal·lada porta el número i el commit amb què es va construir.

## Publicar-ne una

1. Puja els commits:
   ```bash
   git push origin main
   ```
2. A GitHub, ves a **Actions** › **Publica una versió** › **Run workflow**, sobre `main`.

GitHub fa això:

1. Crea la Release `vN`. N és la quantitat de commits.
2. Hi posa com a notes els missatges dels commits des de la versió anterior.
3. Construeix l'app i hi afegeix els fitxers: un `.dmg` per a Mac amb Apple Silicon, i un `.AppImage` i un
   `.deb` per a Linux.

Els missatges dels commits no han de seguir cap format especial, com `feat:` o `fix:`. Les notes són els
missatges tal com els escrius, en català.

## Si falla

- Ho veuràs a **Actions**. Si la Release ja s'ha creat però li falten fitxers, torna a llançar només el
  treball que ha fallat: **Re-run failed jobs**.
- Per publicar el mateix número una altra vegada, esborra abans la Release i el tag `vN` a GitHub.
