"""Text handling of the MLX worker that does not need a model: kept apart so it can be tested."""
import json
import re


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
    # Without a parser of its own (a vision model's weights loaded with mlx_lm, 15-11-2026: MiMo VL), the
    # calls are still read in the forms that need none: JSON, and JSON inside <function=name>…</function>.
    if not start:
        start, end = "<tool_call>", "</tool_call>"
    if start not in text:
        return text
    out, rest = "", text
    while start in rest:
        before, _, after = rest.partition(start)
        body, found_end, rest = after.partition(end) if end else (after, "", "")
        out += before
        try:
            for call in _tool_call_objects(body):
                out += "<tool_call>" + json.dumps({"name": call["name"], "arguments": call.get("arguments") or {}}, ensure_ascii=False) + "</tool_call>"
            continue
        except Exception:
            pass
        try:
            if not parser:
                raise ValueError("no parser")
            parsed = parser(body, tools)
            for call in parsed if isinstance(parsed, list) else [parsed]:
                out += "<tool_call>" + json.dumps({"name": call["name"], "arguments": call.get("arguments", {})}, ensure_ascii=False) + "</tool_call>"
        except Exception:
            out += start + body + found_end
    return out + rest


def _tool_call_objects(body):
    """A tool call written as JSON, also after a «call:» prefix (Gemma 4 sometimes mixes both forms)."""
    text = body.strip()
    if text.startswith("call:"):
        text = text[len("call:"):].strip()
    # Qwen-style models sometimes put JSON arguments inside the XML function tag.
    tagged = re.fullmatch(r"<function=([\w.-]+)>\s*(\{.*\})\s*</function>", text, re.DOTALL)
    if tagged:
        return [{"name": tagged.group(1), "arguments": json.loads(tagged.group(2))}]
    # Qwen3-Coder's XML (<function=name><parameter=key>value</parameter>…), read without mlx_lm's parser.
    xml = re.fullmatch(r"<function=([\w.-]+)>(.*)</function>", text, re.DOTALL)
    if xml and "<parameter=" in xml.group(2):
        arguments = {}
        for key, value in re.findall(r"<parameter=([\w.-]+)>\n?(.*?)\n?</parameter>", xml.group(2), re.DOTALL):
            try:
                arguments[key] = json.loads(value) if value.strip()[:1] in "[{" else value
            except ValueError:
                arguments[key] = value
        return [{"name": xml.group(1), "arguments": arguments}]
    value = json.loads(text)
    calls = value if isinstance(value, list) else [value]
    if not all(isinstance(call, dict) and isinstance(call.get("name"), str) for call in calls):
        raise ValueError("not a tool call")
    return calls


def native_history(messages):
    """The agent keeps every tool call of the model in its history as <tool_call>{json}</tool_call>. A
    model whose own format is different (Gemma 4, Qwen 3.5) starts mixing both forms after seeing it,
    so the calls go back to it in its own format: as the `tool_calls` of the assistant message, which
    its chat template renders natively, and the message that follows a call (the app's reply to it)
    as the `tool` message the template expects."""
    out = []
    pending_tool = None
    for message in messages:
        if pending_tool is not None and message.get("role") == "user":
            out.append({"role": "tool", "name": pending_tool, "content": message.get("content", "")})
            pending_tool = None
            continue
        pending_tool = None
        content = message.get("content", "")
        if message.get("role") != "assistant" or "<tool_call>" not in content:
            out.append(message)
            continue
        text, calls, rest = "", [], content
        while "<tool_call>" in rest:
            before, _, after = rest.partition("<tool_call>")
            body, found, rest = after.partition("</tool_call>")
            text += before
            try:
                for call in _tool_call_objects(body):
                    calls.append({"type": "function", "function": {"name": call["name"], "arguments": call.get("arguments") or {}}})
            except Exception:
                text += "<tool_call>" + body + found
        text += rest
        if not calls:
            out.append(message)
            continue
        out.append({"role": "assistant", "content": text.strip(), "tool_calls": calls})
        pending_tool = calls[-1]["function"]["name"]
    return out
