"""One MLX model on the GPU at a time, on the whole Mac.

Two model processes at once (the app's chat, a benchmark, a training, a test from the terminal) can take
more GPU memory than a 16 GB Mac has; on 13-11-2026 that made the macOS GPU driver panic and restart the
Mac. Every process that loads a model takes this lock first. The lock belongs to the process: it is freed
when the process ends, however it ends.
"""
import fcntl
import os
import time

DEFAULT_PATH = os.path.join(os.path.expanduser("~"), ".agentic-coder", "mlx.lock")


def acquire(timeout=float(os.environ.get("AGENT_MLX_LOCK_TIMEOUT", "30")), path=None):
    """Waits up to `timeout` seconds (a model that is being stopped needs a moment to free the GPU).
    Returns the open lock file, to be kept for as long as the model is loaded, or raises RuntimeError
    naming who holds it."""
    path = path or os.environ.get("AGENT_MLX_LOCK") or DEFAULT_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle = open(path, "a+")
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                handle.seek(0)
                holder = handle.read().strip() or "un altre procés"
                handle.close()
                raise RuntimeError(f"Ja hi ha un altre model carregat en aquest Mac ({holder}). Tanca’l o espera que acabi: dos models alhora no hi caben a la memòria de la GPU.")
            time.sleep(0.5)
    handle.seek(0)
    handle.truncate()
    handle.write(f"pid {os.getpid()}: {os.environ.get('AGENT_MLX_LOCK_LABEL', 'model MLX')}")
    handle.flush()
    return handle
