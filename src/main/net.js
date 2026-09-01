'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

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
 * Lädt eine Datei atomar (erst .part, dann umbenennen) und prüft optional die SHA1.
 * onProgress(receivedBytes, totalBytes|null)
 */
async function download(url, dest, { sha1, onProgress } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;

  const res = await request(url, { headers: { Accept: '*/*' } });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || null;
  let received = 0;

  const source = Readable.fromWeb(res.body);
  if (onProgress) {
    source.on('data', (chunk) => {
      received += chunk.length;
      onProgress(received, total);
    });
  }

  await pipeline(source, fs.createWriteStream(tmp));

  if (sha1) {
    const actual = await sha1File(tmp);
    if (actual.toLowerCase() !== sha1.toLowerCase()) {
      await fsp.rm(tmp, { force: true });
      throw new Error('Prüfsumme stimmt nicht – Datei verworfen');
    }
  }

  await fsp.rm(dest, { force: true });
  await fsp.rename(tmp, dest);
  return dest;
}

module.exports = { UA, request, getJson, download, sha1File, sleep };
