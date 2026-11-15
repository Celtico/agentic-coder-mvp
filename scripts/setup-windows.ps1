# Agentic Coder on Windows with NVIDIA GPUs: prepares the model engine (models\.cuda-venv) and the app.
# Run it from the repository's folder, in PowerShell:   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
# For the installed app (.exe) the engine goes to its data folder:
#   $env:MODELS_DIR = "$env:APPDATA\Agentic Coder\models"; powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
# docs/windows.md explains each step.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { Write-Error "No trobo nvidia-smi: cal el controlador de NVIDIA instal·lat." }
Write-Host "GPU:"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
$python = if (Get-Command py -ErrorAction SilentlyContinue) { 'py' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { Write-Error "Cal Python 3.10 o més nou." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "Cal Node.js 20 o més nou." }

$models = if ($env:MODELS_DIR) { $env:MODELS_DIR } else { 'models' }
$venv = Join-Path $models '.cuda-venv'
New-Item -ItemType Directory -Force -Path $models | Out-Null
& $python -m venv $venv
$pip = Join-Path $venv 'Scripts\pip.exe'
& (Join-Path $venv 'Scripts\python.exe') -m pip install --upgrade pip
$index = if ($env:TORCH_INDEX) { $env:TORCH_INDEX } else { 'https://download.pytorch.org/whl/cu124' }
& $pip install torch --index-url $index
& $pip install -r requirements-linux.txt
& (Join-Path $venv 'Scripts\python.exe') -c "import torch; print('CUDA:', torch.cuda.is_available(), '·', torch.cuda.device_count(), 'GPU')"

# From the repository (not needed for the installed app).
if (-not $env:MODELS_DIR) { npm install }
Write-Host ""
Write-Host "Fet. Obre l'app amb: npm start"
Write-Host "Després, a Aprenentatge local > Gestiona els models > Afegeix un model, posa un model en safetensors"
Write-Host "(per exemple Qwen/Qwen2.5-Coder-7B-Instruct) i, per dictar, baixa el Whisper de la mateixa llista."
