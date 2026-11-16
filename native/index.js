// Native MLX engine for Node: loads an mlx-community Qwen3.5 model (e.g.
// MiMo V2.6 9B OptiQ 4-bit) and generates text, without Python.
const fs = require('node:fs');
const path = require('node:path');

const addon = require('./build/Release/agentic_mlx.node');

// Turns the model's config.json into the flat config the addon expects.
function readConfig(modelDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8'));
  const text = raw.text_config ?? raw;
  if (!['qwen3_5', 'qwen3_5_text'].includes(raw.model_type) && text.model_type !== 'qwen3_5_text') {
    throw new Error(`Arquitectura no suportada pel motor natiu: ${raw.model_type}`);
  }
  if (text.num_experts > 0) throw new Error('El motor natiu encara no suporta models MoE');
  const rope = text.rope_parameters ?? {};
  return {
    ...text,
    rope_theta: rope.rope_theta ?? text.rope_theta ?? 100000,
    partial_rotary_factor: rope.partial_rotary_factor ?? text.partial_rotary_factor ?? 0.25,
    quantization: raw.quantization ?? raw.quantization_config,
    eos_token_id: raw.eos_token_id ?? text.eos_token_id,
  };
}

function eosIds(modelDir, config) {
  const ids = new Set();
  const add = (v) => [].concat(v ?? []).forEach((id) => ids.add(id));
  add(config.eos_token_id);
  const gen = path.join(modelDir, 'generation_config.json');
  if (fs.existsSync(gen)) add(JSON.parse(fs.readFileSync(gen, 'utf8')).eos_token_id);
  return ids;
}

class NativeModel {
  constructor(modelDir) {
    this.dir = modelDir;
    this.config = readConfig(modelDir);
    this.eos = eosIds(modelDir, this.config);
    this.engine = new addon.Engine(modelDir, this.config);
  }

  // Yields token ids until EOS or maxTokens. Sampling: temperature, topP, topK, seed.
  *generate(promptIds, { maxTokens = 512, ...sampling } = {}) {
    this.engine.start(Int32Array.from(promptIds), sampling);
    for (let i = 0; i < maxTokens; i++) {
      const id = this.engine.next();
      if (this.eos.has(id)) return;
      yield id;
    }
  }

  // Applies LoRA adapters made by mlx_lm or trainLora (a folder with
  // adapters.safetensors and adapter_config.json), e.g. a beta.
  loadAdapters(adapterDir) {
    const cfg = JSON.parse(fs.readFileSync(path.join(adapterDir, 'adapter_config.json'), 'utf8'));
    if ((cfg.fine_tune_type ?? 'lora') !== 'lora') throw new Error(`Tipus d'adaptador no suportat: ${cfg.fine_tune_type}`);
    this.engine.loraLoad(path.join(adapterDir, 'adapters.safetensors'), cfg.lora_parameters?.scale ?? 20.0);
  }

  removeAdapters() {
    this.engine.loraRemove();
  }

  memory() {
    return this.engine.memory();
  }
}

module.exports = { NativeModel, readConfig, metal: addon.metal, addon };
