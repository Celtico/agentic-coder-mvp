# Canvis

Tots els canvis destacats d’Agentic Coder. El format segueix [Keep a Changelog](https://keepachangelog.com/ca/1.1.0/)
i les versions, [Semantic Versioning](https://semver.org/lang/ca/):

- **pedaç** (0.1.**1**): correccions;
- **menor** (0.**2**.0): funcionalitats noves;
- **major** (**1**.0.0): canvis que trenquen el que hi havia.

Com publicar-ne una: [docs/publicar.md](docs/publicar.md).

## [Unreleased]

## [0.1.0] - 2026-11-15

La primera versió publicada.

### Agent
- Agent de programació local que treballa sobre la carpeta del projecte. Fa servir eines per llegir,
  escriure i esborrar fitxers, cercar, fer proves, arrencar l’app, fer commits, navegar i usar servidors MCP.
- Revisor de canvis opcional i delegació de tasques.
- Llegeix les crides d’eina en el format de cada model: JSON, XML de Qwen3-Coder i Gemma 4. També entén
  els formats barrejats d’alguns models.
- Imatges adjuntes per als models amb visió.
- Dictat amb Whisper local: el text surt mentre parles i el silenci no arriba a Whisper.

### Avaluació
- Benchmark de tasques obertes, apps des d’una carpeta buida i una tasca dirigida.
- Comparativa per model: per defecte mostra la darrera avaluació completa, amb un selector per veure’n
  una altra o «Totes».
- Detall de cada avaluació: què ha vist i què ha respost el model a cada torn, i els projectes que ha fet.

### Aprenentatge local (LoRA)
- Casos verificats des del xat i dades manuals.
- Dataset preparat: es pot revisar i descarregar.
- Entrenament de betes i versions estables amb LoRA, sempre des de l’original. El model base no es toca mai.

### Models
- MLX al Mac (Apple Silicon): MiMo V2.6 9B (el model base), MiMo amb visió, Gemma 4 12B i
  Qwen2.5-Coder 7B.
- Gestiona els models:
  - llista amb la mida de cada model;
  - interruptor «Al selector»;
  - afegir models de Hugging Face;
  - treure models a la Paperera.
- Un sol model a la GPU alhora.
- Log del model: el que entra i surt de cada crida, les mètriques i, si vols, la probabilitat de cada token.

### Interfície
- Electron, React i Chakra UI v3, amb tokens de Chakra.
- Panells que es poden moure a la barra lateral: converses, fitxers, editor amb l’Historial local,
  navegador, Git, consola, terminal, avaluació, aprenentatge i log del model.
- Preferències d’aparença: tema, accent, capçaleres, estil i fons dels panells, diàlegs i fons translúcid
  (macOS).
- La versió de l’app surt sota el logo.

### Linux
- Motor CUDA per a GPU NVIDIA:
  - transformers en 4 bits, repartit entre totes les GPU;
  - entrenament LoRA amb PEFT;
  - dictat amb faster-whisper;
  - models en safetensors.
- Guia i script d’instal·lació: [docs/linux.md](docs/linux.md).
- Encara no s’ha provat en un PC amb GPU NVIDIA.

[Unreleased]: https://github.com/Celtico/agentic-coder-mvp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Celtico/agentic-coder-mvp/releases/tag/v0.1.0
