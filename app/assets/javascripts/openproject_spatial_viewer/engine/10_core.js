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
    grid: true,
    pointSize: 0.25,      // multiplier on point-cloud point diameter
    pointBudget: 4,       // max points drawn at once, in millions (LOD point clouds)
    splatOpacity: 1.0,    // multiplier on every Gaussian's opacity
    splatSize: 1.0,       // multiplier on every Gaussian's extent
    splatMinAlpha: 0.0,   // hide Gaussians whose own opacity is below this
    splatSh: 2,           // view-dependent colour: 0 off, 1 degree 1, 2 degree 1+2
    splatDepth: 0,        // 1 = depth heat map instead of colour
    splatDepthRange: 0.1, // ramp covers 0 .. this fraction of the farthest distance
    splatShFix: true      // flip the SH view direction like the splat itself is flipped at load
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

    this.upAxis = 'y';
    this._createControls();

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

    // Selection highlight: a real 3D spotlight from the camera toward
    // whatever lasso selection is open (see _updateSelectionSpotlight and
    // SELECTION_SPOTLIGHT_COLOR in interaction/lasso code -- referenced
    // here even though that file runs later in the concatenated build,
    // since this constructor body only ever executes long after the whole
    // file has loaded and every top-level var has already been assigned),
    // rather than a hand-projected 2D overlay. Intensity 0 here means
    // invisible/inert until a selection sets it.
    this.selectionSpotlight = new THREE.SpotLight(SELECTION_SPOTLIGHT_COLOR, 0, 0, Math.PI / 6, 0.5, 2);
    this.selectionSpotlight.castShadow = false;
    this.scene.add(this.selectionSpotlight);
    this.scene.add(this.selectionSpotlight.target);

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
    this._embedMode = this.container.dataset.embed === '1'; // read-only iframe view (SpatialEmbedController)
    this._labelsVisible = !this._embedMode; // toggled by the toolbar's Labels button; never shown when embedded

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
      if (self._pointLODs && self._pointLODs.length) self._updatePointLODs(now);
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
      self._updateSelectionSpotlight();
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

  // OrbitControls bakes camera.up into its update() closure when it is
  // constructed, so changing the up axis means building a new one.
  SpatialViewerApp.prototype._createControls = function() {
    var prev = this.controls, tgt = prev ? prev.target.clone() : null;
    var enabled = prev ? prev.enabled : true;
    if (prev) prev.dispose();
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    // The wheel is handled by _onWheel (zoom toward the cursor), not by
    // OrbitControls' dolly-toward-target — that one stalls as the camera nears
    // the target and never actually reaches the surface you're looking at.
    this.controls.enableZoom = false;
    this.controls.enabled = enabled;
    if (tgt) { this.controls.target.copy(tgt); this.camera.lookAt(tgt); this.controls.update(); }
  };

  // Which world axis points up. Surveys / LAS / E57 are Z-up; glTF/IFC-derived
  // meshes are Y-up. Decides camera.up (orbit/pan/WASD), the ground grid and
  // the shadow plane.
  SpatialViewerApp.prototype._setUpAxis = function(axis) {
    axis = (axis === 'z') ? 'z' : 'y';
    this.upAxis = axis;
    this.camera.up.set(0, axis === 'z' ? 0 : 1, axis === 'z' ? 1 : 0);
    if (this._nav) this._nav.worldUp.copy(this.camera.up);
    this._createControls();
    this._placeGround();
    if (this.keyLight && this._groundInfo) this._placeKeyLight();
    var sel = document.getElementById('rqUp');
    if (sel) sel.value = axis;
  };

  // Camera offset from the model centre for the default "3/4" view.
  SpatialViewerApp.prototype._viewOffset = function(maxDim) {
    return this.upAxis === 'z'
      ? new THREE.Vector3(maxDim * 1.5, -maxDim * 1.5, maxDim * 1.2)
      : new THREE.Vector3(maxDim * 1.5, maxDim * 1.2, maxDim * 1.5);
  };

  SpatialViewerApp.prototype._upStoreKey = function() {
    return 'spatialViewer.up.' + ((this.projectData && this.projectData.id) || 'x');
  };

  // Saved choice for this model, else a default by what was loaded first:
  // point clouds are Z-up, everything else keeps the Y-up convention.
  SpatialViewerApp.prototype._resolveUpAxis = function(firstKind) {
    var saved = null;
    try { saved = window.localStorage.getItem(this._upStoreKey()); } catch (e) {}
    this._setUpAxis(saved === 'y' || saved === 'z' ? saved : (firstKind === 'pointcloud' ? 'z' : 'y'));
  };

  // Ground grid + shadow plane sit under the model (at the bottom of its box
  // along the up axis), lie perpendicular to it, and scale with the model.
  SpatialViewerApp.prototype._placeGround = function() {
    var gi = this._groundInfo;
    if (!gi) return;
    var z = this.upAxis === 'z', c = gi.center, b = gi.box, m = gi.maxDim;
    if (this.gridHelper) {
      this.gridHelper.rotation.set(z ? Math.PI / 2 : 0, 0, 0);
      this.gridHelper.scale.setScalar(Math.max(m * 2, 1) / 50);
      if (z) this.gridHelper.position.set(c.x, c.y, b.min.z - m * 0.0005);
      else this.gridHelper.position.set(c.x, b.min.y - m * 0.0005, c.z);
    }
    if (this.shadowCatcher) {
      this.shadowCatcher.rotation.set(z ? 0 : -Math.PI / 2, 0, 0);
      if (z) this.shadowCatcher.position.set(c.x, c.y, b.min.z - m * 0.002);
      else this.shadowCatcher.position.set(c.x, b.min.y - m * 0.002, c.z);
      this.shadowCatcher.scale.set(m * 8, m * 8, 1);
    }
  };

  SpatialViewerApp.prototype._placeKeyLight = function() {
    var c = this._groundInfo.center, m = this._groundInfo.maxDim;
    if (this.upAxis === 'z') this.keyLight.position.set(c.x + m * 0.9, c.y + m * 0.7, c.z + m * 1.8);
    else this.keyLight.position.set(c.x + m * 0.9, c.y + m * 1.8, c.z + m * 0.7);
    this.keyLight.target.position.copy(c);
    this.keyLight.target.updateMatrixWorld();
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

  // The "full strength" (no selection active) intensity for each of the 4
  // scene lights, from the current renderSettings -- the single formula
  // both _applyRenderSettingsUnsafe and _applySelectionDim (see
  // interaction/lasso code) scale from, so they can never drift apart.
  SpatialViewerApp.prototype._baseLightIntensities = function() {
    var s = this.renderSettings || {};
    var k = s.light != null ? s.light : 1;
    return { ambient: 0.45 * k, key: 0.85 * k, fill: 0.35 * k, hemi: s.env ? (0.65 * k) : 0 };
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
      if (u && u.exposure) u.exposure.value = s.exposure; // x layer exposure: see _applySplatSettings
    });
    this._applySplatSettings();

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

    // Light intensity multiplier -- routed through _applySelectionDim (not
    // set directly) so that re-applying settings while a lasso selection is
    // open re-dims to the new slider value instead of undoing the dim.
    this._applySelectionDim(!!this._selectionLit);

    // Wireframe and opacity are per layer (see _applyLayerOptions).
    if (this._applyAllLayerOptions) this._applyAllLayerOptions();

    // Point clouds: diameter multiplier (plain Points via material.size, LOD
    // nodes via a shared shader uniform) and the LOD point budget.
    var ps = s.pointSize > 0 ? s.pointSize : 1;
    this._pointScaleU = this._pointScaleU || { value: 1 };
    this._pointScaleU.value = ps;
    this.pointBudget = Math.round((s.pointBudget > 0 ? s.pointBudget : 4) * 1e6);
    (this.modelMeshObjects || []).forEach(function(m) {
      var mat = m && m.isPoints && m.material;
      if (mat && mat.userData && mat.userData.baseSize) mat.size = mat.userData.baseSize * ps;
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
    }
    this._groundInfo = { box: box.clone(), center: center.clone(), maxDim: maxDim };
    this._placeGround();
    if (this.keyLight) this._placeKeyLight();
  };
  // Frame the model in view (same maths as the initial load).
  SpatialViewerApp.prototype.fitToView = function() {
    if (!this.modelObject) return;
    var box = this._referenceBox();
    if (box.isEmpty()) box = this._robustObjectBox(this.modelObject);
    if (box.isEmpty()) return;
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z) || 10;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(this._viewOffset(maxDim));
    this.camera.lookAt(center);
    this.controls.update();
    this._rescaleForFlat();
  };

  SpatialViewerApp.prototype.goHome = function() {
    if (!this._homeView) { this.fitToView(); return; }
    this.camera.position.copy(this._homeView.position);
    this.controls.target.copy(this._homeView.target);
    this.controls.update();
    this._rescaleForFlat();
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

  // ---- Saved views (slots 1..4) -------------------------------------------
  SpatialViewerApp.prototype._savedViews = function() {
    var st = this.projectData && this.projectData.settings;
    var v = st && st.saved_views;
    return Array.isArray(v) ? v : [];
  };

  // Small JPEG of the current camera view, cropped to the thumbnail ratio.
  SpatialViewerApp.prototype._captureViewThumb = function() {
    var src = this.renderer.domElement;
    this.renderer.render(this.scene, this.camera);
    var W = 192, H = 120, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var sw = src.width, sh = src.height, r = W / H, cw = sw, ch = sw / r;
    if (ch > sh) { ch = sh; cw = sh * r; }
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.7);
  };

  SpatialViewerApp.prototype._patchSavedView = function(body, errMsg, done) {
    var self = this;
    if (!this.apiUrl) return;
    fetch(this.apiUrl.replace('/api_data', '/set_saved_view'), {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify(body)
    })
      .then(function(r) { return r.json().catch(function() { return {}; }); })
      .then(function(res) {
        if (!res || !res.success) { window.alert(errMsg); return; }
        if (self.projectData) {
          self.projectData.settings = self.projectData.settings || {};
          self.projectData.settings.saved_views = res.saved_views;
        }
        self._renderSavedViews();
        if (done) done();
      })
      .catch(function() { window.alert('Network error: ' + errMsg); });
  };

  SpatialViewerApp.prototype._saveViewSlot = function(slot) {
    var pos = this.camera.position, tgt = this.controls.target;
    var self = this;
    this._patchSavedView({
      slot: slot,
      position: { x: pos.x, y: pos.y, z: pos.z },
      target: { x: tgt.x, y: tgt.y, z: tgt.z },
      thumbnail: this._captureViewThumb()
    }, 'Could not save view ' + slot + '.', function() {
      self._flashTooltip('View ' + slot + ' saved.');
    });
  };

  SpatialViewerApp.prototype._clearViewSlot = function(slot) {
    this._patchSavedView({ slot: slot, clear: true }, 'Could not clear view ' + slot + '.');
  };

  SpatialViewerApp.prototype._goToSavedView = function(slot) {
    var v = this._savedViews()[slot - 1];
    if (!v || !v.position || !v.target) return;
    var self = this;
    var p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    var p1 = new THREE.Vector3(v.position.x, v.position.y, v.position.z);
    var t1 = new THREE.Vector3(v.target.x, v.target.y, v.target.z);
    var k = 0;
    (function step() {
      k = Math.min(1, k + 0.06);
      self.camera.position.lerpVectors(p0, p1, k);
      self.controls.target.lerpVectors(t0, t1, k);
      self.controls.update();
      if (k < 1) requestAnimationFrame(step);
    })();
  };

  SpatialViewerApp.prototype._renderSavedViews = function() {
    var self = this;
    var box = document.getElementById('savedViews');
    if (!box) return;
    var canSet = box.dataset.canSet === '1';
    var views = this._savedViews();
    box.innerHTML = '';
    // Viewers who cannot set views only see the ones that exist.
    if (!canSet && !views.some(function(v) { return v; })) return;
    for (var i = 1; i <= 4; i++) {
      (function(slot) {
        var v = views[slot - 1];
        if (!v && !canSet) return;
        var cell = document.createElement('div');
        cell.className = 'saved-view' + (v ? '' : ' empty');
        if (v) {
          cell.setAttribute('role', 'button');
          cell.title = 'View ' + slot;
          var img = document.createElement('img');
          img.src = v.thumbnail; img.alt = 'View ' + slot;
          cell.appendChild(img);
          var num = document.createElement('span');
          num.className = 'saved-view-num'; num.textContent = slot;
          cell.appendChild(num);
          if (canSet) {
            var x = document.createElement('span');
            x.className = 'saved-view-clear'; x.textContent = '\u00d7'; x.title = 'Clear view ' + slot;
            x.addEventListener('click', function(e) { e.stopPropagation(); self._clearViewSlot(slot); });
            cell.appendChild(x);
          }
          cell.addEventListener('click', function() { self._goToSavedView(slot); });
        } else {
          var add = document.createElement('button');
          add.type = 'button'; add.className = 'saved-view-add';
          add.textContent = '+'; add.title = 'Save the current view as view ' + slot;
          add.setAttribute('aria-label', 'Save current view as view ' + slot);
          add.addEventListener('click', function() { self._saveViewSlot(slot); });
          cell.appendChild(add);
        }
        box.appendChild(cell);
      })(i);
    }
  };

  // Brief status message reusing the drawing tooltip box.
  SpatialViewerApp.prototype._flashTooltip = function(text) {
    this.showTooltip(text);
    setTimeout(function() {
      var t = document.getElementById('drawingTooltip');
      if (t) t.style.display = 'none';
    }, 3000);
  };

  // Gaussian-splatting render options -> the splat shaders' uniforms. Also
  // called when a splat is created (settings may predate it).
  SpatialViewerApp.prototype._applySplatSettings = function() {
    var s = this.renderSettings;
    if (!s) return;
    var self = this;
    (this._splatRenderers || []).forEach(function(sr) {
      var u = sr && sr.mesh && sr.mesh.material && sr.mesh.material.uniforms;
      if (!u) return;
      var lid = self._layerIdOf(sr.mesh);
      var layerOp = lid != null ? self._layerOpt(lid).opacity : 1;
      if (u.exposure) u.exposure.value = (s.exposure == null ? 1 : s.exposure) * (lid != null ? (self._layerOpt(lid).exposure || 1) : 1);
      if (u.opacity) u.opacity.value = (s.splatOpacity > 0 ? s.splatOpacity : 1) * layerOp;
      if (u.uSplatScale) u.uSplatScale.value = s.splatSize > 0 ? s.splatSize : 1;
      if (u.uMinAlpha) u.uMinAlpha.value = s.splatMinAlpha > 0 ? s.splatMinAlpha : 0;
      if (u.uShDegree) u.uShDegree.value = Number(s.splatSh);
      if (u.uMaxRadius) u.uMaxRadius.value = self._xrMode === 'vr' ? 160 : 1024;
      if (u.uDepthMode) u.uDepthMode.value = Number(s.splatDepth) ? 1 : 0;
      if (u.uDepthK) u.uDepthK.value = s.splatDepthRange > 0 ? s.splatDepthRange : 1;
      if (u.uShFlip) {
        if (s.splatShFix && sr.needsShFlip) u.uShFlip.value.set(1, -1, -1);
        else u.uShFlip.value.set(1, 1, 1);
      }
    });
    var dRow = document.getElementById('rqSplatDepthRow');
    if (dRow) dRow.style.display = Number(s.splatDepth) ? '' : 'none';
    var dVal = document.getElementById('rqSplatDepthRangeVal');
    if (dVal) dVal.textContent = Math.round(Number(s.splatDepthRange) * 100);
    this._updateRenderSections();
  };

  // The Render tab is split into sections; the ones for a kind of layer the
  // model does not contain are hidden. Everything stays visible until the
  // model has content, so nothing is hidden by a half-loaded scene.
  SpatialViewerApp.prototype._updateRenderSections = function() {
    var objs = this.modelMeshObjects || [];
    var hasSplat = !!(this._splatRenderers && this._splatRenderers.length);
    var hasPoints = !!(this._pointLODs && this._pointLODs.length);
    var hasMesh = false;
    objs.forEach(function(m) {
      if (m.isPoints) hasPoints = true;
      else if (m.isMesh) {
        var mat = Array.isArray(m.material) ? m.material[0] : m.material;
        var isSplat = mat && mat.uniforms && mat.uniforms.focal;
        if (!isSplat) hasMesh = true;
      }
    });
    var anything = hasSplat || hasPoints || hasMesh;
    var show = { mesh: hasMesh, points: hasPoints, splat: hasSplat };
    var secs = document.querySelectorAll('[data-render-section]');
    for (var i = 0; i < secs.length; i++) {
      var k = secs[i].getAttribute('data-render-section');
      if (k === 'general') continue;
      secs[i].style.display = (!anything || show[k]) ? '' : 'none';
    }
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
    set('rqPointSize', s.pointSize);
    set('rqPointBudget', s.pointBudget);
    var psv = document.getElementById('rqPointSizeVal'); if (psv) psv.textContent = Number(s.pointSize).toFixed(2);
    var pbv = document.getElementById('rqPointBudgetVal'); if (pbv) pbv.textContent = Number(s.pointBudget).toFixed(1);
    set('rqSplatOpacity', s.splatOpacity);
    set('rqSplatSize', s.splatSize);
    set('rqSplatMinAlpha', s.splatMinAlpha);
    set('rqSplatSh', String(s.splatSh));
    set('rqSplatDepth', String(s.splatDepth));
    set('rqSplatDepthRange', s.splatDepthRange);
    var sdv = document.getElementById('rqSplatDepthRangeVal'); if (sdv) sdv.textContent = Math.round(Number(s.splatDepthRange) * 100);
    var sdr = document.getElementById('rqSplatDepthRow'); if (sdr) sdr.style.display = Number(s.splatDepth) ? '' : 'none';
    check('rqSplatShFix', s.splatShFix);
    var sov = document.getElementById('rqSplatOpacityVal'); if (sov) sov.textContent = Number(s.splatOpacity).toFixed(2);
    var ssv = document.getElementById('rqSplatSizeVal'); if (ssv) ssv.textContent = Number(s.splatSize).toFixed(2);
    var smv = document.getElementById('rqSplatMinAlphaVal'); if (smv) smv.textContent = Number(s.splatMinAlpha).toFixed(2);
    var upSel = document.getElementById('rqUp'); if (upSel && this.upAxis) upSel.value = this.upAxis;
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
    bind('rqPointSize', 'pointSize', 'range');
    bind('rqPointBudget', 'pointBudget', 'range');
    bind('rqSplatOpacity', 'splatOpacity', 'range');
    bind('rqSplatSize', 'splatSize', 'range');
    bind('rqSplatMinAlpha', 'splatMinAlpha', 'range');
    bind('rqSplatSh', 'splatSh', 'select');
    bind('rqSplatDepth', 'splatDepth', 'select');
    bind('rqSplatDepthRange', 'splatDepthRange', 'range');
    bind('rqSplatShFix', 'splatShFix', 'check');

    // Up axis is a property of the model, not a global render setting: kept
    // per model in this browser, and the view is re-framed when it changes.
    var upSel = document.getElementById('rqUp');
    if (upSel) upSel.addEventListener('change', function() {
      try { window.localStorage.setItem(self._upStoreKey(), upSel.value); } catch (e) {}
      self._setUpAxis(upSel.value);
      var gi = self._groundInfo;
      if (gi) {
        self.controls.target.copy(gi.center);
        self.camera.position.copy(gi.center).add(self._viewOffset(gi.maxDim));
        self.camera.lookAt(gi.center);
        self.controls.update();
        self._homeView = { position: self.camera.position.clone(), target: self.controls.target.clone() };
      }
    });

    var reset = document.getElementById('rqReset');
    if (reset) reset.addEventListener('click', function() {
      self.renderSettings = JSON.parse(JSON.stringify(RENDER_DEFAULTS));
      self._applyRenderSettings();
    });

    // Toolbar wireframe button mirrors the panel checkbox.
    var wfBtn = document.getElementById('btnWireframe');
    if (wfBtn) wfBtn.addEventListener('click', function() {
      // Toolbar shortcut: wireframe on/off for every layer at once.
      self.renderSettings.wireframe = !self.renderSettings.wireframe;
      Object.keys(self.layerMeta || {}).forEach(function(id) { self._layerOpt(id).wireframe = self.renderSettings.wireframe; });
      self._applyRenderSettings();
      if (self._buildLayerPanel) self._buildLayerPanel();
    });

    var homeBtn = document.getElementById('btnHome');
    if (homeBtn) homeBtn.addEventListener('click', function() { self.goHome(); });
    var fitBtn = document.getElementById('btnFit');
    if (fitBtn) fitBtn.addEventListener('click', function() { self.fitToView(); });

    this._syncRenderPanel();
  };

