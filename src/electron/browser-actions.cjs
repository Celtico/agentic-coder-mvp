const allowedRoles = new Set(['button', 'link', 'checkbox', 'radio', 'textbox', 'heading', 'option']);
const allowedLocators = new Set(['role', 'label', 'placeholder', 'text', 'testId']);

function validateTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('El localitzador de navegador no és vàlid.');
  if (!allowedLocators.has(target.by) || typeof target.value !== 'string' || !target.value.trim() || target.value.length > 200) {
    throw new Error('El localitzador de navegador no és vàlid.');
  }
  if (target.by === 'role' && !allowedRoles.has(target.role)) throw new Error('El rol accessible no és vàlid.');
}

function locatorFor(page, target) {
  validateTarget(target);
  if (target.by === 'role') return page.getByRole(target.role, { name: target.value, exact: true });
  if (target.by === 'label') return page.getByLabel(target.value, { exact: true });
  if (target.by === 'placeholder') return page.getByPlaceholder(target.value, { exact: true });
  if (target.by === 'text') return page.getByText(target.value, { exact: true });
  return page.getByTestId(target.value);
}

async function runBrowserActions(page, actions = []) {
  if (!Array.isArray(actions) || actions.length > 12) throw new Error('Una inspecció pot incloure com a màxim 12 accions de navegador.');
  const results = [];
  for (const [index, action] of actions.entries()) {
    try {
      if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('l’acció no és vàlida');
      if (action.type === 'assertText') {
        if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 1000) throw new Error('el text a comprovar no és vàlid');
        await page.getByText(action.text, { exact: false }).first().waitFor({ state: 'visible', timeout: 5000 });
      } else {
        const locator = locatorFor(page, action.target).first();
        if (action.type === 'click') await locator.click({ timeout: 5000 });
        else if (action.type === 'fill') {
          if (typeof action.value !== 'string' || action.value.length > 1000) throw new Error('el valor del camp no és vàlid');
          await locator.fill(action.value, { timeout: 5000 });
        } else if (action.type === 'assertVisible') await locator.waitFor({ state: 'visible', timeout: 5000 });
        else throw new Error('el tipus d’acció no és admès');
      }
      results.push({ description: `${index + 1}. ${action.type}`, succeeded: true });
    } catch (error) {
      throw new Error(`L’acció de navegador ${index + 1} (${String(action?.type || 'desconeguda')}) ha fallat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

module.exports = { runBrowserActions };
