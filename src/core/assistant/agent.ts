import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TransformersJsInferenceEngine, type ChatTurn, type InferenceEngine } from './inference-engine';

export type AgentStatus = { type: 'status'; message: string };

export class LocalCodingAgent {
  private readonly onStatus: (status: AgentStatus) => void;
  private readonly engine: InferenceEngine;
  private readonly historyDir: string;

  constructor({ onStatus = () => {}, engine = new TransformersJsInferenceEngine() }: {
    onStatus?: (status: AgentStatus) => void;
    engine?: InferenceEngine;
  } = {}) {
    this.onStatus = onStatus;
    this.engine = engine;
    this.historyDir = path.join(os.homedir(), '.agentic-coder', 'memory');
  }

  async ask(prompt: string, projectRoot: string): Promise<string> {
    if (!prompt.trim()) throw new Error('Escriu una tasca.');
    const context = await this.collectContext(projectRoot);
    const system = [
      'Ets un agent de programació local que ajuda a treballar sobre el projecte seleccionat per l’usuari.',
      'Et dius Agentic Coder. La resposta la genera localment el model Qwen2.5-Coder-1.5B-Instruct amb Transformers.js. No ets Claude ni has estat creat per Anthropic; no afirmis ser un producte d’Anthropic, OpenAI ni cap altra empresa. Si et pregunten qui ets, descriu-te com Agentic Coder, l’assistent local basat en Qwen.',
      `La carpeta de projecte oberta és: ${path.resolve(projectRoot)}`,
      'A cada pregunta reps un mapa de fitxers del projecte i el contingut de text que s’ha pogut incloure. Utilitza aquest context per respondre sobre el projecte; no diguis que no tens accés al directori.',
      'L’accés és de lectura i limitat a la carpeta seleccionada. No pots explorar fitxers nous durant la resposta ni escriure’ls directament. Si necessites un fitxer que només apareix al mapa però el contingut no s’hi inclou, demana a l’usuari que l’obri o enganxi el contingut.',
      'No afirmis que has modificat fitxers. Si proposes canvis, indica la ruta relativa correcta i mostra un diff o el contingut complet que cal revisar i desar des de l’editor.',
      'No inventis resultats de proves ni contingut que no aparegui al context.',
      `Mapa de fitxers del projecte (pot estar retallat):\n${context.manifest || '(no s’han trobat fitxers visibles)'}`,
      `Contingut llegit per a aquesta petició (límit aproximat de 20 KB):\n${context.contents || '(no hi ha fitxers de text compatibles dins del límit)'}`,
    ].join('\n\n');

    await this.engine.loadModel((message) => this.onStatus({ type: 'status', message }));
    this.onStatus({ type: 'status', message: 'Generant resposta local…' });
    const messages: ChatTurn[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    const answer = await this.engine.generateResponse(messages, { max_new_tokens: 700, temperature: 0.2, do_sample: false });
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.appendFile(path.join(this.historyDir, 'sessions.jsonl'), JSON.stringify({
      at: new Date().toISOString(),
      model: this.engine.getModelStatus().modelId,
      prompt,
      answer,
    }) + '\n');
    this.onStatus({ type: 'status', message: 'Resposta local generada i registrada a la memòria.' });
    return answer;
  }

  private async collectContext(root: string): Promise<{ manifest: string; contents: string }> {
    const absoluteRoot = path.resolve(root);
    const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', 'models']);
    const allowed = /\.(js|cjs|mjs|ts|tsx|jsx|json|md|html|css|py|go|rs|java|php|yml|yaml)$/i;
    const manifest: string[] = [];
    const snippets: string[] = [];
    let contentSize = 0;
    let manifestTruncated = false;
    const maxManifestEntries = 300;
    const maxContentSize = 20000;

    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 4) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(absoluteRoot, full);
        if (entry.isDirectory()) {
          if (manifest.length < maxManifestEntries) manifest.push(`${relative}/`);
          else manifestTruncated = true;
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (manifest.length < maxManifestEntries) manifest.push(relative);
        else manifestTruncated = true;
        if (!allowed.test(entry.name) || contentSize >= maxContentSize) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.size > 12000) continue;
          const content = await fs.readFile(full, 'utf8');
          const snippet = `\n--- ${relative} ---\n${content.slice(0, 6000)}`;
          if (contentSize + snippet.length <= maxContentSize) {
            snippets.push(snippet);
            contentSize += snippet.length;
          }
        } catch {}
      }
    };

    await walk(absoluteRoot);
    if (manifestTruncated) manifest.push('… (mapa limitat a 300 entrades)');
    return { manifest: manifest.join('\n'), contents: snippets.join('\n') };
  }
}
