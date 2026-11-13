"""Text handling of the MLX worker that does not need a model: kept apart so it can be tested."""
import json


def strip_thinking(text, start, end):
    """Removes the hidden reasoning section (start ... end) a reasoning model writes before answering."""
    if not start or not end:
        return text
    while True:
        head = text.find(start)
        tail = text.find(end, head + len(start) if head >= 0 else 0)
        if tail < 0:
            return text
        # A template can open the section itself, so the answer may hold only its end.
        text = (text[:head] if head >= 0 else "") + text[tail + len(end):]


def normalize_tool_calls(text, tools, start, end, parser):
    """Each model family writes tool calls in its own format (Gemma 4: <|tool_call>call:name{...}<tool_call|>;
    Qwen 3.5 and Qwen3-Coder: XML inside <tool_call>...</tool_call>). mlx_lm knows the format of the loaded
    model; its calls are rewritten as <tool_call>{json}</tool_call>, the one form the agent reads, so the
    agent does not depend on the model family. A call that is already JSON is left as it is."""
    if not start or not parser or start not in text:
        return text
    out, rest = "", text
    while start in rest:
        before, _, after = rest.partition(start)
        body, found_end, rest = after.partition(end) if end else (after, "", "")
        out += before
        try:
            json.loads(body)
            out += "<tool_call>" + body + "</tool_call>"
            continue
        except Exception:
            pass
        try:
            parsed = parser(body, tools)
            for call in parsed if isinstance(parsed, list) else [parsed]:
                out += "<tool_call>" + json.dumps({"name": call["name"], "arguments": call.get("arguments", {})}, ensure_ascii=False) + "</tool_call>"
        except Exception:
            out += start + body + found_end
    return out + rest
