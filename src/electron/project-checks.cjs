const fs = require('node:fs/promises');

async function executeProjectChecks(root, runScript) {
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(require('node:path').join(root, 'package.json'), 'utf8'));
  } catch (error) {
    const reason = error.code === 'ENOENT'
      ? 'Aquest projecte encara no té package.json; no s’han executat comprovacions. Si estàs creant una app JavaScript, crea primer el package.json i els fitxers inicials.'
      : 'El package.json no és vàlid; no s’han executat comprovacions.';
    return { code: -1, output: reason, checksAvailable: false };
  }

  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const checks = scripts.test ? ['test'] : ['lint', 'typecheck', 'build'].filter((script) => typeof scripts[script] === 'string');
  if (!checks.length) return { code: -1, output: 'El projecte no defineix scripts de test, lint, typecheck ni build a package.json.', checksAvailable: false };

  let output = '';
  for (const script of checks) {
    output += `> npm run ${script}\n`;
    const result = await runScript(root, script);
    output += `${result.output || '(sense sortida)'}\n`;
    if (result.code !== 0) return { ...result, output: `${output}\nLa comprovació «${script}» ha fallat.`, checksAvailable: true };
  }
  return { code: 0, output: `${output}\nComprovacions superades: ${checks.join(', ')}.`, checksAvailable: true };
}

module.exports = { executeProjectChecks };
