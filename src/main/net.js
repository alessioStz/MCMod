'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { finished } = require('node:stream/promises');

// Modrinth verlangt einen aussagekräftigen User-Agent.
const UA = 'ModLoom/1.0.0 (Fabric mod manager; local desktop app)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}, attempt = 0) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }
  });

  // 429/5xx: einmal höflich zurückweichen, dann erneut versuchen.
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt;
    await sleep(Math.min(wait, 5000));
    return request(url, opts, attempt + 1);
  }
  return res;
}

async function getJson(url, opts) {
  const res = await request(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} für ${url}${body ? ` – ${body.slice(0, 180)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Lädt eine Datei atomar (erst .part, dann umbenennen) und prüft die SHA1.
 *
 * Die Blöcke werden bewusst kopiert: Electrons fetch im Main-Prozess reicht
 * Puffer weiter, die es nach dem Auflösen wiederverwenden darf. Schreibt man
 * sie ungeprüft in einen Stream, der sie erst später wegschreibt, landen
 * bereits überschriebene Bytes in der Datei — die Länge stimmt dann exakt,
 * der Inhalt nicht. Genau das ließ bei vielen Mods die Prüfsumme scheitern.
 *
 * onProgress(empfangeneBytes, gesamtBytes|null)
 */
async function download(url, dest, { sha1, size, onProgress, versuche = 3 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let letzterFehler = null;

  // Ein kaputter Block oder eine abgerissene Verbindung ist kein Grund
  // aufzugeben — erst nach mehreren Anläufen gilt der Download als gescheitert.
  for (let versuch = 1; versuch <= versuche; versuch++) {
    try {
      const { empfangen, total } = await ladeEinmal(url, tmp, onProgress);

      if (sha1) {
        const ist = await sha1File(tmp);
        if (ist.toLowerCase() !== String(sha1).toLowerCase()) {
          const err = new Error(
            `Prüfsumme stimmt nicht (${empfangen} Bytes empfangen` +
              (size ? `, erwartet ${size}` : '') +
              (total ? `, Content-Length ${total}` : '') +
              `, sha1 ${ist.slice(0, 12)} statt ${String(sha1).slice(0, 12)})`
          );
          err.pruefsumme = true;
          throw err;
        }
      }

      await fsp.rm(dest, { force: true });
      await fsp.rename(tmp, dest);
      return dest;
    } catch (err) {
      letzterFehler = err;
      await fsp.rm(tmp, { force: true });
      if (versuch < versuche) await sleep(300 * versuch);
    }
  }

  const text = letzterFehler && letzterFehler.message ? letzterFehler.message : 'unbekannter Fehler';
  throw new Error(`${text} — nach ${versuche} Versuchen aufgegeben`);
}

/** Ein einzelner Ladevorgang in die .part-Datei. */
async function ladeEinmal(url, tmp, onProgress) {
  const res = await request(url, { headers: { Accept: '*/*' } });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || null;
  const datei = fs.createWriteStream(tmp);
  const leser = res.body.getReader();
  let empfangen = 0;

  try {
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;

      // Buffer.from(TypedArray) kopiert — genau darauf kommt es hier an.
      const block = Buffer.from(value);
      empfangen += block.length;
      if (onProgress) onProgress(empfangen, total);

      // Gegendruck beachten, sonst wächst die Warteschlange unbegrenzt.
      if (!datei.write(block)) await warteAufDrain(datei);
    }
    datei.end();
    await finished(datei);
  } catch (err) {
    datei.destroy();
    await leser.cancel().catch(() => {});
    throw err;
  }

  if (total != null && empfangen !== total) {
    throw new Error(`Übertragung unvollständig: ${empfangen} von ${total} Bytes`);
  }
  return { empfangen, total };
}

/** Wartet auf 'drain', bricht aber ab, wenn der Stream in der Zwischenzeit stirbt. */
function warteAufDrain(stream) {
  return new Promise((resolve, reject) => {
    const beiDrain = () => {
      stream.off('error', beiFehler);
      resolve();
    };
    const beiFehler = (err) => {
      stream.off('drain', beiDrain);
      reject(err);
    };
    stream.once('drain', beiDrain);
    stream.once('error', beiFehler);
  });
}

module.exports = { UA, request, getJson, download, sha1File, sleep };
