"""The model on Linux with NVIDIA GPUs: the same job as mlx-worker.py (one JSON request per line on stdin,
one JSON answer per line on stdout), with PyTorch and transformers instead of MLX.

    python cuda-worker.py <model folder>

The model is a Hugging Face safetensors folder. Unless it is already quantized, it is loaded in 4 bits
(bitsandbytes NF4) and spread over every GPU there is (device_map="auto": two 8 GB cards hold a 9B
model). An optional LoRA adapter (AGENT_MLX_ADAPTER_PATH, a PEFT folder) goes on top; the base weights
are never changed. Reading the tool calls and the history in the model's own format is mlx_text.py, the
same module the Mac uses: nothing of it is MLX.

Images are not read here yet (the Mac's mlx-vlm path has no Linux counterpart in this worker).
"""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlx_lock  # noqa: E402  (a plain file lock: one model on the GPUs at a time, on Linux too)
import mlx_text  # noqa: E402
import mlx_trace  # noqa: E402


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    _gpu_lock = mlx_lock.acquire()
except RuntimeError as error:
    emit({"type": "result", "error": str(error)})
    sys.exit(1)

MODEL_DIR = sys.argv[1]
adapter_path = os.environ.get("AGENT_MLX_ADAPTER_PATH") or None

try:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

    started = time.perf_counter()
    with open(os.path.join(MODEL_DIR, "config.json"), encoding="utf-8") as handle:
        already_quantized = "quantization_config" in json.load(handle)
    options = {"device_map": "auto", "torch_dtype": torch.float16}
    if not already_quantized:
        from transformers import BitsAndBytesConfig

        options["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModelForCausalLM.from_pretrained(MODEL_DIR, **options)
    if adapter_path:
        from peft import PeftModel

        # The app names a beta's weights adapters.safetensors (as mlx_lm does); PEFT reads adapter_model.safetensors.
        named = os.path.join(adapter_path, "adapter_model.safetensors")
        if not os.path.exists(named) and os.path.exists(os.path.join(adapter_path, "adapters.safetensors")):
            mlx_text.link_or_copy(os.path.join(adapter_path, "adapters.safetensors"), named)

        model = PeftModel.from_pretrained(model, adapter_path)
    model.eval()
    LOAD_SECONDS = round(time.perf_counter() - started, 2)
    emit({"type": "ready", "adapter": adapter_path, "loadSeconds": LOAD_SECONDS})
except Exception as error:  # noqa: BLE001 — the window shows what went wrong
    emit({"type": "result", "error": f"No s’ha pogut carregar el model amb CUDA: {error}"})
    sys.exit(1)

THINKING = os.environ.get("AGENT_MLX_THINKING") == "1"
CONTEXT_LIMIT = mlx_trace.context_limit(MODEL_DIR)
# The tool-call format the model's template writes (the Mac takes it from mlx_lm; here from the files).
PARSER_TYPE = mlx_text.tool_parser_type(MODEL_DIR)
NATIVE_FORMAT_DIFFERS = PARSER_TYPE == "qwen3_coder"


def chat_prompt(messages, tools):
    try:
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, tools=tools, enable_thinking=THINKING)
    except TypeError:
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, tools=tools)


def generate(prompt, request, trace):
    inputs = tokenizer(prompt, return_tensors="pt", add_special_tokens=False).to(model.device)
    temperature = float(request.get("temperature", 0.0))
    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=False)
    options = dict(**inputs, max_new_tokens=int(request.get("max_tokens", 700)), streamer=streamer, do_sample=temperature > 0, pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id)
    if temperature > 0:
        options["temperature"] = temperature
    started = time.perf_counter()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    worker = threading.Thread(target=lambda: model.generate(**options))
    worker.start()
    text, first = "", None
    for piece in streamer:
        if first is None:
            first = time.perf_counter() - started
        text += piece
        if trace:
            emit({"type": "token", "text": piece})
    worker.join()
    # The end-of-turn token the streamer leaves at the end is not part of the answer.
    for end in (tokenizer.eos_token or "", "<|im_end|>", "<|endoftext|>"):
        if end and text.endswith(end):
            text = text[: -len(end)]
    seconds = time.perf_counter() - started
    generated = len(tokenizer.encode(text, add_special_tokens=False))
    prompt_tokens = int(inputs["input_ids"].shape[-1])
    metrics = {
        "promptTokens": prompt_tokens, "promptTps": None,
        "generationTokens": generated, "generationTps": round(generated / max(seconds - (first or 0), 1e-6), 2),
        "peakMemoryGb": round(sum(torch.cuda.max_memory_allocated(i) for i in range(torch.cuda.device_count())) / 1e9, 2) if torch.cuda.is_available() else None,
        "finishReason": "length" if generated >= options["max_new_tokens"] else "stop",
        "seconds": round(seconds, 3), "firstTokenSeconds": round(first, 3) if first is not None else None,
    }
    return text, metrics


for line in sys.stdin:
    try:
        request = json.loads(line)
        messages = request.get("messages", [])
        if NATIVE_FORMAT_DIFFERS:
            messages = mlx_text.native_history(messages)
        tools = request.get("tools") or None
        if request.get("images"):
            emit({"type": "result", "error": "Les imatges encara no es poden llegir amb el motor de Linux (CUDA)."})
            continue
        prompt = chat_prompt(messages, tools)
        answer, metrics = generate(prompt, request, bool(request.get("trace")))
        text = mlx_text.normalize_tool_calls(mlx_text.strip_thinking(answer, "<think>", "</think>"), tools, "<tool_call>", "</tool_call>", None).strip()
        if request.get("trace"):
            emit({"type": "result", "text": text, "trace": {**metrics, "prompt": prompt, "raw": answer, "backend": "cuda", "context": CONTEXT_LIMIT, "counts": mlx_trace.part_counts(lambda value: tokenizer.encode(value, add_special_tokens=False), messages, tools, request.get("trace_parts"))}})
        else:
            emit({"type": "result", "text": text})
    except Exception as error:  # noqa: BLE001
        emit({"type": "result", "error": f"Error generant amb CUDA: {error}"})
