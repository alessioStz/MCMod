'use strict';

const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const { getJson, UA } = require('./net');

const META = 'https://meta.fabricmc.net/v2';

/** Alle Minecraft-Versionen, die Fabric unterstützt. */
async function gameVersions() {
  const list = await getJson(`${META}/versions/game`);
  return list.map((v) => ({ version: v.version, stable: !!v.stable }));
}

/** Loader-Versionen für eine Minecraft-Version. */
async function loaderVersions(gameVersion) {
  const list = await getJson(`${META}/versions/loader/${encodeURIComponent(gameVersion)}`);
  return list.map((e) => ({
    version: e.loader.version,
    stable: !!e.loader.stable,
    build: e.loader.build
  }));
}

function profileId(gameVersion, loaderVersion) {
  return `fabric-loader-${loaderVersion}-${gameVersion}`;
}

/** Ist dieses Fabric-Profil bereits im .minecraft-Ordner installiert? */
function isInstalled(mcDir, gameVersion, loaderVersion) {
  const id = profileId(gameVersion, loaderVersion);
  return fss.existsSync(path.join(mcDir, 'versions', id, `${id}.json`));
}

/** Welche Fabric-Profile liegen im .minecraft-Ordner? */
function installedProfiles(mcDir) {
  const dir = path.join(mcDir, 'versions');
  let entries = [];
  try {
    entries = fss.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^fabric-loader-(.+)-([^-]+)$/.test(e.name))
    .map((e) => {
      const m = e.name.match(/^fabric-loader-(.+?)-([0-9][^-]*(?:-[a-z0-9.]+)*)$/i);
      return { id: e.name, loaderVersion: m ? m[1] : null, gameVersion: m ? m[2] : null };
    });
}

/**
 * Installiert Fabric als Version+Profil in den Vanilla-Launcher.
 * Entspricht dem, was der offizielle Fabric-Installer im Client-Modus macht:
 * versions/<id>/<id>.json + leeres <id>.jar, plus Eintrag in launcher_profiles.json.
 */
async function install(mcDir, gameVersion, loaderVersion) {
  const id = profileId(gameVersion, loaderVersion);
  const json = await getJson(
    `${META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  );

  const versionDir = path.join(mcDir, 'versions', id);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, `${id}.json`), JSON.stringify(json, null, 2), 'utf8');
  // Der Vanilla-Launcher erwartet eine (leere) Jar neben der JSON.
  const jar = path.join(versionDir, `${id}.jar`);
  if (!fss.existsSync(jar)) await fs.writeFile(jar, '');

  await fs.mkdir(path.join(mcDir, 'mods'), { recursive: true });
  const profileWritten = await upsertLauncherProfile(mcDir, id, gameVersion);

  return { id, versionDir, profileWritten, userAgent: UA };
}

async function upsertLauncherProfile(mcDir, id, gameVersion) {
  const file = path.join(mcDir, 'launcher_profiles.json');
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    data = { profiles: {}, settings: {}, version: 3 };
  }
  if (!data.profiles || typeof data.profiles !== 'object') data.profiles = {};

  const key = `fabric-loader-${gameVersion}`;
  const now = new Date().toISOString();
  const prev = data.profiles[key] || {};
  data.profiles[key] = {
    ...prev,
    name: `fabric-loader-${gameVersion}`,
    type: 'custom',
    created: prev.created || now,
    lastUsed: now,
    lastVersionId: id,
    icon: prev.icon || 'Furnace'
  };

  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    // Läuft der Launcher gerade, kann die Datei gesperrt sein – Version bleibt trotzdem nutzbar.
    return false;
  }
}

/** Neueste stabile Loader-Version für eine MC-Version (Fallback: neueste überhaupt). */
async function recommendedLoader(gameVersion) {
  const list = await loaderVersions(gameVersion);
  return (list.find((l) => l.stable) || list[0] || null)?.version || null;
}

module.exports = {
  gameVersions,
  loaderVersions,
  profileId,
  isInstalled,
  installedProfiles,
  install,
  recommendedLoader
};
