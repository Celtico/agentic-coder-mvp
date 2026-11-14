import gc
import importlib.util
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlx_text  # noqa: E402
import mlx_lock  # noqa: E402
import mlx_vision  # noqa: E402


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    # Only one model on the GPU on this Mac at a time (see mlx_lock.py); kept until this process ends.
    _gpu_lock = mlx_lock.acquire()
except RuntimeError as error:
    emit({"type": "result", "error": str(error)})
    sys.exit(1)

try:
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler

    # An optional LoRA adapter goes on top of the base weights, which are never modified.
    adapter_path = os.environ.get("AGENT_MLX_ADAPTER_PATH") or None
    model, tokenizer = load(sys.argv[1], adapter_path=adapter_path)
    emit({"type": "ready", "adapter": adapter_path})
except Exception as error:
    emit({"type": "result", "error": f"No s’ha pogut carregar MLX: {error}"})
    sys.exit(1)

# Reasoning models write a long hidden "thinking" section before answering. In a tool loop it costs
# tokens and memory on every turn, so it is off unless AGENT_MLX_THINKING=1.
THINKING = os.environ.get("AGENT_MLX_THINKING") == "1"

# With reasoning off, a model whose chat template has a reasoning section must not open it: Gemma 4,
# greedy and after a few turns, starts the section again and again («<|channel>thought…») and never
# answers. Its first token is banned, so the model answers directly.
# Whether the model writes tool calls in a format other than the agent's <tool_call>{json}</tool_call>
# (Gemma 4's <|tool_call>call:…, Qwen 3.5's XML). Qwen 2.5 writes that same JSON: its history is left as is.
_parser = getattr(tokenizer, "tool_parser", None)
NATIVE_FORMAT_DIFFERS = bool(getattr(tokenizer, "tool_call_start", None)) and (
    tokenizer.tool_call_start != "<tool_call>" or (getattr(_parser, "__module__", "") or "").split(".")[-1] not in ("json_tools", "qwen3", "")
)

LOGITS_PROCESSORS = []
_think_tokens = getattr(tokenizer, "think_start_tokens", None)
if not THINKING and _think_tokens:
    _banned = _think_tokens[0]

    def _no_reasoning(tokens, logits):
        logits[:, _banned] = -float("inf")
        return logits

    LOGITS_PROCESSORS.append(_no_reasoning)


def strip_thinking(text):
    return mlx_text.strip_thinking(text, getattr(tokenizer, "think_start", None), getattr(tokenizer, "think_end", None))


# Images (mlx_vision.py): a model whose weights have a vision tower switches to mlx-vlm on the first
# request with images, after freeing the text model, and stays there. Not with a LoRA adapter on top.
MODEL_DIR = sys.argv[1]
HAS_VISION = mlx_vision.model_has_vision(MODEL_DIR) and not adapter_path
BACKEND = "text"
VLM = None


def vlm_available():
    return importlib.util.find_spec("mlx_vlm") is not None


def switch_to_vision():
    global model, VLM, BACKEND
    import mlx.core as mx
    from mlx_vlm import load as vlm_load
    model = None
    gc.collect()
    mx.clear_cache()
    VLM = vlm_load(MODEL_DIR)
    BACKEND = "vision"


def generate_with_vision(messages, tools, request, paths, index):
    from mlx_vlm import generate as vlm_generate
    vlm_model, processor = VLM
    prompt = processor.apply_chat_template(
        mlx_vision.with_images(messages, index, len(paths)),
        tokenize=False,
        add_generation_prompt=True,
        tools=tools,
        enable_thinking=THINKING,
    )
    result = vlm_generate(
        vlm_model,
        processor,
        prompt,
        image=paths or None,
        max_tokens=int(request.get("max_tokens", 700)),
        temperature=float(request.get("temperature", 0.0)),
        verbose=False,
    )
    return getattr(result, "text", result)


def normalize_tool_calls(text, tools):
    return mlx_text.normalize_tool_calls(text, tools, getattr(tokenizer, "tool_call_start", None), getattr(tokenizer, "tool_call_end", None), getattr(tokenizer, "tool_parser", None))


for line in sys.stdin:
    try:
        request = json.loads(line)
        messages = request.get("messages", [])
        if NATIVE_FORMAT_DIFFERS:
            messages = mlx_text.native_history(messages)
        tools = request.get("tools") or None
        paths, image_message = mlx_vision.image_paths(request)
        backend, problem = mlx_vision.choose_backend(bool(paths), HAS_VISION, vlm_available(), BACKEND)
        if problem:
            emit({"type": "result", "error": problem})
            continue
        if backend == "vision":
            if BACKEND != "vision":
                switch_to_vision()
            answer = generate_with_vision(messages, tools, request, paths, image_message)
            emit({"type": "result", "text": normalize_tool_calls(strip_thinking(answer), tools).strip()})
            continue
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            tools=tools,
            enable_thinking=THINKING,
        )
        answer = generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=int(request.get("max_tokens", 700)),
            sampler=make_sampler(temp=float(request.get("temperature", 0.0))),
            logits_processors=LOGITS_PROCESSORS or None,
        )
        emit({"type": "result", "text": normalize_tool_calls(strip_thinking(answer), tools).strip()})
    except Exception as error:
        emit({"type": "result", "error": f"Error generant amb MLX: {error}"})
