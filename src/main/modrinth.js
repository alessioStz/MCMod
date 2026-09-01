'use strict';

const { getJson } = require('./net');

const API = 'https://api.modrinth.com/v2';

const facet = (arr) => encodeURIComponent(JSON.stringify(arr));
const jsonParam = (arr) => encodeURIComponent(JSON.stringify(arr));

/**
 * Mod-Suche, gefiltert auf Fabric und – wenn gesetzt – die aktive Minecraft-Version.
 */
async function search({ query = '', gameVersion = null, category = null, offset = 0, limit = 20, index = 'relevance' } = {}) {
  const facets = [['project_type:mod'], ['categories:fabric']];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (category) facets.push([`categories:${category}`]);

  const url =
    `${API}/search?query=${encodeURIComponent(query)}` +
    `&facets=${facet(facets)}&offset=${offset}&limit=${limit}&index=${index}`;

  const data = await getJson(url);
  return {
    total: data.total_hits,
    offset: data.offset,
    limit: data.limit,
    hits: data.hits.map(shapeHit)
  };
}

function shapeHit(h) {
  return {
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    iconUrl: h.icon_url || null,
    downloads: h.downloads,
    follows: h.follows,
    categories: (h.display_categories || h.categories || []).filter((c) => !['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    gameVersions: h.versions || [],
    clientSide: h.client_side,
    serverSide: h.server_side,
    updated: h.date_modified
  };
}

async function project(idOrSlug) {
  const p = await getJson(`${API}/project/${encodeURIComponent(idOrSlug)}`);
  return {
    projectId: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
    iconUrl: p.icon_url || null,
    downloads: p.downloads,
    categories: p.categories,
    gameVersions: p.game_versions,
    loaders: p.loaders,
    sourceUrl: p.source_url,
    projectUrl: `https://modrinth.com/mod/${p.slug}`
  };
}

/** Mehrere Projekte auf einmal (spart Requests beim Listen-Abgleich). */
async function projects(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await getJson(`${API}/projects?ids=${jsonParam(chunk)}`);
    out.push(
      ...data.map((p) => ({
        projectId: p.id,
        slug: p.slug,
        title: p.title,
        description: p.description,
        iconUrl: p.icon_url || null,
        downloads: p.downloads,
        gameVersions: p.game_versions,
        loaders: p.loaders
      }))
    );
  }
  return out;
}

/** Alle Fabric-Versionen eines Projekts für eine MC-Version, neueste zuerst. */
async function versions(projectId, gameVersion) {
  let url = `${API}/project/${encodeURIComponent(projectId)}/version?loaders=${jsonParam(['fabric'])}`;
  if (gameVersion) url += `&game_versions=${jsonParam([gameVersion])}`;
  const list = await getJson(url);
  return list.map(shapeVersion).sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));
}

async function versionById(versionId) {
  return shapeVersion(await getJson(`${API}/version/${encodeURIComponent(versionId)}`));
}

function shapeVersion(v) {
  const primary = v.files.find((f) => f.primary) || v.files[0] || null;
  return {
    versionId: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    versionType: v.version_type, // release | beta | alpha
    gameVersions: v.game_versions,
    loaders: v.loaders,
    datePublished: v.date_published,
    downloads: v.downloads,
    dependencies: (v.dependencies || []).map((d) => ({
      projectId: d.project_id,
      versionId: d.version_id,
      fileName: d.file_name,
      type: d.dependency_type
    })),
    file: primary
      ? { url: primary.url, filename: primary.filename, size: primary.size, sha1: primary.hashes?.sha1 || null }
      : null
  };
}

/**
 * Wählt die beste Version: bevorzugt "release", sonst die neueste überhaupt.
 * Gibt null zurück, wenn es für diese MC-Version nichts gibt.
 */
async function bestVersion(projectId, gameVersion) {
  const list = await versions(projectId, gameVersion);
  if (!list.length) return null;
  return list.find((v) => v.versionType === 'release' && v.file) || list.find((v) => v.file) || null;
}

/**
 * Löst benötigte Abhängigkeiten (dependency_type "required") rekursiv auf.
 * Liefert eine flache Liste zusätzlicher Versionen, ohne die Wurzel-Projekte.
 */
async function resolveDependencies(rootVersions, gameVersion, { maxDepth = 4 } = {}) {
  const seen = new Set(rootVersions.map((v) => v.projectId));
  const extra = [];
  const missing = [];
  let frontier = rootVersions;

  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const version of frontier) {
      for (const dep of version.dependencies) {
        if (dep.type !== 'required') continue;

        let resolved = null;
        if (dep.versionId) {
          resolved = await versionById(dep.versionId).catch(() => null);
        }
        if (!resolved && dep.projectId) {
          if (seen.has(dep.projectId)) continue;
          resolved = await bestVersion(dep.projectId, gameVersion).catch(() => null);
        }
        if (!resolved) {
          if (dep.projectId && !seen.has(dep.projectId)) {
            seen.add(dep.projectId);
            missing.push({ projectId: dep.projectId, requiredBy: version.projectId });
          }
          continue;
        }
        if (seen.has(resolved.projectId)) continue;
        seen.add(resolved.projectId);
        extra.push(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }

  // Titel für die Anzeige nachladen.
  if (extra.length) {
    const meta = await projects(extra.map((v) => v.projectId)).catch(() => []);
    const byId = new Map(meta.map((p) => [p.projectId, p]));
    for (const v of extra) {
      const p = byId.get(v.projectId);
      if (p) {
        v.title = p.title;
        v.iconUrl = p.iconUrl;
        v.slug = p.slug;
      }
    }
  }

  return { extra, missing };
}

module.exports = { search, project, projects, versions, versionById, bestVersion, resolveDependencies };
