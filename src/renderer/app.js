/**
 * ModLoom - Ansichten und Abläufe.
 *
 * Leitplanken der Oberfläche:
 *  - config.gameVersion ist die eine aktive Minecraft-Version. Sie ändert sich
 *    ausschließlich über den Wechsel-Ablauf, der vorher fragt und aufräumt.
 *  - Nichts wird still gelöscht: erst fragen, dann in den Papierkorb.
 *  - Fehlende Mod-Versionen werden markiert, nie erzwungen installiert.
 */
(function () {
  'use strict';

  const { h, icon, clear, num, shortNum, bytes, timeAgo, sheet, menu, toast, activity } = window.UI;

  const state = {
    config: null,
    view: 'search',
    installedIds: new Set(),
    installedCount: 0,
    lists: [],
    activeListId: null,
    addToListId: null, // Sammelmodus: Suchtreffer wandern in diese Liste
    search: {
      query: '',
      index: 'relevance',
      onlyCurrentVersion: true,
      hits: [],
      total: 0,
      offset: 0,
      loading: false
    },
    fabric: {
      gameVersions: [],
      loaders: [],
      selectedGame: null,
      selectedLoader: null,
      installedProfiles: [],
      loading: false
    },
    installedMods: [],
    modsDir: ''
  };

  const el = {
    nav: document.getElementById('nav'),
    toolbar: document.getElementById('toolbar'),
    view: document.getElementById('view'),
    scroll: document.getElementById('scroll'),
    setup: document.getElementById('setup-card')
  };

  /* ----------------------------------------------------------------- Brücke */

  /** Entpackt { ok, data } und macht aus Fehlern einen sichtbaren Toast. */
  async function call(fn, payload, { silent = false } = {}) {
    const res = await fn(payload);
    if (!res || res.ok !== true) {
      const message = (res && res.error) || 'Unbekannter Fehler';
      if (!silent) toast(message, 'bad', 6000);
      throw new Error(message);
    }
    return res.data;
  }

  const safe = (promise, fallback = null) => promise.catch(() => fallback);

  /* -------------------------------------------------------------------- Nav */

  const NAV = [
    { id: 'search', label: 'Mods suchen', icon: 'search' },
    { id: 'installed', label: 'Installiert', icon: 'cube' },
    { id: 'lists', label: 'Listen', icon: 'list' },
    { id: 'fabric', label: 'Fabric', icon: 'spool' },
    { id: 'settings', label: 'Einstellungen', icon: 'gear' }
  ];

  function renderNav() {
    clear(el.nav);
    for (const item of NAV) {
      const badge =
        item.id === 'installed' && state.installedCount
          ? h('span', { class: 'badge' }, String(state.installedCount))
          : item.id === 'lists' && state.lists.length
            ? h('span', { class: 'badge' }, String(state.lists.length))
            : null;

      el.nav.append(
        h('button',
          {
            class: 'nav-item',
            type: 'button',
            'aria-current': String(state.view === item.id),
            onclick: () => setView(item.id)
          },
          icon(item.icon),
          h('span', { class: 't-body' }, item.label),
          badge
        )
      );
    }
  }

  function renderSetupCard() {
    const cfg = state.config;
    const active = !!cfg.gameVersion;
    clear(el.setup);
    el.setup.title = 'Zur Fabric-Auswahl';
    el.setup.onclick = () => setView('fabric');
    el.setup.append(
      h('div', { class: 'row' },
        h('span', { class: `dot ${active ? 'on' : 'off'}` }),
        h('span', { class: 't-body', style: { fontWeight: '600' } },
          active ? `Minecraft ${cfg.gameVersion}` : 'Keine Version aktiv'),
      ),
      h('div', { class: 't-cap dim', style: { marginTop: '2px' } },
        active ? `Fabric ${cfg.loaderVersion || '?'}` : 'Fabric-Version wählen'),
      h('div', { class: 'path', title: cfg.mcDir }, cfg.mcDir)
    );
  }

  /* ---------------------------------------------------------------- Routing */

  function setView(name) {
    state.view = name;
    if (name !== 'lists') state.activeListId = null;
    renderNav();
    el.scroll.scrollTop = 0;
    renderChrome();
    renderView();
  }

  function renderChrome() {
    clear(el.toolbar);
    const build = TOOLBARS[state.view];
    if (build) el.toolbar.append(...[].concat(build()));
  }

  function renderView() {
    clear(el.view);
    VIEWS[state.view]();
  }

  el.scroll.addEventListener('scroll', () => {
    el.toolbar.dataset.scrolled = String(el.scroll.scrollTop > 4);
    maybeLoadMore();
  });

  /* ============================================================ Mod-Bausteine */

  function modIcon(url, title, size = 3) {
    if (url) {
      return h('img', {
        class: 'mod-icon',
        src: url,
        alt: '',
        loading: 'lazy',
        style: { width: `${size}rem`, height: `${size}rem` },
        onerror: (e) => {
          e.target.replaceWith(placeholderIcon(title, size));
        }
      });
    }
    return placeholderIcon(title, size);
  }

  function placeholderIcon(title, size = 3) {
    return h('div',
      { class: 'mod-icon placeholder', style: { width: `${size}rem`, height: `${size}rem` } },
      icon('box', size * 9)
    );
  }

  /** Karte in der Suche: Icon, Titel, Beschreibung, Aktionen. */
  function modCard(mod) {
    const installed = state.installedIds.has(mod.projectId);

    const actions = h('div', { class: 'mod-actions' });

    if (state.addToListId) {
      const list = state.lists.find((l) => l.id === state.addToListId);
      const inList = list && list.mods.some((m) => m.projectId === mod.projectId);
      actions.append(
        inList
          ? h('span', { class: 'chip ok' }, icon('check', 13, 2.4), 'In Liste')
          : h('button',
              { class: 'btn btn-primary', type: 'button', onclick: (e) => addToList(state.addToListId, mod, e.currentTarget) },
              icon('plus', 15, 2.2), h('span', { class: 'label' }, 'Hinzufügen'))
      );
    } else {
      actions.append(
        installed
          ? h('span', { class: 'chip ok' }, icon('check', 13, 2.4), 'Installiert')
          : h('button',
              { class: 'btn btn-primary', type: 'button', onclick: (e) => installNow([mod], e.currentTarget) },
              icon('download', 15, 2), h('span', { class: 'label' }, 'Installieren')),
        h('button',
          { class: 'btn btn-icon', type: 'button', title: 'Zu einer Liste hinzufügen', onclick: (e) => listMenu(mod, e.currentTarget) },
          icon('plus', 16, 2.2))
      );
    }

    return h('article', { class: 'card' },
      modIcon(mod.iconUrl, mod.title),
      h('div', { class: 'mod-body' },
        h('div', { class: 'mod-title-row' },
          h('span', { class: 'mod-title t-head' }, mod.title),
          mod.author ? h('span', { class: 't-cap dim' }, `von ${mod.author}`) : null
        ),
        mod.description ? h('p', { class: 'mod-desc' }, mod.description) : null,
        h('div', { class: 'mod-meta' },
          h('span', { class: 'chip' }, icon('download', 12, 2), shortNum(mod.downloads)),
          mod.updated ? h('span', { class: 'chip' }, `aktualisiert ${timeAgo(mod.updated)}`) : null,
          ...(mod.categories || []).slice(0, 3).map((c) => h('span', { class: 'chip' }, c)),
          mod.slug
            ? h('button',
                { class: 'btn btn-sm btn-plain', type: 'button', onclick: () => window.api.openExternal(`https://modrinth.com/mod/${mod.slug}`) },
                'Auf Modrinth', icon('external', 12, 2))
            : null
        )
      ),
      actions
    );
  }

  /* ============================================================== Ansicht: Suche */

  let searchTimer = null;
  let searchToken = 0;

  const TOOLBARS = {};
  const VIEWS = {};

  TOOLBARS.search = () => {
    const input = h('input', {
      type: 'search',
      placeholder: 'Mods auf Modrinth suchen…',
      value: state.search.query,
      spellcheck: false,
      oninput: (e) => {
        state.search.query = e.target.value;
        clearTimeout(searchTimer);
        // Kurz genug, dass es unmittelbar wirkt, lang genug für die API.
        searchTimer = setTimeout(() => runSearch(true), 220);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          clearTimeout(searchTimer);
          runSearch(true);
        }
      }
    });

    const field = h('div', { class: 'search-field' }, icon('search', 16), input);
    requestAnimationFrame(() => input.focus());

    const sort = h('div', { class: 'segmented' },
      [['relevance', 'Relevanz'], ['downloads', 'Beliebt'], ['newest', 'Neu']].map(([value, label]) =>
        h('button',
          { type: 'button', 'aria-pressed': String(state.search.index === value), onclick: () => { state.search.index = value; renderChrome(); runSearch(true); } },
          label)
      )
    );

    return [h('div', { class: 'grow' }, field), sort];
  };

  VIEWS.search = () => {
    if (!state.config.gameVersion) {
      el.view.append(onboardingPanel());
      return;
    }

    if (state.addToListId) {
      const list = state.lists.find((l) => l.id === state.addToListId);
      if (list) {
        el.view.append(
          h('div', { class: 'panel', style: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', padding: '0.75rem 1rem' } },
            icon('list', 18),
            h('div', { style: { flex: '1', minWidth: 0 } },
              h('div', { class: 't-body', style: { fontWeight: '600' } }, `Sammeln für „${list.name}“`),
              h('div', { class: 't-cap dim' }, `${list.mods.length} Mod${list.mods.length === 1 ? '' : 's'} in der Liste`)
            ),
            h('button', { class: 'btn', type: 'button', onclick: () => { state.addToListId = null; setView('lists'); openList(list.id); } }, 'Fertig')
          )
        );
      }
    }

    const meta = h('div', { class: 'section-head' },
      h('span', { class: 't-cap dim', id: 'search-count' }, ''),
      h('span', { class: 'spacer' }),
      h('span', { class: 'chip info' }, `Minecraft ${state.config.gameVersion}`),
      h('span', { class: 'chip' }, 'Fabric')
    );

    const results = h('div', { class: 'cards', id: 'results' });
    el.view.append(meta, results);

    if (!state.search.hits.length) runSearch(true);
    else paintResults();
  };

  function paintResults(append = false) {
    const results = document.getElementById('results');
    if (!results) return;
    if (!append) clear(results);

    const hits = append ? state.search.hits.slice(results.childElementCount) : state.search.hits;
    for (const hit of hits) results.append(modCard(hit));

    const count = document.getElementById('search-count');
    if (count) {
      count.textContent = state.search.hits.length
        ? `${num(state.search.total)} Fabric-Mods gefunden`
        : '';
    }

    const old = document.getElementById('search-foot');
    if (old) old.remove();

    if (state.search.loading) {
      results.after(h('div', { id: 'search-foot', style: { display: 'flex', justifyContent: 'center', padding: '1.5rem' } }, h('div', { class: 'spinner' })));
    } else if (!state.search.hits.length) {
      results.after(
        h('div', { id: 'search-foot', class: 'empty' },
          h('div', { class: 'glyph' }, icon('search', 26)),
          h('div', { class: 't-head' }, 'Nichts gefunden'),
          h('p', { class: 't-body dim' },
            `Für Minecraft ${state.config.gameVersion} gibt es zu dieser Suche keine Fabric-Mods. Andere Schreibweise oder eine andere Minecraft-Version probieren.`)
        )
      );
    } else if (state.search.hits.length < state.search.total) {
      results.after(
        h('div', { id: 'search-foot', style: { display: 'flex', justifyContent: 'center', padding: '1.25rem' } },
          h('button', { class: 'btn', type: 'button', onclick: () => runSearch(false) },
            `Weitere laden (${num(state.search.total - state.search.hits.length)})`)
        )
      );
    } else {
      results.after(h('div', { id: 'search-foot', class: 't-cap dim-more', style: { textAlign: 'center', padding: '1.25rem' } },
        `${num(state.search.total)} Treffer – das war alles`));
    }
  }

  async function runSearch(reset) {
    if (!state.config.gameVersion) return;
    const s = state.search;
    if (s.loading) return;

    const token = ++searchToken;
    if (reset) {
      s.offset = 0;
      s.hits = [];
    }
    s.loading = true;
    paintResults();

    try {
      const data = await call(window.api.modrinth.search, {
        query: s.query,
        gameVersion: s.onlyCurrentVersion ? state.config.gameVersion : null,
        offset: s.offset,
        limit: 20,
        index: s.index
      });
      if (token !== searchToken) return; // Ein neuerer Tastendruck hat übernommen.
      s.hits = reset ? data.hits : s.hits.concat(data.hits);
      s.total = data.total;
      s.offset = s.hits.length;
    } catch {
      /* Fehler ist bereits als Toast draußen. */
    } finally {
      if (token === searchToken) {
        s.loading = false;
        paintResults();
      }
    }
  }

  function maybeLoadMore() {
    if (state.view !== 'search' || state.search.loading) return;
    if (state.search.hits.length >= state.search.total) return;
    const rest = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight;
    if (rest < 400) runSearch(false);
  }

  function onboardingPanel() {
    return h('div', { class: 'panel', style: { marginTop: '2rem', textAlign: 'center', padding: '2.5rem 2rem' } },
      h('div', { class: 'glyph', style: { width: '3.5rem', height: '3.5rem', margin: '0 auto 1rem', borderRadius: '16px', display: 'grid', placeItems: 'center', background: 'var(--fill)' } },
        icon('spool', 26)),
      h('div', { class: 't-title' }, 'Zuerst eine Fabric-Version'),
      h('p', { class: 't-body dim', style: { maxWidth: '26rem', margin: '0.5rem auto 1.25rem' } },
        'Wähle die Minecraft-Version, für die du modden willst. ModLoom installiert Fabric in deinen Minecraft-Ordner und filtert danach alle Mods passend dazu.'),
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => setView('fabric') },
        icon('spool', 16), h('span', { class: 'label' }, 'Fabric-Version wählen'))
    );
  }

  /* ========================================================== Ansicht: Installiert */

  TOOLBARS.installed = () => {
    const title = h('div', { class: 'grow' },
      h('div', { class: 't-title' }, 'Installierte Mods'),
    );
    return [
      title,
      h('button', { class: 'btn', type: 'button', onclick: () => window.api.mods.openFolder() }, icon('folder', 15), h('span', { class: 'label' }, 'Ordner')),
      h('button', { class: 'btn', type: 'button', onclick: (e) => checkUpdates(e.currentTarget) }, icon('refresh', 15), h('span', { class: 'label' }, 'Updates')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveInstalledAsList() }, icon('list', 15), h('span', { class: 'label' }, 'Als Liste sichern'))
    ];
  };

  VIEWS.installed = () => {
    const mods = state.installedMods;

    el.view.append(
      h('div', { class: 'section-head' },
        h('span', { class: 't-cap dim' }, state.modsDir),
        h('span', { class: 'spacer' }),
        state.config.gameVersion ? h('span', { class: 'chip info' }, `Minecraft ${state.config.gameVersion}`) : null
      )
    );

    if (!mods.length) {
      el.view.append(
        h('div', { class: 'empty' },
          h('div', { class: 'glyph' }, icon('cube', 26)),
          h('div', { class: 't-head' }, 'Noch keine Mods'),
          h('p', { class: 't-body dim' }, 'Such dir welche auf Modrinth oder installiere eine gespeicherte Liste.'),
          h('button', { class: 'btn btn-primary', type: 'button', style: { marginTop: '1rem' }, onclick: () => setView('search') }, 'Mods suchen')
        )
      );
      return;
    }

    const cards = h('div', { class: 'cards' });
    for (const mod of mods) {
      cards.append(
        h('article', { class: 'card is-flat' },
          modIcon(mod.iconUrl, mod.title, 2.25),
          h('div', { class: 'mod-body' },
            h('div', { class: 'mod-title-row' },
              h('span', { class: 'mod-title t-body' }, mod.title),
              mod.versionNumber ? h('span', { class: 'chip' }, mod.versionNumber) : null,
              mod.isDependency ? h('span', { class: 'chip dep' }, 'Abhängigkeit') : null,
              !mod.managed ? h('span', { class: 'chip warn' }, 'manuell hinzugefügt') : null
            ),
            h('div', { class: 't-cap dim-more', style: { marginTop: '2px' } }, `${mod.filename} · ${bytes(mod.size)}`)
          ),
          h('div', { class: 'mod-actions' },
            mod.slug
              ? h('button', { class: 'btn btn-icon btn-plain', type: 'button', title: 'Auf Modrinth öffnen', onclick: () => window.api.openExternal(`https://modrinth.com/mod/${mod.slug}`) }, icon('external', 15))
              : null,
            h('button', { class: 'btn btn-icon btn-plain', type: 'button', title: 'Entfernen', onclick: () => removeMod(mod) }, icon('trash', 15))
          )
        )
      );
    }
    el.view.append(cards);
  };

  async function removeMod(mod) {
    const answer = await sheet({
      title: `„${mod.title}“ entfernen?`,
      subtitle: 'Die Datei wandert in den Papierkorb und kann von dort zurückgeholt werden.',
      actions: [
        { label: 'Entfernen', value: 'yes', variant: 'danger' },
        { label: 'Abbrechen', value: null }
      ]
    });
    if (answer !== 'yes') return;
    await safe(call(window.api.mods.remove, { filename: mod.filename }));
    await refreshInstalled();
    renderView();
    toast(`„${mod.title}“ entfernt`, 'ok');
  }

  async function checkUpdates(button) {
    button.classList.add('is-busy');
    const spinner = h('div', { class: 'spinner' });
    button.prepend(spinner);
    try {
      const updates = await call(window.api.mods.checkUpdates, { gameVersion: state.config.gameVersion });
      if (!updates.length) {
        toast('Alle Mods sind aktuell', 'ok');
        return;
      }
      const body = h('div', {}, updates.map((u) =>
        h('div', { class: 'result-row' },
          modIcon(u.iconUrl, u.title, 1.75),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 't-body', style: { fontWeight: '550' } }, u.title),
            h('div', { class: 't-cap dim' }, `${u.from || '?'} → ${u.to}`))
        )
      ));
      const answer = await sheet({
        title: `${updates.length} Update${updates.length === 1 ? '' : 's'} verfügbar`,
        subtitle: 'Alte Dateien wandern dabei in den Papierkorb.',
        body,
        actions: [
          { label: 'Alle aktualisieren', value: 'go', variant: 'primary', icon: 'download' },
          { label: 'Später', value: null }
        ]
      });
      if (answer !== 'go') return;
      await installNow(updates.map((u) => ({ projectId: u.projectId, title: u.title, iconUrl: u.iconUrl, versionId: u.versionId })));
    } catch {
      /* gemeldet */
    } finally {
      spinner.remove();
      button.classList.remove('is-busy');
    }
  }

  async function saveInstalledAsList() {
    const mods = await safe(call(window.api.mods.snapshot), []);
    if (!mods.length) {
      toast('Es gibt nichts zu sichern', 'warn');
      return;
    }
    const input = h('input', {
      class: 'input',
      value: `Mods ${state.config.gameVersion || ''}`.trim(),
      'data-autofocus': true,
      onkeydown: (e) => { if (e.key === 'Enter') e.target.closest('.sheet').querySelector('.btn-primary').click(); }
    });
    const answer = await sheet({
      title: 'Als Liste sichern',
      subtitle: `${mods.length} verwaltete Mod${mods.length === 1 ? '' : 's'} werden gespeichert.`,
      body: h('div', {}, h('label', { class: 't-cap dim', style: { display: 'block', marginBottom: '0.375rem' } }, 'Name der Liste'), input),
      actions: [{ label: 'Speichern', value: 'save', variant: 'primary' }, { label: 'Abbrechen', value: null }]
    });
    if (answer !== 'save') return;
    await safe(call(window.api.lists.create, { name: input.value, mods, gameVersion: state.config.gameVersion }));
    await refreshLists();
    toast('Liste gespeichert', 'ok');
  }

  /* ============================================================== Ansicht: Listen */

  TOOLBARS.lists = () => {
    if (state.activeListId) {
      const list = state.lists.find((l) => l.id === state.activeListId);
      return [
        h('button', { class: 'btn btn-icon btn-plain', type: 'button', title: 'Zurück', onclick: () => { state.activeListId = null; renderChrome(); renderView(); }, style: { transform: 'rotate(180deg)' } }, icon('chevron', 16, 2)),
        h('div', { class: 'grow t-title', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, list ? list.name : 'Liste'),
        h('button', { class: 'btn', type: 'button', onclick: () => { state.addToListId = state.activeListId; setView('search'); } }, icon('plus', 15, 2.2), h('span', { class: 'label' }, 'Mods hinzufügen')),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => installList(state.activeListId, e.currentTarget) }, icon('download', 15), h('span', { class: 'label' }, 'Alle installieren')),
        h('button', { class: 'btn btn-icon', type: 'button', title: 'Mehr', onclick: (e) => listOptions(state.activeListId, e.currentTarget) }, icon('list', 16))
      ];
    }
    return [
      h('div', { class: 'grow t-title' }, 'Listen'),
      h('button', { class: 'btn', type: 'button', onclick: () => importLists() }, icon('download', 15), h('span', { class: 'label' }, 'Importieren')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => createList() }, icon('plus', 15, 2.2), h('span', { class: 'label' }, 'Neue Liste'))
    ];
  };

  VIEWS.lists = () => {
    if (state.activeListId) return renderListDetail();

    if (!state.lists.length) {
      el.view.append(
        h('div', { class: 'empty' },
          h('div', { class: 'glyph' }, icon('list', 26)),
          h('div', { class: 't-head' }, 'Noch keine Listen'),
          h('p', { class: 't-body dim' },
            'Eine Liste bündelt Mods, die zusammengehören. Exportiere sie als Datei, dann installiert die ganze Gruppe dasselbe Set mit einem Klick.'),
          h('div', { style: { display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem' } },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => createList() }, 'Liste anlegen'),
            h('button', { class: 'btn', type: 'button', onclick: () => importLists() }, 'Liste importieren'))
        )
      );
      return;
    }

    const grid = h('div', { class: 'list-grid' });
    for (const list of state.lists) {
      const icons = h('div', { class: 'stack-icons' });
      for (const mod of list.mods.slice(0, 6)) {
        icons.append(mod.iconUrl
          ? h('img', { src: mod.iconUrl, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() })
          : h('div', { class: 'more' }, (mod.title || '?').slice(0, 1).toUpperCase()));
      }
      if (list.mods.length > 6) icons.append(h('div', { class: 'more' }, `+${list.mods.length - 6}`));

      grid.append(
        h('button', { class: 'list-card', type: 'button', onclick: () => openList(list.id) },
          h('div', { class: 't-head', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, list.name),
          h('div', { class: 't-cap dim', style: { marginTop: '2px' } },
            `${list.mods.length} Mod${list.mods.length === 1 ? '' : 's'}${list.gameVersion ? ` · für ${list.gameVersion}` : ''}`),
          list.mods.length ? icons : h('div', { class: 't-cap dim-more', style: { marginTop: '0.75rem' } }, 'leer')
        )
      );
    }
    el.view.append(grid);
  };

  function openList(id) {
    state.activeListId = id;
    state.view = 'lists';
    renderNav();
    renderChrome();
    renderView();
    el.scroll.scrollTop = 0;
  }

  function renderListDetail() {
    const list = state.lists.find((l) => l.id === state.activeListId);
    if (!list) {
      state.activeListId = null;
      return VIEWS.lists();
    }

    el.view.append(
      h('div', { class: 'section-head' },
        h('span', { class: 't-cap dim' }, `${list.mods.length} Mod${list.mods.length === 1 ? '' : 's'} · angelegt ${timeAgo(list.createdAt)}`),
        h('span', { class: 'spacer' }),
        state.config.gameVersion ? h('span', { class: 'chip info' }, `Ziel: Minecraft ${state.config.gameVersion}`) : null
      )
    );

    if (!list.mods.length) {
      el.view.append(
        h('div', { class: 'empty' },
          h('div', { class: 'glyph' }, icon('plus', 26)),
          h('div', { class: 't-head' }, 'Liste ist leer'),
          h('p', { class: 't-body dim' }, 'Füge Mods aus der Suche hinzu.'),
          h('button', { class: 'btn btn-primary', type: 'button', style: { marginTop: '1rem' }, onclick: () => { state.addToListId = list.id; setView('search'); } }, 'Mods hinzufügen')
        )
      );
      return;
    }

    const cards = h('div', { class: 'cards', id: 'list-mods' });
    for (const mod of list.mods) cards.append(listModRow(list, mod));
    el.view.append(cards);

    checkListAvailability(list);
  }

  function listModRow(list, mod) {
    const row = h('article', { class: 'card is-flat', dataset: { project: mod.projectId } },
      modIcon(mod.iconUrl, mod.title, 2.25),
      h('div', { class: 'mod-body' },
        h('div', { class: 'mod-title-row' },
          h('span', { class: 'mod-title t-body' }, mod.title),
          h('span', { class: 'availability' })
        ),
        h('div', { class: 't-cap dim-more', style: { marginTop: '2px' } }, mod.slug || mod.projectId)
      ),
      h('div', { class: 'mod-actions' },
        h('button', { class: 'btn btn-icon btn-plain', type: 'button', title: 'Aus Liste entfernen', onclick: async () => {
          await safe(call(window.api.lists.removeMod, { id: list.id, projectId: mod.projectId }));
          await refreshLists();
          renderView();
        } }, icon('close', 15, 2))
      )
    );
    return row;
  }

  /** Markiert Mods, die es für die aktive Minecraft-Version nicht gibt. */
  async function checkListAvailability(list) {
    if (!state.config.gameVersion || !list.mods.length) return;
    const ids = list.mods.map((m) => m.projectId);
    const data = await safe(call(window.api.modrinth.availability, { projectIds: ids, gameVersion: state.config.gameVersion }, { silent: true }), null);
    if (!data || state.activeListId !== list.id) return;

    let missing = 0;
    for (const mod of list.mods) {
      const info = data[mod.projectId];
      const row = el.view.querySelector(`[data-project="${CSS.escape(mod.projectId)}"]`);
      if (!row) continue;
      const slot = row.querySelector('.availability');
      clear(slot);
      if (!info) continue;
      if (info.available) {
        slot.append(h('span', { class: 'chip ok' }, icon('check', 12, 2.6), state.config.gameVersion));
      } else {
        missing++;
        row.classList.add('is-unavailable');
        slot.append(h('span', { class: 'chip warn' }, icon('warn', 12, 2.2), `nicht für ${state.config.gameVersion}`));
      }
    }

    const head = el.view.querySelector('.section-head .spacer');
    if (missing && head) {
      head.after(h('span', { class: 'chip warn', style: { marginRight: '0.375rem' } }, `${missing} ohne passende Version`));
    }
  }

  async function createList(prefillMods = []) {
    const input = h('input', {
      class: 'input',
      placeholder: 'z. B. Performance-Set',
      'data-autofocus': true,
      onkeydown: (e) => { if (e.key === 'Enter') e.target.closest('.sheet').querySelector('.btn-primary').click(); }
    });
    const answer = await sheet({
      title: 'Neue Liste',
      subtitle: 'Listen sind versionsunabhängig: beim Installieren sucht ModLoom jeweils die passende Version.',
      body: h('div', {}, h('label', { class: 't-cap dim', style: { display: 'block', marginBottom: '0.375rem' } }, 'Name'), input),
      actions: [{ label: 'Anlegen', value: 'ok', variant: 'primary' }, { label: 'Abbrechen', value: null }]
    });
    if (answer !== 'ok') return null;
    const list = await safe(call(window.api.lists.create, { name: input.value, mods: prefillMods, gameVersion: state.config.gameVersion }));
    await refreshLists();
    if (list) {
      toast(`Liste „${list.name}“ angelegt`, 'ok');
      openList(list.id);
    }
    return list;
  }

  async function listOptions(id, anchor) {
    const list = state.lists.find((l) => l.id === id);
    if (!list) return;
    const choice = await menu(anchor, [
      { label: 'Exportieren…', value: 'export', icon: 'external' },
      { label: 'Umbenennen…', value: 'rename', icon: 'list' },
      { type: 'sep' },
      { label: 'Liste löschen', value: 'delete', icon: 'trash' }
    ]);

    if (choice === 'export') {
      const file = await safe(call(window.api.lists.exportList, { id }));
      if (file) toast('Liste exportiert', 'ok');
    } else if (choice === 'rename') {
      const input = h('input', { class: 'input', value: list.name, 'data-autofocus': true });
      const answer = await sheet({
        title: 'Liste umbenennen',
        body: input,
        actions: [{ label: 'Speichern', value: 'ok', variant: 'primary' }, { label: 'Abbrechen', value: null }]
      });
      if (answer === 'ok') {
        await safe(call(window.api.lists.update, { id, patch: { name: input.value } }));
        await refreshLists();
        renderChrome();
        renderView();
      }
    } else if (choice === 'delete') {
      const answer = await sheet({
        title: `„${list.name}“ löschen?`,
        subtitle: 'Die Liste verschwindet aus ModLoom. Installierte Mods bleiben unangetastet.',
        actions: [{ label: 'Löschen', value: 'yes', variant: 'danger' }, { label: 'Abbrechen', value: null }]
      });
      if (answer === 'yes') {
        await safe(call(window.api.lists.remove, { id }));
        state.activeListId = null;
        await refreshLists();
        renderChrome();
        renderView();
        toast('Liste gelöscht', 'ok');
      }
    }
  }

  async function importLists() {
    const imported = await safe(call(window.api.lists.importList));
    if (!imported || !imported.length) return;
    await refreshLists();
    renderView();
    toast(imported.length === 1 ? `„${imported[0].name}“ importiert` : `${imported.length} Listen importiert`, 'ok');
    if (imported.length === 1) openList(imported[0].id);
  }

  /** Menü „zu Liste hinzufügen“, verankert am gedrückten Knopf. */
  async function listMenu(mod, anchor) {
    const items = state.lists.length
      ? [
          { type: 'head', label: 'Zu Liste hinzufügen' },
          ...state.lists.map((l) => ({
            label: l.name,
            value: l.id,
            icon: 'list',
            hint: l.mods.some((m) => m.projectId === mod.projectId) ? 'drin' : String(l.mods.length)
          })),
          { type: 'sep' },
          { label: 'Neue Liste…', value: '__new', icon: 'plus' }
        ]
      : [{ label: 'Neue Liste…', value: '__new', icon: 'plus' }];

    const choice = await menu(anchor, items);
    if (!choice) return;
    if (choice === '__new') {
      await createList([mod]);
      return;
    }
    await addToList(choice, mod);
  }

  async function addToList(listId, mod, anchor) {
    await safe(call(window.api.lists.addMod, { id: listId, mod }));
    await refreshLists();
    const list = state.lists.find((l) => l.id === listId);
    if (anchor) {
      // Direkte Rückmeldung genau dort, wo der Nutzer geklickt hat.
      const chip = h('span', { class: 'chip ok' }, icon('check', 13, 2.4), 'In Liste');
      anchor.replaceWith(chip);
    }
    toast(`„${mod.title}“ → ${list ? list.name : 'Liste'}`, 'ok', 2200);
  }

  /* =========================================================== Ansicht: Fabric */

  TOOLBARS.fabric = () => [
    h('div', { class: 'grow t-title' }, 'Fabric'),
    h('button', { class: 'btn', type: 'button', onclick: () => window.api.openExternal('https://fabricmc.net/') }, 'fabricmc.net', icon('external', 13, 2))
  ];

  VIEWS.fabric = () => {
    const f = state.fabric;

    const showSnapshots = h('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-pressed': String(!!state.config.showSnapshots),
      onclick: async () => {
        state.config = await call(window.api.config.set, { showSnapshots: !state.config.showSnapshots });
        renderView();
      }
    });

    const versionPanel = h('div', { class: 'panel' },
      h('div', { class: 'section-head', style: { margin: '0 0 0.75rem' } },
        h('span', { class: 't-head' }, 'Minecraft-Version'),
        h('span', { class: 'spacer' }),
        h('span', { class: 't-cap dim' }, 'Snapshots'),
        showSnapshots
      ),
      h('div', { class: 'version-grid', id: 'version-grid' })
    );

    el.view.append(versionPanel);

    if (f.loading || !f.gameVersions.length) {
      const grid = versionPanel.querySelector('#version-grid');
      for (let i = 0; i < 12; i++) grid.append(h('div', { class: 'skeleton', style: { height: '2.5rem' } }));
      if (!f.gameVersions.length && !f.loading) loadFabricVersions();
    } else {
      paintVersionGrid(versionPanel.querySelector('#version-grid'));
    }

    /* Loader + Aktion */
    const loaderSelect = h('select', {
      class: 'input',
      style: { width: 'auto', minWidth: '11rem' },
      onchange: (e) => { f.selectedLoader = e.target.value; }
    });

    const installBtn = h('button',
      { class: 'btn btn-primary btn-lg', type: 'button', disabled: !f.selectedGame, onclick: (e) => applyFabricVersion(e.currentTarget) },
      icon('download', 16), h('span', { class: 'label' }, 'Installieren & aktivieren'));

    const detail = h('div', { class: 'panel', id: 'loader-panel' },
      h('div', { class: 'kv' },
        h('div', { class: 'k' },
          h('div', { class: 't-head' }, 'Loader-Version'),
          h('div', { class: 't-cap dim' }, f.selectedGame ? `Fabric-Loader für Minecraft ${f.selectedGame}` : 'Erst eine Minecraft-Version wählen')),
        loaderSelect),
      h('div', { class: 'kv' },
        h('div', { class: 'k' },
          h('div', { class: 't-head' }, 'Aktiv in ModLoom'),
          h('div', { class: 't-cap dim' },
            state.config.gameVersion
              ? `Minecraft ${state.config.gameVersion} · Fabric ${state.config.loaderVersion || '?'} · ${state.installedCount} Mod${state.installedCount === 1 ? '' : 's'}`
              : 'Noch keine Version aktiviert')),
        installBtn)
    );

    el.view.append(detail);
    fillLoaderSelect(loaderSelect, installBtn);

    /* Was liegt schon im Minecraft-Ordner? */
    if (f.installedProfiles.length) {
      const rows = h('div', {});
      for (const p of f.installedProfiles.slice(0, 8)) {
        rows.append(
          h('div', { class: 'result-row' },
            icon('check', 16, 2.2),
            h('div', { style: { flex: '1', minWidth: 0 } },
              h('div', { class: 't-body' }, `Minecraft ${p.gameVersion || '?'}`),
              h('div', { class: 't-cap dim' }, `Fabric ${p.loaderVersion || '?'}`))
          )
        );
      }
      el.view.append(h('div', { class: 'panel' },
        h('div', { class: 't-head', style: { marginBottom: '0.5rem' } }, 'Bereits installierte Fabric-Profile'),
        h('p', { class: 't-cap dim', style: { margin: '0 0 0.5rem' } },
          'Diese Profile stehen im Minecraft-Launcher zur Auswahl.'),
        rows));
    }
  };

  function paintVersionGrid(grid) {
    const f = state.fabric;
    clear(grid);
    const versions = state.config.showSnapshots ? f.gameVersions : f.gameVersions.filter((v) => v.stable);
    const installedGames = new Set(f.installedProfiles.map((p) => p.gameVersion));

    for (const v of versions.slice(0, 140)) {
      grid.append(
        h('button', {
          class: 'version-chip',
          type: 'button',
          'aria-pressed': String(f.selectedGame === v.version),
          onclick: () => selectGameVersion(v.version)
        },
          installedGames.has(v.version) ? h('span', { class: 'installed-dot', title: 'Fabric installiert' }) : null,
          v.version,
          state.config.gameVersion === v.version ? h('span', { class: 'sub' }, 'aktiv') : null
        )
      );
    }
  }

  async function loadFabricVersions() {
    const f = state.fabric;
    f.loading = true;
    try {
      const [versions, profiles] = await Promise.all([
        call(window.api.fabric.gameVersions),
        safe(call(window.api.fabric.installedProfiles, {}, { silent: true }), [])
      ]);
      f.gameVersions = versions;
      f.installedProfiles = profiles || [];
      if (!f.selectedGame) f.selectedGame = state.config.gameVersion || versions.find((v) => v.stable)?.version || null;
    } catch {
      /* gemeldet */
    } finally {
      f.loading = false;
      if (state.view === 'fabric') renderView();
      if (state.fabric.selectedGame) loadLoaders(state.fabric.selectedGame);
    }
  }

  function selectGameVersion(version) {
    state.fabric.selectedGame = version;
    state.fabric.loaders = [];
    state.fabric.selectedLoader = null;
    renderView();
    loadLoaders(version);
  }

  async function loadLoaders(gameVersion) {
    try {
      const loaders = await call(window.api.fabric.loaderVersions, { gameVersion });
      if (state.fabric.selectedGame !== gameVersion) return;
      state.fabric.loaders = loaders;
      state.fabric.selectedLoader = (loaders.find((l) => l.stable) || loaders[0] || {}).version || null;
      if (state.view === 'fabric') renderView();
    } catch {
      /* gemeldet */
    }
  }

  function fillLoaderSelect(select, installBtn) {
    const f = state.fabric;
    clear(select);
    if (!f.selectedGame) {
      select.append(h('option', {}, '–'));
      select.disabled = true;
      installBtn.disabled = true;
      return;
    }
    if (!f.loaders.length) {
      select.append(h('option', {}, 'Lade…'));
      select.disabled = true;
      installBtn.disabled = true;
      return;
    }
    select.disabled = false;
    installBtn.disabled = false;
    for (const l of f.loaders.slice(0, 40)) {
      select.append(h('option', { value: l.version, selected: l.version === f.selectedLoader },
        `${l.version}${l.stable ? ' (stabil)' : ''}`));
    }
  }

  /* ------------------------- Versionswechsel: fragen, sichern, aufräumen ---- */

  async function applyFabricVersion(button) {
    const f = state.fabric;
    if (!f.selectedGame || !f.selectedLoader) return;

    const previous = state.config.gameVersion;
    const isSwitch = previous && previous !== f.selectedGame;
    let saveListName = null;
    let includeUnmanaged = true;

    if (isSwitch && state.installedMods.length) {
      const managed = state.installedMods.filter((m) => m.managed).length;
      const unmanaged = state.installedMods.length - managed;

      const nameInput = h('input', {
        class: 'input',
        value: `Mods ${previous}`,
        onkeydown: (e) => { if (e.key === 'Enter') e.target.closest('.sheet').querySelector('.btn-primary').click(); }
      });
      const unmanagedBox = h('input', { type: 'checkbox', checked: true, onchange: (e) => { includeUnmanaged = e.target.checked; } });

      const body = h('div', {},
        h('div', { class: 'panel', style: { padding: '0.75rem', marginBottom: '1rem', boxShadow: 'none' } },
          h('div', { class: 'result-row', style: { paddingTop: 0 } },
            icon('cube', 16),
            h('div', { style: { flex: 1 } }, h('span', { class: 't-body' }, `${managed} von ModLoom verwaltete Mod${managed === 1 ? '' : 's'}`))),
          unmanaged
            ? h('div', { class: 'result-row' },
                icon('warn', 16),
                h('div', { style: { flex: 1 } }, h('span', { class: 't-body' }, `${unmanaged} fremde .jar-Datei${unmanaged === 1 ? '' : 'en'}`)))
            : null
        ),
        h('label', { class: 't-cap dim', style: { display: 'block', marginBottom: '0.375rem' } }, 'Liste benennen'),
        nameInput,
        unmanaged
          ? h('label', { class: 'check', style: { marginTop: '0.75rem' } }, unmanagedBox,
              h('span', { class: 't-cap dim' }, 'Fremde .jar-Dateien ebenfalls entfernen (nur verwaltete Mods lassen sich sichern)'))
          : null,
        h('p', { class: 't-cap dim-more', style: { marginTop: '0.75rem' } },
          'Alles Entfernte wandert in den Papierkorb und bleibt dort zurückholbar.')
      );

      const answer = await sheet({
        title: `Wechsel auf Minecraft ${f.selectedGame}`,
        subtitle: state.installedMods.length === 1
          ? `1 Mod im Ordner ist für ${previous} gebaut und funktioniert danach nicht mehr. Vorher als Liste sichern?`
          : `${state.installedMods.length} Mods im Ordner sind für ${previous} gebaut und funktionieren danach nicht mehr. Vorher als Liste sichern?`,
        body,
        actions: [
          { label: 'Als Liste sichern & wechseln', value: 'save', variant: 'primary', icon: 'list' },
          { label: 'Ohne sichern wechseln', value: 'wipe', variant: 'danger', icon: 'trash' },
          { label: 'Abbrechen', value: null }
        ]
      });

      if (!answer) return;
      if (answer === 'save') saveListName = nameInput.value.trim() || `Mods ${previous}`;
    }

    button.classList.add('is-busy');
    const spinner = h('div', { class: 'spinner on-accent' });
    button.prepend(spinner);
    const act = activity();

    try {
      if (saveListName) {
        act.set('Mods sichern', saveListName, null);
        const snapshotMods = await call(window.api.mods.snapshot);
        await call(window.api.lists.create, { name: saveListName, mods: snapshotMods, gameVersion: previous });
        await refreshLists();
      }

      if (isSwitch && state.installedMods.length) {
        act.set('Alte Mods aufräumen', `${state.installedMods.length} Dateien in den Papierkorb`, null);
        const cleared = await call(window.api.mods.clear, { includeUnmanaged, newGameVersion: f.selectedGame });
        if (cleared.failed.length) {
          toast(`${cleared.failed.length} Datei(en) waren gesperrt – läuft Minecraft noch?`, 'warn', 6000);
        }
      }

      act.set('Fabric installieren', `Minecraft ${f.selectedGame} · Loader ${f.selectedLoader}`, null);
      const result = await call(window.api.fabric.install, { gameVersion: f.selectedGame, loaderVersion: f.selectedLoader });

      state.config = await call(window.api.config.get);
      state.search.hits = [];
      state.search.offset = 0;
      await Promise.all([refreshInstalled(), refreshFabricProfiles()]);

      renderSetupCard();
      renderNav();
      renderView();

      if (!result.profileWritten) {
        toast('Version installiert – der Launcher-Eintrag war gesperrt. Launcher schließen und erneut installieren.', 'warn', 7000);
      } else {
        toast(saveListName
          ? `Minecraft ${f.selectedGame} aktiv · Liste „${saveListName}“ gesichert`
          : `Fabric für Minecraft ${f.selectedGame} installiert`, 'ok', 4500);
      }

      if (saveListName) {
        const list = state.lists.find((l) => l.name === saveListName);
        if (list) offerReinstall(list);
      }
    } catch {
      /* gemeldet */
    } finally {
      act.done();
      spinner.remove();
      button.classList.remove('is-busy');
    }
  }

  /** Nach dem Wechsel: die gesicherte Liste direkt für die neue Version anbieten. */
  async function offerReinstall(list) {
    const answer = await sheet({
      title: 'Liste jetzt neu installieren?',
      subtitle: `ModLoom sucht für jede der ${list.mods.length} Mods die Version für Minecraft ${state.config.gameVersion}. Was es dort nicht gibt, wird nur markiert.`,
      actions: [
        { label: 'Jetzt installieren', value: 'go', variant: 'primary', icon: 'download' },
        { label: 'Später', value: null }
      ]
    });
    if (answer === 'go') await installList(list.id);
  }

  /* ======================================================== Installieren */

  let progressUnsub = null;

  async function installNow(entries, button) {
    if (!state.config.gameVersion) {
      toast('Erst eine Fabric-Version aktivieren', 'warn');
      setView('fabric');
      return;
    }
    if (!entries.length) return;

    let spinner = null;
    if (button) {
      button.classList.add('is-busy');
      spinner = h('div', { class: 'spinner on-accent' });
      button.prepend(spinner);
    }

    const act = activity();
    act.set(entries.length === 1 ? entries[0].title : `${entries.length} Mods installieren`, 'Versionen prüfen…', null);

    progressUnsub = window.api.onProgress((e) => {
      if (e.type === 'resolve') act.set('Versionen prüfen', `${e.title} (${e.index + 1}/${e.total})`, null);
      else if (e.type === 'dependencies') act.set('Abhängigkeiten auflösen', 'Pflicht-Mods ergänzen…', null);
      else if (e.type === 'download') act.set(e.isDependency ? `${e.title} (Abhängigkeit)` : e.title, `Lädt ${e.index + 1} von ${e.total}`, 0);
      else if (e.type === 'progress' && e.size) act.set(e.title, `${bytes(e.received)} von ${bytes(e.size)}`, e.received / e.size);
    });

    try {
      const { results, dependencyMissing } = await call(window.api.mods.install, {
        entries: entries.map((m) => ({ projectId: m.projectId, slug: m.slug, title: m.title, iconUrl: m.iconUrl, versionId: m.versionId })),
        gameVersion: state.config.gameVersion
      });

      await refreshInstalled();
      renderNav();
      if (state.view === 'installed' || state.view === 'search' || state.view === 'lists') renderView();

      await showInstallSummary(results, dependencyMissing);
    } catch {
      /* gemeldet */
    } finally {
      if (progressUnsub) progressUnsub();
      progressUnsub = null;
      act.done();
      if (button && spinner) {
        spinner.remove();
        button.classList.remove('is-busy');
      }
    }
  }

  async function installList(listId, button) {
    const list = state.lists.find((l) => l.id === listId);
    if (!list || !list.mods.length) {
      toast('Die Liste ist leer', 'warn');
      return;
    }
    await installNow(list.mods, button);
  }

  async function showInstallSummary(results, dependencyMissing = []) {
    const by = (status) => results.filter((r) => r.status === status);
    const installed = by('installed');
    const already = by('already');
    const unavailable = by('unavailable');
    const failed = by('failed');

    // Alles glatt und überschaubar? Dann reicht ein Toast statt eines Dialogs.
    if (!unavailable.length && !failed.length) {
      const deps = installed.filter((r) => r.isDependency).length;
      toast(
        installed.length
          ? `${installed.length} Mod${installed.length === 1 ? '' : 's'} installiert${deps ? ` (inkl. ${deps} Abhängigkeit${deps === 1 ? '' : 'en'})` : ''}`
          : 'Alles war bereits aktuell',
        'ok'
      );
      return;
    }

    const body = h('div', {});
    const group = (title, rows, kind) => {
      if (!rows.length) return;
      body.append(h('div', { class: 't-micro dim', style: { marginTop: '1rem', marginBottom: '0.25rem' } }, title));
      for (const r of rows) {
        body.append(
          h('div', { class: 'result-row' },
            modIcon(r.iconUrl, r.title, 1.75),
            h('div', { style: { flex: '1', minWidth: 0 } },
              h('div', { class: 't-body', style: { fontWeight: '550', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.title || r.projectId),
              r.reason ? h('div', { class: 't-cap dim' }, r.reason) : r.versionNumber ? h('div', { class: 't-cap dim' }, r.versionNumber) : null),
            h('span', { class: `chip ${kind}` },
              kind === 'ok' ? icon('check', 12, 2.6) : icon('warn', 12, 2.2),
              kind === 'ok' ? 'ok' : kind === 'warn' ? 'markiert' : 'Fehler')
          )
        );
      }
    };

    group('Installiert', installed, 'ok');
    group('Bereits aktuell', already, 'ok');
    group('Nicht verfügbar – übersprungen', unavailable, 'warn');
    group('Fehlgeschlagen', failed, 'bad');

    if (dependencyMissing.length) {
      body.append(h('p', { class: 't-cap dim', style: { marginTop: '1rem' } },
        `${dependencyMissing.length} Pflicht-Abhängigkeit(en) ließen sich nicht auflösen. Die betroffenen Mods starten möglicherweise nicht.`));
    }

    await sheet({
      title: `${installed.length} installiert, ${unavailable.length} markiert`,
      subtitle: unavailable.length
        ? `Für Minecraft ${state.config.gameVersion} gibt es zu diesen Mods keine Fabric-Version. Sie wurden nicht installiert und bleiben in der Liste erhalten.`
        : 'Ergebnis der Installation.',
      body,
      wide: true,
      actions: [{ label: 'Fertig', value: 'ok', variant: 'primary' }]
    });
  }

  /* ====================================================== Ansicht: Einstellungen */

  TOOLBARS.settings = () => [h('div', { class: 'grow t-title' }, 'Einstellungen')];

  VIEWS.settings = () => {
    const cfg = state.config;

    const autoDeps = h('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-pressed': String(cfg.autoDependencies !== false),
      onclick: async () => {
        state.config = await call(window.api.config.set, { autoDependencies: !(state.config.autoDependencies !== false) });
        renderView();
      }
    });

    el.view.append(
      h('div', { class: 'panel' },
        h('div', { class: 'kv' },
          h('div', { class: 'k' },
            h('div', { class: 't-head' }, 'Minecraft-Ordner'),
            h('div', { class: 't-cap dim', style: { wordBreak: 'break-all' } }, cfg.mcDir),
            h('div', { class: 't-cap', style: { marginTop: '0.25rem', color: cfg.mcDirExists ? 'var(--green)' : 'var(--amber)' } },
              cfg.mcDirExists ? 'Ordner gefunden' : 'Ordner existiert noch nicht – wird beim Installieren angelegt')),
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            const next = await safe(call(window.api.config.pickMcDir));
            if (!next) return;
            state.config = await call(window.api.config.get);
            await Promise.all([refreshInstalled(), refreshFabricProfiles()]);
            renderSetupCard();
            renderNav();
            renderView();
            toast('Ordner übernommen', 'ok');
          } }, icon('folder', 15), h('span', { class: 'label' }, 'Ändern'))),

        h('div', { class: 'kv' },
          h('div', { class: 'k' },
            h('div', { class: 't-head' }, 'Mods-Ordner öffnen'),
            h('div', { class: 't-cap dim' }, `${cfg.mcDir}\\mods`)),
          h('button', { class: 'btn', type: 'button', onclick: () => window.api.mods.openFolder() }, 'Öffnen')),

        h('div', { class: 'kv' },
          h('div', { class: 'k' },
            h('div', { class: 't-head' }, 'Abhängigkeiten mitinstallieren'),
            h('div', { class: 't-cap dim' }, 'Pflicht-Mods wie die Fabric API werden automatisch ergänzt.')),
          autoDeps)
      ),

      h('div', { class: 'panel' },
        h('div', { class: 'kv' },
          h('div', { class: 'k' },
            h('div', { class: 't-head' }, 'Listen weitergeben'),
            h('div', { class: 't-cap dim' }, 'Exportierte .modlist.json-Dateien lassen sich importieren – so installiert eine Gruppe dasselbe Set.')),
          h('button', { class: 'btn', type: 'button', onclick: () => { setView('lists'); importLists(); } }, 'Importieren')),

        h('div', { class: 'kv' },
          h('div', { class: 'k' },
            h('div', { class: 't-head' }, 'Daten'),
            h('div', { class: 't-cap dim' }, 'Mods kommen von Modrinth, Loader-Daten von FabricMC.')),
          h('div', { style: { display: 'flex', gap: '0.375rem' } },
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => window.api.openExternal('https://modrinth.com') }, 'Modrinth', icon('external', 12, 2)),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => window.api.openExternal('https://fabricmc.net') }, 'Fabric', icon('external', 12, 2)))),

        h('div', { class: 'kv' },
          h('div', { class: 'k' },
            h('div', { class: 't-head' }, 'Version'),
            h('div', { class: 't-cap dim' }, `ModLoom ${cfg.appVersion || ''}`)),
          null)
      )
    );
  };

  /* ============================================================ Datenabgleich */

  async function refreshInstalled() {
    const data = await safe(call(window.api.mods.list, {}, { silent: true }), { mods: [], dir: '' });
    state.installedMods = data.mods || [];
    state.modsDir = data.dir || '';
    state.installedCount = state.installedMods.length;
    state.installedIds = new Set(state.installedMods.filter((m) => m.projectId).map((m) => m.projectId));
  }

  async function refreshLists() {
    state.lists = await safe(call(window.api.lists.all, {}, { silent: true }), []);
    renderNav();
  }

  async function refreshFabricProfiles() {
    state.fabric.installedProfiles = await safe(call(window.api.fabric.installedProfiles, {}, { silent: true }), []);
  }

  /* ------------------------------------------------------------------- Start */

  async function boot() {
    state.config = await call(window.api.config.get);
    await Promise.all([refreshInstalled(), refreshLists(), refreshFabricProfiles()]);
    state.fabric.selectedGame = state.config.gameVersion || null;
    state.fabric.selectedLoader = state.config.loaderVersion || null;

    renderNav();
    renderSetupCard();
    setView(state.config.gameVersion ? 'search' : 'fabric');
  }

  window.api.onTheme(() => {
    // Farben kommen aus CSS-Variablen; nur die abgeleiteten Flächen neu zeichnen.
    renderSetupCard();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (state.view !== 'search') setView('search');
      else el.toolbar.querySelector('input')?.focus();
    }
  });

  boot();
})();
