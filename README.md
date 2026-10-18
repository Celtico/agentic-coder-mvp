# Agentic Coder MVP (macOS Apple Silicon, 16 GB RAM)

Prototip local-first d'escriptori amb Electron + JavaScript + Transformers.js. No utilitza Ollama, llama.cpp ni un servidor LLM separat.

## Què inclou
- Aplicació d'escriptori Electron.
- Selecció d'una carpeta de projecte i exploració de fitxers.
- Inferència local amb `onnx-community/Qwen2.5-Coder-1.5B-Instruct` quantitzat Q4 mitjançant Transformers.js.
- Context limitat del projecte que prioritza `AGENTS.md`, README, manifestos de dependències i fitxers d’entrada; converses persistides localment i recuperació dels intercanvis completats des de `~/.agentic-coder/memory/sessions.jsonl` quan falten a l’historial de la interfície. La recuperació es mostra en una conversa separada i no substitueix les converses existents.
- Cerca semàntica local i opcionalment carregada per recuperar casos verificats del mateix projecte amb un model multilingüe independent de Qwen; si no està disponible, es manté la cerca per paraules.
- La lectura de context respecta regles habituals de `.gitignore` a l’arrel i als subdirectoris, inclosos comodins i negacions senzilles; també manté exclusions fixes per a carpetes generades i fitxers ocults.
- Execució explícita de `npm test` al projecte seleccionat.
- Execució confirmada de scripts existents del projecte i instal·lació confirmada de paquets npm.
- Panell Git de només lectura amb branca, estat, diff preparat i diff local; només mostra el repositori si coincideix amb la carpeta de projecte seleccionada.
- Límits bàsics de ruta i mida per a lectura/escriptura a través de l'IPC.
- Contracte `InferenceEngine` tipat i implementació Transformers.js aïllada de l'orquestrador.
- Registre local optatiu de casos verificats, amb procedència i confirmació de l'usuari; no entrena automàticament el model.

La decisió del motor, l'estat de compatibilitat de Qwen3-Coder-Next i les fases pendents d'aprenentatge verificable estan documentats a [`docs/engine-and-learning.md`](docs/engine-and-learning.md).

## Requisits
- macOS amb Apple Silicon.
- Node.js 20 LTS o posterior (recomanat).
- Connexió a internet per instal·lar dependències i descarregar inicialment els pesos de Qwen; si s’utilitza la cerca semàntica, també es descarrega el seu model multilingüe. Després, tots dos models s’executen localment des de la memòria cau.

## Inici

```bash
npm install
npm run check
npm start
```

La primera inferència pot trigar i descarregar fitxers de model. La primera cerca de casos verificats també pot descarregar el model d’embeddings. No s’envia el prompt a una API remota; Transformers.js baixa els models publicats a Hugging Face per preparar la memòria cau local.

## Limitacions conscients del MVP
- El model 1.5B és petit: serveix per validar la integració, però no s'ha d'esperar la qualitat d'un model de programació gran.
- El model s'executa a través del backend ONNX de Transformers.js; l'acceleració GPU en Electron/Node pot variar segons el backend i la configuració.
- La interfície permet obrir fitxers, editar-los i revisar el contingut abans de desar. El desat requereix confirmació explícita i crea una còpia de seguretat local a la carpeta de dades de l'aplicació. La resposta del model continua sent una proposta: no s'aplica automàticament.
- L'execució de tests és una acció explícita de l'usuari.
- El registre JSONL conserva els intercanvis complets de l’agent; les converses de la interfície es desen separadament a SQLite. Els casos verificats es poden cercar amb embeddings locals; això no entrena ni modifica el model generatiu.
- L'entrenament nocturn no està implementat encara. La fase següent ha d'afegir preparació de dades, avaluació independent, adaptadors/fine-tuning compatible, versions immutables i rollback. No s'ha de modificar el model actiu sense superar benchmarks.

## Seguretat
Utilitza només amb projectes de confiança. `npm test`, altres scripts npm i les instal·lacions de paquets demanen confirmació abans d’executar-se. Una instal·lació pot modificar `package.json`, `package-lock.json` i `node_modules`; la finestra de confirmació mostra el paquet, l’ordre i la carpeta. La instal·lació del navegador Chromium per a Playwright també té una confirmació pròpia. Revisa els canvis suggerits abans d’aplicar-los. No posis secrets al prompt ni als fitxers indexats.

Per a tasques de codi, l’agent ha d’inspeccionar instruccions i scripts, preparar un pla, implementar, executar comprovacions adequades i resumir els fitxers, resultats i limitacions. La inspecció amb Playwright només es pot afirmar quan el projecte tingui Playwright i les proves de navegador s’hagin executat; l’app demana confirmació abans d’instal·lar el paquet o Chromium. L’app encara no instal·la Playwright automàticament.

## Model i llicència
El model generatiu és `onnx-community/Qwen2.5-Coder-1.5B-Instruct`, publicat sota Apache-2.0. La cerca semàntica opcional utilitza `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, també sota Apache-2.0. Consulta els [model cards de Qwen](https://huggingface.co/onnx-community/Qwen2.5-Coder-1.5B-Instruct) i [MiniLM multilingüe](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) abans de redistribuir pesos o crear un producte.


## Fases del projecte

- [Primera fase: Agentic Desktop IDE](docs/primera-fase-projecte.md)
- [Segona fase: aprenentatge autònom i evolució del model](docs/segona-fase-projecte.md)

### Estat verificat

| Fase | Estat actual |
| --- | --- |
| Motor local | Transformers.js amb Qwen2.5-Coder-1.5B funciona dins d’un procés Node local. La prova d’execució sense xarxa i l’acceleració Metal encara estan pendents. |
| Orquestrador | Bucle local d’eines limitat, validació d’arguments, restricció a la carpeta seleccionada i confirmació abans d’escriure o executar. La generació es pot aturar tancant el procés aïllat del model, que es torna a carregar en la petició següent; les accions confirmades en curs no s’interrompen. No hi ha una eina de shell lliure per al model. |
| Navegador | Playwright ha inspeccionat una app Vue/Vite local: HTTP 200, sense errors de consola, pàgina ni xarxa, i captura desada. No s’ha validat encara el cicle complet d’editar, corregir un error preparat i tornar a provar. |
| Interfície | React, TypeScript, Chakra UI, xat amb historial local, panells separables, navegador integrat, terminal, editor amb revisió i panell Git de només lectura. La distribució instal·lable encara no està feta. |
| Memòria i aprenentatge | Converses guardades a SQLite local, associades al projecte quan se selecciona i restaurades amb la carpeta corresponent; migració des de `localStorage`. Els casos verificats es desen localment i se’n recuperen fins a tres del mateix projecte amb un model d’embeddings multilingüe local; si no es pot carregar, s’utilitza coincidència de paraules. L’entrenament automàtic continua pendent. |
| Distribució | L’app encara s’executa des del repositori; falten empaquetament, signatura i instal·lador de macOS. |

El registre detallat de la decisió del motor i de les limitacions és a [`docs/engine-and-learning.md`](docs/engine-and-learning.md).
