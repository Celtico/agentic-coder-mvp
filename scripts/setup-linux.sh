#!/usr/bin/env bash
# Agentic Coder on Linux with NVIDIA GPUs: prepares the model engine (models/.cuda-venv) and the app.
# Run it from the repository's folder: bash scripts/setup-linux.sh   (docs/linux.md explains each step)
# For the installed app (AppImage or .deb) the engine goes to its data folder:
#   MODELS_DIR=~/.config/Agentic\ Coder/models bash scripts/setup-linux.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v nvidia-smi >/dev/null || { echo "No trobo nvidia-smi: cal el controlador de NVIDIA instal·lat."; exit 1; }
echo "GPU:"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
command -v python3 >/dev/null || { echo "Cal Python 3.10 o més nou (python3)."; exit 1; }
command -v node >/dev/null || { echo "Cal Node.js 20 o més nou (node)."; exit 1; }

# PyTorch for CUDA 12 from PyTorch's own index; then the rest (transformers, peft, bitsandbytes, faster-whisper…).
MODELS="${MODELS_DIR:-models}"
VENV="$MODELS/.cuda-venv"
mkdir -p "$MODELS"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install torch --index-url "${TORCH_INDEX:-https://download.pytorch.org/whl/cu124}"
"$VENV/bin/pip" install -r requirements-linux.txt
"$VENV/bin/python" -c "import torch; print('CUDA:', torch.cuda.is_available(), '·', torch.cuda.device_count(), 'GPU')"

# From the repository (not needed for the installed app).
[ -n "${MODELS_DIR:-}" ] || npm install
echo
echo "Fet. Obre l'app amb: npm start"
echo "Després, a Aprenentatge local › Gestiona els models › Afegeix un model, posa un model en safetensors"
echo "(per exemple Qwen/Qwen2.5-Coder-7B-Instruct) i, per dictar, baixa el Whisper de la mateixa llista."
