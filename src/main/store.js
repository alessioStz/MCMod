'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

const DEFAULTS = {
  mcDir: path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft'),
  gameVersion: null,
  loaderVersion: null,
  showSnapshots: false,
  autoDependencies: true,
  lists: []
};

let cache = null;
let file = null;

function configPath() {
  if (!file) file = path.join(app.getPath('userData'), 'config.json');
  return file;
}

function read() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  if (!Array.isArray(cache.lists)) cache.lists = [];
  return cache;
}

function write(next) {
  cache = { ...read(), ...next };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Listen ---------- */

function listsAll() {
  return read().lists;
}

function listCreate(name, mods = [], meta = {}) {
  const list = {
    id: newId(),
    name: (name || 'Neue Liste').trim() || 'Neue Liste',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    gameVersion: meta.gameVersion || null,
    loader: 'fabric',
    mods: mods.map(normalizeMod)
  };
  const lists = listsAll().slice();
  lists.push(list);
  write({ lists });
  return list;
}

function listUpdate(id, patch) {
  const lists = listsAll().map((l) =>
    l.id === id ? { ...l, ...patch, updatedAt: new Date().toISOString() } : l
  );
  write({ lists });
  return lists.find((l) => l.id === id) || null;
}

function listDelete(id) {
  write({ lists: listsAll().filter((l) => l.id !== id) });
  return true;
}

function normalizeMod(m) {
  return {
    projectId: m.projectId || m.project_id || m.id,
    slug: m.slug || null,
    title: m.title || m.name || m.slug || m.projectId,
    iconUrl: m.iconUrl || m.icon_url || null,
    author: m.author || null,
    versionId: m.versionId || null // optionaler Pin auf eine konkrete Version
  };
}

function listAddMod(id, mod) {
  const list = listsAll().find((l) => l.id === id);
  if (!list) return null;
  const entry = normalizeMod(mod);
  if (list.mods.some((m) => m.projectId === entry.projectId)) return list;
  return listUpdate(id, { mods: [...list.mods, entry] });
}

function listRemoveMod(id, projectId) {
  const list = listsAll().find((l) => l.id === id);
  if (!list) return null;
  return listUpdate(id, { mods: list.mods.filter((m) => m.projectId !== projectId) });
}

module.exports = {
  DEFAULTS,
  read,
  write,
  listsAll,
  listCreate,
  listUpdate,
  listDelete,
  listAddMod,
  listRemoveMod,
  normalizeMod,
  newId
};
