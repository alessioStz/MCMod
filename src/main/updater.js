'use strict';

/**
 * Updates aus den GitHub-Releases.
 *
 * Der Installer (NSIS) kann sich selbst ersetzen — dort läuft der volle Weg:
 * prüfen, herunterladen, beim Beenden einspielen. Die portable .exe kann das
 * bauartbedingt nicht; dort meldet ModLoom nur, dass eine neue Fassung da ist,
 * und öffnet auf Wunsch die Release-Seite.
 */

const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES = 'https://github.com/alessioStz/MCMod/releases/latest';

let senden = () => {};
let protokoll = () => {};
let letzterStand = { zustand: 'unbekannt' };
let laueft = false;

/** Die portable .exe setzt diese Variable — dort ist kein Selbstersetzen möglich. */
const istPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

/** Ohne Paket gibt es keine Update-Quelle (Entwicklungsstart). */
const moeglich = () => app.isPackaged && !istPortable();

function stand(next) {
  letzterStand = { ...next, version: app.getVersion(), portable: istPortable(), moeglich: moeglich() };
  senden(letzterStand);
  return letzterStand;
}

function init({ onStatus, onLog }) {
  senden = onStatus || (() => {});
  protokoll = onLog || (() => {});

  autoUpdater.autoDownload = false; // Erst fragen, dann laden.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: protokoll, warn: protokoll, error: protokoll, debug: () => {} };

  autoUpdater.on('update-available', (info) => {
    protokoll(`Update verfügbar: ${info.version}`);
    stand({ zustand: 'verfuegbar', neueVersion: info.version, hinweise: info.releaseNotes || null });
  });

  autoUpdater.on('update-not-available', () => {
    stand({ zustand: 'aktuell' });
  });

  autoUpdater.on('download-progress', (p) => {
    stand({ zustand: 'laedt', anteil: p.percent / 100, uebertragen: p.transferred, gesamt: p.total });
  });

  autoUpdater.on('update-downloaded', (info) => {
    protokoll(`Update geladen: ${info.version}`);
    stand({ zustand: 'bereit', neueVersion: info.version });
  });

  autoUpdater.on('error', (err) => {
    protokoll(`Update-Fehler: ${err && err.message}`);
    stand({ zustand: 'fehler', fehler: err && err.message ? err.message : String(err) });
  });

  return letzterStand;
}

/**
 * Sucht nach einer neueren Fassung.
 * `still` unterdrückt Rückmeldungen, wenn ohnehin alles aktuell ist (Start).
 */
async function pruefen({ still = false } = {}) {
  if (istPortable()) {
    // Auch portabel wollen wir wissen, ob es etwas Neues gibt — nur eben ohne
    // Selbstinstallation. Dafür genügt die öffentliche Release-Auskunft.
    return pruefePortable(still);
  }
  if (!app.isPackaged) {
    return stand({ zustand: 'entwicklung' });
  }
  if (laueft) return letzterStand;

  laueft = true;
  stand({ zustand: 'pruefe', still });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    stand({ zustand: 'fehler', fehler: err && err.message ? err.message : String(err) });
  } finally {
    laueft = false;
  }
  return letzterStand;
}

/** Portable: nur nachsehen, welche Version im letzten Release steht. */
async function pruefePortable(still) {
  stand({ zustand: 'pruefe', still });
  try {
    const res = await fetch('https://api.github.com/repos/alessioStz/MCMod/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ModLoom/${app.getVersion()}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const daten = await res.json();
    const neu = String(daten.tag_name || '').replace(/^v/, '');
    if (neu && vergleiche(neu, app.getVersion()) > 0) {
      return stand({ zustand: 'verfuegbar', neueVersion: neu, nurHinweis: true });
    }
    return stand({ zustand: 'aktuell' });
  } catch (err) {
    return stand({ zustand: 'fehler', fehler: err && err.message ? err.message : String(err) });
  }
}

/** Einfacher Versionsvergleich (1.10.0 > 1.9.0). */
function vergleiche(a, b) {
  const zerlegen = (v) => String(v).split('.').map((t) => parseInt(t, 10) || 0);
  const x = zerlegen(a);
  const y = zerlegen(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function herunterladen() {
  if (!moeglich()) {
    await shell.openExternal(RELEASES);
    return stand({ ...letzterStand, zustand: letzterStand.zustand });
  }
  stand({ zustand: 'laedt', anteil: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    stand({ zustand: 'fehler', fehler: err && err.message ? err.message : String(err) });
  }
  return letzterStand;
}

/** Beendet die App und spielt das Update ein. */
function einspielen() {
  if (!moeglich()) return false;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

const releaseSeite = () => shell.openExternal(RELEASES);

module.exports = { init, pruefen, herunterladen, einspielen, releaseSeite, stand: () => letzterStand, moeglich, istPortable };
