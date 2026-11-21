  // ---- Multi-layer model loading & lifecycle ----------------------------
  // Fetching/sequencing each layer's own model file, fade-in/out, the
  // layer visibility panel -- orchestration only; the actual per-format
  // parsing lives in the sibling 21_point_cloud_formats.js/22_splat_
  // rendering.js/23_parsers.js, reached via load3DModel -> _downloadModel
  // -> _parseModel (see 23_parsers.js).

  SpatialViewerApp.prototype.loadProjectData = function() {
    this.showLoader('Loading model configuration...');
    var self = this;
    fetch(this.apiUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function(res) {
        if (!res.ok) throw new Error('Failed to fetch model info (HTTP ' + res.status + ')');
        return res.json();
      })
      .then(function(data) {
        self.projectData = data;
        self.renderAnnotationsList(data.annotations);
        if (self._renderSavedViews) self._renderSavedViews();
        self.renderWorkPackagesList(data.work_packages);

        var layers = (data.layers && data.layers.length) ? data.layers.slice() : [];
        if (!layers.length && data.model_url) {
          layers = [{
            id: 'model', title: data.title || 'Model', kind: 'mesh',
            format: data.model_format, url: data.model_url, visible: true,
            conversion: data.conversion, file_size: data.file_size
          }];
        }
        self._startLayerLoading(layers);
      })
      .catch(function(err) {
        console.error('[SpatialViewer] API Error:', err);
        self.showLoader('Error loading model configuration: ' + err.message);
      });
  };

  // ---- Multi-layer loading (IFC / mesh / point cloud / splat) -----------

  // " \u201cLayer name\u201d" suffix for loader messages ('' outside layer loading).
  SpatialViewerApp.prototype._loaderName = function() {
    return this._loadingLayerTitle ? ' \u201c' + this._loadingLayerTitle + '\u201d' : '';
  };

  SpatialViewerApp.prototype._startLayerLoading = function(layers) {
    var self = this;
    // An IFC layer that coexists with non-IFC layers is shown Z-up like them
    // (see onModelLoaded); an IFC-only model keeps the glTF Y-up convention.
    this._ifcSharesFrameWithScans =
      layers.some(function(l) { return l.kind === 'ifc'; }) &&
      layers.some(function(l) { return l.kind && l.kind !== 'ifc'; });
    // The currently hovered mesh part (if any) is about to be torn down
    // with the rest of the old layer -- drop the hover state (and its
    // cloned material / halo mesh) before that happens, not after.
    this._clearHoverEffects();
    if (!this.layersRoot) { this.layersRoot = new THREE.Group(); this.scene.add(this.layersRoot); }
    while (this.layersRoot.children.length) this.layersRoot.remove(this.layersRoot.children[0]);

    this.layerGroups = {};
    this.layerMeta = {};
    this.layerError = {};
    // Each true-splat layer may own a background sort worker (see
    // SplatRenderer) -- terminate them before dropping the references, or
    // reloading layers repeatedly leaks one Worker thread per previous load.
    (this._splatRenderers || []).forEach(function(s) { if (s._worker) s._worker.terminate(); });
    this._splatRenderers = [];
    (this._pointLODs || []).forEach(function(l) { try { l.dispose(); } catch (e) {} });
    this._pointLODs = [];
    this._allLayerMeshes = [];
    this.modelMeshObjects = [];
    this._loadingLayerId = null;
    this._framed = false;
    this._layerTotal = layers.length;
    this._layerIndex = 0;
    layers.forEach(function(l) { self.layerMeta[l.id] = l; });
    // Display order (object keys can't carry it: integer-like ids sort numerically).
    this._layerOrder = layers.map(function(l) { return String(l.id); });

    var heavyMb = parseInt(this.container.dataset.heavyModelMb, 10) || 40;
    var maxSize = 0;
    layers.forEach(function(l) { if (l.file_size > maxSize) maxSize = l.file_size; });
    if (maxSize) this.heavyMode = maxSize >= heavyMb * 1048576;

    // Load in reference order: the first layer loaded is the one the camera,
    // orbit centre, bounding box and tool scale are framed on, so LiDAR comes
    // first, then IFC / photogrammetry, and Gaussian splats last (they only
    // frame the view when nothing else could).
    var rank = function(k) { return k === 'pointcloud' ? 0 : (k === 'ifc' || k === 'mesh') ? 1 : 2; };
    this._layerQueue = layers.filter(function(l) { return !!l.url; })
      .map(function(l, i) { return { l: l, i: i }; })
      .sort(function(a, b) { return (rank(a.l.kind) - rank(b.l.kind)) || (a.i - b.i); })
      .map(function(x) { return x.l; });
    if (!this._layerQueue.length) {
      this.showLoader('This model has no uploaded files yet — add layers from the model edit page.');
      setTimeout(function() { self.hideLoader(); self.createDemoModel(); }, 3500);
      this._buildLayerPanel();
      return;
    }
    this._layerProgress = {};
    this._prefetchLayers(this._layerQueue);
    this._loadNextLayer();
  };

  SpatialViewerApp.prototype._loadNextLayer = function() {
    var self = this;
    clearTimeout(this._layerWatchdog);

    if (!this._layerQueue || !this._layerQueue.length) {
      this._loadingLayerId = null;
      this._prefetched = {};
      if (this._pfWorker) { try { this._pfWorker.terminate(); } catch (e) {} this._pfWorker = null; }
      // fitToView / bbox helpers operate on the whole stack from here on.
      this.modelObject = this.layersRoot;
      this.hideLoader();
      this._buildLayerPanel();
      if (this._embedMode) this._initEmbed();
      var errs = Object.keys(this.layerError || {});
      if (errs.length) {
        this.showTooltip(errs.length + ' layer(s) could not be loaded — see the console.');
      }
      return;
    }

    var l = this._layerQueue.shift();
    this._loadingLayerId = l.id;
    this._loadingLayerTitle = l.title || String(l.id);
    this._layerIndex++;
    this.showLoader('Loading layer ' + this._layerIndex + '/' + this._layerTotal + ': ' + (l.title || l.id) + '…');

    var conv = l.conversion;
    if (conv && conv.status === 'error') {
      console.warn('[SpatialViewer] layer', l.id, 'conversion error:', conv.message);
      this.layerError[l.id] = 'conversion: ' + (conv.message || 'failed');
      this._layerProg(l.id, { state: 'error' });
      return this._loadNextLayer();
    }

    // Last-resort watchdog: real download/convert/parse failures short-circuit
    // via _layerLoadFailed, so this only catches a genuine hang. Kept long
    // because a big server-side conversion can legitimately run for minutes.
    this._layerWatchdog = setTimeout(function() {
      if (self._loadingLayerId !== l.id) return;
      console.warn('[SpatialViewer] layer', l.id, 'timed out');
      self.layerError[l.id] = 'timed out';
      self.modelObject = null;
      self._loadNextLayer();
    }, 1200000);

    this._loadingLayerKind = l.kind;
    var pg = (this._layerProgress || {})[l.id];
    if (!pg || pg.state !== 'download') this._layerProg(l.id, { state: l.octree_url && l.kind === 'pointcloud' ? 'streaming' : 'processing' });
    // Big point clouds stream from a server-built octree (25_point_lod.js);
    // it falls back to the plain full download if that isn't available.
    if (l.kind === 'pointcloud' && l.octree_url) { this._loadPointOctree(l); return; }
    this.load3DModel(l.url, l.format);
  };

  // Layers the view is referenced to (camera framing, orbit centre, bounding
  // box): the LiDAR point cloud(s) if there are any, else IFC / photogrammetry,
  // never the Gaussian splat unless it is all there is.
  SpatialViewerApp.prototype._referenceGroups = function() {
    var self = this;
    var kinds = [['pointcloud'], ['ifc', 'mesh'], ['splat']];
    for (var i = 0; i < kinds.length; i++) {
      var out = [];
      Object.keys(this.layerGroups || {}).forEach(function(id) {
        var m = self.layerMeta && self.layerMeta[id];
        if (m && kinds[i].indexOf(m.kind) !== -1) out.push(self.layerGroups[id]);
      });
      if (out.length) return out;
    }
    return [];
  };

  SpatialViewerApp.prototype._referenceBox = function() {
    var self = this;
    var box = new THREE.Box3();
    this._referenceGroups().forEach(function(g) {
      var b = self._robustObjectBox(g);
      if (!b.isEmpty()) box.union(b);
    });
    return box;
  };

  // Called at the end of onModelLoaded: move the just-loaded object into its
  // own toggleable layer group and start the next layer.
  SpatialViewerApp.prototype._harvestLayer = function(id) {
    clearTimeout(this._layerWatchdog);
    var obj = this.modelObject;
    if (obj) {
      if (obj.parent) obj.parent.remove(obj);
      var g = new THREE.Group();
      g.name = 'layer:' + id;
      var meta = this.layerMeta[id] || {};
      g.visible = false;
      g.add(obj);
      this.layersRoot.add(g);
      this.layerGroups[id] = g;
      // A live reference (not a snapshot flag) to this layer's group, so
      // _raycastAt can tell a hidden layer's surface apart from a visible
      // one's without needing to invalidate anything when visibility is
      // later toggled -- see that function for why this matters (THREE's
      // Raycaster.intersectObjects does NOT check .visible on the objects
      // it's handed directly, only during normal rendering).
      // layerKind drives the hover glow's IFC-only gating (see
      // _updateHoverEffects) -- photogrammetry/scan meshes (kind "mesh") are
      // one big fused surface with no discrete "parts" to highlight, unlike
      // an IFC conversion's per-element meshes (kind "ifc").
      (this._lastLayerMeshes || []).forEach(function(m) {
        m.userData.layerVisibilityGroup = g;
        m.userData.layerKind = meta.kind;
      });
      this._allLayerMeshes = (this._allLayerMeshes || []).concat(this._lastLayerMeshes || []);
      this.modelMeshObjects = this._allLayerMeshes;
      this._applyLayerOptions(id);
      this._layerProg(id, { state: 'done' });
      if (meta.visible !== false) this._fadeLayer(id, true, 320);
    }
    this.modelObject = null;
    this._loadNextLayer();
  };

  // Terminal parse failure: advance the layer queue if loading layered,
  // otherwise just show the message on the loader.
  SpatialViewerApp.prototype._parseError = function(msg) {
    if (this._loadingLayerId != null) this._layerLoadFailed(msg);
    else this.showLoader(msg);
  };

  // A layer failed to download / convert / parse: note it and move on so one
  // bad layer never blocks the rest of the stack.
  SpatialViewerApp.prototype._layerLoadFailed = function(msg) {
    var id = this._loadingLayerId;
    console.warn('[SpatialViewer] layer', id, 'failed:', msg);
    if (id == null) { this.showLoader('Error loading model: ' + msg); return; }
    this.layerError = this.layerError || {};
    this.layerError[id] = msg;
    this._layerProg(id, { state: 'error' });
    this.modelObject = null;
    clearTimeout(this._layerWatchdog);
    this._loadNextLayer();
  };

  // Cross-fade a layer in / out (opacity ramp on all its materials).
  SpatialViewerApp.prototype._fadeLayer = function(id, show, ms) {
    var self = this;
    var g = this.layerGroups && this.layerGroups[id];
    if (!g) return;
    ms = ms || 380;
    this._layerFades = this._layerFades || {};

    var mats = [];
    g.traverse(function(o) {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m) {
        if (!m || mats.indexOf(m) !== -1) return;
        if (!m.userData._fadeOrig) {
          m.userData._fadeOrig = {
            opacity: (m.opacity == null ? 1 : m.opacity),
            transparent: !!m.transparent,
            depthWrite: (m.depthWrite !== false)
          };
        }
        m.userData._layerOp = self._layerOpt(id).opacity;
        mats.push(m);
      });
    });
    if (!mats.length) { g.visible = !!show; return; }

    mats.forEach(function(m) { m.transparent = true; m.depthWrite = false; });
    if (show) { g.visible = true; mats.forEach(function(m) { m.opacity = 0; }); }

    this._layerFades[id] = {
      group: g, mats: mats, show: !!show, ms: ms,
      start: (window.performance && performance.now) ? performance.now() : Date.now()
    };
  };

  SpatialViewerApp.prototype._tickLayerFades = function() {
    var fades = this._layerFades;
    if (!fades) return;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    Object.keys(fades).forEach(function(id) {
      var f = fades[id];
      var t = Math.min(1, (now - f.start) / f.ms);
      var e = t * t * (3 - 2 * t);            // smoothstep
      var k = f.show ? e : (1 - e);
      f.mats.forEach(function(m) {
        var lo = (m.userData._layerOp == null) ? 1 : m.userData._layerOp;
        m.opacity = ((m.userData._fadeOrig && m.userData._fadeOrig.opacity) || 1) * lo * k;
      });
      if (t >= 1) {
        f.mats.forEach(function(m) {
          var o = m.userData._fadeOrig || { opacity: 1, transparent: false, depthWrite: true };
          var lo = (m.userData._layerOp == null) ? 1 : m.userData._layerOp;
          m.opacity = o.opacity * lo;
          m.transparent = o.transparent || lo < 1;
          m.depthWrite = o.depthWrite && lo >= 1;
        });
        if (!f.show) f.group.visible = false;
        delete fades[id];
      }
    });
  };

  // Embedded (iframe) mode: the toolbar/panels are hidden by CSS. Spot-light the
  // annotation the share link points at and offer a single "reset view" button.
  SpatialViewerApp.prototype._initEmbed = function() {
    var self = this;
    var anns = (this.projectData && this.projectData.annotations) || [];
    if (anns.length) this.showAnnotationSurface(anns[0]);
    if (this._embedHomeBtn || !this.viewport) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sv-embed-home';
    btn.title = 'Reset view';
    btn.textContent = '\u2302';
    btn.addEventListener('click', function() {
      if (!self._homeView) return;
      self.camera.position.copy(self._homeView.position);
      self.controls.target.copy(self._homeView.target);
      self.controls.update();
    });
    this.viewport.appendChild(btn);
    this._embedHomeBtn = btn;
  };

  SpatialViewerApp.prototype.setLayerVisible = function(id, visible) {
    var self = this;
    if (this.layerMeta[id]) this.layerMeta[id].visible = !!visible;
    // A heavy mesh layer shown for the first time has to build its picking
    // structure and upload textures, which blocks the page for a while: say so
    // and do it up front instead of on the first mouse press.
    if (visible && this._layerNeedsWarmup(id)) {
      this._warmLayer(id, function() {
        if (self.layerMeta[id] && self.layerMeta[id].visible) self._fadeLayer(id, true);
      });
      return;
    }
    this._fadeLayer(id, !!visible);
    // Session-only: the layers shown when the viewer opens are set per layer
    // on the model's edit page ("Visible by default").
  };

  // Turns a layer row into an inline editor (title, delete). Persisted through
  // SpatialLayersController#update / #destroy.
  // Moves a real layer one step up/down the list and saves the new order
  // (spatial_layers.position = index among the real layers).
  SpatialViewerApp.prototype._moveLayer = function(id, dir) {
    var self = this;
    var real = (this._layerOrder || []).filter(function(i) { return i !== 'model' && self.layerMeta[i]; });
    var from = real.indexOf(String(id)), to = from + dir;
    if (from < 0 || to < 0 || to >= real.length) return;
    var other = real[to];
    real[to] = real[from]; real[from] = other;
    // Keep the legacy "model" entry (if any) first, then the real layers.
    this._layerOrder = (this.layerMeta['model'] ? ['model'] : []).concat(real);
    this._buildLayerPanel();

    var chain = Promise.resolve();
    real.forEach(function(lid, idx) {
      if (self.layerMeta[lid].position === idx) return;
      self.layerMeta[lid].position = idx;
      var url = self.apiUrl.replace('/api_data', '/spatial_layers/' + lid);
      chain = chain.then(function() {
        return fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': self.csrfToken },
          body: JSON.stringify({ spatial_layer: { position: idx } })
        });
      });
    });
    chain.catch(function() { self.showTooltip('Could not save the layer order.'); });
  };

  SpatialViewerApp.prototype._editLayerRow = function(id, row) {
    var self = this;
    var m = this.layerMeta[id];
    var base = this.apiUrl.replace('/api_data', '/spatial_layers/' + id);
    var send = function(method, body) {
      return fetch(base, {
        method: method,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': self.csrfToken },
        body: body ? JSON.stringify(body) : null
      }).then(function(r) { return r.json().catch(function() { return {}; }); });
    };

    row.innerHTML = '';
    row.classList.add('layer-row-editing');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input layer-row-input';
    input.value = m.title || '';
    input.maxLength = 255;

    var mkBtn = function(label, cls, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'button -small ' + (cls || '');
      b.textContent = label;
      if (title) b.title = title;
      return b;
    };
    var save = mkBtn('Save', '-primary');
    var cancel = mkBtn('Cancel');
    var del = mkBtn('Delete', 'text-danger', 'Delete this layer and its file');

    save.addEventListener('click', function() {
      var title = input.value.trim();
      if (!title) { input.focus(); return; }
      save.disabled = true;
      send('PATCH', { spatial_layer: { title: title } }).then(function(res) {
        if (!res || !res.success) { save.disabled = false; alert('Save failed: ' + ((res && res.errors) || ['unknown error']).join(', ')); return; }
        m.title = res.layer ? res.layer.title : title;
        self._buildLayerPanel();
      }).catch(function(err) { save.disabled = false; alert('Network error: ' + err); });
    });
    cancel.addEventListener('click', function() { self._buildLayerPanel(); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') save.click();
      else if (e.key === 'Escape') cancel.click();
    });
    del.addEventListener('click', function() {
      if (!window.confirm('Delete layer "' + (m.title || id) + '" and its file? This cannot be undone.')) return;
      del.disabled = true;
      send('DELETE').then(function(res) {
        if (!res || !res.success) { del.disabled = false; alert('Delete failed.'); return; }
        self.loadProjectData(); // reload the remaining layers
      }).catch(function(err) { del.disabled = false; alert('Network error: ' + err); });
    });

    var actions = document.createElement('div');
    actions.className = 'layer-row-actions';
    actions.appendChild(save); actions.appendChild(cancel); actions.appendChild(del);
    row.appendChild(input); row.appendChild(actions);
    input.focus(); input.select();
  };

  // ---- Per-layer display options (opacity, wireframe) ---------------------
  SpatialViewerApp.prototype._layerOpt = function(id) {
    this._layerOpts = this._layerOpts || {};
    if (!this._layerOpts[id]) {
      var mx = this.layerMeta && this.layerMeta[id] && Number(this.layerMeta[id].exposure);
      this._layerOpts[id] = { opacity: 1, wireframe: false, exposure: (mx > 0 ? mx : 1) };
    }
    return this._layerOpts[id];
  };

  // The id of the layer an object belongs to (its ancestor group "layer:<id>").
  SpatialViewerApp.prototype._layerIdOf = function(obj) {
    for (var o = obj; o; o = o.parent) {
      if (o.name && o.name.indexOf('layer:') === 0) return o.name.slice(6);
    }
    return null;
  };

  SpatialViewerApp.prototype._applyLayerOptions = function(id) {
    var g = this.layerGroups && this.layerGroups[id];
    if (!g) return;
    var o = this._layerOpt(id);
    var fading = !!(this._layerFades && this._layerFades[id]);
    g.traverse(function(obj) {
      if (!obj.material) return;
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(function(m) {
        if (!m) return;
        if (!m.userData._fadeOrig) {
          m.userData._fadeOrig = {
            opacity: (m.opacity == null ? 1 : m.opacity),
            transparent: !!m.transparent,
            depthWrite: (m.depthWrite !== false)
          };
        }
        m.userData._layerOp = o.opacity;
        // Per-layer exposure: scale the material colour (lit meshes, points).
        // Splat shaders take it from their `exposure` uniform instead.
        if (m.color && !m.isShaderMaterial) {
          if (!m.userData._expOrig) m.userData._expOrig = m.color.clone();
          m.color.copy(m.userData._expOrig).multiplyScalar(o.exposure == null ? 1 : o.exposure);
        }
        // Splat/shader materials draw their own quads; wireframe is for meshes.
        if (!m.isShaderMaterial && 'wireframe' in m) m.wireframe = !!o.wireframe;
        if (!fading) {
          var f = m.userData._fadeOrig;
          m.opacity = f.opacity * o.opacity;
          m.transparent = f.transparent || o.opacity < 1;
          m.depthWrite = f.depthWrite && o.opacity >= 1;
          m.needsUpdate = true;
        }
      });
    });
    // Splat layers take their opacity from a uniform.
    if (this._applySplatSettings) this._applySplatSettings();
  };

  // Remember the last exposure used on a layer (managers only; others keep it
  // for the session). Debounced so dragging the slider sends one request.
  SpatialViewerApp.prototype._saveLayerExposure = function(id) {
    var self = this;
    if (id === 'model' || this._embedMode || !(this.projectData && this.projectData.can_manage)) return;
    this._expTimers = this._expTimers || {};
    clearTimeout(this._expTimers[id]);
    this._expTimers[id] = setTimeout(function() {
      var url = self.apiUrl.replace('/api_data', '/spatial_layers/' + id);
      fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': self.csrfToken },
        body: JSON.stringify({ spatial_layer: { exposure: self._layerOpt(id).exposure } })
      }).catch(function() {});
    }, 700);
  };

  SpatialViewerApp.prototype._applyAllLayerOptions = function() {
    var self = this;
    Object.keys(this.layerGroups || {}).forEach(function(id) { self._applyLayerOptions(id); });
  };

  SpatialViewerApp.prototype._buildLayerPanel = function() {
    var self = this;
    var panel = document.getElementById('layerPanel'); // now a tab-content div, see show.html.erb
    var list = document.getElementById('layerList');
    var btn = document.getElementById('tabBtnLayers'); // the tab button, not a toolbar button anymore
    if (!panel || !list) return;

    var ids = Object.keys(this.layerMeta || {});
    if (this._layerOrder) {
      var ordered = this._layerOrder.filter(function(i) { return self.layerMeta[i]; });
      ids.forEach(function(i) { if (ordered.indexOf(i) < 0) ordered.push(i); });
      ids = ordered;
    }
    var canManage = !!(this.projectData && this.projectData.can_manage) && !this._embedMode;
    // The tab also carries the general display options, so it is always shown.
    if (btn) btn.style.display = '';

    // Park the per-kind option blocks before the list is rebuilt (they live
    // inside layer rows while in use and would be destroyed with them).
    var stash = document.getElementById('renderStash');
    var kindBlock = {};
    ['points', 'splat'].forEach(function(k) {
      var n = document.querySelector('[data-render-section="' + k + '"]');
      if (n) { kindBlock[k] = n; if (stash && n.parentNode !== stash) stash.appendChild(n); }
    });
    var kindOwner = {}; // block kind -> first layer id of that kind
    var kindCount = { points: 0, splat: 0 };
    ids.forEach(function(i) {
      var k = (self.layerMeta[i] || {}).kind === 'pointcloud' ? 'points' : ((self.layerMeta[i] || {}).kind === 'splat' ? 'splat' : null);
      if (!k) return;
      kindCount[k]++;
      if (!kindOwner[k]) kindOwner[k] = i;
    });
    this._layerExpanded = this._layerExpanded || {};

    list.innerHTML = '';
    ids.forEach(function(id) {
      var m = self.layerMeta[id];
      var item = document.createElement('div');
      item.className = 'layer-item';
      var row = document.createElement('div');
      row.className = 'layer-row';

      // Disclosure triangle: right = options hidden, down = shown.
      var tri = document.createElement('button');
      tri.type = 'button';
      tri.className = 'layer-row-toggle';
      tri.title = 'Display options';
      var opts = document.createElement('div');
      opts.className = 'layer-options';
      var setOpen = function(open) {
        self._layerExpanded[id] = open;
        tri.textContent = open ? '\u25BE' : '\u25B8';
        tri.setAttribute('aria-expanded', open ? 'true' : 'false');
        opts.style.display = open ? '' : 'none';
      };
      tri.addEventListener('click', function() { setOpen(!self._layerExpanded[id]); });
      row.appendChild(tri);
      // Layer type icon (photogrammetry / LiDAR / IFC / Gaussian splat).
      var kindIcon = document.createElement('i');
      kindIcon.className = 'sv-kind-icon -' + (m.kind || 'mesh');
      var kindLabels = { mesh: 'Photogrammetry / mesh', pointcloud: 'LiDAR point cloud', ifc: 'IFC', splat: 'Gaussian splat' };
      kindIcon.title = kindLabels[m.kind] || m.kind || '';
      row.appendChild(kindIcon);

      var span = document.createElement('span');
      span.className = 'layer-row-name';
      span.textContent = (m.title || id);

      var tag = document.createElement('em');
      tag.textContent = self.layerError[id] ? ('— ' + self.layerError[id])
        : (m.kind || '') + (m.source_format ? ' · ' + String(m.source_format).toUpperCase() : '');

      var eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.className = 'layer-row-eye';
      eyeBtn.disabled = !self.layerGroups[id];
      var setEyeState = function(visible) {
        eyeBtn.title = visible ? 'Hide layer' : 'Show layer';
        eyeBtn.innerHTML = '<i class="' + (visible ? 'icon-watched' : 'icon-unwatched') + '"></i>';
      };
      setEyeState(m.visible !== false && !self.layerError[id]);
      eyeBtn.addEventListener('click', function() {
        var next = !(m.visible !== false);
        self.setLayerVisible(id, next); // also updates self.layerMeta[id].visible (== m) synchronously
        setEyeState(next);
      });

      row.appendChild(span); row.appendChild(tag);
      // Edit (rename / delete) -- real layers only; the legacy "model" file
      // takes its title from the model itself.
      if (canManage && id !== 'model') {
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'layer-row-eye';
        editBtn.title = 'Edit layer';
        editBtn.innerHTML = '<i class="icon-edit"></i>';
        editBtn.addEventListener('click', function() { self._editLayerRow(id, row); });
        var mkMove = function(dir) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'layer-row-eye';
          b.title = dir < 0 ? 'Move up' : 'Move down';
          b.textContent = dir < 0 ? '\u25B2' : '\u25BC';
          b.style.fontSize = '0.7rem';
          b.addEventListener('click', function() { self._moveLayer(id, dir); });
          return b;
        };
        row.appendChild(mkMove(-1));
        row.appendChild(mkMove(1));
        row.appendChild(editBtn);
      }
      row.appendChild(eyeBtn);
      item.appendChild(row);

      // ---- display options of this layer ----
      var lo = self._layerOpt(id);
      var opRow = document.createElement('label');
      opRow.className = 'render-row -range';
      var opLabel = document.createElement('span');
      opLabel.appendChild(document.createTextNode('Opacity '));
      var opVal = document.createElement('b');
      opVal.textContent = Math.round(lo.opacity * 100) + '%';
      opLabel.appendChild(opVal);
      var opIn = document.createElement('input');
      opIn.type = 'range'; opIn.min = '0.05'; opIn.max = '1'; opIn.step = '0.05'; opIn.value = String(lo.opacity);
      opIn.addEventListener('input', function() {
        lo.opacity = parseFloat(opIn.value);
        opVal.textContent = Math.round(lo.opacity * 100) + '%';
        self._applyLayerOptions(id);
      });
      opRow.appendChild(opLabel); opRow.appendChild(opIn);
      opts.appendChild(opRow);

      var exRow = document.createElement('label');
      exRow.className = 'render-row -range';
      var exLabel = document.createElement('span');
      exLabel.appendChild(document.createTextNode('Exposure '));
      var exVal = document.createElement('b');
      exVal.textContent = Number(lo.exposure).toFixed(2);
      exLabel.appendChild(exVal);
      var exIn = document.createElement('input');
      exIn.type = 'range'; exIn.min = '0.2'; exIn.max = '2.5'; exIn.step = '0.05'; exIn.value = String(lo.exposure);
      exIn.addEventListener('input', function() {
        lo.exposure = parseFloat(exIn.value);
        exVal.textContent = lo.exposure.toFixed(2);
        m.exposure = lo.exposure;
        self._applyLayerOptions(id);
        self._saveLayerExposure(id);
      });
      exRow.appendChild(exLabel); exRow.appendChild(exIn);
      opts.appendChild(exRow);

      if (m.kind === 'mesh' || m.kind === 'ifc') {
        var wfRow = document.createElement('label');
        wfRow.className = 'render-row -check';
        var wfIn = document.createElement('input');
        wfIn.type = 'checkbox'; wfIn.checked = !!lo.wireframe;
        wfIn.addEventListener('change', function() {
          lo.wireframe = wfIn.checked;
          self._applyLayerOptions(id);
        });
        wfRow.appendChild(wfIn);
        wfRow.appendChild(document.createTextNode(' Wireframe'));
        opts.appendChild(wfRow);
      }

      var bk = m.kind === 'pointcloud' ? 'points' : (m.kind === 'splat' ? 'splat' : null);
      if (bk && kindOwner[bk] === id && kindBlock[bk]) {
        opts.appendChild(kindBlock[bk]);
        var t = kindBlock[bk].querySelector('.render-section-title');
        if (t) t.style.display = 'none';
        var note = kindBlock[bk].querySelector('.layer-kind-note');
        if (!note) {
          note = document.createElement('p');
          note.className = 'layer-kind-note text-muted small';
          kindBlock[bk].insertBefore(note, kindBlock[bk].firstChild);
        }
        note.textContent = kindCount[bk] > 1 ? 'These settings apply to all layers of this type.' : '';
        note.style.display = kindCount[bk] > 1 ? '' : 'none';
      }
      if (m.kind === 'ifc' && id !== 'model' && !self._embedMode) {
        var ifcHost = document.createElement('div');
        ifcHost.className = 'ifc-tree-host';
        opts.appendChild(ifcHost);
        // Fetched the first time the layer is expanded.
        var loadTree = function() {
          if (ifcHost.dataset.loaded) return;
          ifcHost.dataset.loaded = '1';
          self._buildIfcTree(id, ifcHost);
        };
        tri.addEventListener('click', function() { if (self._layerExpanded[id]) loadTree(); });
        if (self._layerExpanded[id]) loadTree();
      }
      item.appendChild(opts);
      setOpen(!!self._layerExpanded[id]);
      list.appendChild(item);
    });
  };

