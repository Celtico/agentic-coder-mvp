/**
 * Clicks, form filling and visibility checks carried out inside a page the app itself has open.
 * Electron is already a browser, so none of this needs Playwright or anything installed in the
 * project. Elements are found the way a person would name them: by role, label, placeholder,
 * visible text or test id. No selectors and no script come from the model.
 */
const ROLES = ['button', 'link', 'checkbox', 'radio', 'textbox', 'heading', 'option'];
const BY = ['role', 'label', 'placeholder', 'text', 'testId'];

function checkedActions(actions = []) {
  if (!Array.isArray(actions) || actions.length > 12) throw new Error('Una inspecció pot incloure com a màxim 12 accions de navegador.');
  return actions.map((action, index) => {
    const fail = (why) => { throw new Error(`L’acció de navegador ${index + 1} (${String(action?.type || 'desconeguda')}) ha fallat: ${why}`); };
    if (!action || typeof action !== 'object' || Array.isArray(action)) fail('l’acció no és vàlida');
    if (action.type === 'assertText') {
      if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 1000) fail('el text a comprovar no és vàlid');
      return { type: 'assertText', text: action.text };
    }
    if (!['click', 'fill', 'assertVisible'].includes(action.type)) fail('el tipus d’acció no és admès');
    const target = action.target;
    if (!target || typeof target !== 'object' || !BY.includes(target.by) || typeof target.value !== 'string' || target.value.length > 300) fail('l’element indicat no és vàlid');
    if (target.by === 'role' && !ROLES.includes(target.role)) fail('el rol indicat no és admès');
    if (target.by !== 'role' && !target.value.trim()) fail('falta el text que identifica l’element');
    if (action.type === 'fill' && (typeof action.value !== 'string' || action.value.length > 1000)) fail('el valor del camp no és vàlid');
    return { type: action.type, target: { by: target.by, value: target.value, role: target.role }, ...(action.type === 'fill' ? { value: action.value } : {}) };
  });
}

/** Runs inside the page. Receives only validated data; returns what happened. */
async function runInPage(actions) {
  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (element) => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const roleSelector = {
    button: 'button,[role=button],input[type=button],input[type=submit]', link: 'a[href],[role=link]',
    checkbox: 'input[type=checkbox],[role=checkbox]', radio: 'input[type=radio],[role=radio]',
    textbox: 'input:not([type]),input[type=text],input[type=email],input[type=search],input[type=password],input[type=number],input[type=tel],input[type=url],textarea,[role=textbox],[contenteditable=true]',
    heading: 'h1,h2,h3,h4,h5,h6,[role=heading]', option: 'option,[role=option]',
  };
  const nameOf = (element) => norm(element.getAttribute('aria-label') || element.innerText || element.value || element.getAttribute('title') || element.getAttribute('placeholder'));
  const find = (target) => {
    const wanted = norm(target.value);
    let found = [];
    if (target.by === 'testId') found = [...document.querySelectorAll('[data-testid]')].filter((element) => element.getAttribute('data-testid') === target.value);
    else if (target.by === 'placeholder') found = [...document.querySelectorAll('[placeholder]')].filter((element) => norm(element.getAttribute('placeholder')).includes(wanted));
    else if (target.by === 'label') {
      found = [...document.querySelectorAll('label')].filter((label) => norm(label.innerText).includes(wanted)).map((label) => label.control || label.querySelector('input,textarea,select')).filter(Boolean);
      found.push(...[...document.querySelectorAll('[aria-label]')].filter((element) => norm(element.getAttribute('aria-label')).includes(wanted)));
    } else if (target.by === 'role') found = [...document.querySelectorAll(roleSelector[target.role])].filter((element) => !wanted || nameOf(element).includes(wanted));
    else {
      const holders = [...document.querySelectorAll('body *')].filter((element) => norm(element.innerText).includes(wanted));
      found = holders.filter((element) => !holders.some((other) => other !== element && element.contains(other)));
    }
    return found.find(visible) || null;
  };
  const until = async (probe) => { const end = Date.now() + 4000; for (;;) { const value = probe(); if (value) return value; if (Date.now() > end) return null; await new Promise((resolve) => setTimeout(resolve, 100)); } };
  const results = [];
  for (const [index, action] of actions.entries()) {
    const failed = (why) => ({ results, error: `L’acció de navegador ${index + 1} (${action.type}) ha fallat: ${why}` });
    if (action.type === 'assertText') {
      if (!await until(() => norm(document.body.innerText).includes(norm(action.text)))) return failed(`a la pàgina no es veu el text «${action.text}»`);
    } else {
      const element = await until(() => find(action.target));
      if (!element) return failed(`no s’ha trobat cap element visible per ${action.target.by} «${action.target.value || action.target.role}»`);
      if (action.type === 'click') element.click();
      else if (action.type === 'fill') {
        element.focus();
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = 'value' in element ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
        if (setter) setter.call(element, action.value); else element.textContent = action.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    results.push({ description: `${index + 1}. ${action.type}`, succeeded: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { results };
}

/** The text to evaluate in the page: the function above applied to the validated actions. */
function pageActionsScript(actions) {
  return `(${runInPage.toString()})(${JSON.stringify(checkedActions(actions))})`;
}

module.exports = { checkedActions, pageActionsScript, runInPage };
