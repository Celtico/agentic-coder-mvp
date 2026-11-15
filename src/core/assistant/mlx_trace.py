"""Log del model: what one call to the model was, measured while it runs (src/app, Log del model panel).

Used by mlx-worker.py only for a request with "trace" (the panel is open). It reads what the model does;
it changes nothing it receives or generates: the text is the same stream_generate gives (mlx_lm's own
generate() is that same stream joined), with the same sampler and logits processors.
"""
import json
import math
import os
import time


def context_limit(model_dir):
    """The model's context window from its config (also inside text_config, for a vision model)."""
    try:
        with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as handle:
            config = json.load(handle)
    except Exception:
        return None
    for source in (config, config.get("text_config") or {}):
        for key in ("max_position_embeddings", "max_sequence_length", "seq_length"):
            if isinstance(source.get(key), int):
                return source[key]
    return None


def count_tokens(encode, text):
    try:
        return len(encode(text or ""))
    except Exception:
        return None


def part_counts(encode, messages, tools, parts):
    """Tokens of each message, of the tool definitions and of each named part of the system prompt.
    The template adds its own markers around them, so the total of the prompt is a little more."""
    return {
        "messages": [count_tokens(encode, message.get("content") if isinstance(message.get("content"), str) else json.dumps(message.get("content"), ensure_ascii=False)) for message in messages],
        "tools": count_tokens(encode, json.dumps(tools, ensure_ascii=False)) if tools else 0,
        "parts": [count_tokens(encode, part) for part in (parts or [])],
    }


def alternatives(logprobs, token, decode, k=5):
    """The chosen token's probability and the k most likely tokens at that step."""
    import mlx.core as mx

    values = logprobs.reshape(-1)
    top = mx.argpartition(-values, kth=k - 1)[:k]
    top = top[mx.argsort(-values[top])]
    return {
        "p": math.exp(values[token].item()),
        "top": [[decode([int(index)]), math.exp(values[int(index)].item())] for index in top.tolist()],
    }


def traced_generate(stream_generate, model, tokenizer, prompt, max_tokens, sampler, logits_processors, emit, logprobs=False):
    """Generates as generate() does, sending each piece of text as it comes ({"type": "token"}), and
    returns the text and what was measured."""
    started = time.perf_counter()
    first = None
    text = ""
    last = None
    tokens = []
    for response in stream_generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens, sampler=sampler, logits_processors=logits_processors):
        if first is None:
            first = time.perf_counter() - started
        text += response.text
        last = response
        emit({"type": "token", "text": response.text})
        if logprobs:
            try:
                tokens.append({"t": response.text, **alternatives(response.logprobs, response.token, tokenizer.decode)})
            except Exception:
                pass
    return text, {
        **metrics(last, started),
        "firstTokenSeconds": round(first, 3) if first is not None else None,
        **({"tokens": tokens} if logprobs else {}),
    }


def metrics(result, started):
    """The figures mlx_lm and mlx-vlm give with their last response, and the total time."""
    def value(name):
        number = getattr(result, name, None)
        return round(number, 2) if isinstance(number, float) else number
    return {
        "promptTokens": value("prompt_tokens"),
        "promptTps": value("prompt_tps"),
        "generationTokens": value("generation_tokens"),
        "generationTps": value("generation_tps"),
        "peakMemoryGb": value("peak_memory"),
        # "length": the token limit; "stop": the model's end; None: stopped before.
        "finishReason": getattr(result, "finish_reason", None),
        "seconds": round(time.perf_counter() - started, 3),
    }
