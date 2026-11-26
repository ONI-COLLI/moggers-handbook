/* 3D block scenes for the handbook: a small software rasterizer over vanilla block faces.
   window.MoggersBlocks (blocks3d.js, generated) holds {models: {key: [[points, uv, tex]]}, textures: [[size, base64 RGBA]]}.
   A scene is {blocks: [[x, y, z, key, step]], steps: [[name, text]]}. */
(() => {
  "use strict";
  let atlas = null, textures = null, loading = null;

  function loadAtlas() {
    if (textures) return Promise.resolve();
    if (!loading) loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "blocks3d.js" + (window.HANDBOOK_BUILD ? "?v=" + window.HANDBOOK_BUILD : "");
      script.onload = () => {
        atlas = window.MoggersBlocks;
        textures = atlas.textures.map(([size, encoded]) => {
          const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
          return { size, pixels: new Uint32Array(bytes.buffer) };
        });
        resolve();
      };
      script.onerror = () => { loading = null; reject(new Error("blocks3d.js")); };
      document.head.append(script);
    });
    return loading;
  }

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const START_YAW = 0.62, START_PITCH = 0.5;

  class Viewer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.raster = document.createElement("canvas");
      this.rctx = this.raster.getContext("2d");
      this.yaw = START_YAW; this.pitch = START_PITCH; this.zoom = 1;
      this.limit = Infinity; this.isolated = false; this.focus = null;
      this.dirty = true; this.frame = 0; this.listeners = [];
      this.bind();
      new ResizeObserver(() => { this.dirty = true; this.request(); }).observe(canvas);
    }

    setScene(scene) {
      this.scene = scene;
      const blocks = scene.blocks;
      const min = [0, 1, 2].map((i) => Math.min(...blocks.map((b) => b[i])));
      const max = [0, 1, 2].map((i) => Math.max(...blocks.map((b) => b[i])) + 1);
      this.mid = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      this.size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      this.min = min; this.max = max;
      this.faces = [];
      for (const [x, y, z, key, step] of blocks) {
        for (const [points, uv, tex] of atlas.models[key] || []) {
          this.faces.push({ step, tex, uv, y, points: points.map(([a, b, c]) => [a + x - this.mid[0], b + y, c + z - this.mid[2]]) });
        }
      }
      this.dirty = true; this.request();
    }
    setLimit(step, isolated) { this.limit = step; this.isolated = !!isolated; this.dirty = true; this.request(); }
    setFocus(focus, onMove) { this.focus = focus; this.onMove = onMove || null; this.request(); }
    reset() { this.yaw = START_YAW; this.pitch = START_PITCH; this.zoom = 1; this.dirty = true; this.request(); }
    turn(delta) { this.yaw += delta; this.dirty = true; this.request(); }
    scaleBy(factor) { this.zoom = clamp(this.zoom * factor, 0.5, 3.5); this.dirty = true; this.request(); }

    visible(face) {
      if (this.isolated) return face.step === this.limit;
      return face.step <= this.limit;
    }

    camera(w, h) {
      const ca = Math.cos(this.yaw), sa = Math.sin(this.yaw), ce = Math.cos(this.pitch), se = Math.sin(this.pitch);
      const reach = Math.hypot(this.size[0], this.size[2]);
      const shown = this.faces.filter((f) => this.visible(f));
      const top = shown.length ? Math.max(...shown.map((f) => f.y)) + 1 : this.max[1];
      const bottom = this.isolated && shown.length ? Math.min(...shown.map((f) => f.y)) : this.min[1];
      const centerY = (top + bottom) / 2;
      const scale = 0.8 * this.zoom * Math.min(w / reach, h / (this.size[1] * ce + reach * Math.abs(se)));
      return (p) => {
        const x = p[0], y = p[1] - centerY, z = p[2];
        const across = sa * x - ca * z;
        return [w / 2 + (-ca * x - sa * z) * scale, h / 2 + (se * across - ce * y) * scale, ce * across + se * y];
      };
    }

    rasterize(w, h) {
      if (this.raster.width !== w || this.raster.height !== h) {
        this.raster.width = w; this.raster.height = h;
        this.buffer = this.rctx.createImageData(w, h);
        this.rgba = new Uint32Array(this.buffer.data.buffer);
        this.depth = new Float32Array(w * h);
      }
      const { rgba, depth } = this;
      rgba.fill(0); depth.fill(-Infinity);
      const project = this.project = this.camera(w, h);
      for (const face of this.faces) {
        if (!this.visible(face)) continue;
        const [o, u, , v] = face.points.map(project);
        const ax = u[0] - o[0], ay = u[1] - o[1], bx = v[0] - o[0], by = v[1] - o[1];
        const det = ax * by - ay * bx;
        if (det < 0.001) continue;
        const xMin = Math.max(0, Math.floor(o[0] + Math.min(0, ax) + Math.min(0, bx)));
        const xMax = Math.min(w, Math.ceil(o[0] + Math.max(0, ax) + Math.max(0, bx)));
        const yMin = Math.max(0, Math.floor(o[1] + Math.min(0, ay) + Math.min(0, by)));
        const yMax = Math.min(h, Math.ceil(o[1] + Math.max(0, ay) + Math.max(0, by)));
        const [t0, t1, , t3] = face.uv, { size, pixels } = textures[face.tex];
        const du = t1[0] - t0[0], dv = t1[1] - t0[1], eu = t3[0] - t0[0], ev = t3[1] - t0[1];
        const k = size / 16;
        for (let y = yMin; y < yMax; y++) {
          const dy = y + 0.5 - o[1], dx = xMin + 0.5 - o[0];
          let a = (dx * by - dy * bx) / det, b = (ax * dy - ay * dx) / det;
          for (let x = xMin; x < xMax; x++, a += by / det, b -= ay / det) {
            if (a < 0 || b < 0 || a > 1 || b > 1) continue;
            const near = o[2] + a * (u[2] - o[2]) + b * (v[2] - o[2]), at = y * w + x;
            if (near < depth[at] - 0.00001) continue;
            const col = clamp(Math.floor((t0[0] + a * du + b * eu) * k), 0, size - 1);
            const row = clamp(Math.floor((t0[1] + a * dv + b * ev) * k), 0, size - 1);
            const pixel = pixels[row * size + col];
            if (pixel >>> 24) { rgba[at] = pixel; depth[at] = near; }
          }
        }
      }
      this.rctx.putImageData(this.buffer, 0, 0);
    }

    floor(project) {
      const { ctx } = this;
      const y = this.isolated ? null : this.min[1];
      if (y == null) return;
      const x0 = this.min[0] - this.mid[0] - 0.75, x1 = this.max[0] - this.mid[0] + 0.75;
      const z0 = this.min[2] - this.mid[2] - 0.75, z1 = this.max[2] - this.mid[2] + 0.75;
      const corners = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]].map(project);
      ctx.beginPath();
      corners.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    highlight(project, ratio, time) {
      const [fx, fy, fz] = this.focus;
      const x = fx - this.mid[0], z = fz - this.mid[2];
      const p = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => project([x + i, fy + j, z + k]))));
      const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      const pulse = still.matches ? 1 : 0.55 + 0.45 * Math.sin(time / 260);
      const { ctx } = this;
      ctx.save();
      ctx.lineWidth = 2.5 * ratio;
      ctx.strokeStyle = `rgba(232,176,74,${0.45 + 0.55 * pulse})`;
      ctx.shadowColor = "rgba(232,176,74,0.9)";
      ctx.shadowBlur = 8 * ratio * pulse;
      ctx.beginPath();
      for (const [a, b] of edges) { ctx.moveTo(p[a][0], p[a][1]); ctx.lineTo(p[b][0], p[b][1]); }
      ctx.stroke();
      ctx.restore();
      if (this.onMove) {
        const [sx, sy] = project([x + 0.5, fy + 1.15, z + 0.5]);
        this.onMove(sx / ratio, sy / ratio);
      }
    }

    draw(time) {
      this.frame = 0;
      const box = this.canvas.getBoundingClientRect();
      if (!box.width || !box.height || !this.faces) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5, 1100 / box.width);
      const w = Math.max(1, Math.round(box.width * ratio)), h = Math.max(1, Math.round(box.height * ratio));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.dirty = true; }
      if (this.dirty) { this.rasterize(w, h); this.dirty = false; }
      const { ctx } = this;
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      this.floor(this.project);
      ctx.drawImage(this.raster, 0, 0);
      if (this.focus) {
        this.highlight(this.project, ratio, time || 0);
        if (!still.matches && document.contains(this.canvas)) this.request();
      }
    }
    request() { if (!this.frame) this.frame = requestAnimationFrame((t) => this.draw(t)); }

    bind() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener("pointerdown", (e) => {
        if (drag || e.button !== 0) return;
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener("pointermove", (e) => {
        if (drag?.id !== e.pointerId) return;
        this.yaw -= (e.clientX - drag.x) * 0.011;
        this.pitch = clamp(this.pitch + (e.clientY - drag.y) * 0.009, -0.2, 1.45);
        drag.x = e.clientX; drag.y = e.clientY;
        this.dirty = true; this.request();
      });
      c.addEventListener("lostpointercapture", () => { drag = null; });
      c.addEventListener("pointerdown", () => c.focus({ preventScroll: true }));
      c.addEventListener("wheel", (e) => {
        // The page keeps scrolling unless the model was clicked first or Ctrl is held.
        if (!e.ctrlKey && document.activeElement !== c) return;
        e.preventDefault();
        this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.5, 3.5);
        this.dirty = true; this.request();
      }, { passive: false });
      c.addEventListener("keydown", (e) => {
        const keys = { ArrowLeft: () => (this.yaw -= 0.22), ArrowRight: () => (this.yaw += 0.22),
          ArrowUp: () => (this.pitch = clamp(this.pitch + 0.16, -0.2, 1.45)), ArrowDown: () => (this.pitch = clamp(this.pitch - 0.16, -0.2, 1.45)),
          "+": () => (this.zoom = clamp(this.zoom * 1.12, 0.5, 3.5)), "-": () => (this.zoom = clamp(this.zoom / 1.12, 0.5, 3.5)) };
        if (!keys[e.key]) return;
        e.preventDefault(); keys[e.key](); this.dirty = true; this.request();
      });
    }
  }

  window.HandbookViewer = { load: loadAtlas, create: (canvas) => new Viewer(canvas) };
})();
