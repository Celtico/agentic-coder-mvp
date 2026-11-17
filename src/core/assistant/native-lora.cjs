#!/usr/bin/env node
// LoRA training without Python: the `lora` command of `python -m mlx_lm` (the arguments the app gives it,
// src/electron/learning-versions.cjs) with the native engine (native/lora.js). It prints the same lines as
// mlx_lm («Iter 5: Train loss 1.234, Learning Rate 1e-05, It/sec 0.4, Tokens/sec 380.5, …», «Iter 20: Val
// loss …») and writes the same adapters.safetensors and adapter_config.json, which both engines load.
//
//   node native-lora.cjs lora --model <dir> --train --data <dir> --adapter-path <dir> --iters 300 \
//     --batch-size 1 --num-layers 8 --learning-rate 1e-5 --max-seq-length 2048 --grad-checkpoint \
//     --mask-prompt --seed 0 --steps-per-report 5 --steps-per-eval 300 --save-every 300
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nativeDir = path.join(__dirname, '..', '..', '..', 'native');

/** The mlx_lm lora arguments this launcher understands (others are ignored, as mlx_lm's defaults). */
function parseArgs(argv) {
  const args = argv[0] === 'lora' ? argv.slice(1) : argv;
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const number = (name, fallback) => Number(value(name, fallback));
  return {
    model: value('--model'), data: value('--data'), adapterPath: value('--adapter-path', 'adapters'),
    train: args.includes('--train'), iters: number('--iters', 1000), batchSize: number('--batch-size', 4),
    numLayers: number('--num-layers', 16), learningRate: number('--learning-rate', 1e-5), maxSeqLength: number('--max-seq-length', 2048),
    gradCheckpoint: args.includes('--grad-checkpoint'), maskPrompt: args.includes('--mask-prompt'), seed: number('--seed', 0),
    stepsPerReport: number('--steps-per-report', 10), stepsPerEval: number('--steps-per-eval', 200), saveEvery: number('--save-every', 100),
  };
}

const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) : []);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.train || !options.model || !options.data) throw new Error('Cal --train, --model i --data (només entrena).');
  if (options.batchSize !== 1) throw new Error('El motor natiu entrena amb lots d’1 exemple (--batch-size 1).');
  // Only one model on the GPU at a time (the same lock as the workers, src/core/assistant/mlx_lock.py).
  const { addon } = require(path.join(nativeDir, 'index.js'));
  const lockFile = process.env.AGENT_MLX_LOCK || path.join(os.homedir(), '.agentic-coder', 'mlx.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  addon.lock(lockFile, process.env.AGENT_MLX_LOCK_LABEL || 'un entrenament', Number(process.env.AGENT_MLX_LOCK_TIMEOUT || 30));

  const { ChatModel } = require(path.join(nativeDir, 'chat.js'));
  const { trainLora, tokenizeExample, padExample } = require(path.join(nativeDir, 'lora.js'));
  const train = readJsonl(path.join(options.data, 'train.jsonl'));
  const valid = readJsonl(path.join(options.data, 'valid.jsonl'));
  if (!train.length) throw new Error(`No hi ha exemples a ${path.join(options.data, 'train.jsonl')}.`);
  console.log(`Loading pretrained model ${options.model}`);
  const chat = new ChatModel(options.model);
  const engine = chat.model.engine;
  console.log(`Training: ${train.length} examples, ${options.iters} iterations (native engine)`);

  // Validation loss as mlx_lm reports it, at its evaluation steps (every steps-per-eval, and the last).
  const validExamples = valid.map((example) => padExample(tokenizeExample(chat, example, options.maskPrompt), options.maxSeqLength));
  const validLoss = () => {
    let sum = 0;
    let tokens = 0;
    for (const example of validExamples) {
      const result = engine.loraLoss(example.tokens, example.offset, example.length);
      sum += result.loss * result.tokens;
      tokens += result.tokens;
    }
    return tokens ? sum / tokens : null;
  };
  const evaluate = (iteration) => {
    if (!validExamples.length) return;
    const started = Date.now();
    const loss = validLoss();
    console.log(`Iter ${iteration}: Val loss ${loss.toFixed(3)}, Val took ${((Date.now() - started) / 1000).toFixed(3)}s`);
  };

  let lastReport = Date.now();
  let trainedTokens = 0;
  await trainLora(chat, train, {
    adapterPath: options.adapterPath, iters: options.iters, learningRate: options.learningRate, numLayers: options.numLayers,
    maxSeqLength: options.maxSeqLength, maskPrompt: options.maskPrompt, gradCheckpoint: options.gradCheckpoint, seed: options.seed,
    stepsPerReport: options.stepsPerReport, saveEvery: options.saveEvery,
    onReport: (report) => {
      const seconds = (Date.now() - lastReport) / 1000;
      lastReport = Date.now();
      const steps = Math.min(options.stepsPerReport, report.iteration);
      trainedTokens += Math.round(report.tokensPerSecond * seconds);
      console.log(`Iter ${report.iteration}: Train loss ${report.trainLoss.toFixed(3)}, Learning Rate ${options.learningRate.toExponential(3)}, It/sec ${(steps / seconds).toFixed(3)}, Tokens/sec ${report.tokensPerSecond.toFixed(3)}, Trained Tokens ${trainedTokens}, Peak mem ${(report.peakMemory / 1e9).toFixed(3)} GB`);
      if (report.iteration % options.stepsPerEval === 0 || report.iteration === options.iters) evaluate(report.iteration);
    },
  });
  console.log(`Saved final weights to ${path.join(options.adapterPath, 'adapters.safetensors')}.`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { parseArgs };
