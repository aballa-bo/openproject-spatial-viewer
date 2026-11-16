  // ---- Level-of-detail point clouds (Potree-style octree streaming) ------
  // Big LAS/LAZ/E57 clouds are converted server-side (bin/build_point_octree.js)
  // into an octree whose nodes each hold a SAMPLE of their cube: the root a
  // coarse sample of the whole scan, deeper nodes progressively denser ones.
  // Every few frames this picks the nodes worth drawing for the CURRENT camera
  // -- biggest on screen first, frustum-culled, never more than `pointBudget`
  // points in total -- streams the ones it doesn't have yet and evicts the
  // ones it no longer needs. A cloud can therefore be far larger than the
  // budget: you always see the part you are looking at, at the density the
  // distance justifies.

  var LOD_DEFAULT_BUDGET = 4000000;  // max points drawn at once, all LOD layers together
  var LOD_MIN_NODE_PX = 40;          // don't refine nodes whose projected radius is below this
  var LOD_MAX_REQUESTS = 6;          // parallel node downloads
  var LOD_UPDATE_MS = 120;           // selection throttle
  var LOD_SQRT3_2 = 0.8660254;       // half cube diagonal / cube size

  // Binary max-heap on `.prio`.
  function LodHeap() { this.a = []; }
  LodHeap.prototype.push = function(item) {
    var a = this.a, i = a.length;
    a.push(item);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].prio >= a[i].prio) break;
      var t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  };
  LodHeap.prototype.pop = function() {
    var a = this.a;
    if (!a.length) return null;
    var top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l].prio > a[m].prio) m = l;
        if (r < n && a[r].prio > a[m].prio) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  };
  LodHeap.prototype.size = function() { return this.a.length; };

  // One octree-streamed point-cloud layer.
  function PointLOD(app, layerId, hierarchy, baseUrl) {
    this.app = app;
    this.layerId = layerId;
    this.h = hierarchy;
    this.baseUrl = baseUrl;                       // ...?v=N&node=
    this.origin = new THREE.Vector3(hierarchy.origin[0], hierarchy.origin[1], hierarchy.origin[2]);
    this.group = new THREE.Group();
    // Absolute coordinates can be huge (survey grids); node positions are stored
    // relative to the root cube, and this group carries the (double precision)
    // offset, so float32 GPU precision is never the limit.
    this.group.position.copy(this.origin);
    this.group.name = 'pointlod:' + layerId;
    this.loaded = {};        // name -> { name, points, n, lastSeen }
    this.loading = {};       // name -> true
    this.queue = [];         // names still to fetch, best first
    this.visibleSet = {};    // names chosen by the last selection
    this.mats = {};          // depth -> shared material
    this.loadedPoints = 0;
    this.lastSig = null;
    this.lastUpdate = 0;
    this.frame = 0;
    this.dead = false;
  }

  PointLOD.prototype._nodeUrl = function(name) { return this.baseUrl + name; };

  PointLOD.prototype._material = function(depth) {
    var m = this.mats[depth];
    if (m) return m;
    var spacing = this.h.size / Math.pow(2, depth) / this.h.grid;
    var opts = { size: spacing * 1.5, sizeAttenuation: true };
    if (this.h.hasColor) opts.vertexColors = true; else opts.color = 0x9aa7b4;
    m = new THREE.PointsMaterial(opts);
    var scaleU = this.app._pointScaleU = this.app._pointScaleU || { value: 1 };
    m.onBeforeCompile = function(shader) {
      // Round points, and keep their on-screen size between 2 and 16 px so far
      // nodes don't shimmer at sub-pixel size and near ones don't become blobs.
      // `uPointScale` is the Render panel's point-size slider (shared by every
      // LOD material), applied to the size and to both clamp bounds.
      shader.uniforms.uPointScale = scaleU;
      shader.vertexShader = 'uniform float uPointScale;\n' + shader.vertexShader.replace(
        '#include <logdepthbuf_vertex>',
        'gl_PointSize = clamp(gl_PointSize * uPointScale, 2.0 * uPointScale, 16.0 * uPointScale);\n#include <logdepthbuf_vertex>');
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'void main() {\n\tvec2 _pc = gl_PointCoord - 0.5;\n\tif (dot(_pc, _pc) > 0.25) discard;\n');
    };
    m.clippingPlanes = this.app.clipPlanes;
    this.mats[depth] = m;
    return m;
  };

  // Fetch + decode one node into a THREE.Points (not yet attached).
  PointLOD.prototype._fetchNode = function(name) {
    var self = this, meta = this.h.nodes[name];
    return fetch(this._nodeUrl(name), { credentials: 'same-origin' }).then(function(r) {
      if (!r.ok) throw new Error('node ' + name + ': HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function(buf) {
      var n = meta.n;
      var geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 0, n * 3), 3));
      if (self.h.hasColor) {
        geom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(buf, n * 12, n * 3), 3, true));
      }
      var pts = new THREE.Points(geom, self._material(name.length - 1));
      // Node positions are relative to the root cube; shift to this node's cube.
      pts.position.set(meta.o[0], meta.o[1], meta.o[2]);
      pts.userData.lodNode = name;
      pts.userData.layerKind = 'pointcloud';
      return pts;
    });
  };

  // Root node first, so the layer has something to frame the camera on. The
  // returned group is what the layer pipeline (onModelLoaded) receives.
  PointLOD.prototype.loadRoot = function() {
    var self = this;
    return this._fetchNode('r').then(function(pts) {
      var rb = self.h.robust, o = self.origin;
      // Outlier-trimmed box for camera framing (see _robustObjectBox); local
      // to the root Points object, whose world position is `origin`.
      pts.userData.robustBox = new THREE.Box3(
        new THREE.Vector3(rb.min[0] - o.x, rb.min[1] - o.y, rb.min[2] - o.z),
        new THREE.Vector3(rb.max[0] - o.x, rb.max[1] - o.y, rb.max[2] - o.z));
      self.group.add(pts);
      self.loaded['r'] = { name: 'r', points: pts, n: self.h.nodes.r.n, lastSeen: 0 };
      self.loadedPoints += self.h.nodes.r.n;
      self.visibleSet['r'] = true;
      return self.group;
    });
  };

  // Which nodes to draw for this camera: best (largest on screen) first until
  // the point budget is spent.
  PointLOD.prototype._select = function(camera, viewH, budget) {
    var h = this.h, nodes = h.nodes, origin = this.origin;
    camera.updateMatrixWorld();
    var frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    var cam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    var pxScale = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    var sphere = new THREE.Sphere(), center = new THREE.Vector3();

    function eval_(name) {
      var m = nodes[name];
      var half = m.s / 2, r = m.s * LOD_SQRT3_2;
      center.set(origin.x + m.o[0] + half, origin.y + m.o[1] + half, origin.z + m.o[2] + half);
      sphere.center.copy(center); sphere.radius = r;
      if (!frustum.intersectsSphere(sphere)) return -1;
      var d = center.distanceTo(cam);
      if (d <= r) return 1e9;                         // camera inside the node
      return r / d * pxScale;
    }

    var heap = new LodHeap(), out = [], total = 0;
    heap.push({ name: 'r', prio: 1e10 });
    while (heap.size()) {
      var it = heap.pop(), name = it.name, m = nodes[name];
      if (total + m.n > budget && name !== 'r') continue;
      out.push({ name: name, prio: it.prio });
      total += m.n;
      for (var o = 0; o < 8; o++) {
        if (!(m.c & (1 << o))) continue;
        var cn = name + o, px = eval_(cn);
        if (px >= LOD_MIN_NODE_PX) heap.push({ name: cn, prio: px });
      }
    }
    return out;
  };

  PointLOD.prototype._attach = function(name, pts) {
    var app = this.app;
    var g = app.layerGroups && app.layerGroups[this.layerId];
    pts.userData.layerVisibilityGroup = g || this.group;
    pts.visible = !!this.visibleSet[name];
    this.group.add(pts);
    this.loaded[name] = { name: name, points: pts, n: this.h.nodes[name].n, lastSeen: this.frame };
    this.loadedPoints += this.h.nodes[name].n;
    // Make the node visible to picking / raycasting like any other layer mesh.
    app._allLayerMeshes = app._allLayerMeshes || [];
    app._allLayerMeshes.push(pts);
    app.modelMeshObjects = app._allLayerMeshes;
  };

  PointLOD.prototype._evict = function(name) {
    var rec = this.loaded[name];
    if (!rec || name === 'r') return;
    var app = this.app;
    this.group.remove(rec.points);
    rec.points.geometry.dispose();
    [app._allLayerMeshes, app.modelMeshObjects].forEach(function(arr) {
      var i = arr ? arr.indexOf(rec.points) : -1;
      if (i !== -1) arr.splice(i, 1);
    });
    this.loadedPoints -= rec.n;
    delete this.loaded[name];
  };

  PointLOD.prototype._pump = function() {
    var self = this, inflight = Object.keys(this.loading).length;
    while (!this.dead && inflight < LOD_MAX_REQUESTS && this.queue.length) {
      var name = this.queue.shift();
      if (this.loaded[name] || this.loading[name] || !this.visibleSet[name]) continue;
      this.loading[name] = true; inflight++;
      (function(nm) {
        self._fetchNode(nm).then(function(pts) {
          delete self.loading[nm];
          if (self.dead) { pts.geometry.dispose(); return; }
          self._attach(nm, pts);
          self.app._lodDirty = true;
          self._pump();
        }).catch(function(err) {
          delete self.loading[nm];
          console.warn('[SpatialViewer] LOD node failed:', nm, err && err.message || err);
          self._pump();
        });
      })(name);
    }
  };

  PointLOD.prototype.update = function(now, budget) {
    var app = this.app, cam = app.camera;
    if (this.dead || !cam) return;
    var g = app.layerGroups && app.layerGroups[this.layerId];
    if (g && g.visible === false) return;               // hidden layer: load nothing

    // Re-select only when the view actually changed.
    var e = cam.matrixWorld.elements;
    var sig = [e[12], e[13], e[14], e[0], e[1], e[2], e[4], e[5], e[6], cam.fov, cam.aspect, budget].join(',');
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.frame++;

    var viewH = app.viewport ? (app.viewport.clientHeight || 1) : 1;
    var sel = this._select(cam, viewH, budget);

    var vis = {};
    sel.forEach(function(s) { vis[s.name] = s.prio; });
    this.visibleSet = vis;

    // Show/hide loaded nodes, queue missing ones (best first).
    var self = this, need = [];
    Object.keys(this.loaded).forEach(function(nm) {
      var rec = self.loaded[nm], v = (nm in vis);
      rec.points.visible = v;
      if (v) rec.lastSeen = self.frame;
    });
    sel.forEach(function(s) {
      if (!self.loaded[s.name] && !self.loading[s.name]) need.push(s.name);
    });
    this.queue = need;       // already ordered by priority (heap pop order)

    // Evict the stalest hidden nodes once the cache is well over budget.
    if (this.loadedPoints > budget * 1.5) {
      var hidden = Object.keys(this.loaded).filter(function(nm) { return !(nm in vis) && nm !== 'r'; });
      hidden.sort(function(a, b) { return self.loaded[a].lastSeen - self.loaded[b].lastSeen; });
      for (var i = 0; i < hidden.length && this.loadedPoints > budget * 1.2; i++) this._evict(hidden[i]);
    }
    this._pump();
  };

  PointLOD.prototype.visiblePoints = function() {
    var n = 0, self = this;
    Object.keys(this.loaded).forEach(function(nm) { if (self.loaded[nm].points.visible) n += self.loaded[nm].n; });
    return n;
  };

  PointLOD.prototype.dispose = function() {
    this.dead = true;
    var self = this;
    Object.keys(this.loaded).forEach(function(nm) { self.loaded[nm].points.geometry.dispose(); });
  };

  // Per-frame hook (called from the render loop). Cheap when the camera hasn't
  // moved: one signature compare per LOD layer.
  SpatialViewerApp.prototype._updatePointLODs = function(now) {
    if (now - (this._lodLast || 0) < LOD_UPDATE_MS) return;
    this._lodLast = now;
    var self = this, active = (this._pointLODs || []).filter(function(l) {
      var g = self.layerGroups && self.layerGroups[l.layerId];
      return !g || g.visible !== false;
    });
    if (!active.length) return;
    var budget = Math.floor((this.pointBudget || LOD_DEFAULT_BUDGET) / active.length);
    active.forEach(function(l) { l.update(now, budget); });
  };

  // Load a point-cloud layer from its octree. Falls back to the plain LAS
  // download if the octree can't be read.
  SpatialViewerApp.prototype._loadPointOctree = function(l) {
    var self = this;
    var base = l.octree_url + (l.octree_url.indexOf('?') !== -1 ? '&' : '?') + 'node=';
    self.showLoader('Opening multi-resolution point cloud…');

    fetch(base + 'hierarchy', { credentials: 'same-origin' }).then(function(r) {
      if (!r.ok) throw new Error('hierarchy: HTTP ' + r.status);
      return r.json();
    }).then(function(h) {
      var lod = new PointLOD(self, l.id, h, base);
      return lod.loadRoot().then(function(group) { return { lod: lod, group: group }; });
    }).then(function(res) {
      if (self._loadingLayerId !== l.id) { res.lod.dispose(); return; }
      (self._pointLODs = self._pointLODs || []).push(res.lod);
      try { self._updateRenderSections(); } catch (e) {}
      self.onModelLoaded(res.group);
      console.log('[SpatialViewer] LOD point cloud: ' + res.lod.h.count + ' points in ' +
        Object.keys(res.lod.h.nodes).length + ' nodes, budget ' + (self.pointBudget || LOD_DEFAULT_BUDGET));
    }, function(err) {
      console.warn('[SpatialViewer] octree unavailable, loading the full LAS instead:', err && err.message || err);
      if (self._loadingLayerId === l.id) self.load3DModel(l.url, l.format);
    });
  };

