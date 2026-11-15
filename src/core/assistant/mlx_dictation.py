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
MISSING_ENGINE = ("Falta faster-whisper al runtime CUDA: el dictat no funcionarà fins que s’instal·li (docs/linux.md)."
                  if os.environ.get("AGENT_DICTATION_ENGINE") == "cuda"
                  else "Falta mlx-whisper al runtime MLX: el dictat no funcionarà fins que s’instal·li.")


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


SILENCE_PEAK = 0.005


def is_silent(samples):
    """Silence (or almost): Whisper given it invents a word («Gràcies.»), so it is not called."""
    return samples.size == 0 or float(abs(samples).max()) < SILENCE_PEAK


def transcribe(mlx_whisper, model_dir, path, language):
    samples = read_wav(path)
    if is_silent(samples):
        return ""
    if isinstance(mlx_whisper, CudaWhisper):
        return mlx_whisper.transcribe(samples, language_option(language))
    result = mlx_whisper.transcribe(samples, path_or_hf_repo=model_dir, language=language_option(language), task="transcribe", verbose=None, condition_on_previous_text=False)
    return str(result.get("text", "")).strip()


class CudaWhisper:
    """Linux with NVIDIA GPUs (AGENT_DICTATION_ENGINE=cuda): faster-whisper on CUDA, the model a CTranslate2
    folder (models/whisper/<folder>), loaded once. The same answers as mlx-whisper's for the app."""

    def __init__(self, model_dir):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model_dir, device="cuda", compute_type="float16")

    def transcribe(self, samples, language):
        segments, _info = self.model.transcribe(samples, language=language, task="transcribe", condition_on_previous_text=False)
        return "".join(segment.text for segment in segments).strip()


def load_engine(model_dir):
    """mlx-whisper on a Mac; faster-whisper on Linux. Raises ImportError when it is not installed."""
    if os.environ.get("AGENT_DICTATION_ENGINE") == "cuda":
        return CudaWhisper(model_dir)
    import mlx_whisper

    return mlx_whisper


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve(model_dir, language):
    """Live dictation: the model stays loaded until stdin closes. It takes the GPU lock (mlx_lock.py), one
    model at a time, unless the app asks it to live beside the chat's model (AGENT_DICTATION_SHARED=1,
    Preferències › Agent › Dictat); then the app closes it before a training or an evaluation."""
    try:
        mlx_whisper = load_engine(model_dir)
    except ImportError:
        emit({"error": MISSING_ENGINE})
        return 1
    if os.environ.get("AGENT_DICTATION_SHARED") != "1":
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
            emit({"id": job_id, "text": transcribe(mlx_whisper, model_dir, job["file"], language)})
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
        mlx_whisper = load_engine(model_dir)
    except ImportError:
        emit({"error": MISSING_ENGINE})
        return 1
    import mlx_lock

    try:
        lock = mlx_lock.acquire()  # noqa: F841 — kept until this process ends
    except RuntimeError as error:
        emit({"error": str(error)})
        return 1
    try:
        emit({"text": transcribe(mlx_whisper, model_dir, audio_path, language)})
        return 0
    except Exception as error:  # noqa: BLE001 — the window shows what went wrong
        emit({"error": f"No s’ha pogut transcriure: {error}"})
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
