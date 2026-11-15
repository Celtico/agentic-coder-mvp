"""LoRA on Linux with NVIDIA GPUs: what `mlx_lm lora` and `mlx_lm fuse` do on a Mac, with PEFT (QLoRA:
the base in 4 bits, the adapter in 16) and the same command line, so src/electron/learning-versions.cjs
trains a beta or a stable version the same way on both. It holds the one-model-at-a-time lock.

    python cuda-lora.py lora --model <base> --train --data <dir with train.jsonl> --adapter-path <out>
        --iters N --batch-size 1 --num-layers L --learning-rate LR --max-seq-length M --mask-prompt --seed S
        [--grad-checkpoint] [--steps-per-report K] (other mlx_lm options are accepted and ignored)
    python cuda-lora.py fuse --model <base> --adapter-path <adapter> --save-path <out>

Progress lines are mlx_lm's («Iter 5: Train loss 1.234, …») so the app reads them as it does on a Mac.
The base model's folder is never written to.
"""
import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlx_lock  # noqa: E402

ADAPTER_FILE = "adapters.safetensors"


def arguments(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["lora", "fuse"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter-path", required=True)
    parser.add_argument("--data")
    parser.add_argument("--save-path")
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--iters", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--num-layers", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--mask-prompt", action="store_true")
    parser.add_argument("--grad-checkpoint", action="store_true")
    parser.add_argument("--steps-per-report", type=int, default=10)
    parsed, _ignored = parser.parse_known_args(argv)
    return parsed


def read_examples(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line)["messages"] for line in handle if line.strip()]


def encode(tokenizer, messages, max_length, mask_prompt):
    """The token ids of a conversation and its labels: with --mask-prompt only the last answer is learnt."""
    full = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False)
    labels = list(full)
    if mask_prompt and messages and messages[-1].get("role") == "assistant":
        prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True)
        labels = [-100] * min(len(prompt), len(full)) + full[len(prompt):]
    return full[:max_length], labels[:max_length]


def last_layers(config, count):
    total = getattr(config, "num_hidden_layers", None) or getattr(getattr(config, "text_config", None), "num_hidden_layers", None)
    return list(range(max(0, total - count), total)) if total else None


def train(args):
    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model, device_map="auto", torch_dtype=torch.float16,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True),
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=args.grad_checkpoint)
    layers = last_layers(model.config, args.num_layers)
    model = get_peft_model(model, LoraConfig(
        r=8, lora_alpha=16, lora_dropout=0.0, bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], **({"layers_to_transform": layers} if layers else {}),
    ))
    examples = [encode(tokenizer, messages, args.max_seq_length, args.mask_prompt) for messages in read_examples(os.path.join(args.data, "train.jsonl"))]
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.learning_rate)
    model.train()
    losses = []
    for iteration in range(1, args.iters + 1):
        ids, labels = random.choice(examples)
        batch = torch.tensor([ids], device=model.device)
        loss = model(input_ids=batch, labels=torch.tensor([labels], device=model.device)).loss
        loss.backward()
        optimizer.step()
        optimizer.zero_grad()
        losses.append(float(loss))
        if iteration % args.steps_per_report == 0 or iteration == args.iters:
            window = losses[-args.steps_per_report:]
            print(f"Iter {iteration}: Train loss {sum(window) / len(window):.3f}, Learning Rate {args.learning_rate:.3e}", flush=True)
    model.save_pretrained(args.adapter_path)
    # The app looks for adapters.safetensors in a beta's folder (as mlx_lm names it).
    saved = os.path.join(args.adapter_path, "adapter_model.safetensors")
    if os.path.exists(saved):
        os.replace(saved, os.path.join(args.adapter_path, ADAPTER_FILE))


def fuse(args):
    import torch
    from peft import PeftConfig, PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    adapter = args.adapter_path
    # PEFT looks for adapter_model.safetensors; the app's name is adapters.safetensors.
    if not os.path.exists(os.path.join(adapter, "adapter_model.safetensors")) and os.path.exists(os.path.join(adapter, ADAPTER_FILE)):
        os.symlink(ADAPTER_FILE, os.path.join(adapter, "adapter_model.safetensors"))
    PeftConfig.from_pretrained(adapter)
    model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.float16, device_map="cpu")
    model = PeftModel.from_pretrained(model, adapter).merge_and_unload()
    model.save_pretrained(args.save_path, safe_serialization=True)
    AutoTokenizer.from_pretrained(args.model).save_pretrained(args.save_path)


def main(argv):
    args = arguments(argv)
    try:
        _lock = mlx_lock.acquire()  # noqa: F841 — kept until this process ends
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 3
    if args.command == "lora":
        train(args)
    else:
        fuse(args)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
