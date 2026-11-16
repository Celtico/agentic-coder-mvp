# Motor natiu (prototip)

Addon de Node (N-API) que executa el model MLX directament des de Node, sense
Python: **generació de text** i **LoRA** (carregar adaptadors i entrenar-los).
Funciona amb models d'arquitectura Qwen3.5 en format mlx-community (el MiMo
V2.6 9B OptiQ 4-bit ho és).

## Com està fet

- `src/qwen35.cpp`: el model Qwen3.5 (24 capes Gated DeltaNet + 8 d'atenció
  completa) escrit amb l'API C++ d'MLX. És un port de `mlx_lm/models/qwen3_5.py`
  i `gated_delta.py` (mlx-lm 0.32.2); el kernel Metal del Gated DeltaNet està
  copiat tal qual. Sense GPU fa servir el mateix camí d'operacions que mlx-lm.
- `src/addon.cpp`: la classe `Engine` per a Node (`start`, `next`, `logits`,
  `reset`, `memory`) i el mostreig (temperatura, top-p, top-k) igual que mlx-lm.
- `index.js`: llegeix el `config.json` del model (inclosa la quantització
  4/8 bits per capa) i crea l'`Engine`.
- `src/prompt_cache.h`: memòria cau de prompts com la del worker Python
  (`LRUPromptCache`, 8 entrades, 1 GB). Desa còpies de la memòria cau del model
  (al final de la generació i als mateixos punts de control que el worker, a
  partir de 256 tokens) i el missatge següent només llegeix el que és nou.
  `generate(..., { cache: false })` la desactiva; canviar adaptadors la buida.
- `chat.js`: tokenitzador i plantilla de xat en JS (`@huggingface/tokenizers`,
  `@huggingface/jinja`) i text en streaming.
- `src/lora.cpp` i `lora.js`: LoRA com `mlx_lm lora` (mateixos noms de
  paràmetres, inicialització, pèrdua amb `mask_prompt`, Adam, farciment a
  múltiples de 32 i checkpoint de gradients). Desa `adapters.safetensors` i
  `adapter_config.json`, que es carreguen tant a mlx-lm com aquí
  (`NativeModel.loadAdapters(carpeta)`), així que les betes actuals també
  serveixen. L'únic que canvia és l'ordre aleatori dels exemples (mlx-lm fa
  servir numpy).

MLX no es compila: s'enllaça amb la `libmlx` que porta el paquet pip
(`mlx-metal` al Mac). En compilar, `libmlx.dylib` i `mlx.metallib` es copien al
costat de l'addon, així que en execució no cal Python.

Les crides són síncrones. A l'app s'ha d'executar en un procés a part
(utilityProcess), com el worker de Python, perquè si la GPU falla no s'emporti
l'app.

## Compilar

Cal clang (Xcode Command Line Tools) i cmake (`brew install cmake`).

```sh
cd native
npm install
npm run build        # troba MLX a ../models/.mlx-venv (o MLX_PYTHON=...)
```

## Provar

```sh
node scripts/prova.js ../models/mlx/<model> "missatge" --compare
```

Mostra la resposta, la velocitat i la memòria. Amb `--compare` també executa
mlx-lm amb els mateixos tokens i diu si la sortida és idèntica, i comprova que
el tokenitzador JS doni els mateixos tokens que el de Python.

LoRA (train.jsonl amb una línia `{"messages": [...]}` per exemple):

```sh
node scripts/prova-lora.js ../models/mlx/<model> train.jsonl /tmp/beta-prova \
  --iters 10 --mask-prompt --grad-checkpoint
```

Tests (model aleatori petit, comparat amb mlx-lm):

```sh
python test/make_tiny.py /tmp/tiny       # amb el python que té mlx-lm
python test/make_lora_ref.py /tmp/tiny   # referència LoRA (inclou `mlx_lm lora`)
TINY_MODEL=/tmp/tiny npm test
```

## Què falta

- Integrar-lo a l'app com a motor alternatiu al worker de Python.
- LoRA: lots de més d'un exemple, acumulació de gradients, programació del
  learning rate i DoRA (l'app fa servir lots d'1, que ja funciona).
- Visió (imatges).
- Altres arquitectures (Gemma, Qwen2.5...).
