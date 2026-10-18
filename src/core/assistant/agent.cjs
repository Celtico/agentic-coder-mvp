const path = require('node:path');
const fs = require('node:fs/promises');

class LocalCodingAgent {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.generator = null;
    this.loading = null;
    this.modelId = process.env.AGENT_MODEL || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct';
    this.historyDir = path.join(require('node:os').homedir(), '.agentic-coder', 'memory');
  }

  async loadModel() {
    if (this.generator) return this.generator;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.onStatus({ type: 'status', message: `Carregant model local: ${this.modelId}. La primera execució descarrega els pesos.` });
      const { pipeline, env } = await import('@huggingface/transformers');
      // Keep downloaded model weights inside the project so they are easy to find
      // and back up. Transformers.js creates the cache structure on first download.
      env.cacheDir = path.join(__dirname, '..', '..', '..', 'models');
      this.generator = await pipeline('text-generation', this.modelId, { dtype: 'q4' });
      this.onStatus({ type: 'status', message: 'Model carregat.' });
      return this.generator;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async ask(prompt, projectRoot) {
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
      `Contingut llegit per a aquesta petició (límit aproximat de 20 KB):\n${context.contents || '(no hi ha fitxers de text compatibles dins del límit)'}`
    ].join('\n\n');
    const generator = await this.loadModel();
    this.onStatus({ type: 'status', message: 'Generant resposta…' });
    const result = await generator([
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ], { max_new_tokens: 700, temperature: 0.2, do_sample: false });
    const text = result?.[0]?.generated_text;
    let answer = '';
    if (Array.isArray(text)) answer = text[text.length - 1]?.content || '';
    else answer = String(text || 'No s’ha generat cap resposta.');
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.appendFile(path.join(this.historyDir, 'sessions.jsonl'), JSON.stringify({ at: new Date().toISOString(), model: this.modelId, prompt, answer }) + '\n');
    this.onStatus({ type: 'status', message: 'Resposta generada i registrada a la memòria local.' });
    return answer;
  }

  async collectContext(root) {
    const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', 'models']);
    const allowed = /\.(js|cjs|mjs|ts|tsx|jsx|json|md|html|css|py|go|rs|java|php|yml|yaml)$/i;
    const manifest = [];
    const snippets = [];
    let contentSize = 0;
    let manifestTruncated = false;
    const maxManifestEntries = 300;
    const maxContentSize = 20000;

    async function walk(dir, depth = 0) {
      if (depth > 4) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
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
    }

    await walk(root);
    if (manifestTruncated) manifest.push('… (mapa limitat a 300 entrades)');
    return {
      manifest: manifest.join('\n'),
      contents: snippets.join('\n')
    };
  }
}
module.exports = { LocalCodingAgent };
