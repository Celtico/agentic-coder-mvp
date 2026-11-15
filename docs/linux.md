# Agentic Coder a Linux (GPU NVIDIA)

Al Mac l'app fa servir **MLX**, i no canvia res. A Linux fa servir un motor **CUDA**: PyTorch i
transformers a les GPU NVIDIA. L'app, les converses, els casos verificats, l'avaluació i el flux de
betes i estables són els mateixos. Només canvia el motor que hi ha a sota.

> **Estat:** el camí de Linux s'ha escrit i provat amb proves unitàries al Mac, però **encara no s'ha
> executat en un PC amb GPU NVIDIA**. La primera vegada, segueix els passos d'aquí sota i comprova cada
> cosa. Si alguna cosa falla, l'error surt a la finestra.

## Què cal

- Linux x86-64 amb el controlador de NVIDIA (que `nvidia-smi` funcioni).
- Python 3.10 o més nou, i Node.js 20 o més nou.
- Les GPU: amb dues RTX 3070 (2 × 8 GB) hi caben models de 7–9B carregats en 4 bits, repartits entre les
  dues targetes. També s'hi poden entrenar betes amb QLoRA.

## Instal·lar

```bash
git clone <el repositori> && cd agentic-coder-mvp
bash scripts/setup-linux.sh
npm start
```

L'script fa això:

1. Crea `models/.cuda-venv`.
2. Hi instal·la PyTorch per a CUDA 12, des de l'índex de PyTorch. Amb una altra versió de CUDA:
   `TORCH_INDEX=https://download.pytorch.org/whl/cu121 bash scripts/setup-linux.sh`.
3. Hi instal·la la resta: transformers, accelerate, bitsandbytes, peft i faster-whisper
   (`requirements-linux.txt`).
4. Comprova que PyTorch veu les GPU.
5. Fa `npm install`.

## Primers passos a l'app

1. **Afegir un model.** Ves a Aprenentatge local › Gestiona els models › «Afegeix un model» i escriu un
   model de Hugging Face en **safetensors normals**, no MLX. Per exemple: `Qwen/Qwen2.5-Coder-7B-Instruct`.
   - Fes «Comprova» i després «Baixa». El model va a `models/hf/<nom>`.
   - El límit de mida surt de la memòria de les GPU (`nvidia-smi`): el model es baixa en 16 bits i es
     carrega en 4.
   - Els models MLX es rebutgen, perquè són per a Mac.
2. **Triar-lo** al selector del xat i escriure-hi. A Log del model hi veuràs el motor «cuda».
3. **Dictat.** A la mateixa llista hi ha «Whisper large-v3 turbo (CUDA)», que funciona amb faster-whisper.
   Baixa'l amb la fletxa.
4. **Entrenar una beta.** Funciona igual que al Mac: Aprenentatge local › Entrenament › Beta. Fa servir
   PEFT QLoRA (`src/core/assistant/cuda-lora.py`). El model base no es toca mai: la beta és un adaptador a
   `models/adapters/<model>/beta-N-…`.
   Els casos verificats són els mateixos fitxers que al Mac, així que els pots copiar d'un ordinador a
   l'altre.

## Com està fet

| | Mac | Linux |
|---|---|---|
| Motor del xat | `mlx-worker.py` (mlx-lm / mlx-vlm) | `cuda-worker.py` (transformers, 4 bits, `device_map=auto`) |
| Lectura de crides i historial | `mlx_text.py` | el mateix `mlx_text.py` |
| Entrenament | `mlx_lm lora` / `fuse` | `cuda-lora.py lora` / `fuse` (PEFT), amb la mateixa línia d'ordres |
| Models | `models/mlx/…` (MLX) | `models/hf/…` (safetensors) |
| Dictat | mlx-whisper | faster-whisper (CTranslate2) a `models/whisper/…` |
| Un sol model a la GPU | `~/.agentic-coder/mlx.lock` | el mateix bloqueig |
| Paquet | `npm run dist:mac` (dmg) | `npm run dist:linux` (AppImage i deb) |

**Encara no ho fa a Linux:**

- Llegir imatges. Els models amb visió són de mlx-vlm, només per a Mac.
- El fons translúcid.
- Els semàfors propis de la finestra. A Linux, la finestra és la del sistema.
