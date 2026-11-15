"""One MLX model on the GPU at a time, on the whole Mac.

Two model processes at once (the app's chat, a benchmark, a training, a test from the terminal) can take
more GPU memory than a 16 GB Mac has; on 13-11-2026 that made the macOS GPU driver panic and restart the
Mac. Every process that loads a model takes this lock first. The lock belongs to the process: it is freed
when the process ends, however it ends.
"""
import os
import sys
import time

# A lock on the file that the system frees when the process ends, however it ends: flock on macOS and
# Linux, msvcrt.locking on Windows.
if os.name == "nt":
    import msvcrt

    def _try_lock(handle):
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise BlockingIOError(str(error)) from error
else:
    import fcntl

    def _try_lock(handle):
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

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
            _try_lock(handle)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                handle.seek(0)
                try:
                    holder = handle.read().strip() or "un altre procés"
                except OSError:  # Windows: the locked byte cannot be read by another process
                    holder = "un altre procés"
                handle.close()
                machine = "aquest Mac" if sys.platform == "darwin" else "aquest ordinador"
                raise RuntimeError(f"Ja hi ha un altre model carregat en {machine} ({holder}). Tanca’l o espera que acabi: dos models alhora no hi caben a la memòria de la GPU.")
            time.sleep(0.5)
    handle.seek(0)
    handle.truncate()
    handle.write(f"pid {os.getpid()}: {os.environ.get('AGENT_MLX_LOCK_LABEL', 'model MLX')}")
    handle.flush()
    return handle
