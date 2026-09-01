/**
 * Federn nach Apples Modell: gedacht wird in "response" (wie schnell der Wert
 * ankommt) und "damping ratio" (wie viel Überschwingen). Keine Dauer, keine
 * Keyframes - dadurch ist jede Bewegung jederzeit unterbrechbar und übernimmt
 * die Geschwindigkeit, die der Nutzer gerade in der Geste hatte.
 */
(function (global) {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Apples Werte aus "Designing Fluid Interfaces".
  const PRESET = {
    ui: { damping: 1.0, response: 0.4 }, // Standard: kritisch gedämpft, kein Überschwingen
    move: { damping: 1.0, response: 0.4 },
    rotate: { damping: 0.8, response: 0.4 },
    sheet: { damping: 0.8, response: 0.3 }, // Bounce nur, weil eine Geste Schwung mitbringt
    snappy: { damping: 1.0, response: 0.25 }
  };

  class SpringValue {
    constructor(value, options = {}) {
      this.value = value;
      this.velocity = 0;
      this.target = value;
      this.damping = options.damping ?? 1;
      this.response = options.response ?? 0.4;
      this.restDelta = options.restDelta ?? 0.01;
      this.restSpeed = options.restSpeed ?? 0.05;
      this.onUpdate = options.onUpdate || (() => {});
      this.onComplete = options.onComplete || null;
      this._raf = null;
      this._last = 0;
    }

    /** Neues Ziel. Startet immer beim aktuellen (sichtbaren) Wert und trägt die
     *  aktuelle Geschwindigkeit weiter - kein Sprung, keine "Wand" beim Umkehren. */
    to(target, options = {}) {
      if (options.damping != null) this.damping = options.damping;
      if (options.response != null) this.response = options.response;
      if (options.velocity != null) this.velocity = options.velocity;
      this.onComplete = options.onComplete ?? this.onComplete;
      this.target = target;

      if (reduceMotion.matches) {
        this.stop();
        this.value = target;
        this.velocity = 0;
        this.onUpdate(this.value, this);
        if (this.onComplete) this.onComplete();
        return this;
      }

      if (this._raf == null) {
        this._last = performance.now();
        this._raf = requestAnimationFrame(this._tick);
      }
      return this;
    }

    /** Sofort setzen (z. B. beim Greifen während einer laufenden Animation). */
    jump(value, velocity = 0) {
      this.stop();
      this.value = value;
      this.target = value;
      this.velocity = velocity;
      this.onUpdate(this.value, this);
      return this;
    }

    stop() {
      if (this._raf != null) cancelAnimationFrame(this._raf);
      this._raf = null;
      return this;
    }

    get isAnimating() {
      return this._raf != null;
    }

    _tick = (now) => {
      // Große Lücken (Tab im Hintergrund) nicht auf einmal integrieren.
      const dt = Math.min((now - this._last) / 1000, 1 / 30);
      this._last = now;

      const { value, velocity } = solve(
        this.value - this.target,
        this.velocity,
        this.damping,
        this.response,
        dt
      );
      this.value = this.target + value;
      this.velocity = velocity;

      const settled =
        Math.abs(this.value - this.target) < this.restDelta && Math.abs(velocity) < this.restSpeed / dt;

      if (settled) {
        this.value = this.target;
        this.velocity = 0;
        this._raf = null;
        this.onUpdate(this.value, this);
        if (this.onComplete) this.onComplete();
        return;
      }

      this.onUpdate(this.value, this);
      this._raf = requestAnimationFrame(this._tick);
    };
  }

  /** Analytische Lösung der gedämpften Feder für einen Zeitschritt. */
  function solve(x0, v0, zeta, response, t) {
    const w0 = (2 * Math.PI) / Math.max(response, 0.0001);

    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-zeta * w0 * t);
      const c1 = x0;
      const c2 = (v0 + zeta * w0 * x0) / wd;
      const cos = Math.cos(wd * t);
      const sin = Math.sin(wd * t);
      const value = e * (c1 * cos + c2 * sin);
      const velocity = e * ((c2 * wd - zeta * w0 * c1) * cos - (c1 * wd + zeta * w0 * c2) * sin);
      return { value, velocity };
    }

    if (zeta === 1) {
      const e = Math.exp(-w0 * t);
      const c2 = v0 + w0 * x0;
      return { value: e * (x0 + c2 * t), velocity: e * (c2 - w0 * (x0 + c2 * t)) };
    }

    const r = w0 * Math.sqrt(zeta * zeta - 1);
    const a = -zeta * w0 + r;
    const b = -zeta * w0 - r;
    const c2 = (v0 - a * x0) / (b - a);
    const c1 = x0 - c2;
    return {
      value: c1 * Math.exp(a * t) + c2 * Math.exp(b * t),
      velocity: c1 * a * Math.exp(a * t) + c2 * b * Math.exp(b * t)
    };
  }

  /**
   * Wohin trägt der Schwung? Apples Projektionsfunktion aus dem Sample-Code -
   * nicht die Lehrbuchformel. Damit landet ein Flick dort, wo er "hinwill".
   */
  function project(velocity, decelerationRate = 0.998) {
    return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
  }

  /** Weiche Grenze: je weiter darüber hinaus, desto weniger folgt das Element. */
  function rubberband(overshoot, dimension, constant = 0.55) {
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  /** Verfolgt die letzten Zeigerpunkte, um beim Loslassen echte Geschwindigkeit zu kennen. */
  class VelocityTracker {
    constructor(window = 5) {
      this.window = window;
      this.samples = [];
    }
    add(value) {
      this.samples.push({ value, time: performance.now() });
      if (this.samples.length > this.window) this.samples.shift();
    }
    reset(value) {
      this.samples = [{ value, time: performance.now() }];
    }
    /** px pro Sekunde */
    get velocity() {
      if (this.samples.length < 2) return 0;
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      const dt = (last.time - first.time) / 1000;
      if (dt <= 0) return 0;
      return (last.value - first.value) / dt;
    }
  }

  global.Spring = { SpringValue, PRESET, project, rubberband, VelocityTracker, reduceMotion };
})(window);
