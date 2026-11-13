// Run with Electron: loads one URL in a hidden window and prints one line
//   PAGE_RESULT {"errors": [...], "textLength": n, "text": "...", "elements": n}
// with the console errors and how much visible content the page shows. Used by the app tasks of the
// benchmark to check that a built app really renders.
const { app, BrowserWindow } = require('electron');

const url = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    const level = event.level ?? event.params?.level;
    const message = event.message ?? event.params?.message;
    if (level === 'error' || level === 3) errors.push(String(message).slice(0, 300));
  });
  win.webContents.on('did-fail-load', (_event, code, description) => errors.push(`load failed ${code} ${description}`));
  try { await win.loadURL(url); } catch (error) { errors.push(String(error.message)); }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  let text = '';
  let elements = 0;
  try {
    text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
    elements = await win.webContents.executeJavaScript('document.querySelectorAll("body *").length');
  } catch (error) { errors.push(String(error.message)); }
  console.log(`PAGE_RESULT ${JSON.stringify({ errors, textLength: text.trim().length, text: text.trim().slice(0, 300), elements })}`);
  app.exit(0);
});
