import json
import sys
import traceback


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(sys.argv[1])
    emit({"type": "ready"})
except Exception as error:
    emit({"type": "result", "error": f"No s’ha pogut carregar MLX: {error}"})
    sys.exit(1)

for line in sys.stdin:
    try:
        request = json.loads(line)
        messages = request.get("messages", [])
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            tools=request.get("tools") or None,
        )
        answer = generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=int(request.get("max_tokens", 700)),
            sampler=make_sampler(temp=float(request.get("temperature", 0.0))),
        )
        emit({"type": "result", "text": answer})
    except Exception as error:
        emit({"type": "result", "error": f"Error generant amb MLX: {error}"})
