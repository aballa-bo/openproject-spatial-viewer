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
    this._allLayerMeshes = [];
    this.modelMeshObjects = [];
    this._loadingLayerId = null;
    this._framed = false;
    this._layerTotal = layers.length;
    this._layerIndex = 0;
    layers.forEach(function(l) { self.layerMeta[l.id] = l; });

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

  SpatialViewerApp.prototype.setLayerVisible = function(id, visible) {
    this._fadeLayer(id, !!visible);
    if (this.layerMeta[id]) this.layerMeta[id].visible = !!visible;
    // Persist for real layers (not the legacy "model" file).
    if (id !== 'model' && this.apiUrl) {
      var base = this.apiUrl.replace('/api_data', '/spatial_layers/' + id);
      fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
        body: JSON.stringify({ spatial_layer: { visible: !!visible } })
      }).catch(function() {});
    }
  };

  SpatialViewerApp.prototype._buildLayerPanel = function() {
    var self = this;
    var panel = document.getElementById('layerPanel'); // now a tab-content div, see show.html.erb
    var list = document.getElementById('layerList');
    var btn = document.getElementById('tabBtnLayers'); // the tab button, not a toolbar button anymore
    if (!panel || !list) return;

    var ids = Object.keys(this.layerMeta || {});
    if (ids.length <= 1) { if (btn) btn.style.display = 'none'; return; }
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

      row.appendChild(span); row.appendChild(tag); row.appendChild(eyeBtn);
      list.appendChild(row);
    });
  };

