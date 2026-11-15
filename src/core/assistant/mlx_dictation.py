"""Dictation: transcribes one WAV on this Mac with mlx-whisper, then ends (src/electron/dictation.cjs).

    python mlx_dictation.py <model folder> <audio.wav> <language: auto | ca | es | en>
    python mlx_dictation.py --serve <model folder> <language>

The second form keeps the model loaded while the user dictates (live dictation): it prints {"ready": true}
and then reads one JSON line per audio file ({"id": n, "file": "...wav"}) and prints {"id": n, "text": "..."}
(or {"id": n, "error": "..."}) for each, until its input closes.

Prints one JSON line: {"text": "..."} or {"error": "..."}. It takes the GPU lock like any model process
(mlx_lock.py) and frees it when it ends. The WAV (16 kHz, mono, 16 bits) is read with the standard library,
so no ffmpeg is needed.
"""

import json
import os
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LANGUAGES = ("ca", "es", "en")


def language_option(value):
    """None lets Whisper detect the language; otherwise one of the languages offered in Preferències."""
    return value if value in LANGUAGES else None


def read_wav(path):
    """The samples of a 16 kHz mono 16-bit WAV as float32 in [-1, 1]."""
    import numpy as np

    with wave.open(path, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
            raise ValueError("l’àudio ha de ser WAV de 16 kHz, mono i 16 bits")
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve(model_dir, language):
    """Live dictation: the model stays loaded (and the GPU lock held) until stdin closes."""
    try:
        import mlx_whisper
    except ImportError:
        emit({"error": "Falta mlx-whisper al runtime MLX: el dictat no funcionarà fins que s’instal·li."})
        return 1
    import mlx_lock

    try:
        lock = mlx_lock.acquire()  # noqa: F841 — kept until this process ends
    except RuntimeError as error:
        emit({"error": str(error)})
        return 1
    emit({"ready": True})
    for line in sys.stdin:
        try:
            job = json.loads(line)
        except ValueError:
            continue
        job_id = job.get("id")
        try:
            result = mlx_whisper.transcribe(read_wav(job["file"]), path_or_hf_repo=model_dir, language=language_option(language), task="transcribe", verbose=None)
            emit({"id": job_id, "text": str(result.get("text", "")).strip()})
        except Exception as error:  # noqa: BLE001 — the window shows what went wrong
            emit({"id": job_id, "error": f"No s’ha pogut transcriure: {error}"})
    return 0


def main(argv):
    if len(argv) == 4 and argv[1] == "--serve":
        return serve(argv[2], argv[3])
    if len(argv) != 4:
        emit({"error": "Ús: mlx_dictation.py <model> <àudio.wav> <idioma>"})
        return 2
    model_dir, audio_path, language = argv[1], argv[2], argv[3]
    try:
        import mlx_whisper
    except ImportError:
        emit({"error": "Falta mlx-whisper al runtime MLX: el dictat no funcionarà fins que s’instal·li."})
        return 1
    import mlx_lock

    try:
        lock = mlx_lock.acquire()  # noqa: F841 — kept until this process ends
    except RuntimeError as error:
        emit({"error": str(error)})
        return 1
    try:
        result = mlx_whisper.transcribe(read_wav(audio_path), path_or_hf_repo=model_dir, language=language_option(language), task="transcribe", verbose=None)
        emit({"text": str(result.get("text", "")).strip()})
        return 0
    except Exception as error:  # noqa: BLE001 — the window shows what went wrong
        emit({"error": f"No s’ha pogut transcriure: {error}"})
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
