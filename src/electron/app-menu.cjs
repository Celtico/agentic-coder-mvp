// The app's menu, in Catalan (the text is in src/electron/menu-labels.cjs). Built as a plain template so
// it can be checked without Electron; main.cjs gives it the actions and turns it into the menu.
const PANES = ['editor', 'browser', 'evaluation', 'console', 'terminal', 'git', 'learning', 'llmlog'];

/**
 * `actions`: { preferences, openFolder, newChat, save, togglePane(pane), capture, repository, readme, turnLog }.
 * `panes`: which panes are open (a check beside each). `isMac`: the app menu and Window's macOS items.
 */
function buildMenuTemplate({ labels, actions, panes = {}, isMac = process.platform === 'darwin' }) {
  const separator = { type: 'separator' };
  const appMenu = {
    label: labels.app,
    submenu: [
      { role: 'about', label: labels.about },
      separator,
      { label: labels.preferences, accelerator: 'CmdOrCtrl+,', click: () => actions.preferences() },
      separator,
      { role: 'services', label: labels.services },
      separator,
      { role: 'hide', label: labels.hide },
      { role: 'hideOthers', label: labels.hideOthers },
      { role: 'unhide', label: labels.showAll },
      separator,
      { role: 'quit', label: labels.quit },
    ],
  };
  const file = {
    label: labels.file,
    submenu: [
      { label: labels.openFolder, accelerator: 'CmdOrCtrl+O', click: () => actions.openFolder() },
      { label: labels.newChat, accelerator: 'CmdOrCtrl+N', click: () => actions.newChat() },
      separator,
      { label: labels.save, accelerator: 'CmdOrCtrl+S', click: () => actions.save() },
      separator,
      ...(isMac ? [] : [{ label: labels.preferences, accelerator: 'CmdOrCtrl+,', click: () => actions.preferences() }, separator]),
      { role: 'close', label: labels.closeWindow },
      ...(isMac ? [] : [{ role: 'quit', label: labels.quit }]),
    ],
  };
  const edit = {
    label: labels.edit,
    submenu: [
      { role: 'undo', label: labels.undo },
      { role: 'redo', label: labels.redo },
      separator,
      { role: 'cut', label: labels.cut },
      { role: 'copy', label: labels.copy },
      { role: 'paste', label: labels.paste },
      ...(isMac ? [{ role: 'pasteAndMatchStyle', label: labels.pasteAndMatchStyle }] : []),
      { role: 'delete', label: labels.delete },
      { role: 'selectAll', label: labels.selectAll },
    ],
  };
  const view = {
    label: labels.view,
    submenu: [
      { role: 'reload', label: labels.reload },
      { role: 'forceReload', label: labels.forceReload },
      { role: 'toggleDevTools', label: labels.devTools },
      separator,
      { role: 'resetZoom', label: labels.actualSize },
      { role: 'zoomIn', label: labels.zoomIn },
      { role: 'zoomOut', label: labels.zoomOut },
      separator,
      { role: 'togglefullscreen', label: labels.fullScreen },
      separator,
      // The app's own panes, with a check when open; the editor opens from a file, but can be shown here too.
      ...PANES.map((pane) => ({ label: labels.panes[pane], type: 'checkbox', checked: Boolean(panes[pane]), click: () => actions.togglePane(pane) })),
      separator,
      { label: labels.capture, accelerator: 'CmdOrCtrl+Shift+S', click: () => actions.capture() },
    ],
  };
  const windowMenu = {
    label: labels.window,
    role: 'windowMenu',
    submenu: [
      { role: 'minimize', label: labels.minimize },
      { role: 'zoom', label: labels.zoom },
      ...(isMac ? [separator, { role: 'front', label: labels.front }] : []),
    ],
  };
  const help = {
    label: labels.help,
    role: 'help',
    submenu: [
      { label: labels.repository, click: () => actions.repository() },
      { label: labels.readme, click: () => actions.readme() },
      { label: labels.turnLog, click: () => actions.turnLog() },
    ],
  };
  return [...(isMac ? [appMenu] : []), file, edit, view, windowMenu, help];
}

module.exports = { buildMenuTemplate, PANES };
