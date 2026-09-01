'use strict';

const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const { download } = require('./net');
const modrinth = require('./modrinth');

const MANIFEST = '.modloom.json';
const SCHEMA = 'modloom-installed@1';

const modsDir = (mcDir) => path.join(mcDir, 'mods');
const manifestPath = (mcDir) => path.join(modsDir(mcDir), MANIFEST);

async function readManifest(mcDir) {
  try {
    const data = JSON.parse(await fs.readFile(manifestPath(mcDir), 'utf8'));
    if (!data.mods || typeof data.mods !== 'object') data.mods = {};
    return data;
  } catch {
    return { schema: SCHEMA, gameVersion: null, loader: 'fabric', mods: {} };
  }
}

async function writeManifest(mcDir, data) {
  await fs.mkdir(modsDir(mcDir), { recursive: true });
  await fs.writeFile(manifestPath(mcDir), JSON.stringify({ ...data, schema: SCHEMA }, null, 2), 'utf8');
}

/** Alles im mods-Ordner: verwaltete Mods aus dem Manifest + fremde .jar-Dateien. */
async function listInstalled(mcDir) {
  const dir = modsDir(mcDir);
  const manifest = await readManifest(mcDir);

  let files = [];
  try {
    files = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && /\.jar(\.disabled)?$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    return { dir, gameVersion: manifest.gameVersion, mods: [] };
  }

  const mods = [];
  for (const filename of files) {
    const meta = manifest.mods[filename];
    let size = 0;
    try {
      size = (await fs.stat(path.join(dir, filename))).size;
    } catch {}
    mods.push(
      meta
        ? { ...meta, filename, size, managed: true, disabled: filename.endsWith('.disabled') }
        : {
            filename,
            size,
            managed: false,
            disabled: filename.endsWith('.disabled'),
            title: filename.replace(/\.jar(\.disabled)?$/i, ''),
            projectId: null,
            iconUrl: null
          }
    );
  }

  mods.sort((a, b) => String(a.title).localeCompare(String(b.title), 'de'));
  return { dir, gameVersion: manifest.gameVersion, mods };
}

/**
 * Installiert eine Menge von Modrinth-Versionen in den mods-Ordner.
 * Jeder Eintrag: { projectId, versionId?, title?, iconUrl?, slug? }
 * Rückgabe pro Eintrag: status = installed | already | unavailable | failed
 * onEvent({ type, ... }) meldet Fortschritt live an den Renderer.
 */
async function installMany(mcDir, entries, gameVersion, { autoDependencies = true, onEvent = () => {} } = {}) {
  await fs.mkdir(modsDir(mcDir), { recursive: true });
  const manifest = await readManifest(mcDir);
  manifest.gameVersion = gameVersion;

  const results = [];
  const resolved = [];

  // 1) Passende Version je Mod suchen - ohne Treffer wird nur markiert, nie installiert.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    onEvent({ type: 'resolve', index: i, total: entries.length, title: entry.title || entry.projectId });
    try {
      const version = entry.versionId
        ? await modrinth.versionById(entry.versionId).catch(() => null)
        : await modrinth.bestVersion(entry.projectId, gameVersion);

      const fits = version && version.file && (!gameVersion || version.gameVersions.includes(gameVersion));
      if (!fits) {
        results.push({
          ...entry,
          status: 'unavailable',
          reason: `Keine Fabric-Version für Minecraft ${gameVersion || '?'}`
        });
        continue;
      }
      version.title = entry.title || version.name;
      version.iconUrl = entry.iconUrl || null;
      version.slug = entry.slug || null;
      resolved.push({ entry, version });
    } catch (err) {
      results.push({ ...entry, status: 'failed', reason: err.message });
    }
  }

  // 2) Pflicht-Abhängigkeiten ergänzen.
  let dependencyMissing = [];
  if (autoDependencies && resolved.length) {
    onEvent({ type: 'dependencies' });
    try {
      const { extra, missing } = await modrinth.resolveDependencies(resolved.map((r) => r.version), gameVersion);
      dependencyMissing = missing;
      for (const version of extra) {
        resolved.push({
          entry: {
            projectId: version.projectId,
            title: version.title || version.name,
            iconUrl: version.iconUrl || null,
            slug: version.slug || null
          },
          version,
          isDependency: true
        });
      }
    } catch {
      // Abhängigkeiten sind ein Bonus - ein Fehler hier darf die Installation nicht stoppen.
    }
  }

  // 3) Herunterladen.
  for (let i = 0; i < resolved.length; i++) {
    const { entry, version, isDependency } = resolved[i];
    const filename = version.file.filename;
    const dest = path.join(modsDir(mcDir), filename);

    const already = manifest.mods[filename] && fss.existsSync(dest);
    if (already && manifest.mods[filename].versionId === version.versionId) {
      results.push({ ...entry, status: 'already', filename, isDependency });
      continue;
    }

    onEvent({
      type: 'download',
      index: i,
      total: resolved.length,
      title: entry.title,
      isDependency: !!isDependency
    });

    try {
      await download(version.file.url, dest, {
        sha1: version.file.sha1,
        onProgress: (received, size) => onEvent({ type: 'progress', title: entry.title, received, size })
      });

      // Aeltere Datei desselben Projekts entfernen (Versionswechsel innerhalb derselben MC-Version).
      for (const [name, meta] of Object.entries(manifest.mods)) {
        if (meta.projectId === version.projectId && name !== filename) {
          await trash(path.join(modsDir(mcDir), name));
          delete manifest.mods[name];
        }
      }

      manifest.mods[filename] = {
        projectId: version.projectId,
        slug: entry.slug || null,
        title: entry.title || version.name,
        iconUrl: entry.iconUrl || null,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        gameVersion,
        loader: 'fabric',
        installedAt: new Date().toISOString(),
        isDependency: !!isDependency
      };
      results.push({ ...entry, status: 'installed', filename, versionNumber: version.versionNumber, isDependency });
    } catch (err) {
      results.push({ ...entry, status: 'failed', reason: err.message, isDependency });
    }
  }

  await writeManifest(mcDir, manifest);
  return { results, dependencyMissing };
}

