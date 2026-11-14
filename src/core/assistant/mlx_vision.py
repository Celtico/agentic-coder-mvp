"""Images for a model with vision, in the MLX worker (mlx-worker.py).

The worker starts with mlx_lm, as for any model. The first request that brings images, on a model whose
weights have a vision tower, frees that text model and loads the same weights with mlx-vlm, which then
answers every request (text too): only one copy of the model is ever in memory. Without images, or on a
model without vision, nothing changes.

The functions here only decide and reshape; they import neither mlx_lm nor mlx_vlm.
"""

import json
import os

VISION_WEIGHT_PREFIXES = ("vision_tower.", "visual.", "vision_model.", "model.visual.")


def model_has_vision(model_dir):
    """The config describes a vision tower and the weights have it (a text-only quant keeps only the config's tokens)."""
    try:
        with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return False
    if not isinstance(config.get("vision_config"), dict):
        return False
    try:
        with open(os.path.join(model_dir, "model.safetensors.index.json"), encoding="utf-8") as handle:
            names = json.load(handle).get("weight_map", {}).keys()
    except (OSError, ValueError):
        return False
    return any(name.startswith(VISION_WEIGHT_PREFIXES) or ".visual." in name for name in names)


def image_paths(request):
    """The image files of a request that exist on disk (at most four), and the index of the message they go with."""
    images = request.get("images") if isinstance(request, dict) else None
    if not isinstance(images, dict):
        return [], None
    paths = [path for path in images.get("paths") or [] if isinstance(path, str) and os.path.isfile(path)][:4]
    index = images.get("message")
    return paths, index if isinstance(index, int) and index >= 0 else None


def choose_backend(has_images, has_vision, vlm_available, current):
    """Which library answers: 'text' (mlx_lm) or 'vision' (mlx-vlm). Once on 'vision' it stays there.

    Returns (backend, problem): problem is a message for the user when images cannot be seen.
    """
    if current == "vision":
        return "vision", None
    if not has_images:
        return "text", None
    if not has_vision:
        return "text", "Aquest model no pot veure imatges: tria un model amb visió."
    if not vlm_available:
        return "text", "Falta mlx-vlm al runtime MLX: no es poden mirar imatges fins que s’instal·li."
    return "vision", None


def with_images(messages, index, count):
    """The messages with `count` image slots before the text of message `index`, in the chat-template form."""
    if not count or index is None or index >= len(messages):
        return messages
    result = list(messages)
    message = dict(result[index])
    text = message.get("content") if isinstance(message.get("content"), str) else ""
    message["content"] = [{"type": "image"} for _ in range(count)] + [{"type": "text", "text": text}]
    result[index] = message
    return result
