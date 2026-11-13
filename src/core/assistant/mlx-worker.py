import json
import os
import sys
import traceback


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


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


def strip_thinking(text):
    start, end = getattr(tokenizer, "think_start", None), getattr(tokenizer, "think_end", None)
    if not start or not end:
        return text
    while True:
        head = text.find(start)
        tail = text.find(end, head + len(start) if head >= 0 else 0)
        if tail < 0:
            return text
        # A template can open the section itself, so the answer may hold only its end.
        text = (text[:head] if head >= 0 else "") + text[tail + len(end):]


def normalize_tool_calls(text, tools):
    """Each model family writes tool calls in its own format (Gemma 4: <|tool_call>call:name{...}<tool_call|>).
    mlx_lm knows the format of the loaded model; its calls are rewritten as <tool_call>{json}</tool_call>,
    the one form the agent reads, so the agent does not depend on the model family."""
    start = getattr(tokenizer, "tool_call_start", None)
    end = getattr(tokenizer, "tool_call_end", None)
    parser = getattr(tokenizer, "tool_parser", None)
    if not start or not parser or start not in text or start == "<tool_call>":
        return text
    out, rest = "", text
    while start in rest:
        before, _, after = rest.partition(start)
        body, found_end, rest = after.partition(end) if end else (after, "", "")
        out += before
        try:
            parsed = parser(body, tools)
            for call in parsed if isinstance(parsed, list) else [parsed]:
                out += "<tool_call>" + json.dumps({"name": call["name"], "arguments": call.get("arguments", {})}, ensure_ascii=False) + "</tool_call>"
        except Exception:
            out += start + body + found_end
    return out + rest


for line in sys.stdin:
    try:
        request = json.loads(line)
        messages = request.get("messages", [])
        tools = request.get("tools") or None
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
        )
        emit({"type": "result", "text": normalize_tool_calls(strip_thinking(answer), tools).strip()})
    except Exception as error:
        emit({"type": "result", "error": f"Error generant amb MLX: {error}"})