/** Löscht eine Mod-Datei (in den Papierkorb) und entfernt sie aus dem Manifest. */
async function removeMod(mcDir, filename) {
  await trash(path.join(modsDir(mcDir), filename));
  const manifest = await readManifest(mcDir);
  delete manifest.mods[filename];
  await writeManifest(mcDir, manifest);
  return true;
}

/** Räumt den mods-Ordner beim Versionswechsel. Alles wandert in den Papierkorb. */
async function clearMods(mcDir, { includeUnmanaged = true, newGameVersion = null } = {}) {
  const { mods } = await listInstalled(mcDir);
  const manifest = await readManifest(mcDir);
  let removed = 0;
  const failed = [];

  for (const mod of mods) {
    if (!mod.managed && !includeUnmanaged) continue;
    const ok = await trash(path.join(modsDir(mcDir), mod.filename));
    if (ok) {
      removed++;
      delete manifest.mods[mod.filename];
    } else {
      failed.push(mod.filename);
    }
  }

  manifest.gameVersion = newGameVersion;
  await writeManifest(mcDir, manifest);
  return { removed, failed };
}

/** Snapshot der installierten Mods - Grundlage für "vorher als Liste sichern". */
async function snapshot(mcDir) {
  const { mods } = await listInstalled(mcDir);
  return mods
    .filter((m) => m.managed && m.projectId)
    .map((m) => ({
      projectId: m.projectId,
      slug: m.slug,
      title: m.title,
      iconUrl: m.iconUrl,
      author: m.author || null
    }));
}

/** Prüft für alle verwalteten Mods, ob es eine neuere Version gibt. */
async function checkUpdates(mcDir, gameVersion) {
  const { mods } = await listInstalled(mcDir);
  const updates = [];
  for (const mod of mods) {
    if (!mod.managed || !mod.projectId) continue;
    const best = await modrinth.bestVersion(mod.projectId, gameVersion).catch(() => null);
    if (best && best.versionId !== mod.versionId) {
      updates.push({
        projectId: mod.projectId,
        title: mod.title,
        iconUrl: mod.iconUrl,
        filename: mod.filename,
        from: mod.versionNumber,
        to: best.versionNumber,
        versionId: best.versionId
      });
    }
  }
  return updates;
}

async function trash(file) {
  if (!fss.existsSync(file)) return true;
  try {
    await shell.trashItem(file); // Papierkorb statt endgültig löschen - Fehlgriffe bleiben rückholbar.
    return true;
  } catch {
    try {
      await fs.rm(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  modsDir,
  listInstalled,
  installMany,
  removeMod,
  clearMods,
  snapshot,
  checkUpdates,
  readManifest,
  writeManifest
};
