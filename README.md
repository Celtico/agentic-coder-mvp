# Agentic Coder MVP (macOS Apple Silicon, 16 GB RAM)

Prototip local-first d'escriptori amb Electron + JavaScript + Transformers.js. No utilitza Ollama, llama.cpp ni un servidor LLM separat.

## Què inclou
- Aplicació d'escriptori Electron.
- Selecció d'una carpeta de projecte i exploració de fitxers.
- Inferència local amb `onnx-community/Qwen2.5-Coder-1.5B-Instruct` quantitzat Q4 mitjançant Transformers.js.
- Context limitat del projecte i registre local de les converses a `~/.agentic-coder/memory/sessions.jsonl`.
- Execució explícita de `npm test` al projecte seleccionat.
- Límits bàsics de ruta i mida per a lectura/escriptura a través de l'IPC.
- Contracte `InferenceEngine` tipat i implementació Transformers.js aïllada de l'orquestrador.

La decisió del motor, l'estat de compatibilitat de Qwen3-Coder-Next i les fases pendents d'aprenentatge verificable estan documentats a [`docs/engine-and-learning.md`](docs/engine-and-learning.md).

## Requisits
- macOS amb Apple Silicon.
- Node.js 20 LTS o posterior (recomanat).
- Connexió a internet només per instal·lar dependències i descarregar els pesos la primera vegada. Després de la descàrrega, el model queda a la memòria cau local.

## Inici

```bash
npm install
npm run check
npm start
```

La primera inferència pot trigar i descarregar fitxers de model. No s'envia el prompt a una API remota; Transformers.js baixa el model publicat al repositori Hugging Face per preparar la memòria cau local.

## Limitacions conscients del MVP
- El model 1.5B és petit: serveix per validar la integració, però no s'ha d'esperar la qualitat d'un model de programació gran.
- El model s'executa a través del backend ONNX de Transformers.js; l'acceleració GPU en Electron/Node pot variar segons el backend i la configuració.
- La interfície permet obrir fitxers, editar-los i revisar el contingut abans de desar. El desat requereix confirmació explícita i crea una còpia de seguretat local a la carpeta de dades de l'aplicació. La resposta del model continua sent una proposta: no s'aplica automàticament.
- L'execució de tests és una acció explícita de l'usuari.
- La memòria actual és un registre JSONL, encara no una base vectorial ni una memòria amb embeddings.
- L'entrenament nocturn no està implementat encara. La fase següent ha d'afegir preparació de dades, avaluació independent, adaptadors/fine-tuning compatible, versions immutables i rollback. No s'ha de modificar el model actiu sense superar benchmarks.

## Seguretat
Utilitza només amb projectes de confiança. `npm test` executa codi del projecte seleccionat. Revisa els canvis suggerits abans d'aplicar-los. No posis secrets al prompt ni als fitxers indexats.

## Model i llicència
`onnx-community/Qwen2.5-Coder-1.5B-Instruct`, publicat sota Apache-2.0. Consulta el model card abans de redistribuir pesos o crear un producte.
