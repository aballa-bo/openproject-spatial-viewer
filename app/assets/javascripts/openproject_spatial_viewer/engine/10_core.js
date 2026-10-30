  // ===================================================================
  // SpatialViewerApp
  // ===================================================================

  function SpatialViewerApp(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.apiUrl = this.container.dataset.apiUrl;
    this.csrfToken = this.container.dataset.csrfToken;
    // { "<type_id>": [{id, name, format, required, multi_value, options}, ...], ... }
    // -- custom fields are enabled per (project, type) in OpenProject, see
    // SpatialModelsController#show's @custom_fields_by_type.
    try { this.customFieldsByType = JSON.parse(this.container.dataset.customFieldsByType || '{}'); }
    catch (e) { this.customFieldsByType = {}; }
    this.canvas = document.getElementById('threeCanvas');
    this.viewport = document.getElementById('spatialViewport');

    if (!this.canvas || !this.viewport) {
      console.error('[SpatialViewer] Missing canvas or viewport element');
      return;
    }

    this.currentTool = 'orbit';
    this.activeColor = '#3b82f6';
    this.isDrawing = false;
    this.currentDrawingPoints = [];
    this.currentDrawingLine = null;
    this.measureStartPoint = null;
    this.activeAnnotations = [];
    this.modelMeshObjects = [];
    this._animFrameId = null;

    try {
      this.initThree();
      this.initEvents();
      this.initUI();
      this.loadProjectData();
    } catch (err) {
      // Release the WebGL context of a half-built viewer so a retry / the next
      // page does not inherit a leaked context (browsers cap them per process).
      try {
        if (this.renderer) {
          this.renderer.setAnimationLoop(null);
          this.renderer.dispose();
          this.renderer.forceContextLoss();
        }
        if (this.controls) this.controls.dispose();
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        if (this._navKeyDown) window.removeEventListener('keydown', this._navKeyDown);
        if (this._navKeyUp) window.removeEventListener('keyup', this._navKeyUp);
        if (this._navBlur) window.removeEventListener('blur', this._navBlur);
      } catch (ignore) {}
      throw err;
    }
  }

  // ---- Render-quality settings ------------------------------------------
  // User-tweakable via the "Render" panel; persisted per browser.
  var RENDER_DEFAULTS = {
    shadows: 'soft',      // 'off' | 'hard' | 'soft'
    tone: 'aces',         // 'aces' | 'reinhard' | 'linear' | 'none'
    background: 'light',  // 'light' | 'dark' | 'studio'
    exposure: 1.0,        // tone-mapping exposure
    light: 1.0,           // multiplier on the scene lights
    env: true,            // image-based environment light + reflections
    hiDpi: true,          // render at devicePixelRatio (vs 1)
    wireframe: false,
    grid: true
  };
  var RENDER_STORE_KEY = 'spatialViewer.render';

  var BG_COLORS = { light: 0xeef1f4, dark: 0x0f172a, studio: 0x15181e };

  // Wire three-mesh-bvh onto THREE (once) so surface raycasts stay fast on big
  // meshes. No-op if the library did not load.
  function installBVH() {
    if (typeof THREE === 'undefined' || THREE.__bvhInstalled || !window.MeshBVHLib) return;
    try {
      THREE.BufferGeometry.prototype.computeBoundsTree = window.MeshBVHLib.computeBoundsTree;
      THREE.BufferGeometry.prototype.disposeBoundsTree = window.MeshBVHLib.disposeBoundsTree;
      THREE.Mesh.prototype.raycast = window.MeshBVHLib.acceleratedRaycast;
      THREE.__bvhInstalled = true;
      console.log('[SpatialViewer] three-mesh-bvh installed');
    } catch (e) {
      console.warn('[SpatialViewer] BVH install failed:', e);
    }
  }

  // If the hook did not emit the <script> (e.g. only the JS was redeployed),
  // pull three-mesh-bvh in ourselves so big-model raycasts still get accelerated.
  function ensureBVHLibLoaded() {
    if (window.MeshBVHLib || window.__bvhLibLoading) { installBVH(); return; }
    window.__bvhLibLoading = true;
    var s = document.createElement('script');
    s.src = '/assets/openproject_spatial_viewer/vendor/mesh-bvh.js';
    s.onload = function() { installBVH(); };
    s.onerror = function() { console.warn('[SpatialViewer] could not load mesh-bvh.js'); };
    (document.head || document.documentElement).appendChild(s);
  }

  // Create the WebGLRenderer, degrading the options step by step. Browsers cap
  // the number of live WebGL contexts (~16) per process; once that ceiling is
  // hit (usually after many failed viewer inits or a GPU-process crash) every
  // constructor call throws "Error creating WebGL context" until the *tab* is
  // closed — a reload is not enough. Throw a clear, actionable message then.
  function createWebGLRenderer(canvas) {
    var attempts = [
      { canvas: canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' },
      { canvas: canvas, antialias: true, preserveDrawingBuffer: true },
      { canvas: canvas, antialias: false, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false },
      { canvas: canvas, antialias: false }
    ];
    var lastErr;
    for (var i = 0; i < attempts.length; i++) {
      try { return new THREE.WebGLRenderer(attempts[i]); }
      catch (e) { lastErr = e; }
    }
    var probe = document.createElement('canvas');
    var gl = probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl');
    var hint = gl
      ? 'Your browser hit its limit of active 3D contexts. Close every other tab that has a 3D viewer open (and this one), then reopen the model. Restarting the browser also clears it.'
      : 'WebGL is unavailable or disabled in this browser. Check chrome://gpu, enable hardware acceleration, or try another browser.';
    var err = new Error('WebGL context could not be created. ' + hint);
    err.webglFatal = true;
    err.cause = lastErr;
    throw err;
  }

  SpatialViewerApp.prototype.initThree = function() {
    installBVH();
    ensureBVHLibLoaded();
    var width = this.viewport.clientWidth || window.innerWidth;
    var height = this.viewport.clientHeight || (window.innerHeight - 150);

    this.renderSettings = this._loadRenderSettings();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLORS[this.renderSettings.background] || BG_COLORS.light);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    this.camera.position.set(10, 10, 10);

    this.renderer = createWebGLRenderer(this.canvas);
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.localClippingEnabled = true;
    this.renderer.xr.enabled = true; // WebXR / VR headset support
    // Correct colour pipeline for glTF PBR materials (r128 defaults to linear
    // output, which makes textured models look dark / washed out).
    if (THREE.sRGBEncoding != null) this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.physicallyCorrectLights = false;

    // Dolly rig: the camera is parented to a group so we can place the VR
    // "player" near the model when entering immersive mode. Outside VR the
    // dolly stays at the origin, so camera local space == world space and
    // OrbitControls / raycasting behave exactly as before.
    this.xrDolly = new THREE.Group();
    this.xrDolly.add(this.camera);
    this.scene.add(this.xrDolly);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    // The wheel is handled by _onWheel (zoom toward the cursor), not by
    // OrbitControls' dolly-toward-target — that one stalls as the camera nears
    // the target and never actually reaches the surface you're looking at.
    this.controls.enableZoom = false;

    // Scratch vectors + state for WASD / R-F fly navigation (desktop) and
    // thumbstick locomotion (VR) — the two never run in the same frame, so
    // they share the same scratch objects.
    this._navKeys = Object.create(null);
    this._nav = {
      fwd: new THREE.Vector3(), right: new THREE.Vector3(),
      worldUp: new THREE.Vector3(0, 1, 0), move: new THREE.Vector3(),
      xrHead: new THREE.Vector3()
    };
    this._xrTurnArmed = false;
    this._lastFrameT = (window.performance && performance.now) ? performance.now() : Date.now();

    // Base intensities are kept modest: the image-based environment map and
    // tone mapping carry most of the look. The "Light intensity" slider scales
    // all three (see _applyRenderSettings).
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
    this.keyLight.position.set(20, 40, 20);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0x90b0ff, 0.35);
    this.fillLight.position.set(-20, -20, -20);
    this.scene.add(this.fillLight);

    // Soft sky/ground ambient — stands in for an image-based environment
    // (no render-target juggling, works on every GPU). Intensity is driven by
    // the "Environment light" toggle in _applyRenderSettings.
    this.hemiLight = new THREE.HemisphereLight(0xdfe7f2, 0x8d8375, 0.0);
    this.scene.add(this.hemiLight);

    // Invisible plane under the model that only catches shadows.
    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.22 })
    );
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.visible = false;
    this.scene.add(this.shadowCatcher);

    this.gridHelper = new THREE.GridHelper(50, 50, 0xb8c0cc, 0xdbe0e6);
    this.gridHelper.position.y = -0.01;
    this.scene.add(this.gridHelper);

    this.annotationsGroup = new THREE.Group();
    this.scene.add(this.annotationsGroup);
    // Per-frame billboard state for lasso label cards built in
    // renderExisting3DAnnotations -- see _updateAnnotationLabels.
    this._annotationLabels = [];
    this._labelsVisible = true; // toggled by the toolbar's Labels button

    this.tempMarkupGroup = new THREE.Group();
    this.scene.add(this.tempMarkupGroup);

    this.lassoHighlightGroup = new THREE.Group();
    this.scene.add(this.lassoHighlightGroup);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true; // honoured by three-mesh-bvh
    this.mouse = new THREE.Vector2();

    this.clipPlanes = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1000),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), 1000),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), 1000)
    ];

    try { this._applyRenderSettings(); } catch (e) { console.warn('[SpatialViewer] render settings failed:', e); }

    var self = this;
    // setAnimationLoop (not requestAnimationFrame) is required for WebXR:
    // during an immersive session the browser drives the frame timing. The
    // 2nd argument (frame) is only meaningful while presenting -- three.js's
    // XR manager passes the raw XRFrame through to this callback itself
    // (verified against the vendored build, not assumed); AR's hit-test
    // needs it (see _processARFrame/_handleArSelect) and there is no
    // three.js-level equivalent to fetch it separately in this version.
    this.renderer.setAnimationLoop(function(time, frame) {
      var presenting = self.renderer.xr && self.renderer.xr.isPresenting;

      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var dt = Math.min(0.1, (now - self._lastFrameT) / 1000);
      self._lastFrameT = now;
      if (presenting && self._xrMode === 'ar') {
        self._arLastFrame = frame || null;
        self._processARFrame(frame);
      } else if (presenting) {
        self._processXRInput(dt);
      } else {
        self._processNavKeys(dt);
      }
      if (self._layerFades) self._tickLayerFades();
      if (self._splatRenderers && self._splatRenderers.length) {
        var vw = self.viewport.clientWidth || 1, vh = self.viewport.clientHeight || 1;
        var projCam = self.camera;
        // In VR, self.camera's own projection is the flat/mono one -- neither
        // eye actually renders through it. Each eye has its own asymmetric
        // projection matrix and its own framebuffer resolution (can differ
        // from the flat canvas entirely), both needed to size/place splats
        // correctly on screen. Both eyes share effectively the same focal
        // length and resolution in practice (only the asymmetric horizontal
        // offset differs, which this shader doesn't model), so reading just
        // eye 0 and reusing it for both eyes' draws is correct.
        if (presenting && self.renderer.xr && self.renderer.xr.getCamera) {
          var xrCam = self.renderer.xr.getCamera();
          var eye0 = xrCam && xrCam.cameras && xrCam.cameras[0];
          if (eye0 && eye0.viewport && eye0.viewport.z && eye0.viewport.w) {
            vw = eye0.viewport.z;
            vh = eye0.viewport.w;
            projCam = eye0;
          }
        }
        for (var si = 0; si < self._splatRenderers.length; si++) {
          self._splatRenderers[si].updateFrame(self.camera, vw, vh, projCam);
        }
      }

      if (self._annotationLabels && self._annotationLabels.length) self._updateAnnotationLabels();

      if (self.controls && !presenting) self.controls.update();
      // After controls.update() (not before): the vignette projects world
      // points to screen pixels, which needs this frame's camera
      // position/orientation already applied, not last frame's.
      self._updateSelectionVignette();
      // Frame-rate-driven sampling of the drawing stroke: guarantees a dense
      // outline regardless of how the browser batches pointermove events.
      if (self.isDrawing && self._pointerClient) {
        self._sampleDrawPoint(self._pointerClient.x, self._pointerClient.y);
      }
      if (self.renderer && self.scene && self.camera) {
        self.renderer.render(self.scene, self.camera);
      }
    });
  };

  // ---- Render quality ----------------------------------------------------

  SpatialViewerApp.prototype._loadRenderSettings = function() {
    var s = {};
    try {
      var raw = window.localStorage.getItem(RENDER_STORE_KEY);
      if (raw) s = JSON.parse(raw) || {};
    } catch (e) {}
    var out = {};
    Object.keys(RENDER_DEFAULTS).forEach(function(k) {
      out[k] = (s[k] === undefined || s[k] === null) ? RENDER_DEFAULTS[k] : s[k];
    });
    return out;
  };

  SpatialViewerApp.prototype._saveRenderSettings = function() {
    try { window.localStorage.setItem(RENDER_STORE_KEY, JSON.stringify(this.renderSettings)); } catch (e) {}
  };

  var TONE_MAP = {
    aces: 'ACESFilmicToneMapping',
    reinhard: 'ReinhardToneMapping',
    linear: 'LinearToneMapping',
    none: 'NoToneMapping'
  };

  // Push the current renderSettings onto the renderer / scene / lights / model.
  // Guarded end-to-end: a bad setting must never stop a model from displaying.
  SpatialViewerApp.prototype._applyRenderSettings = function() {
    try { this._applyRenderSettingsUnsafe(); }
    catch (e) { console.warn('[SpatialViewer] _applyRenderSettings failed:', e); }
  };

  SpatialViewerApp.prototype._applyRenderSettingsUnsafe = function() {
    var r = this.renderer, s = this.renderSettings;
    if (!r || !s) return;

    // Tone mapping + exposure
    var tmName = TONE_MAP[s.tone] || TONE_MAP.aces;
    r.toneMapping = (THREE[tmName] != null) ? THREE[tmName] : THREE.NoToneMapping;
    r.toneMappingExposure = s.exposure;
    // True Gaussian-splat materials (SplatRenderer/SplatRendererTex) write
    // gl_FragColor directly and never run through three.js's own
    // <tonemapping_fragment> chunk, so r.toneMappingExposure above has no
    // effect on them -- see the `exposure` uniform note in
    // SPLAT_FRAGMENT_SHADER. Push the same slider value into that uniform
    // by hand instead. `light` (ambient/key/fill/hemi below) intentionally
    // does NOT get a splat-side equivalent: splat color is baked-in per-
    // splat spherical harmonics from training, never re-lit by scene
    // lights, so there is nothing physically meaningful for a "light
    // intensity" control to multiply there.
    (this._splatRenderers || []).forEach(function(sr) {
      var u = sr && sr.mesh && sr.mesh.material && sr.mesh.material.uniforms;
      if (u && u.exposure) u.exposure.value = s.exposure;
    });

    // Pixel ratio
    var ratio = s.hiDpi ? Math.min(window.devicePixelRatio, 2) : 1;
    if (ratio !== this._appliedRatio) {
      this._appliedRatio = ratio;
      r.setPixelRatio(ratio);
      var w = this.viewport ? this.viewport.clientWidth : 0;
      var h = this.viewport ? this.viewport.clientHeight : 0;
      if (w > 0 && h > 0) r.setSize(w, h, false);
    }

    // Shadows
    var shadowsOn = s.shadows !== 'off';
    r.shadowMap.enabled = shadowsOn;
    r.shadowMap.type = (s.shadows === 'soft') ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    r.shadowMap.needsUpdate = true;
    if (this.keyLight) this.keyLight.castShadow = shadowsOn;
    if (this.shadowCatcher) this.shadowCatcher.visible = shadowsOn && !!this.modelObject;
    (this.modelMeshObjects || []).forEach(function(m) {
      m.castShadow = shadowsOn;
      m.receiveShadow = shadowsOn;
    });

    // Light intensity multiplier
    var k = s.light;
    if (this.ambientLight) this.ambientLight.intensity = 0.45 * k;
    if (this.keyLight) this.keyLight.intensity = 0.85 * k;
    if (this.fillLight) this.fillLight.intensity = 0.35 * k;
    // "Environment light" -> soft sky/ground hemisphere ambient
    if (this.hemiLight) this.hemiLight.intensity = s.env ? (0.65 * k) : 0;

    // Wireframe
    var wf = !!s.wireframe;
    (this.modelMeshObjects || []).forEach(function(m) {
      var mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach(function(mm) { if (mm && 'wireframe' in mm) mm.wireframe = wf; });
    });

    // Ground grid + background
    if (this.gridHelper) this.gridHelper.visible = !!s.grid;
    if (this.scene) {
      this.scene.background = new THREE.Color(BG_COLORS[s.background] != null ? BG_COLORS[s.background] : BG_COLORS.light);
    }

    this._syncRenderPanel();
    this._saveRenderSettings();
  };

  // Size the shadow frustum + shadow-catcher plane to the freshly loaded model.
  SpatialViewerApp.prototype._fitShadowsToModel = function(box, center, maxDim) {
    if (this.keyLight) {
      var d = maxDim * 1.2;
      var cam = this.keyLight.shadow.camera;
      cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
      cam.near = maxDim * 0.01; cam.far = maxDim * 12;
      cam.updateProjectionMatrix();
      this.keyLight.position.set(center.x + maxDim * 0.9, center.y + maxDim * 1.8, center.z + maxDim * 0.7);
      this.keyLight.target.position.copy(center);
      this.keyLight.target.updateMatrixWorld();
    }
    if (this.shadowCatcher) {
      this.shadowCatcher.position.set(center.x, box.min.y - maxDim * 0.002, center.z);
      this.shadowCatcher.scale.set(maxDim * 8, maxDim * 8, 1);
    }
  };

  // Frame the model in view (same maths as the initial load).
  SpatialViewerApp.prototype.fitToView = function() {
    if (!this.modelObject) return;
    var box = new THREE.Box3().setFromObject(this.modelObject);
    if (box.isEmpty()) return;
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z) || 10;
    this.controls.target.copy(center);
    this.camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 1.2, center.z + maxDim * 1.5);
    this.camera.lookAt(center);
    this.controls.update();
  };

  SpatialViewerApp.prototype.goHome = function() {
    if (!this._homeView) { this.fitToView(); return; }
    this.camera.position.copy(this._homeView.position);
    this.controls.target.copy(this._homeView.target);
    this.controls.update();
  };

  // "Set as start view" — persist the current camera position + orbit target
  // so the model opens there (instead of the auto fit-to-view) next time.
  SpatialViewerApp.prototype._setCurrentViewAsStart = function() {
    var self = this;
    if (!this.apiUrl) return;
    var pos = this.camera.position.clone(), tgt = this.controls.target.clone();
    var url = this.apiUrl.replace('/api_data', '/set_start_view');
    fetch(url, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify({
        position: { x: pos.x, y: pos.y, z: pos.z },
        target: { x: tgt.x, y: tgt.y, z: tgt.z }
      })
    })
      .then(function(r) { return r.json().catch(function() { return {}; }); })
      .then(function(res) {
        if (!res || !res.success) { window.alert('Could not save the start view.'); return; }
        if (self.projectData) {
          self.projectData.settings = self.projectData.settings || {};
          self.projectData.settings.start_view = res.start_view;
        }
        self._homeView = { position: pos, target: tgt };
        self._flashTooltip('Start view saved — the model will open here next time.');
      })
      .catch(function() { window.alert('Network error while saving the start view.'); });
  };

  SpatialViewerApp.prototype._clearStartView = function() {
    var self = this;
    if (!this.apiUrl) return;
    var url = this.apiUrl.replace('/api_data', '/set_start_view');
    fetch(url, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify({ clear: true })
    })
      .then(function(r) { return r.json().catch(function() { return {}; }); })
      .then(function(res) {
        if (!res || !res.success) { window.alert('Could not clear the start view.'); return; }
        if (self.projectData && self.projectData.settings) self.projectData.settings.start_view = null;
        self._flashTooltip('Start view cleared — the model will open with the default fit-to-view.');
      })
      .catch(function() { window.alert('Network error while clearing the start view.'); });
  };

  // Brief status message reusing the drawing tooltip box.
  SpatialViewerApp.prototype._flashTooltip = function(text) {
    this.showTooltip(text);
    setTimeout(function() {
      var t = document.getElementById('drawingTooltip');
      if (t) t.style.display = 'none';
    }, 3000);
  };

  // Reflect renderSettings into the Render panel's inputs.
  SpatialViewerApp.prototype._syncRenderPanel = function() {
    var s = this.renderSettings;
    var set = function(id, val) { var el = document.getElementById(id); if (el) el.value = val; };
    var check = function(id, val) { var el = document.getElementById(id); if (el) el.checked = !!val; };
    set('rqShadows', s.shadows);
    set('rqTone', s.tone);
    set('rqBackground', s.background);
    set('rqExposure', s.exposure);
    set('rqLight', s.light);
    check('rqEnv', s.env);
    check('rqHiDpi', s.hiDpi);
    check('rqWireframe', s.wireframe);
    check('rqGrid', s.grid);
    var ev = document.getElementById('rqExposureVal'); if (ev) ev.textContent = Number(s.exposure).toFixed(2);
    var lv = document.getElementById('rqLightVal'); if (lv) lv.textContent = Number(s.light).toFixed(1);
    var btn = document.getElementById('btnWireframe');
    if (btn) btn.classList.toggle('active', !!s.wireframe);
  };

  // Render quality is a plain tab now (#renderPanel, see show.html.erb),
  // not a floating panel of its own -- this only wires up the settings
  // controls inside it, same as always.
  SpatialViewerApp.prototype._initRenderPanel = function() {
    var self = this;
    var bind = function(id, key, kind) {
      var el = document.getElementById(id);
      if (!el) return;
      var evt = (kind === 'range') ? 'input' : 'change';
      el.addEventListener(evt, function() {
        if (kind === 'check') self.renderSettings[key] = el.checked;
        else if (kind === 'range') self.renderSettings[key] = parseFloat(el.value);
        else self.renderSettings[key] = el.value;
        self._applyRenderSettings();
      });
    };
    bind('rqShadows', 'shadows', 'select');
    bind('rqTone', 'tone', 'select');
    bind('rqBackground', 'background', 'select');
    bind('rqExposure', 'exposure', 'range');
    bind('rqLight', 'light', 'range');
    bind('rqEnv', 'env', 'check');
    bind('rqHiDpi', 'hiDpi', 'check');
    bind('rqWireframe', 'wireframe', 'check');
    bind('rqGrid', 'grid', 'check');

    var reset = document.getElementById('rqReset');
    if (reset) reset.addEventListener('click', function() {
      self.renderSettings = JSON.parse(JSON.stringify(RENDER_DEFAULTS));
      self._applyRenderSettings();
    });

    // Toolbar wireframe button mirrors the panel checkbox.
    var wfBtn = document.getElementById('btnWireframe');
    if (wfBtn) wfBtn.addEventListener('click', function() {
      self.renderSettings.wireframe = !self.renderSettings.wireframe;
      self._applyRenderSettings();
    });

    var homeBtn = document.getElementById('btnHome');
    if (homeBtn) homeBtn.addEventListener('click', function() { self.goHome(); });
    var fitBtn = document.getElementById('btnFit');
    if (fitBtn) fitBtn.addEventListener('click', function() { self.fitToView(); });

    this._syncRenderPanel();
  };

