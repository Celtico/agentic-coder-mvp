"""Runs an mlx_lm command (lora, fuse…) holding the one-model-on-the-GPU lock (mlx_lock.py).

    python mlx-locked.py lora --model … --train …
"""
import os
import runpy
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlx_lock  # noqa: E402

try:
    _lock = mlx_lock.acquire()
except RuntimeError as error:
    print(str(error), file=sys.stderr)
    sys.exit(3)
sys.argv = ["mlx_lm"] + sys.argv[1:]
runpy.run_module("mlx_lm", run_name="__main__")
