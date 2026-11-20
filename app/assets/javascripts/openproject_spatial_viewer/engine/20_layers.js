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

    this._layerQueue = layers.filter(function(l) { return !!l.url; });
    if (!this._layerQueue.length) {
      this.showLoader('This model has no uploaded files yet — add layers from the model edit page.');
      setTimeout(function() { self.hideLoader(); self.createDemoModel(); }, 3500);
      this._buildLayerPanel();
      return;
    }
    this._loadNextLayer();
  };

  SpatialViewerApp.prototype._loadNextLayer = function() {
    var self = this;
    clearTimeout(this._layerWatchdog);

    if (!this._layerQueue || !this._layerQueue.length) {
      this._loadingLayerId = null;
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
    this._layerIndex++;
    this.showLoader('Loading layer ' + this._layerIndex + '/' + this._layerTotal + ': ' + (l.title || l.id) + '…');

    var conv = l.conversion;
    if (conv && conv.status === 'error') {
      console.warn('[SpatialViewer] layer', l.id, 'conversion error:', conv.message);
      this.layerError[l.id] = 'conversion: ' + (conv.message || 'failed');
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
    // Big point clouds stream from a server-built octree (25_point_lod.js);
    // it falls back to the plain full download if that isn't available.
    if (l.kind === 'pointcloud' && l.octree_url) { this._loadPointOctree(l); return; }
    this.load3DModel(l.url, l.format);
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
    this.modelObject = null;
    clearTimeout(this._layerWatchdog);
    this._loadNextLayer();
  };

  // Cross-fade a layer in / out (opacity ramp on all its materials).
  SpatialViewerApp.prototype._fadeLayer = function(id, show, ms) {
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
        m.opacity = ((m.userData._fadeOrig && m.userData._fadeOrig.opacity) || 1) * k;
      });
      if (t >= 1) {
        f.mats.forEach(function(m) {
          var o = m.userData._fadeOrig || { opacity: 1, transparent: false, depthWrite: true };
          m.opacity = o.opacity;
          m.transparent = o.transparent;
          m.depthWrite = o.depthWrite;
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
    this._fadeLayer(id, !!visible);
    if (this.layerMeta[id]) this.layerMeta[id].visible = !!visible;
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
    if (ids.length <= 1 && !(canManage && ids.length && ids[0] !== 'model')) { if (btn) btn.style.display = 'none'; return; }
    if (btn) btn.style.display = '';

    list.innerHTML = '';
    ids.forEach(function(id) {
      var m = self.layerMeta[id];
      var row = document.createElement('div');
      row.className = 'layer-row';

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
      list.appendChild(row);
    });
  };

