"""Downloads a model from Hugging Face into a folder (Aprenentatge local › Gestiona els models).

    python mlx_download.py <org/name> <folder> <pattern>...

Only the files that match the patterns (weights, configs, tokenizer; never code). It loads nothing: the
GPU lock is not needed. The app measures the folder for the progress and removes it if this fails or
is stopped.
"""
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from huggingface_hub import snapshot_download  # noqa: E402


def main():
    if len(sys.argv) < 4:
        print("Ús: mlx_download.py <org/name> <folder> <pattern>...", file=sys.stderr)
        return 2
    repo, folder, patterns = sys.argv[1], sys.argv[2], sys.argv[3:]
    snapshot_download(repo_id=repo, local_dir=folder, allow_patterns=patterns)
    print("BAIXAT", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
