# Agentic Coder a Windows (GPU NVIDIA)

Windows fa servir el mateix motor **CUDA** que Linux ([docs/linux.md](linux.md)): PyTorch, transformers en
4 bits, PEFT per entrenar betes i faster-whisper per dictar. Al Mac no canvia res: continua amb MLX.

> **Estat:** el camí de Windows s'ha escrit i provat amb proves unitàries al Mac, però **encara no s'ha
> executat en un Windows real**. El punt amb més risc la primera vegada és bitsandbytes, que fa el 4 bits:
> a Windows funciona a partir de les versions 0.43 o 0.44. Si alguna cosa falla, l'error surt a la finestra.

## Què cal

- Windows 10 o 11 de 64 bits, amb el controlador de NVIDIA (que `nvidia-smi` funcioni).
- Python 3.10 o més nou (de python.org; marca «Add to PATH»), i Node.js 20 o més nou.

## Instal·lar

**Des del repositori**, en PowerShell:

```powershell
git clone https://github.com/Celtico/agentic-coder-mvp.git
cd agentic-coder-mvp
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
npm start
```

**Amb l'instal·lador** (`.exe` de [Releases](https://github.com/Celtico/agentic-coder-mvp/releases)):

1. Instal·la l'app. No està signada: Windows pot dir «Windows ha protegit l'ordinador». Fes «Més
   informació» › «Executa igualment».
2. Prepara el motor a la carpeta de dades de l'app, des d'una còpia del repositori:
   ```powershell
   $env:MODELS_DIR = "$env:APPDATA\Agentic Coder\models"
   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
   ```

## Primers passos

Són els mateixos que a Linux:

1. Afegeix un model en safetensors des de Gestiona els models. Per exemple `Qwen/Qwen2.5-Coder-7B-Instruct`.
2. Tria'l al xat.
3. Per dictar, baixa el Whisper «(CUDA)».
4. Entrena una beta des d'Entrenament.

## Què canvia a Windows

- **Python:** el motor és `models\.cuda-venv\Scripts\python.exe`.
- **Ordres:** `npm` i `npx` s'executen amb els seus `.cmd`. Els arguments van entre cometes i, si en
  algun hi ha un caràcter especial de la consola (`& | < > ^ % "`), l'ordre no s'executa.
- **Aturar processos:** una avaluació, un entrenament o el servidor d'un projecte s'aturen amb
  `taskkill /T`, que tanca també tots els processos que han obert.
- **Un sol model a la GPU:** es fa amb el bloqueig de fitxers de Windows (`msvcrt`).
- **Fitxers de les betes:** es copien on al Mac es fa un enllaç, perquè a Windows els enllaços demanen
  permisos especials.

**Encara no ho fa a Windows:**

- Llegir imatges.
- El fons translúcid.
- Els semàfors de la finestra. La finestra és la del sistema.
