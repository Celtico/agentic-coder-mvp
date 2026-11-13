// Renders docs/cover/cover.html (with docs/cover/app.png, a capture of the app) into docs/cover.png,
// 2400 × 1254, with Electron's own browser.
//
//   npx electron scripts/render-cover.cjs
//
// A new app.png comes from the app itself: View › «Desa una captura de la finestra…» (Cmd+Shift+S).
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 2400, height: 1254, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'docs', 'cover', 'cover.html'));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 2400, height: 1254 });
  const out = path.join(__dirname, '..', 'docs', 'cover.png');
  fs.writeFileSync(out, image.toPNG());
  console.error(`Portada: ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});
