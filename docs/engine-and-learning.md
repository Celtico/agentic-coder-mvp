# Motor local i aprenentatge verificable

## Decisió del motor

La versió actual conserva `onnx-community/Qwen2.5-Coder-1.5B-Instruct` amb Transformers.js i ONNX Runtime. El model es carrega en un procés Node aïllat de l’UI, i la memòria cau es desa a `models/` dins del projecte de l’aplicació. La primera càrrega necessita Internet per obtenir els pesos; un cop complets, l’execució és local. No hi ha cap servei LLM extern, Ollama ni procés `llama.cpp`.

El codi separa ara el contracte `InferenceEngine` de l’orquestrador. `TransformersJsInferenceEngine` n’és la implementació actual i exposa càrrega, generació, descàrrega, estat i ús de memòria. Això permet provar altres runtimes sense reescriure la lògica de projecte.

Qwen3-Coder-Next no s’activa com a candidat encara. La fitxa oficial el descriu com a 80B paràmetres totals (3B activats) en BF16; “3B actius” no implica que el model càpiga en 16 GB de RAM. La cerca feta no ha localitzat una distribució ONNX compatible i verificada per Transformers.js. Per tant, no es descarrega, no es converteix automàticament i no substitueix el model estable.

Transformers.js usa ONNX Runtime. ONNX Runtime documenta un CoreML Execution Provider per macOS, però això no demostra que el paquet Node utilitzat per aquesta aplicació l’estigui carregant. L’acceleració Apple Silicon queda pendent d’una prova mesurada al Mac; no es mostra com a disponible fins llavors.

## Aprenentatge i versions

- L’historial existent de xat és context, no dades d’entrenament aprovades. L’usuari pot desar manualment una resposta com a cas verificat indicant l’evidència; l’app demana confirmació, intenta detectar credencials conegudes i desa el registre local amb permisos restringits.
- Els casos verificats són una col·lecció curada amb procedència, no un procés d’entrenament ni una garantia que el contingut sigui correcte. L’agent recupera fins a tres exemples amb coincidència de paraules a partir de la petició desada i només els inclou quan pertanyen exactament al mateix directori de projecte. No s’utilitzen embeddings.
- Les còpies de seguretat dels fitxers editats són separades de la memòria de l’agent.
- Els embeddings i la cerca semàntica han de ser un component independent de la generació. Encara no estan implementats.
- No hi ha fine-tuning ni tasca nocturna activa. El primer pas de curació manual ja desa casos a `userData/learning/verified-experiences.jsonl`. Abans d’entrenar cal auditar-ne la qualitat, afegir avaluacions repetibles i validar un runtime d’entrenament compatible amb el model i el Mac.
- Els pesos estables no s’han de sobreescriure. Qualsevol candidat futur s’ha de guardar en una ubicació versionada, avaluar amb tasques fixes i activar només després de superar els criteris objectius.

## Estat del flux de l’agent

Ja existeixen selecció persistent de projecte, context de fitxers limitat, edició amb confirmació i còpia de seguretat, terminal amb confirmació i un webview integrat. El recopilador de context aplica regles habituals de `.gitignore` de l’arrel i dels subdirectoris (patrons de noms, comodins, directoris i negacions senzilles), a més d’exclusions fixes per a fitxers ocults i carpetes generades. No és una implementació completa de totes les particularitats de Git ignore. L’agent ara té un bucle limitat de fins a sis crides JSON validades per l’orquestrador: llistar, cercar i llegir fitxers, proposar crear o modificar fitxers i demanar `npm test`. Cada escriptura es mostra completa en un diàleg natiu amb una diferència resumida; només s’aplica amb aprovació i fa còpia de seguretat quan reemplaça un fitxer. Les proves també requereixen aprovació i retornen el codi de sortida i la sortida reals.

El bucle de l’agent pot inspeccionar una URL local amb Playwright quan el projecte seleccionat tingui la biblioteca i Chromium instal·lats. Abans d’obrir el navegador demana confirmació; només accepta `localhost`, `127.0.0.1` i `::1`. Retorna el títol, el codi HTTP, errors de consola/pàgina/xarxa i la ruta d’una captura local. Si Playwright falta, l’agent pot proposar instal·lar `@playwright/test` i Chromium mitjançant les confirmacions existents.

La inspecció s’ha validat a l’app amb un projecte Vue/Vite local: HTTP 200, títol `Vite App`, cap error de consola, pàgina o xarxa, i captura PNG desada a les dades locals de l’aplicació. Després de la prova, la resposta s’ha canviat perquè l’orquestrador presenti directament els fets retornats per Playwright, sense demanar al model que els reescrigui.

Encara falten ordres arbitràries des del bucle d’eines, vista de diff dedicada, persistència SQLite, cancel·lació real de generació, embeddings i entrenament. Aquests elements no es consideren completats ni se simulen.

## Fonts tècniques consultades

- [Transformers.js: configuració de cache i models locals](https://huggingface.co/docs/transformers.js/api/env)
- [Model ONNX Qwen2.5-Coder-1.5B-Instruct](https://huggingface.co/onnx-community/Qwen2.5-Coder-1.5B-Instruct)
- [Model card Qwen3-Coder-Next](https://huggingface.co/Qwen/Qwen3-Coder-Next)
- [ONNX Runtime: CoreML Execution Provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
