'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fss = require('node:fs');

const store = require('./store');
const fabric = require('./fabric');
const modrinth = require('./modrinth');
const mods = require('./mods');
const updater = require('./updater');

const LIST_SCHEMA = 'modloom-list@1';

let win = null;

/* ---------------------------------------------------------------- Protokoll */

// Ein Startproblem soll nachvollziehbar sein, ohne dass jemand die App aus der
// Konsole starten muss. Die Datei wird bei jedem Start neu angelegt.
const logFile = path.join(app.getPath('userData'), 'modloom.log');

function log(text) {
  const zeile = `[${new Date().toISOString()}] ${text}\n`;
  try {
    fss.mkdirSync(path.dirname(logFile), { recursive: true });
    fss.appendFileSync(logFile, zeile);
  } catch {
    /* Ein fehlgeschlagenes Protokoll darf die App nicht aufhalten. */
  }
}

try {
  fss.mkdirSync(path.dirname(logFile), { recursive: true });
  fss.writeFileSync(logFile, '');
} catch {}

process.on('uncaughtException', (err) => {
  log(`Unbehandelter Fehler: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (err) => {
  log(`Unbehandelte Rejection: ${err && err.stack ? err.stack : err}`);
});

log(`Start – Version ${app.getVersion()}, gepackt=${app.isPackaged}`);

/* ------------------------------------------------------------------ Fenster */

const TITLEBAR = {
  dark: { color: '#1c1c1e', symbolColor: '#f5f5f7' },
  light: { color: '#f2f2f4', symbolColor: '#1c1c1e' }
};

function overlayForTheme() {
  return { ...(nativeTheme.shouldUseDarkColors ? TITLEBAR.dark : TITLEBAR.light), height: 44 };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f4',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayForTheme(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  // Das Fenster darf niemals unsichtbar bleiben. 'ready-to-show' ist im
  // gepackten Zustand unzuverlässig (feuerte im Test nur in einem von sechs
  // Starts), deshalb hängt das Anzeigen an drei unabhängigen Auslösern.
  let revealed = false;
  const reveal = (grund) => {
    if (revealed || !win || win.isDestroyed()) return;
    revealed = true;
    log(`Fenster anzeigen (${grund})`);
    win.show();
    win.focus();
  };

  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  const notbremse = setTimeout(() => reveal('Zeitlimit'), 4000);
  win.once('show', () => clearTimeout(notbremse));

  // Lädt die Seite nicht, ist ein sichtbares Fenster mit Fehlertext immer noch
  // besser als eine App, die scheinbar gar nicht startet.
  win.webContents.on('did-fail-load', (_e, code, beschreibung, url) => {
    log(`Seite nicht geladen: ${code} ${beschreibung} ${url}`);
    reveal('did-fail-load');
    dialog.showErrorBox(
      'ModLoom konnte nicht starten',
      `Die Oberfläche ließ sich nicht laden (${beschreibung}, Code ${code}).\n\n` +
        'Bitte die App neu installieren. Ein Fehlerprotokoll liegt unter:\n' +
        logFile
    );
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log(`Renderer beendet: ${JSON.stringify(details)}`);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
  });

  // Externe Links immer im Systembrowser, nie im App-Fenster.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

nativeTheme.on('updated', () => {
  if (!win || win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay(overlayForTheme());
  } catch {}
  win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
});

app.whenReady().then(() => {
  createWindow();

  updater.init({
    onStatus: (s) => emit('update:status', s),
    onLog: (t) => log(`Updater: ${t}`)
  });
  // Beim Start still nachsehen: nur melden, wenn es wirklich etwas Neues gibt.
  setTimeout(() => updater.pruefen({ still: true }).catch(() => {}), 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* --------------------------------------------------------------------- IPC */

/** Fehler landen als { ok:false, error } im Renderer statt als stiller Absturz. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

const emit = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

/* Konfiguration */

handle('config:get', async () => {
  const cfg = store.read();
  return {
    ...cfg,
    mcDirExists: fss.existsSync(cfg.mcDir),
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    appVersion: app.getVersion()
  };
});

handle('config:set', async (patch) => store.write(patch));

handle('dialog:pickMcDir', async () => {
  const cfg = store.read();
  const res = await dialog.showOpenDialog(win, {
    title: 'Minecraft-Ordner wählen',
    defaultPath: fss.existsSync(cfg.mcDir) ? cfg.mcDir : app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Ordner verwenden'
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return store.write({ mcDir: res.filePaths[0] });
});

/* Fabric */

handle('fabric:gameVersions', () => fabric.gameVersions());
handle('fabric:loaderVersions', ({ gameVersion }) => fabric.loaderVersions(gameVersion));
handle('fabric:recommendedLoader', ({ gameVersion }) => fabric.recommendedLoader(gameVersion));
handle('fabric:installedProfiles', () => fabric.installedProfiles(store.read().mcDir));
handle('fabric:isInstalled', ({ gameVersion, loaderVersion }) =>
  fabric.isInstalled(store.read().mcDir, gameVersion, loaderVersion)
);

handle('fabric:install', async ({ gameVersion, loaderVersion }) => {
  const cfg = store.read();
  const result = await fabric.install(cfg.mcDir, gameVersion, loaderVersion);
  store.write({ gameVersion, loaderVersion });
  return result;
});

/* Modrinth */

handle('modrinth:search', (args) => modrinth.search(args));
handle('modrinth:project', ({ id }) => modrinth.project(id));
handle('modrinth:versions', ({ projectId, gameVersion }) => modrinth.versions(projectId, gameVersion));

/** Für eine Liste: welcher Mod hat eine Version für diese MC-Version, welcher nicht? */
handle('modrinth:availability', async ({ projectIds, gameVersion }) => {
  const out = {};
  const metas = await modrinth.projects(projectIds).catch(() => []);
  const byId = new Map(metas.map((p) => [p.projectId, p]));
  for (const id of projectIds) {
    const meta = byId.get(id);
    const available = !!meta && Array.isArray(meta.gameVersions) && (!gameVersion || meta.gameVersions.includes(gameVersion));
    out[id] = {
      available,
      title: meta ? meta.title : null,
      iconUrl: meta ? meta.iconUrl : null,
      latestGameVersion: meta && meta.gameVersions ? meta.gameVersions[meta.gameVersions.length - 1] : null
    };
  }
  return out;
});

/* Mods */

handle('mods:list', () => mods.listInstalled(store.read().mcDir));

handle('mods:install', async ({ entries, gameVersion }) => {
  const cfg = store.read();
  return mods.installMany(cfg.mcDir, entries, gameVersion || cfg.gameVersion, {
    autoDependencies: cfg.autoDependencies !== false,
    onEvent: (e) => emit('mods:progress', e)
  });
});

handle('mods:remove', ({ filename }) => mods.removeMod(store.read().mcDir, filename));

handle('mods:clear', ({ includeUnmanaged, newGameVersion }) =>
  mods.clearMods(store.read().mcDir, { includeUnmanaged, newGameVersion })
);

handle('mods:snapshot', () => mods.snapshot(store.read().mcDir));

handle('mods:checkUpdates', ({ gameVersion }) => mods.checkUpdates(store.read().mcDir, gameVersion || store.read().gameVersion));

handle('mods:openFolder', async () => {
  const dir = mods.modsDir(store.read().mcDir);
  await fs.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

/* Listen */

handle('lists:all', () => store.listsAll());
handle('lists:create', ({ name, mods: entries, gameVersion }) => store.listCreate(name, entries || [], { gameVersion }));
handle('lists:update', ({ id, patch }) => store.listUpdate(id, patch));
handle('lists:delete', ({ id }) => store.listDelete(id));
handle('lists:addMod', ({ id, mod }) => store.listAddMod(id, mod));
handle('lists:removeMod', ({ id, projectId }) => store.listRemoveMod(id, projectId));

handle('lists:export', async ({ id }) => {
  const list = store.listsAll().find((l) => l.id === id);
  if (!list) throw new Error('Liste nicht gefunden');

  const safeName = list.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'modliste';
  const res = await dialog.showSaveDialog(win, {
    title: 'Liste exportieren',
    defaultPath: `${safeName}.modlist.json`,
    filters: [{ name: 'ModLoom-Liste', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return null;

  const payload = {
    schema: LIST_SCHEMA,
    name: list.name,
    exportedAt: new Date().toISOString(),
    gameVersion: list.gameVersion || store.read().gameVersion,
    loader: 'fabric',
    mods: list.mods
  };
  await fs.writeFile(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
  return res.filePath;
});

handle('lists:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Liste importieren',
    filters: [{ name: 'ModLoom-Liste', extensions: ['json'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || !res.filePaths.length) return null;

  const imported = [];
  for (const file of res.filePaths) {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const entries = extractMods(raw);
    if (!entries.length) throw new Error(`${path.basename(file)} enthält keine Mods`);
    const name = raw.name || path.basename(file).replace(/\.modlist\.json$|\.json$/i, '');
    imported.push(store.listCreate(name, entries, { gameVersion: raw.gameVersion || null }));
  }
  return imported;
});

/** Nimmt unser Exportformat, aber auch eine blanke Mod-Liste oder ein Array von Slugs. */
function extractMods(raw) {
  const source = Array.isArray(raw) ? raw : raw.mods || raw.projects || raw.files || [];
  return source
    .map((m) => {
      if (typeof m === 'string') return { projectId: m, slug: m, title: m };
      const projectId = m.projectId || m.project_id || m.id || m.slug;
      if (!projectId) return null;
      return store.normalizeMod({ ...m, projectId });
    })
    .filter(Boolean);
}

/* Sonstiges */

/* Updates */

handle('update:status', async () => updater.stand());
handle('update:check', async ({ still } = {}) => updater.pruefen({ still: !!still }));
handle('update:download', async () => updater.herunterladen());
handle('update:install', async () => updater.einspielen());
handle('update:openReleases', async () => {
  await updater.releaseSeite();
  return true;
});

handle('app:openLog', async () => {
  await shell.showItemInFolder(logFile);
  return logFile;
});

handle('app:openExternal', async ({ url }) => {
  if (!/^https?:\/\//.test(url)) throw new Error('Nur http(s)-Links erlaubt');
  await shell.openExternal(url);
  return true;
});
