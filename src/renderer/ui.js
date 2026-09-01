/**
 * Wiederverwendbare Bausteine: DOM-Helfer, Sheets, Popover-Menüs, Toasts.
 * Jede Bewegung läuft über Federn und startet beim aktuellen Bildschirmwert,
 * damit man sie mitten im Flug greifen und umkehren kann.
 */
(function (global) {
  'use strict';

  const { SpringValue, PRESET, project, rubberband, VelocityTracker, reduceMotion } = global.Spring;

  /* ------------------------------------------------------------- DOM-Helfer */

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'html') el.innerHTML = value;
      else if (key in el && key !== 'list' && typeof value !== 'object') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(4)) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(name, size = 17, strokeWidth = 1.7) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', strokeWidth);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const clear = (el) => {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  };

  /* ------------------------------------------------------------ Formatierung */

  const nf = new Intl.NumberFormat('de-DE');
  const compact = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });

  const num = (n) => nf.format(n || 0);
  const shortNum = (n) => compact.format(n || 0);

  function bytes(n) {
    if (!n) return '–';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
    const steps = [
      [60, 'second'],
      [3600, 'minute'],
      [86400, 'hour'],
      [2592000, 'day'],
      [31536000, 'month']
    ];
    let unit = 'year';
    let value = diff / 31536000;
    for (let i = 0; i < steps.length; i++) {
      if (diff < steps[i][0]) {
        unit = i === 0 ? 'second' : steps[i - 1][1];
        value = diff / (i === 0 ? 1 : steps[i - 1][0]);
        break;
      }
    }
    return rtf.format(-Math.round(value), unit);
  }

  /* ------------------------------------------------------------------ Scrim */

  function makeScrim() {
    const el = h('div', { class: 'scrim' });
    document.body.append(el);
    const spring = new SpringValue(0, {
      ...PRESET.snappy,
      onUpdate: (v) => {
        el.style.opacity = v;
      }
    });
    spring.to(1);
    return {
      el,
      hide: () =>
        new Promise((resolve) =>
          spring.to(0, {
            onComplete: () => {
              el.remove();
              resolve();
            }
          })
        )
    };
  }

  /* ------------------------------------------------------------------ Sheet */

  /**
   * Modales Sheet. Kommt von unten, geht nach unten wieder weg (gleicher Weg),
   * lässt sich am Griff 1:1 ziehen und mit Schwung wegwerfen.
   * Auflösung: der Wert der gedrückten Aktion, oder null beim Abbrechen.
   */
  function sheet({ title, subtitle, body, actions = [], wide = false, dismissable = true }) {
    return new Promise((resolve) => {
      const scrim = makeScrim();
      const host = h('div', { class: 'sheet-host' });

      const content = h('div', { class: 'sheet-content' });
      if (title) {
        content.append(
          h('div', { style: { padding: '0.5rem 0 0.75rem' } },
            h('div', { class: 't-title' }, title),
            subtitle ? h('div', { class: 't-body dim', style: { marginTop: '0.25rem' } }, subtitle) : null
          )
        );
      }
      if (body) content.append(body);

      const actionRow = h(
        'div',
        { class: `sheet-actions${actions.length > 2 ? ' stack' : ''}` },
        actions.map((a) =>
          h(
            'button',
            {
              class: `btn btn-lg ${a.variant === 'primary' ? 'btn-primary' : a.variant === 'danger' ? 'btn-danger' : ''}`,
              type: 'button',
              onclick: () => close(a.value)
            },
            a.icon ? icon(a.icon, 16) : null,
            h('span', { class: 'label' }, a.label)
          )
        )
      );

      const grip = h('div', { class: 'sheet-grip', title: 'Zum Schließen nach unten ziehen' });
      const el = h('div', { class: `sheet${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
        dismissable ? grip : null, content, actions.length ? actionRow : null);

      host.append(el);
      document.body.append(host);

      /* --- Bewegung: Y und Deckkraft getrennt federn --- */
      const y = new SpringValue(reduceMotion.matches ? 0 : 28, { ...PRESET.sheet, onUpdate: render });
      const fade = new SpringValue(reduceMotion.matches ? 1 : 0, { ...PRESET.snappy, onUpdate: render });
      let scale = reduceMotion.matches ? 1 : 0.96;

      function render() {
        el.style.transform = `translate3d(0, ${y.value}px, 0) scale(${scale})`;
        el.style.opacity = fade.value;
      }

      render();
      requestAnimationFrame(() => {
        y.to(0);
        fade.to(1, {
          onUpdate: null,
          onComplete: () => {
            scale = 1;
          }
        });
        // Materialisieren statt nur einblenden: Skalierung läuft mit der Deckkraft.
        const scaleSpring = new SpringValue(scale, {
          ...PRESET.sheet,
          onUpdate: (v) => {
            scale = v;
            render();
          }
        });
        scaleSpring.to(1);
      });

      let settled = false;
      function close(value, velocity = 0) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        scrim.hide();
        fade.to(0, { response: 0.25 });
        y.to(220, {
          velocity,
          damping: 1,
          response: 0.32,
          onComplete: () => {
            host.remove();
            resolve(value);
          }
        });
      }

      function onKey(e) {
        if (!dismissable) return;
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(null);
        }
      }
      document.addEventListener('keydown', onKey, true);

      if (dismissable) {
        scrim.el.addEventListener('pointerdown', () => close(null));
        enableDragDismiss(grip, y, close);
      }

      // Fokus auf die primäre Aktion, damit Enter das Naheliegende tut.
      requestAnimationFrame(() => {
        const focusTarget = el.querySelector('[data-autofocus]') || el.querySelector('.btn-primary');
        if (focusTarget) focusTarget.focus();
      });
    });
  }

  /** 1:1-Ziehen am Griff, weiche Grenze nach oben, Wurf mit Schwung nach unten. */
  function enableDragDismiss(grip, y, close) {
    const tracker = new VelocityTracker();
    let dragging = false;
    let startY = 0;
    let base = 0;

    grip.addEventListener('pointerdown', (e) => {
      dragging = true;
      grip.setPointerCapture(e.pointerId);
      // Beim Greifen den aktuellen (sichtbaren) Wert übernehmen, nicht das Ziel.
      base = y.value;
      y.stop();
      startY = e.clientY;
      tracker.reset(e.clientY);
    });

    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      tracker.add(e.clientY);
      const delta = e.clientY - startY + base;
      // Nach oben gibt es nichts mehr - also Widerstand statt harter Stopp.
      y.jump(delta < 0 ? rubberband(delta, window.innerHeight * 0.4) : delta);
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      const velocity = tracker.velocity;
      // Wohin trägt die Geste? Danach entscheiden, nicht nach der Position beim Loslassen.
      const projected = y.value + project(velocity);
      if (projected > 130 || velocity > 900) close(null, velocity);
      else y.to(0, { velocity, ...PRESET.sheet });
    };

    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /* ------------------------------------------------------------ Popover-Menü */

  /**
   * Menü am Auslöser verankert: es wächst aus dem Button heraus,
   * damit die räumliche Beziehung sichtbar bleibt.
   */
  function menu(anchor, items) {
    return new Promise((resolve) => {
      const el = h('div', { class: 'menu', role: 'menu' });
      for (const item of items) {
        if (item.type === 'sep') {
          el.append(h('div', { class: 'sep' }));
          continue;
        }
        if (item.type === 'head') {
          el.append(h('div', { class: 'head t-micro' }, item.label));
          continue;
        }
        el.append(
          h('button', { type: 'button', role: 'menuitem', onclick: () => close(item.value) },
            item.icon ? icon(item.icon, 15) : null,
            h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label),
            item.hint ? h('span', { class: 'dim t-cap' }, item.hint) : null
          )
        );
      }

      document.body.append(el);

      const rect = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      const openUp = rect.bottom + height + 8 > window.innerHeight;
      const top = openUp ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.transformOrigin = `${Math.min(Math.max(rect.left + rect.width / 2 - left, 12), width - 12)}px ${openUp ? '100%' : '0'}`;

      const grow = new SpringValue(reduceMotion.matches ? 1 : 0.92, {
        damping: 1,
        response: 0.26,
        onUpdate: (v) => {
          el.style.transform = `scale(${v})`;
        }
      });
      const fade = new SpringValue(reduceMotion.matches ? 1 : 0, {
        ...PRESET.snappy,
        onUpdate: (v) => {
          el.style.opacity = v;
        }
      });
      grow.to(1);
      fade.to(1);

      let settled = false;
      function close(value) {
        if (settled) return;
        settled = true;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', () => close(null));
        grow.to(0.95, { response: 0.2 });
        fade.to(0, {
          response: 0.18,
          onComplete: () => {
            el.remove();
            resolve(value);
          }
        });
      }

      function onOutside(e) {
        if (!el.contains(e.target)) close(null);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(null);
        }
      }

      setTimeout(() => {
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
    });
  }

  /* ------------------------------------------------------------------ Toast */

  const toastHost = () => document.getElementById('toast-host');

  function toast(message, kind = 'ok', duration = 3200) {
    const glyph = kind === 'ok' ? 'check' : kind === 'warn' ? 'warn' : kind === 'bad' ? 'warn' : 'check';
    const el = h('div', { class: `toast ${kind}` }, icon(glyph, 16, 2), h('span', {}, message));
    toastHost().append(el);

    const x = new SpringValue(24, { ...PRESET.sheet, onUpdate: render });
    const fade = new SpringValue(0, { ...PRESET.snappy, onUpdate: render });
    function render() {
      el.style.transform = `translate3d(${x.value}px, 0, 0)`;
      el.style.opacity = fade.value;
    }
    render();
    x.to(0);
    fade.to(1);

    const timer = setTimeout(dismiss, duration);
    function dismiss() {
      clearTimeout(timer);
      // Raus auf demselben Weg, auf dem es hereinkam.
      x.to(24, { response: 0.28 });
      fade.to(0, { response: 0.22, onComplete: () => el.remove() });
    }
    el.addEventListener('pointerdown', dismiss);
    return dismiss;
  }

  /* --------------------------------------------------------------- Aktivität */

  /** Schwebende Fortschrittsanzeige während Downloads. */
  function activity() {
    const titleEl = h('div', { class: 't-body', style: { fontWeight: '600' } }, 'Vorbereiten…');
    const subEl = h('div', { class: 't-cap dim', style: { marginTop: '1px' } }, '');
    const fill = h('i');
    const bar = h('div', { class: 'bar indeterminate' }, fill);
    const el = h('div', { class: 'activity' }, titleEl, subEl, bar);
    document.body.append(el);

    const y = new SpringValue(reduceMotion.matches ? 0 : 60, {
      ...PRESET.sheet,
      onUpdate: (v) => {
        el.style.transform = `translate3d(-50%, ${v}px, 0)`;
      }
    });
    const fade = new SpringValue(reduceMotion.matches ? 1 : 0, {
      ...PRESET.snappy,
      onUpdate: (v) => {
        el.style.opacity = v;
      }
    });
    el.style.transform = 'translate3d(-50%, 60px, 0)';
    y.to(0);
    fade.to(1);

    return {
      set(title, sub, ratio) {
        titleEl.textContent = title;
        subEl.textContent = sub || '';
        if (ratio == null) {
          bar.classList.add('indeterminate');
          fill.style.width = '';
        } else {
          bar.classList.remove('indeterminate');
          fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
        }
      },
      done() {
        y.to(60, { response: 0.3 });
        fade.to(0, { response: 0.22, onComplete: () => el.remove() });
      }
    };
  }

  global.UI = { h, icon, clear, num, shortNum, bytes, timeAgo, sheet, menu, toast, activity };
})(window);
