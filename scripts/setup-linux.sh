#!/usr/bin/env bash
# Agentic Coder on Linux with NVIDIA GPUs: prepares the model engine (models/.cuda-venv) and the app.
# Run it from the repository's folder: bash scripts/setup-linux.sh   (docs/linux.md explains each step)
set -euo pipefail
cd "$(dirname "$0")/.."

command -v nvidia-smi >/dev/null || { echo "No trobo nvidia-smi: cal el controlador de NVIDIA instal·lat."; exit 1; }
echo "GPU:"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
command -v python3 >/dev/null || { echo "Cal Python 3.10 o més nou (python3)."; exit 1; }
command -v node >/dev/null || { echo "Cal Node.js 20 o més nou (node)."; exit 1; }

# PyTorch for CUDA 12 from PyTorch's own index; then the rest (transformers, peft, bitsandbytes, faster-whisper…).
python3 -m venv models/.cuda-venv
models/.cuda-venv/bin/pip install --upgrade pip
models/.cuda-venv/bin/pip install torch --index-url "${TORCH_INDEX:-https://download.pytorch.org/whl/cu124}"
models/.cuda-venv/bin/pip install -r requirements-linux.txt
models/.cuda-venv/bin/python -c "import torch; print('CUDA:', torch.cuda.is_available(), '·', torch.cuda.device_count(), 'GPU')"

npm install
echo
echo "Fet. Obre l'app amb: npm start"
echo "Després, a Aprenentatge local › Gestiona els models › Afegeix un model, posa un model en safetensors"
echo "(per exemple Qwen/Qwen2.5-Coder-7B-Instruct) i, per dictar, baixa el Whisper de la mateixa llista."
