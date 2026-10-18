/**
 * OpenProject 3D & Gaussian Splatting Viewer Engine
 * Supports GLTF/GLB, OBJ, PLY/Splat, IFC (server-side converted).
 *
 * Turbo Drive compatible: uses MutationObserver to reliably detect
 * when #spatialViewerApp appears in the DOM after Turbo body swaps.
 */

(function() {
  'use strict';

  // Guard against double registration
  if (window.__spatialViewerRegistered) return;
  window.__spatialViewerRegistered = true;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Lasso surface-highlight: raycast grid --------------------------------
  // The fill is built by casting a grid of rays (one per sample point inside
  // the lasso's screen polygon) at the model and meshing the hits together.
  // Every vertex of the resulting patch IS a point where a ray actually met a
  // surface, so it can never drift off of it — it literally *is* the nearest
  // surface along each ray, across all visible layers. (An earlier version
  // projected the model's own geometry through a frozen camera matrix and
  // depth-tested it against a cached depth map; that approach kept drifting
  // out of alignment whenever the aspect ratio, camera, or scene changed
  // between selection and render, so it has been replaced outright.)

  // Even-odd point-in-polygon test, polygon implicitly closed (last point
  // pairs with the first via the `j = i++` wrap).
  function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // The pin cone is modeled base-at-origin, tip hanging down along local -Y
  // (see place3DPin/renderExisting3DAnnotations) -- i.e. local +Y is its
  // "away from the surface" direction. Previously the mesh was just left at
  // the identity rotation, which only looks right when the surface normal
  // happens to be world +Y (a floor); on a wall or ceiling the tip pointed
  // straight down instead of into the surface, giving no visual cue of
  // exactly where the pin actually sits. Rotating local +Y onto the real hit
  // normal makes the tip touch the surface (pointing into it, opposite the
  // normal) and the body stick out along the normal, on any surface.
  function pinQuaternionFromNormal(normal) {
    var n = (normal && isFinite(normal.x) && isFinite(normal.y) && isFinite(normal.z))
      ? new THREE.Vector3(normal.x, normal.y, normal.z) : new THREE.Vector3(0, 1, 0);
    if (n.lengthSq() < 1e-10) n.set(0, 1, 0);
    n.normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  }

  // Cap the polygon used for hit-testing so a long freehand stroke (up to
  // 4000 points) never makes the per-sample inside-test expensive.
  function downsamplePolyPx(path, maxPts) {
    if (path.length <= maxPts) return path;
    var out = [], stride = path.length / maxPts;
    for (var i = 0; i < maxPts; i++) out.push(path[Math.floor(i * stride)]);
    return out;
  }

  // Keeps a stored lasso fill grid's JSON compact -- 1e-5 units of precision
  // is far finer than visually meaningful for this viewer's models.
  function round5(n) { return Math.round(n * 1e5) / 1e5; }

  // Two independent triangles per grid cell (a-b-c, b-d-c) rather than
  // requiring all 4 corners: a lasso edge or a small gap in the surface then
  // only loses a sliver instead of the whole cell. `grid` is a flat
  // rows*cols array of {x,y,z}-like points, with a falsy entry wherever
  // there was no hit at that cell. Shared by the live fill (built from fresh
  // raycasts every time it's called) and by rebuilding a SAVED fill directly
  // from its stored grid (no raycasting at all -- see _buildLassoFillFromGrid).
  function triangulateLassoGrid(grid, rows, cols) {
    var positions = [];
    for (var j = 0; j < rows - 1; j++) {
      for (var k = 0; k < cols - 1; k++) {
        var a = grid[j * cols + k], b = grid[j * cols + k + 1];
        var c = grid[(j + 1) * cols + k], d = grid[(j + 1) * cols + k + 1];
        if (a && b && c) { positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
        if (b && d && c) { positions.push(b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z); }
      }
    }
    return positions;
  }

  // ---- Cleanup previous viewer instance ----
  function destroyExistingViewer() {
    if (window.spatialViewerApp) {
      try {
        var app = window.spatialViewerApp;
        if (app._animFrameId) cancelAnimationFrame(app._animFrameId);
        if (app._conversionPoll) clearTimeout(app._conversionPoll);
        if (app._gltfWorker) { try { app._gltfWorker.terminate(); } catch (ignore3) {} }
        if (app._splatRenderers) {
          app._splatRenderers.forEach(function(s) { try { if (s._worker) s._worker.terminate(); } catch (e) {} });
        }
        if (typeof app._revokeBundleUrls === 'function') { try { app._revokeBundleUrls(); } catch (e) {} }
        app._modelBlob = null;
        if (app.modelMeshObjects) {
          app.modelMeshObjects.forEach(function(m) {
            try { if (m.geometry && m.geometry.disposeBoundsTree) m.geometry.disposeBoundsTree(); } catch (e) {}
          });
        }
        if (app._xrSession) { try { app._xrSession.end(); } catch (ignore2) {} }
        if (app.renderer) {
          app.renderer.setAnimationLoop(null);
          app.renderer.dispose();
          app.renderer.forceContextLoss();
        }
        if (app.controls) app.controls.dispose();
        if (app._resizeHandler) window.removeEventListener('resize', app._resizeHandler);
        if (app._navKeyDown) window.removeEventListener('keydown', app._navKeyDown);
        if (app._navKeyUp) window.removeEventListener('keyup', app._navKeyUp);
        if (app._navBlur) window.removeEventListener('blur', app._navBlur);
      } catch(ignore) {}
      window.spatialViewerApp = null;
    }
  }

  // ---- Is the 3D engine actually available yet? ----
  // The <script> tags are injected into <head> by the plugin hook and load
  // asynchronously. On a Turbo Drive visit, turbo:load / the MutationObserver
  // fire BEFORE vendor.bundle.js has executed, so THREE is still undefined.
  function engineReady() {
    return typeof THREE !== 'undefined' && !!THREE.OrbitControls;
  }

  // ---- Initialization: find container and boot ----
  function initSpatialViewerApp() {
    var container = document.getElementById('spatialViewerApp');
    if (!container) return;
    // Already running for this DOM node, or a boot poll is already pending
    if (container.dataset.spatialInit === '1') return;
    if (container.dataset.spatialBooting === '1') return;

    if (!engineReady()) {
      container.dataset.spatialBooting = '1';
      var attempts = 0;
      (function pollForEngine() {
        // Node was swapped away by a later Turbo navigation: abort silently
        if (!document.body || !document.body.contains(container)) {
          delete container.dataset.spatialBooting;
          return;
        }
        if (engineReady()) {
          delete container.dataset.spatialBooting;
          bootSpatialViewer(container);
          return;
        }
        if (++attempts > 150) { // ~30s
          delete container.dataset.spatialBooting;
          var lt = document.getElementById('loaderText');
          if (lt) lt.innerText = 'Error: the 3D engine (Three.js) failed to load. Please reload the page.';
          return;
        }
        setTimeout(pollForEngine, 200);
      })();
      return;
    }

    bootSpatialViewer(container);
  }

  function bootSpatialViewer(container) {
    if (container.dataset.spatialInit === '1') return;
    // Claim the node up-front so a second Turbo event cannot start a parallel
    // init (which would bind every UI listener twice).
    container.dataset.spatialInit = '1';
    destroyExistingViewer();
    console.log('[SpatialViewer] Initializing 3D viewer');
    try {
      window.spatialViewerApp = new SpatialViewerApp('spatialViewerApp');
    } catch (err) {
      var lt = document.getElementById('loaderText');
      // A WebGL-context failure will not fix itself on the next Turbo event, and
      // retrying only burns more contexts. Stop, and show what to do.
      if (err && err.webglFatal) {
        console.error('[SpatialViewer] WebGL unavailable:', err, err.cause || '');
        if (lt) lt.innerText = err.message;
        return;
      }
      console.error('[SpatialViewer] init failed, will retry on next event:', err);
      container.dataset.spatialInit = ''; // release so a later Turbo event can retry
      if (lt) lt.innerText = 'Viewer initialization error: ' + (err.message || err);
    }
  }

  // ---- Multiple fallback strategies to catch Turbo navigations ----

  // 1. DOMContentLoaded (first full page load)
  document.addEventListener('DOMContentLoaded', initSpatialViewerApp);

  // 2. turbo:load (fires after Turbo Drive visit completes)
  document.addEventListener('turbo:load', initSpatialViewerApp);

  // 3. turbo:render (fires when Turbo renders new body — including cached snapshots)
  document.addEventListener('turbo:render', function() {
    setTimeout(initSpatialViewerApp, 100);
  });

  // 4. turbolinks:load (legacy)
  document.addEventListener('turbolinks:load', initSpatialViewerApp);

  // 5. MutationObserver on document.documentElement (<html>).
  //    Turbo Drive does document.body.replaceWith(newBody), which replaces
  //    the entire <body> element. Observing the old body would be useless
  //    because it becomes orphaned. document.documentElement is never
  //    replaced, so we observe it to catch the new body being inserted.
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        // Check if the added node IS a body, or contains #spatialViewerApp
        if (node.id === 'spatialViewerApp' ||
            (node.querySelector && node.querySelector('#spatialViewerApp'))) {
          setTimeout(initSpatialViewerApp, 50);
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 6. If DOM already ready (script loaded asynchronously)
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(initSpatialViewerApp, 0);
  }

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
    // during an immersive session the browser drives the frame timing.
    this.renderer.setAnimationLoop(function() {
      var presenting = self.renderer.xr && self.renderer.xr.isPresenting;

      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var dt = Math.min(0.1, (now - self._lastFrameT) / 1000);
      self._lastFrameT = now;
      if (presenting) self._processXRInput(dt);
      else self._processNavKeys(dt);
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

  SpatialViewerApp.prototype._initRenderPanel = function() {
    var self = this;
    var panel = document.getElementById('renderPanel');
    var btn = document.getElementById('btnRender');
    if (btn && panel) {
      btn.addEventListener('click', function() {
        var open = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = open ? 'block' : 'none';
        btn.classList.toggle('active', open);
      });
    }
    var closeBtn = document.getElementById('closeRenderBtn');
    if (closeBtn && panel) closeBtn.addEventListener('click', function() {
      panel.style.display = 'none';
      if (btn) btn.classList.remove('active');
    });

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
      (this._lastLayerMeshes || []).forEach(function(m) { m.userData.layerVisibilityGroup = g; });
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
    var panel = document.getElementById('layerPanel');
    var list = document.getElementById('layerList');
    var btn = document.getElementById('btnLayers');
    if (!panel || !list) return;

    var ids = Object.keys(this.layerMeta || {});
    if (ids.length <= 1) { if (btn) btn.style.display = 'none'; return; }
    if (btn) btn.style.display = '';

    list.innerHTML = '';
    ids.forEach(function(id) {
      var m = self.layerMeta[id];
      var row = document.createElement('label');
      row.className = 'layer-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = m.visible !== false && !self.layerError[id];
      cb.disabled = !self.layerGroups[id];
      cb.addEventListener('change', function() { self.setLayerVisible(id, cb.checked); });
      var span = document.createElement('span');
      span.textContent = (m.title || id);
      var tag = document.createElement('em');
      tag.textContent = self.layerError[id] ? ('— ' + self.layerError[id])
        : (m.kind || '') + (m.source_format ? ' · ' + String(m.source_format).toUpperCase() : '');
      row.appendChild(cb); row.appendChild(span); row.appendChild(tag);
      list.appendChild(row);
    });
  };

  SpatialViewerApp.prototype.load3DModel = function(url, format) {
    if (!url) {
      // No attachment on the SpatialModel. The most common cause is that the
      // uploaded file exceeded OpenProject's "Attachment max. size" setting
      // (default 5 MB) and was silently rejected when the model was created.
      console.warn('[SpatialViewer] No model_url returned by api_data - the model has no attachment.');
      this.showLoader('No 3D file attached to this model. Check the upload, then edit the model to add a file. ' +
        'Showing a demo model.');
      var self = this;
      setTimeout(function() { self.hideLoader(); self.createDemoModel(); }, 4000);
      return;
    }

    format = (format || 'glb').toLowerCase();

    if (typeof THREE === 'undefined') {
      this.showLoader('Error: Three.js engine failed to initialize.');
      return;
    }

    var self = this;
    var warnMb = parseInt(this.container.dataset.maxModelMb, 10) || 250;
    var heavyMb = parseInt(this.container.dataset.heavyModelMb, 10) || 40;

    this.showLoader('Checking 3D model...');

    // (6) HEAD first: learn the size before pulling the whole file.
    fetch(url, { method: 'HEAD', credentials: 'same-origin' })
      .then(function(head) {
        var ct = head.headers.get('content-type') || '';
        var lenHdr = head.headers.get('content-length');
        var bytes = lenHdr ? parseInt(lenHdr, 10) : 0;

        // Prefer the authoritative size from api_data; the HEAD Content-Length
        // may be gzip-compressed and understate a large model.
        if (self._modelBytes) bytes = Math.max(bytes, self._modelBytes);

        if (ct.indexOf('application/json') === -1 && bytes > 0) {
          self._modelBytes = bytes;
          self.heavyMode = bytes >= heavyMb * 1048576;

          if (bytes > warnMb * 1048576) {
            var mb = (bytes / 1048576).toFixed(0);
            var ok = window.confirm(
              'This 3D model is about ' + mb + ' MB.\n\n' +
              'Loading it may take a long time, use a lot of memory, or crash ' +
              'this browser tab. Continue?');
            if (!ok) {
              self.showLoader('Loading cancelled — the model is ' + mb + ' MB. ' +
                'Reload the page to try again.');
              return { aborted: true };
            }
          }
        }
        return self._downloadModel(url, format);
      })
      .catch(function() {
        // HEAD blocked/unsupported: just download, rely on GET headers.
        return self._downloadModel(url, format);
      })
      .then(function(res) {
        if (res && res.convError) { self._layerLoadFailed('conversion: ' + res.convError); return; }
        if (!res || res.aborted || res.pending) return;
        self._parseModel(res.buffer, format);
      })
      .catch(function(err) {
        console.error('[SpatialViewer] Model loading failed:', err);
        self._layerLoadFailed(err && err.message || String(err));
      });
  };

  // Download the model, streaming for progress. Returns { buffer } / { pending }.
  SpatialViewerApp.prototype._downloadModel = function(url, format) {
    var self = this;
    self.showLoader('Downloading 3D model (' + format.toUpperCase() + ')...');

    return fetch(url, { credentials: 'same-origin' }).then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);

      // model_file replies with a small JSON envelope ({status, message}) while
      // a server-side conversion (IFC -> GLB) is pending. But a .gltf file *is*
      // JSON too, and some servers label it application/json — so a JSON
      // content-type alone must NOT be treated as "conversion pending", or the
      // viewer polls model_file forever and never renders the model.
      var ct = (response.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('/json') !== -1) {
        return response.arrayBuffer().then(function(b) {
          var head = '';
          try { head = new TextDecoder('utf-8').decode(b.slice(0, 4096)); } catch (e) {}
          var isEnvelope = b.byteLength < 4096 &&
                           head.indexOf('"status"') !== -1 &&
                           head.indexOf('"asset"') === -1;

          if (!isEnvelope && (format === 'glb' || format === 'gltf')) {
            // It's the glTF document itself. Parse it as the model.
            try { self._modelBlob = new Blob([b]); } catch (e) {}
            return { buffer: b };
          }

          var j = {};
          try { j = JSON.parse(head); } catch (e) {}
          if (j && j.status === 'error') {
            self.showLoader('Conversion failed: ' + (j.message || 'unknown error'));
            return { convError: (j.message || 'conversion failed') };
          }
          self.showLoader('Converting on the server…');
          clearTimeout(self._conversionPoll);
          self._conversionPoll = setTimeout(function() { self.load3DModel(url, format); }, 8000);
          return { pending: true };
        });
      }

      var lenHdr = response.headers.get('content-length');
      var total = lenHdr ? parseInt(lenHdr, 10) : 0;
      if (total && !self._modelBytes) {
        self._modelBytes = total;
        self.heavyMode = total >= ((parseInt(self.container.dataset.heavyModelMb, 10) || 40) * 1048576);
      }

      if (!response.body || !window.ReadableStream) {
        return response.arrayBuffer().then(function(b) {
          try { self._modelBlob = new Blob([b]); } catch (e) {}
          return { buffer: b };
        });
      }

      var loaded = 0;
      var chunks = [];
      var reader = response.body.getReader();

      function read() {
        return reader.read().then(function(r) {
          if (r.done) {
            // (3) Hand the bytes to a browser-managed Blob and drop the chunks;
            // the ArrayBuffer is then transferred to the worker so the main
            // thread heap is freed during parsing.
            var blob = new Blob(chunks);
            chunks.length = 0;
            self._modelBlob = blob;
            return blob.arrayBuffer().then(function(b) { return { buffer: b }; });
          }
          chunks.push(r.value);
          loaded += r.value.length;
          var pct = total ? Math.round(loaded / total * 100) + '% ' : '';
          self.showLoader('Downloading model: ' + pct + '(' + (loaded / 1048576).toFixed(1) + ' MB)');
          return read();
        });
      }
      return read();
    });
  };

  function isZipBuffer(buffer) {
    if (!buffer || buffer.byteLength < 4) return false;
    var b = new Uint8Array(buffer, 0, 4);
    // "PK\x03\x04" (local file header) or "PK\x05\x06" (empty archive)
    return b[0] === 0x50 && b[1] === 0x4B && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
  }

  // Minimal async ZIP reader — enough for a normal `zip -r` of an OBJ/glTF plus
  // its .mtl and textures. Supports stored (0) and deflate (8) entries; rejects
  // ZIP64 and other compression methods with a clear message. Resolves to
  // { "<path/in/zip>": Uint8Array }.
  function unzipBuffer(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);
    var n = bytes.length;
    var td = new TextDecoder('utf-8');

    var eocd = -1;
    var minPos = Math.max(0, n - 22 - 65535);
    for (var i = n - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('not a valid .zip file'));

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset === 0xffffffff || dv.getUint16(eocd + 8, true) === 0xffff) {
      return Promise.reject(new Error('ZIP64 archives are not supported — re-create the zip'));
    }

    var entries = [];
    var p = cdOffset;
    for (var e = 0; e < count; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var uncompSize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOffset = dv.getUint32(p + 42, true);
      var name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (/\/$/.test(name)) continue; // directory entry
      entries.push({ name: name, method: method, compSize: compSize, uncompSize: uncompSize, localOffset: localOffset });
    }

    var out = {};
    var chain = Promise.resolve();
    entries.forEach(function(ent) {
      chain = chain.then(function() {
        if (ent.localOffset + 30 > n || dv.getUint32(ent.localOffset, true) !== 0x04034b50) {
          throw new Error('corrupt or truncated zip (entry "' + ent.name + '")');
        }
        var lNameLen = dv.getUint16(ent.localOffset + 26, true);
        var lExtraLen = dv.getUint16(ent.localOffset + 28, true);
        var start = ent.localOffset + 30 + lNameLen + lExtraLen;
        if (start + ent.compSize > n) {
          throw new Error('the archive download is incomplete (entry "' + ent.name + '" is cut off)');
        }
        var comp = bytes.subarray(start, start + ent.compSize);
        var check = function(u8) {
          if (u8.length !== ent.uncompSize) {
            throw new Error('"' + ent.name + '" unpacked to ' + u8.length + ' bytes, expected ' + ent.uncompSize + ' — the download was truncated');
          }
          out[ent.name] = u8;
        };
        if (ent.method === 0) { check(comp.slice()); return; }
        if (ent.method !== 8) throw new Error('unsupported compression in "' + ent.name + '"');
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('this browser cannot decompress the zip; upload an uncompressed archive');
        }
        var s = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(s).arrayBuffer().then(function(buf) { check(new Uint8Array(buf)); });
      });
    });
    return chain.then(function() { return out; });
  }

  // A Uint8Array's bytes as a standalone ArrayBuffer (offset 0, exact length).
  function toArrayBuffer(u8) {
    return (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength)
      ? u8.buffer : u8.slice().buffer;
  }

  var PLY_TYPE_SIZES = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4,
    float: 4, float32: 4,
    double: 8, float64: 8
  };

  // Reads one scalar PLY property value at a byte offset, by type name.
  function plyReadScalar(dv, offset, type) {
    switch (type) {
      case 'char': case 'int8': return dv.getInt8(offset);
      case 'uchar': case 'uint8': return dv.getUint8(offset);
      case 'short': case 'int16': return dv.getInt16(offset, true);
      case 'ushort': case 'uint16': return dv.getUint16(offset, true);
      case 'int': case 'int32': return dv.getInt32(offset, true);
      case 'uint': case 'uint32': return dv.getUint32(offset, true);
      case 'double': case 'float64': return dv.getFloat64(offset, true);
      default: return dv.getFloat32(offset, true); // float / float32
    }
  }

  // Parses a binary-little-endian PLY trained as a 3D Gaussian Splat (the
  // de-facto standard produced by the original INRIA 3DGS codebase and every
  // compatible tool): per-vertex float properties x/y/z, scale_0..2 (log
  // scale), rot_0..3 (quaternion w,x,y,z, not necessarily normalized),
  // opacity (logit -- needs a sigmoid), f_dc_0..2 (DC spherical-harmonic
  // color, same convention as SOG's sh0). Higher-order f_rest_* (view-
  // dependent color) is present in most such files but intentionally not
  // decoded, same scope limit as SOG.
  //
  // THREE.PLYLoader (vendored) only ever builds position/normal/uv/color
  // attributes and silently drops every other named property -- it cannot
  // be reused here, so this reads the binary vertex block directly.
  //
  // Returns null (not an error) when the file doesn't have these properties
  // -- the caller falls back to the plain colored-point-cloud path, since
  // .ply/.splat/.ksplat are also used in this plugin for ordinary point
  // clouds with no Gaussian training data at all.
  function parseSplatPLY(buffer, maxPoints) {
    var bytes = new Uint8Array(buffer);
    var headerEnd = -1;
    var ascii = '';
    // The header is pure ASCII and short; decode a generous prefix only.
    var scanLen = Math.min(bytes.length, 8192);
    for (var i = 0; i < scanLen; i++) ascii += String.fromCharCode(bytes[i]);
    var marker = ascii.indexOf('end_header\n');
    if (marker === -1) throw new Error('not a PLY file (no end_header)');
    headerEnd = marker + 'end_header\n'.length;
    var header = ascii.slice(0, marker);

    if (!/format\s+binary_little_endian/i.test(header)) return null; // ASCII/BE PLY: not handled here, fall back

    var vertexCountMatch = header.match(/element\s+vertex\s+(\d+)/i);
    if (!vertexCountMatch) return null;
    var count = parseInt(vertexCountMatch[1], 10);
    if (!count) return null;

    // Only the properties of the `vertex` element (the first `element`
    // block up to the next `element` line or end_header) matter here --
    // a `face` element, if present, is ignored entirely (splat plys don't
    // have one, but a defensive reader shouldn't assume that).
    var vertexBlockMatch = header.match(/element\s+vertex\s+\d+\n([\s\S]*?)(?=\nelement\s|\n?$)/i);
    var propText = vertexBlockMatch ? vertexBlockMatch[1] : header;
    var props = [];
    var propRe = /property\s+(\w+)\s+(\w+)/gi;
    var m;
    while ((m = propRe.exec(propText))) props.push({ type: m[1].toLowerCase(), name: m[2] });
    if (props.some(function(p) { return !PLY_TYPE_SIZES[p.type]; })) return null; // a `list` property (e.g. face indices) -- not a plain vertex record

    var offsets = {};
    var cursor = 0;
    props.forEach(function(p) {
      offsets[p.name] = cursor;
      cursor += PLY_TYPE_SIZES[p.type];
    });
    var recordSize = cursor;

    var need = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2',
                'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
    if (need.some(function(k) { return !(k in offsets); })) return null; // no Gaussian splat data in this ply

    // Optional view-dependent colour (spherical harmonics, degree 1-2). The
    // reference 3DGS trainer always exports all 3 bands (45 f_rest_* floats,
    // 15 per channel) when SH data is present at all, but this only reads
    // the first 8 (degree 1+2 -- the lowest-frequency, highest-impact
    // coefficients per channel) -- see the SplatRenderer comment on why
    // degree is capped there. f_rest_* is stored channel-major (all of R's
    // coefficients, then all of G's, then all of B's), unlike the
    // interleaved-per-coefficient layout used everywhere else in this file.
    var restCount = 0;
    while (('f_rest_' + restCount) in offsets) restCount++;
    // 0 (no SH data) unless restCount divides evenly into 3 equal channel
    // blocks -- a malformed/non-standard restCount is treated the same as
    // "no SH data" rather than risking a fractional, garbage offset below.
    var coeffsPerChannel = (restCount > 0 && restCount % 3 === 0) ? restCount / 3 : 0;

    var propType = {};
    props.forEach(function(p) { propType[p.name] = p.type; });
    var read = function(dv, base, name) { return plyReadScalar(dv, base + offsets[name], propType[name]); };

    if (headerEnd + count * recordSize > buffer.byteLength) {
      throw new Error('PLY file is truncated (vertex data shorter than the header promises)');
    }

    var dv = new DataView(buffer);
    var cap = maxPoints || TRUE_SPLAT_MAX_POINTS;
    var step = count > cap ? Math.ceil(count / cap) : 1;
    // Each dropped splat was itself covering part of the surface; thinning
    // the set to 1-in-`step` without compensation leaves visible gaps
    // between the survivors (reported as "big, separated dots" instead of a
    // continuous surface) -- each kept splat's own scale was fitted assuming
    // its now-discarded neighbours were still there to cover the rest. Grow
    // the survivors to compensate, same cube-root density heuristic already
    // used by _adaptivePointSize for the point-cloud approximation path.
    var scaleComp = step > 1 ? Math.cbrt(step) : 1;
    var n = Math.floor((count + step - 1) / step);
    var positions = new Float32Array(n * 3);
    var cov6 = new Float32Array(n * 6);
    var colors = new Float32Array(n * 4);
    // Degree-1/2 SH coefficients (zero-filled -- i.e. no view-dependent term
    // -- when the file has no f_rest_* data, or not enough of it, at all).
    var sh1 = new Float32Array(n * 3), sh2 = new Float32Array(n * 3), sh3 = new Float32Array(n * 3);
    var sh4 = new Float32Array(n * 3), sh5 = new Float32Array(n * 3), sh6 = new Float32Array(n * 3);
    var sh7 = new Float32Array(n * 3), sh8 = new Float32Array(n * 3);
    var shOut = [sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8];
    var maxCoeff = Math.min(coeffsPerChannel, 8);
    var k = 0;
    for (var vi = 0; vi < count; vi += step) {
      var base = headerEnd + vi * recordSize;

      positions[k * 3]     = read(dv, base, 'x');
      // Same ground-truth-down vs. viewer-Y-up correction as SOG (see
      // parseSOG) -- a 180 degree rotation about X (flip Y AND Z), not a
      // single-axis mirror; the matching covariance sign fix-up follows
      // below.
      positions[k * 3 + 1] = -read(dv, base, 'y');
      positions[k * 3 + 2] = -read(dv, base, 'z');

      var sx = Math.exp(read(dv, base, 'scale_0')) * scaleComp;
      var sy = Math.exp(read(dv, base, 'scale_1')) * scaleComp;
      var sz = Math.exp(read(dv, base, 'scale_2')) * scaleComp;

      var qw = read(dv, base, 'rot_0'), qx = read(dv, base, 'rot_1');
      var qy = read(dv, base, 'rot_2'), qz = read(dv, base, 'rot_3');
      var qlen = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) || 1;
      qw /= qlen; qx /= qlen; qy /= qlen; qz /= qlen;

      var c6 = quatScaleToCovariance6(sx, sy, sz, qw, qx, qy, qz);
      // Sigma' = F*Sigma*F^T for F = diag(1,-1,-1) (180 deg about X): cross
      // terms get multiplied by the product of the two flipped signs --
      // xy and xz each touch exactly one flipped axis (sign flips), yz
      // touches two (signs cancel, stays unflipped). Diagonal entries are
      // always unaffected (each sign squares to 1).
      cov6[k * 6] = c6[0];
      cov6[k * 6 + 1] = -c6[1]; // xy
      cov6[k * 6 + 2] = -c6[2]; // xz
      cov6[k * 6 + 3] = c6[3];
      cov6[k * 6 + 4] = c6[4];  // yz
      cov6[k * 6 + 5] = c6[5];

      var opacityLogit = read(dv, base, 'opacity');
      // Raw DC coefficient -- NOT yet scaled by SH_C0 or offset by 0.5; the
      // vertex shader does that (and adds the degree-1 term below) every
      // frame, since the degree-1 contribution depends on view direction.
      colors[k * 4]     = read(dv, base, 'f_dc_0');
      colors[k * 4 + 1] = read(dv, base, 'f_dc_1');
      colors[k * 4 + 2] = read(dv, base, 'f_dc_2');
      colors[k * 4 + 3] = 1 / (1 + Math.exp(-opacityLogit)); // sigmoid: 3DGS stores opacity as a logit

      // f_rest_* is channel-major: coefficient c of channel R/G/B lives at
      // f_rest_{c}, f_rest_{coeffsPerChannel+c}, f_rest_{2*coeffsPerChannel+c}
      // respectively. Coefficient index c here = CUDA sh[c+1] (sh1=c0, ...,
      // sh8=c7).
      for (var c = 0; c < maxCoeff; c++) {
        var dst = shOut[c];
        dst[k * 3] = read(dv, base, 'f_rest_' + c);
        dst[k * 3 + 1] = read(dv, base, 'f_rest_' + (coeffsPerChannel + c));
        dst[k * 3 + 2] = read(dv, base, 'f_rest_' + (2 * coeffsPerChannel + c));
      }
      k++;
    }

    return {
      positions: positions.subarray(0, k * 3),
      cov6: cov6.subarray(0, k * 6),
      colors: colors.subarray(0, k * 4),
      sh1: sh1.subarray(0, k * 3),
      sh4: sh4.subarray(0, k * 3),
      sh5: sh5.subarray(0, k * 3),
      sh6: sh6.subarray(0, k * 3),
      sh7: sh7.subarray(0, k * 3),
      sh8: sh8.subarray(0, k * 3),
      sh2: sh2.subarray(0, k * 3),
      sh3: sh3.subarray(0, k * 3)
    };
  }

  // Minimal LAS reader (point data record formats 0-3 and 6-8, the common ones).
  // No LAZ: those are converted to LAS server-side. Coordinates are used as-is
  // (the uploader is responsible for a shared, near-origin coordinate system).
  function parseLAS(buffer) {
    var dv = new DataView(buffer);
    if (dv.getUint8(0) !== 0x4C || dv.getUint8(1) !== 0x41 ||
        dv.getUint8(2) !== 0x53 || dv.getUint8(3) !== 0x46) {
      throw new Error('not a LAS file (bad signature)');
    }
    var verMinor = dv.getUint8(25);
    var offsetToPoints = dv.getUint32(96, true);
    var pdrf = dv.getUint8(104) & 0x7f;
    var pdrLen = dv.getUint16(105, true);
    var count = dv.getUint32(107, true);
    if (verMinor >= 4 && count === 0 && dv.getBigUint64) {
      try { count = Number(dv.getBigUint64(247, true)); } catch (e) {}
    }
    var sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
    var ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
    if (!count || !pdrLen) throw new Error('LAS header reports no points');

    var hasRGB = [2, 3, 5, 7, 8, 10].indexOf(pdrf) !== -1;
    var rgbOff = (pdrf <= 5) ? 20 : 30;

    var MAX = 4000000;
    var step = count > MAX ? Math.ceil(count / MAX) : 1;
    var n = Math.floor((count + step - 1) / step);
    var positions = new Float32Array(n * 3);
    var colors = hasRGB ? new Float32Array(n * 3) : null;

    var k = 0;
    for (var i = 0; i < count && k < n; i += step) {
      var p = offsetToPoints + i * pdrLen;
      if (p + 12 > buffer.byteLength) break;
      // Raw X/Y/Z -> x/y/z, no axis swap and no recentering: consistent with
      // PLYLoader, and the uploader owns the shared, near-origin coordinate
      // system across all layers.
      positions[k * 3]     = dv.getInt32(p, true) * sx + ox;
      positions[k * 3 + 1] = dv.getInt32(p + 4, true) * sy + oy;
      positions[k * 3 + 2] = dv.getInt32(p + 8, true) * sz + oz;
      if (colors && p + rgbOff + 6 <= buffer.byteLength) {
        var r = dv.getUint16(p + rgbOff, true);
        var g = dv.getUint16(p + rgbOff + 2, true);
        var b = dv.getUint16(p + rgbOff + 4, true);
        var d = (r > 255 || g > 255 || b > 255) ? 65535 : 255;
        colors[k * 3] = r / d; colors[k * 3 + 1] = g / d; colors[k * 3 + 2] = b / d;
      }
      k++;
    }
    return {
      positions: k === n ? positions : positions.subarray(0, k * 3),
      colors: colors ? (k === n ? colors : colors.subarray(0, k * 3)) : null
    };
  }

  // Decode one lossless WebP entry into its raw RGBA pixel bytes. SOG's spec
  // requires reading image data "as raw 8-bit integers with no gamma
  // conversion" -- a plain canvas 2D readback matches that (no color
  // management applied beyond default sRGB, same as any other WebP texture
  // decode path in a browser).
  function decodeWebpToImageData(bytes) {
    return createImageBitmap(new Blob([bytes], { type: 'image/webp' })).then(function(bitmap) {
      var canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : document.createElement('canvas');
      if (!(canvas instanceof OffscreenCanvas)) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      var img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      if (bitmap.close) bitmap.close();
      return img;
    });
  }

  // 3x3 world-space covariance Sigma = M*M^T, M = R(quat) * diag(sx,sy,sz),
  // returned as its 6 unique symmetric entries [xx,xy,xz,yy,yz,zz]. Shared by
  // every true-splat source (SOG, 3DGS-trained .ply). Verified by hand against
  // two known cases (identity rotation -> diag(sx^2,sy^2,sz^2); 90 deg around Z
  // swaps the x/y variances) before relying on it here.
  function quatScaleToCovariance6(sx, sy, sz, w, x, y, z) {
    var R00 = 1 - 2 * (y * y + z * z), R01 = 2 * (x * y - w * z), R02 = 2 * (x * z + w * y);
    var R10 = 2 * (x * y + w * z), R11 = 1 - 2 * (x * x + z * z), R12 = 2 * (y * z - w * x);
    var R20 = 2 * (x * z - w * y), R21 = 2 * (y * z + w * x), R22 = 1 - 2 * (x * x + y * y);
    var M00 = R00 * sx, M01 = R01 * sy, M02 = R02 * sz;
    var M10 = R10 * sx, M11 = R11 * sy, M12 = R12 * sz;
    var M20 = R20 * sx, M21 = R21 * sy, M22 = R22 * sz;
    return [
      M00 * M00 + M01 * M01 + M02 * M02, // xx
      M00 * M10 + M01 * M11 + M02 * M12, // xy
      M00 * M20 + M01 * M21 + M02 * M22, // xz
      M10 * M10 + M11 * M11 + M12 * M12, // yy
      M10 * M20 + M11 * M21 + M12 * M22, // yz
      M20 * M20 + M21 * M21 + M22 * M22  // zz
    ];
  }

  // Decode a SOG (.sog) bundle -- PlayCanvas's "Spatially Ordered Gaussians"
  // compressed container: a zip of meta.json + a handful of lossless WebP
  // textures, each pixel holding quantized per-Gaussian data. Spec:
  // https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/
  //
  // Decodes position (means_l/means_u), scale+rotation (scales/quats), DC
  // color+opacity (sh0) and, when present, the degree-1 view-dependent color
  // term (shN, first 3 of its coefficients per channel only -- see
  // SplatRenderer for why degree is capped there) -- everything
  // SplatRenderer needs for true elliptical splat shading.
  function parseSOG(buffer, maxPoints) {
    return unzipBuffer(buffer).then(function(files) {
      var names = Object.keys(files);
      var metaName = names.filter(function(n) { return /(^|\/)meta\.json$/i.test(n); })[0];
      if (!metaName) throw new Error('.sog archive has no meta.json');
      var meta = JSON.parse(new TextDecoder('utf-8').decode(files[metaName]));

      if (!meta.means || !meta.means.files || meta.means.files.length < 2) {
        throw new Error('.sog meta.json is missing means.files');
      }
      if (!meta.sh0 || !meta.sh0.files || !meta.sh0.files[0] || !meta.sh0.codebook) {
        throw new Error('.sog meta.json is missing sh0');
      }
      if (!meta.scales || !meta.scales.files || !meta.scales.files[0] || !meta.scales.codebook) {
        throw new Error('.sog meta.json is missing scales');
      }
      if (!meta.quats || !meta.quats.files || !meta.quats.files[0]) {
        throw new Error('.sog meta.json is missing quats');
      }
      var count = meta.count | 0;
      if (!count) throw new Error('.sog meta.json reports zero Gaussians');

      var dir = metaName.indexOf('/') !== -1 ? metaName.slice(0, metaName.lastIndexOf('/') + 1) : '';
      var findFile = function(name) {
        var key = names.filter(function(n) { return n === dir + name || n.split('/').pop() === name; })[0];
        if (!key) throw new Error('.sog archive is missing "' + name + '"');
        return files[key];
      };

      // shN (degree-1+ view-dependent color) is optional -- only decoded when
      // the file actually has it.
      var hasSHN = !!(meta.shN && meta.shN.files && meta.shN.files[0] && meta.shN.files[1] &&
                       meta.shN.codebook && meta.shN.bands >= 1);
      var corePromises = [
        decodeWebpToImageData(findFile(meta.means.files[0])),  // means_l: lower 8 bits / axis
        decodeWebpToImageData(findFile(meta.means.files[1])),  // means_u: upper 8 bits / axis
        decodeWebpToImageData(findFile(meta.sh0.files[0])),    // sh0: RGB = DC color index, A = opacity
        decodeWebpToImageData(findFile(meta.scales.files[0])), // scales: per-axis codebook index
        decodeWebpToImageData(findFile(meta.quats.files[0]))   // quats: RGB = smallest-three, A = mode
      ];
      if (hasSHN) {
        corePromises.push(decodeWebpToImageData(findFile(meta.shN.files[0]))); // shN_centroids: palette
        corePromises.push(decodeWebpToImageData(findFile(meta.shN.files[1]))); // shN_labels: per-Gaussian index
      }
      return Promise.all(corePromises).then(function(imgs) {
        var l = imgs[0].data, u = imgs[1].data, sh0 = imgs[2].data, sc = imgs[3].data, qt = imgs[4].data;
        var shNCentroids = hasSHN ? imgs[5].data : null;
        var shNCentroidsWidth = hasSHN ? imgs[5].width : 0;
        var shNLabels = hasSHN ? imgs[6].data : null;
        var shNCodebook = hasSHN ? meta.shN.codebook : null;
        // Coefficients per channel in the FILE (3/8/15 for bands 1/2/3) --
        // needed to compute the centroid texture's column stride even though
        // only the first 8 (degree 1+2) are actually read below.
        var shNCoeffsPerChannel = hasSHN ? ({ 1: 3, 2: 8, 3: 15 }[meta.shN.bands] || 3) : 0;
        var shNMaxCoeff = Math.min(shNCoeffsPerChannel, 8);
        var mins = meta.means.mins, maxs = meta.means.maxs;
        var shCodebook = meta.sh0.codebook, scCodebook = meta.scales.codebook;
        // Only skip truly zero-opacity Gaussians. A real splat scene relies on
        // many individually low-opacity Gaussians stacking up via back-to-front
        // alpha blending to read as a solid surface -- dropping anything under
        // ~4% opacity (the old threshold) looked harmless splat-by-splat but
        // removed exactly the contributors that fill the gaps between the
        // higher-opacity ones, which is part of why the result looked like
        // separated dots instead of a continuous surface. The actual
        // performance budget is TRUE_SPLAT_MAX_POINTS/the decimation step
        // above, not this filter.
        var MIN_ALPHA = 1;

        var lerp = function(a, b, t) { return a + (b - a) * t; };
        var unlog = function(n) { return Math.sign(n) * (Math.exp(Math.abs(n)) - 1); };
        var INV_SQRT2 = 1 / Math.SQRT2;

        // Stride over the source rather than decoding every Gaussian and
        // decimating afterwards -- saves the (otherwise wasted) decode work
        // for whatever gets thrown away on a heavy file. SOG's own ordering
        // ("Spatially Ordered Gaussians") means a strided subsample stays
        // reasonably representative of the whole scene rather than just its
        // first chunk.
        //
        // Capped against the caller-supplied budget (see _parseModel --
        // higher when the texture-indexed SplatRendererTex will actually be
        // used, since it no longer pays per-splat-payload resort cost) or
        // TRUE_SPLAT_MAX_POINTS as a default. SOG always has scale/quat data
        // and always goes through the true-splat renderer (_buildTrueSplats),
        // never the plain-point fallback, so it must respect one budget or
        // the other.
        var cap = maxPoints || TRUE_SPLAT_MAX_POINTS;
        var step = count > cap ? Math.ceil(count / cap) : 1;
        // See parseSplatPLY's matching comment: compensate thinned-out
        // splats' scale so survivors still cover the gaps left by their
        // discarded neighbours, instead of reading as separated dots.
        var scaleComp = step > 1 ? Math.cbrt(step) : 1;
        var n = Math.floor((count + step - 1) / step);
        var positions = new Float32Array(n * 3);
        var cov6 = new Float32Array(n * 6);
        var colors = new Float32Array(n * 4);
        var sh1 = new Float32Array(n * 3), sh2 = new Float32Array(n * 3), sh3 = new Float32Array(n * 3);
        var sh4 = new Float32Array(n * 3), sh5 = new Float32Array(n * 3), sh6 = new Float32Array(n * 3);
        var sh7 = new Float32Array(n * 3), sh8 = new Float32Array(n * 3);
        var shOut = [sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8];
        var k = 0;
        for (var i = 0; i < count; i += step) {
          var o = i * 4; // ImageData is row-major RGBA, same (x,y) layout as the spec's i = x + y*W
          var a8 = sh0[o + 3];
          if (a8 < MIN_ALPHA) continue;

          var qx = (u[o] << 8) | l[o];
          var qy = (u[o + 1] << 8) | l[o + 1];
          var qz = (u[o + 2] << 8) | l[o + 2];

          positions[k * 3] = unlog(lerp(mins[0], maxs[0], qx / 65535));
          // Gaussian-splat training pipelines commonly author +Y pointing
          // down (ground), the opposite of three.js/this viewer's Y-up
          // convention -- the same reason other splat viewers apply a
          // correction rotation on load. Flipping Y ALONE was tried first,
          // but a single-axis flip is a mirror reflection (determinant -1):
          // it inverts the scene's chirality, which reads to a viewer as a
          // left/right mirroring of any asymmetric content (text, faces,
          // most real objects) even though X itself was never touched -- the
          // classic "looks like a mirror image" effect. Flipping Y AND Z
          // instead is a proper 180 degree rotation about X (determinant
          // +1): same fix for up/down, no chirality inversion, X still
          // genuinely untouched. The matching covariance fix-up is applied
          // below, right after it's built.
          positions[k * 3 + 1] = -unlog(lerp(mins[1], maxs[1], qy / 65535));
          positions[k * 3 + 2] = -unlog(lerp(mins[2], maxs[2], qz / 65535));

          var sx = Math.exp(scCodebook[sc[o]]) * scaleComp;
          var sy = Math.exp(scCodebook[sc[o + 1]]) * scaleComp;
          var sz = Math.exp(scCodebook[sc[o + 2]]) * scaleComp;

          var qa = (qt[o] / 255 - 0.5) * 2.0 * INV_SQRT2;
          var qb = (qt[o + 1] / 255 - 0.5) * 2.0 * INV_SQRT2;
          var qc = (qt[o + 2] / 255 - 0.5) * 2.0 * INV_SQRT2;
          var mode = qt[o + 3] - 252;
          var t = qa * qa + qb * qb + qc * qc;
          var qd = Math.sqrt(Math.max(0, 1 - t));
          var qw, qx_, qy_, qz_;
          if (mode === 0) { qw = qd; qx_ = qa; qy_ = qb; qz_ = qc; }
          else if (mode === 1) { qw = qa; qx_ = qd; qy_ = qb; qz_ = qc; }
          else if (mode === 2) { qw = qa; qx_ = qb; qy_ = qd; qz_ = qc; }
          else { qw = qa; qx_ = qb; qy_ = qc; qz_ = qd; }

          var c6 = quatScaleToCovariance6(sx, sy, sz, qw, qx_, qy_, qz_);
          // Sigma' = F*Sigma*F^T for F = diag(1,-1,-1) (180 deg about X): see
          // the position fix-up comment above. xy/xz each touch exactly one
          // flipped axis (sign flips); yz touches two (signs cancel).
          cov6[k * 6] = c6[0];       // xx
          cov6[k * 6 + 1] = -c6[1];  // xy
          cov6[k * 6 + 2] = -c6[2];  // xz
          cov6[k * 6 + 3] = c6[3];   // yy
          cov6[k * 6 + 4] = c6[4];   // yz
          cov6[k * 6 + 5] = c6[5];   // zz

          // Raw DC coefficient -- NOT yet scaled by SH_C0 or offset by 0.5;
          // the vertex shader does that (and adds the degree-1 term below)
          // every frame, since the degree-1 contribution depends on view
          // direction.
          colors[k * 4]     = shCodebook[sh0[o]];
          colors[k * 4 + 1] = shCodebook[sh0[o + 1]];
          colors[k * 4 + 2] = shCodebook[sh0[o + 2]];
          colors[k * 4 + 3] = a8 / 255;

          if (hasSHN) {
            var label = shNLabels[o] | (shNLabels[o + 1] << 8);
            var colBase = (label % 64) * shNCoeffsPerChannel;
            var rowBase = Math.floor(label / 64) * shNCentroidsWidth;
            // Coefficient index c here = CUDA sh[c+1] (sh1=c0, ..., sh8=c7),
            // same ascending (coefficient-index, then R/G/B) order as
            // parseSplatPLY's f_rest_* reader.
            for (var c = 0; c < shNMaxCoeff; c++) {
              var px = (rowBase + colBase + c) * 4;
              var dst = shOut[c];
              dst[k * 3] = shNCodebook[shNCentroids[px]];
              dst[k * 3 + 1] = shNCodebook[shNCentroids[px + 1]];
              dst[k * 3 + 2] = shNCodebook[shNCentroids[px + 2]];
            }
          }
          k++;
        }

        return {
          positions: positions.subarray(0, k * 3),
          cov6: cov6.subarray(0, k * 6),
          colors: colors.subarray(0, k * 4),
          sh1: sh1.subarray(0, k * 3),
          sh2: sh2.subarray(0, k * 3),
          sh3: sh3.subarray(0, k * 3),
          sh4: sh4.subarray(0, k * 3),
          sh5: sh5.subarray(0, k * 3),
          sh6: sh6.subarray(0, k * 3),
          sh7: sh7.subarray(0, k * 3),
          sh8: sh8.subarray(0, k * 3)
        };
      });
    });
  }

  // Adaptive point size: a flat "modelRadius * constant" guess looks fine
  // for a dense LIDAR/photogrammetry scan, but a far sparser point set
  // (e.g. one point per Gaussian in a splat scene, vs. millions of samples
  // over the same volume) leaves visible gaps with that same guess -- looks
  // like scattered dots instead of a covered surface. Derive the size
  // instead from actual point density: the average spacing implied by this
  // cloud's own bounding-box volume and point count, with a small overlap
  // factor so neighbouring points' discs touch rather than gap.
  SpatialViewerApp.prototype._adaptivePointSize = function(geom, count) {
    var size = (this.modelRadius || 20) * 0.0012;
    if (geom.boundingBox && count > 1) {
      var bsize = new THREE.Vector3();
      geom.boundingBox.getSize(bsize);
      var volume = Math.max(bsize.x, 1e-6) * Math.max(bsize.y, 1e-6) * Math.max(bsize.z, 1e-6);
      var spacing = Math.cbrt(volume / count);
      if (isFinite(spacing) && spacing > 0) {
        var floor = (this.modelRadius || 20) * 0.0003, ceil = (this.modelRadius || 20) * 0.03;
        size = Math.min(ceil, Math.max(floor, spacing * 1.8));
      }
    }
    return size;
  };

  SpatialViewerApp.prototype._buildPointCloud = function(data) {
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.positions), 3));
    geom.computeBoundingBox();
    var size = this._adaptivePointSize(geom, data.positions.length / 3);

    var mat;
    if (data.colors) {
      geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.colors), 3));
      mat = new THREE.PointsMaterial({ size: size, vertexColors: true, sizeAttenuation: true });
    } else {
      mat = new THREE.PointsMaterial({ size: size, color: 0x9aa7b4, sizeAttenuation: true });
    }
    geom.computeBoundingSphere();
    return new THREE.Points(geom, mat);
  };

  // Max Gaussians/vertices actually submitted to the GPU for a splat-kind
  // layer (.ply/.splat/.ksplat/.sog). Heavy scenes had NO cap at all before
  // this, unlike LAS point clouds (capped at 4M in parseLAS) -- the main
  // cause of "very slow on heavy models". Splats also tend to render as
  // bigger discs than LAS's tiny dots (see _adaptivePointSize), so the
  // fill-rate cost per point is higher too; the cap is set lower than LAS's.
  var SPLAT_MAX_POINTS = 2000000;

  // Strided (not random) subsample: cheap, and for spatially-ordered data
  // (SOG's own design, see decodeWebpToImageData's caller) still reasonably
  // representative of the whole cloud rather than clustering losses in one area.
  function decimateXYZ(positions, colors, maxCount) {
    var count = positions.length / 3;
    if (count <= maxCount) return { positions: positions, colors: colors };
    var step = Math.ceil(count / maxCount);
    var n = Math.floor((count + step - 1) / step);
    var outP = new Float32Array(n * 3);
    var outC = colors ? new Float32Array(n * 3) : null;
    var k = 0;
    for (var i = 0; i < count; i += step) {
      outP[k * 3] = positions[i * 3]; outP[k * 3 + 1] = positions[i * 3 + 1]; outP[k * 3 + 2] = positions[i * 3 + 2];
      if (outC) { outC[k * 3] = colors[i * 3]; outC[k * 3 + 1] = colors[i * 3 + 1]; outC[k * 3 + 2] = colors[i * 3 + 2]; }
      k++;
    }
    return { positions: outP.subarray(0, k * 3), colors: outC ? outC.subarray(0, k * 3) : null };
  }

  // Gaussian-splat-kind rendering (.ply/.splat/.ksplat/.sog): same adaptive
  // point sizing as _buildPointCloud, plus a soft round falloff instead of a
  // hard square/disc, loosely "inspired by" how dedicated splat renderers
  // (e.g. SuperSplat) blend overlapping splats -- this is still a point-cloud
  // approximation, not true per-Gaussian covariance shading (no scale/
  // rotation/SH data is decoded anywhere in this viewer), but the falloff
  // reads much closer to a real splat surface than a grid of hard dots, and
  // the early `discard` on the PointsMaterial's unused square corners trims
  // some otherwise-wasted fill-rate on top of the point-count cap above.
  SpatialViewerApp.prototype._buildSplatPoints = function(rawPositions, rawColors) {
    var decimated = decimateXYZ(rawPositions, rawColors, SPLAT_MAX_POINTS);

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(decimated.positions), 3));
    geom.computeBoundingBox();
    var size = this._adaptivePointSize(geom, decimated.positions.length / 3);

    var mat = decimated.colors
      ? new THREE.PointsMaterial({ size: size, vertexColors: true, sizeAttenuation: true })
      : new THREE.PointsMaterial({ size: size, color: 0x9aa7b4, sizeAttenuation: true });
    if (decimated.colors) geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(decimated.colors), 3));

    // Leaves three.js's own vertex shader (and its size-attenuation / pixel
    // ratio uniform bookkeeping, refreshed automatically every frame) alone
    // entirely -- only the fragment shader gets a few extra lines, via the
    // same hook THREE.Material itself documents for exactly this kind of
    // small, targeted customization.
    mat.onBeforeCompile = function(shader) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'void main() {\n' +
        '\tvec2 _splatUv = gl_PointCoord * 2.0 - 1.0;\n' +
        '\tfloat _splatD2 = dot(_splatUv, _splatUv);\n' +
        '\tif (_splatD2 > 1.0) discard;\n' +
        '\tfloat _splatFalloff = exp(-_splatD2 * 4.0);\n'
      ).replace(
        '#include <dithering_fragment>',
        'gl_FragColor.a *= _splatFalloff;\n\t#include <dithering_fragment>'
      );
    };
    mat.transparent = true;
    mat.depthWrite = false;

    geom.computeBoundingSphere();
    return new THREE.Points(geom, mat);
  };

  // ---- True Gaussian-splat rendering --------------------------------------
  // Per-splat 3D->2D covariance projection (EWA splatting, the technique
  // behind the original "3D Gaussian Splatting" paper and every WebGL splat
  // viewer, including SuperSplat/PlayCanvas) instead of a plain colored
  // point. Each Gaussian is drawn as a camera-facing quad sized/oriented to
  // its own projected covariance ellipse; the fragment shader evaluates the
  // actual 2D Gaussian falloff inside it. Depth-sorted back-to-front for
  // correct alpha blending (see SplatRenderer.resort), throttled rather than
  // re-sorted every single frame -- see maybeResort.
  //
  // Lower point budget than the plain point-cloud path: each splat carries
  // 37 floats (vs. 6-7 for a plain point) and the vertex shader does real
  // per-instance matrix math plus a spherical-harmonics evaluation, so the
  // same "heavy model" budget costs more here. Capped at degree-2 SH (8 of
  // up to 15 possible per-channel coefficients) rather than the full
  // degree-3 a file may contain: each additional band roughly doubles the
  // per-splat payload (and so the resort/reorder cost, already this
  // renderer's single most expensive operation -- see SplatRenderer.resort),
  // for steeply diminishing visual return past the first couple of bands.
  // Raised from the original "same resort-cost budget as before SH" value
  // (420,000) to 1,000,000 at the user's explicit request, after confirming
  // speed was still acceptable at the lower cap -- this knowingly costs
  // roughly 2.4x the resort/reorder time (linear in splat count at a fixed
  // stride), paid once per idle-settle (see maybeResort's debounce), not
  // per frame while navigating.
  var TRUE_SPLAT_MAX_POINTS = 1000000;

  var SPLAT_VERTEX_SHADER = [
    'precision highp float;',
    'attribute vec2 corner;',
    'attribute vec3 center;',
    'attribute vec3 covA;', // Sxx, Sxy, Sxz
    'attribute vec3 covB;', // Syy, Syz, Szz
    'attribute vec4 colorOpacity;', // rgb = RAW DC coefficient (not yet scaled/offset), a = opacity
    // Spherical harmonics coefficients, degree 1 (sh1-3) and 2 (sh4-8),
    // rgb per coefficient, zero when the source has no (or less) view-
    // dependent data than this. Indices/signs match the reference 3DGS
    // computeColorFromSH: sh[1]=y-term, sh[2]=z-term, sh[3]=x-term (degree
    // 1); sh[4..8] per the degree-2 term below.
    'attribute vec3 sh1;',
    'attribute vec3 sh2;',
    'attribute vec3 sh3;',
    'attribute vec3 sh4;',
    'attribute vec3 sh5;',
    'attribute vec3 sh6;',
    'attribute vec3 sh7;',
    'attribute vec3 sh8;',
    'uniform vec2 focal;',    // fx, fy in pixels
    'uniform vec2 viewport;', // drawing-buffer size in pixels
    'varying vec4 vColor;',
    'varying vec2 vPos;',
    'void main() {',
    '  vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);',
    '  float zc = mvPosition.z;',
    '  if (zc > -0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }', // behind/at the camera: clip it
    '  mat3 Vrk = mat3(',
    '    covA.x, covA.y, covA.z,',
    '    covA.y, covB.x, covB.y,',
    '    covA.z, covB.y, covB.z',
    '  );',
    '  mat3 W = mat3(modelViewMatrix);',
    '  mat3 J = mat3(',
    '    focal.x / -zc, 0.0, 0.0,',
    '    0.0, focal.y / -zc, 0.0,',
    '    (focal.x * mvPosition.x) / (zc * zc), (focal.y * mvPosition.y) / (zc * zc), 0.0',
    '  );',
    '  mat3 T = J * W;',
    '  mat3 cov2d = T * Vrk * transpose(T);',
    '  float a = cov2d[0][0] + 0.25;', // + a small, constant px^2 dilation: numerical
    '  float b = cov2d[0][1];',        // floor against degenerate/zero-size splats, and a
    '  float c = cov2d[1][1] + 0.25;', // touch of antialiasing (same trick as common 3DGS renderers)
    '  float mid = 0.5 * (a + c);',
    '  float diff = 0.5 * (a - c);',
    '  float rad = sqrt(max(0.0, diff * diff + b * b));',
    '  float lambda1 = mid + rad;',
    '  float lambda2 = max(mid - rad, 0.01);',
    '  vec2 eig1 = (abs(b) > 1e-4) ? normalize(vec2(b, lambda1 - a)) : (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0));',
    '  vec2 eig2 = vec2(-eig1.y, eig1.x);',
    // 3 sigma, clamped against pathological scales -- PROPORTIONAL to the
    // actual viewport, not a large fixed constant: a genuinely huge/needle
    // Gaussian (common in real trained scenes -- poorly-constrained
    // background/sparse-coverage regions routinely produce a few splats
    // with scale far beyond the rest of the model) would otherwise balloon
    // into a quad several times WIDER than the whole canvas on a modest
    // viewport, dominating the screen and barely changing size as the
    // camera moves (since it is pinned at the same oversized clamp across a
    // wide range of distances) -- exactly the "stuck, wrong-looking area"
    // symptom this fixes. Ported from PlayCanvas's own splat shader
    // (verified by reading their bundled source, not guessed): same
    // "1024, or the viewport if smaller" cap, applied to our own already-
    // verified 3-sigma value rather than adopting their differently-scaled
    // one, to change only what needed fixing.
    '  float maxR = min(min(viewport.x, viewport.y), 1024.0);',
    '  float r1 = min(sqrt(lambda1) * 3.0, maxR);',
    '  float r2 = min(sqrt(lambda2) * 3.0, maxR);',
    '  vec2 screenOffsetPx = corner.x * eig1 * r1 + corner.y * eig2 * r2;',
    '  vec4 clip = projectionMatrix * mvPosition;',
    '  clip.xy += screenOffsetPx * (2.0 / viewport) * clip.w;',
    '  gl_Position = clip;',
    // View-dependent color: ported from the reference 3DGS computeColorFromSH
    // (degree 1+2 -- see the TRUE_SPLAT_MAX_POINTS comment on why it stops
    // there). `dir` is the world-space direction from the splat to the
    // camera, matching the reference's `dir = pos - campos` (both built-in
    // uniforms three.js provides to every ShaderMaterial).
    '  vec3 worldCenter = (modelMatrix * vec4(center, 1.0)).xyz;',
    '  vec3 dir = normalize(worldCenter - cameraPosition);',
    '  float dx = dir.x, dy = dir.y, dz = dir.z;',
    '  float dxx = dx * dx, dyy = dy * dy, dzz = dz * dz;',
    '  float dxy = dx * dy, dyz = dy * dz, dxz = dx * dz;',
    '  vec3 col = 0.28209479177387814 * colorOpacity.rgb',
    '    + 0.4886025119029199 * (-dy * sh1 + dz * sh2 - dx * sh3)',
    '    + 1.0925484305920792 * dxy * sh4',
    '    - 1.0925484305920792 * dyz * sh5',
    '    + 0.31539156525252005 * (2.0 * dzz - dxx - dyy) * sh6',
    '    - 1.0925484305920792 * dxz * sh7',
    '    + 0.5462742152960396 * (dxx - dyy) * sh8',
    '    + 0.5;',
    '  vColor = vec4(clamp(col, 0.0, 1.0), colorOpacity.a);',
    '  vPos = corner * 3.0;', // corner in {-1..1} along each ellipse axis -> *3 = "how many sigma", since r1/r2 above already encode the 3-sigma extent
    '}'
  ].join('\n');

  var SPLAT_FRAGMENT_SHADER = [
    'precision highp float;',
    'uniform float opacity;',
    // 0 (default, every non-glTF source): the reconstructed color is
    // already display-referred (matches "srgb_rec709_display" per the
    // KHR_gaussian_splatting spec, the same convention .sog/.ply already
    // assume) -- used as-is. 1: the source declared "lin_rec709_display"
    // (linear-light) color -- gl_FragColor is written with no further
    // encoding pass (see the note on custom ShaderMaterial bypassing
    // three.js's output-encoding pipeline), so the standard sRGB OETF is
    // applied here instead, once per fragment, before writing it out.
    'uniform float linearColor;',
    'varying vec4 vColor;',
    'varying vec2 vPos;',
    'void main() {',
    '  float r2 = dot(vPos, vPos);',
    '  if (r2 > 9.0) discard;', // outside the 3-sigma ellipse
    '  float falloff = exp(-0.5 * r2);',
    '  float a = vColor.a * falloff * opacity;',
    '  if (a < 0.01) discard;',
    '  vec3 outColor = vColor.rgb;',
    '  if (linearColor > 0.5) {',
    '    vec3 lo = outColor * 12.92;',
    '    vec3 hi = 1.055 * pow(outColor, vec3(1.0 / 2.4)) - 0.055;',
    '    outColor = mix(lo, hi, step(vec3(0.0031308), outColor));',
    '  }',
    '  gl_FragColor = vec4(outColor, a);',
    '}'
  ].join('\n');

  // positions: Float32Array(n*3); cov6: Float32Array(n*6) [xx,xy,xz,yy,yz,zz];
  // colors: Float32Array(n*4) [r,g,b,a] -- rgb is the RAW DC coefficient (not
  // yet scaled/offset, see parseSOG/parseSplatPLY), a is opacity in its final
  // 0..1 form; sh1..sh8: Float32Array(n*3) each, degree-1 (sh1-3) and
  // degree-2 (sh4-8) SH coefficients (zero-filled when the source has no, or
  // less, view-dependent data than this); colorSpaceLinear: true only for a
  // glTF KHR_gaussian_splatting primitive declaring "lin_rec709_display"
  // (see SPLAT_FRAGMENT_SHADER) -- falsy/omitted for every other source.
  function SplatRenderer(positions, cov6, colors, sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8, colorSpaceLinear) {
    var n = positions.length / 3;
    this.count = n;

    // All per-instance data lives in ONE interleaved buffer (center.xyz,
    // covA.xyz, covB.xyz, colorOpacity.xyzw, sh1.xyz .. sh8.xyz -- 37
    // floats/splat). A resort reorders every splat's data every time it
    // runs; profiling showed a single combined copy loop over one contiguous
    // buffer is roughly 2x faster than the same copy spread across several
    // separate attribute arrays (cache locality -- one run per splat instead
    // of several smaller, scattered ones), which matters a lot given resort
    // is already the single most expensive operation this renderer does.
    var STRIDE = 37;
    this.STRIDE = STRIDE;
    var shAll = [sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8];
    var src = new Float32Array(n * STRIDE);
    for (var i0 = 0; i0 < n; i0++) {
      var o0 = i0 * STRIDE;
      src[o0] = positions[i0 * 3]; src[o0 + 1] = positions[i0 * 3 + 1]; src[o0 + 2] = positions[i0 * 3 + 2];
      src[o0 + 3] = cov6[i0 * 6]; src[o0 + 4] = cov6[i0 * 6 + 1]; src[o0 + 5] = cov6[i0 * 6 + 2];
      src[o0 + 6] = cov6[i0 * 6 + 3]; src[o0 + 7] = cov6[i0 * 6 + 4]; src[o0 + 8] = cov6[i0 * 6 + 5];
      src[o0 + 9] = colors[i0 * 4]; src[o0 + 10] = colors[i0 * 4 + 1];
      src[o0 + 11] = colors[i0 * 4 + 2]; src[o0 + 12] = colors[i0 * 4 + 3];
      for (var sc = 0; sc < 8; sc++) {
        var so = o0 + 13 + sc * 3, sh = shAll[sc];
        src[so] = sh[i0 * 3]; src[so + 1] = sh[i0 * 3 + 1]; src[so + 2] = sh[i0 * 3 + 2];
      }
    }
    this.srcInterleaved = src;

    var geom = new THREE.InstancedBufferGeometry();
    geom.instanceCount = n;
    geom.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 2));
    geom.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));

    this.dataBuffer = new THREE.InstancedInterleavedBuffer(new Float32Array(n * STRIDE), STRIDE, 1);
    geom.setAttribute('center', new THREE.InterleavedBufferAttribute(this.dataBuffer, 3, 0));
    geom.setAttribute('covA', new THREE.InterleavedBufferAttribute(this.dataBuffer, 3, 3));
    geom.setAttribute('covB', new THREE.InterleavedBufferAttribute(this.dataBuffer, 3, 6));
    geom.setAttribute('colorOpacity', new THREE.InterleavedBufferAttribute(this.dataBuffer, 4, 9));
    for (var sa = 0; sa < 8; sa++) {
      geom.setAttribute('sh' + (sa + 1), new THREE.InterleavedBufferAttribute(this.dataBuffer, 3, 13 + sa * 3));
    }

    // World-space extent of the actual splat centers. This geometry has no
    // attribute literally named "position" (the per-vertex quad corner is
    // "corner", per-instance offsets only exist inside the vertex shader),
    // so BOTH of these must be set explicitly -- three.js's own
    // computeBoundingBox()/computeBoundingSphere() look specifically for
    // "position" and silently produce an empty/degenerate box otherwise.
    // That empty box is what Box3.expandByObject (used by onModelLoaded to
    // frame the camera and fit the near/far clip planes) would then
    // silently copy in -- union'd into a scene that's otherwise empty, it
    // collapses the whole framing to onModelLoaded's generic "model
    // bounding box is not finite" fallback (centered at the origin,
    // maxDim=20) regardless of this layer's real size. That mismatch is
    // exactly what produced "huge, disconnected" splats (camera framed far
    // too close relative to the real scene scale) and splats disappearing
    // past an incorrectly-near far clip plane as soon as the camera moved
    // away from the lucky initial position -- fixed by giving three.js the
    // real extent for both.
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i < n; i++) {
      var px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
    geom.boundingSphere = new THREE.Sphere();
    geom.boundingBox.getBoundingSphere(geom.boundingSphere);
    // Splat centers aren't the full visual extent -- each one is actually
    // drawn as a quad up to 3-sigma wide around its center. Pad the culling
    // radius a bit so splats right at the edge of the cloud don't get
    // clipped out just because their center (not their visible edge) left
    // the frustum/sphere first.
    geom.boundingSphere.radius *= 1.15;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        focal: { value: new THREE.Vector2(1000, 1000) },
        viewport: { value: new THREE.Vector2(1000, 1000) },
        opacity: { value: 1.0 },
        linearColor: { value: colorSpaceLinear ? 1.0 : 0.0 }
      },
      vertexShader: SPLAT_VERTEX_SHADER,
      fragmentShader: SPLAT_FRAGMENT_SHADER,
      transparent: true,
      // Explicit, even though it's three.js's own default: back-to-front
      // depth-sorted splats only composite correctly under standard "over"
      // blending, so this is pinned rather than left implicit.
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(geom, mat);
    // The real per-splat position only exists after the vertex shader's
    // GPU-side billboard math -- THREE.Mesh's default CPU raycast tests the
    // (meaningless, 4-vertex) base quad instead, so disable it rather than
    // let it report wrong/spurious hits. Lasso/pin/measurement tools simply
    // cannot target a true-splat layer; same trade-off every WebGL splat
    // viewer makes, since none of them are CPU-raycastable either.
    this.mesh.raycast = function() {};
    this.mesh.frustumCulled = true;

    this._order = new Uint32Array(n);
    for (var oi = 0; oi < n; oi++) this._order[oi] = oi;
    this._depths = new Float32Array(n);
    this._bucketOf = new Uint32Array(n);
    // Counting sort is O(n + buckets): raising this is one bigger
    // fixed-size pass per resort, not more per-splat work, so it's
    // effectively free at this renderer's point counts. A coarser bucket
    // count left splats sharing a bucket (common in a thin depth slice,
    // e.g. a wall viewed at a shallow angle) blended in arbitrary order
    // relative to each other -- small but visible blending artifacts in
    // dense regions.
    this._BUCKETS = 65536;
    this._counts = new Uint32Array(this._BUCKETS + 1);
    this._tmpMatrix = new THREE.Matrix4();
    this._tmpDir = new THREE.Vector3();
    this._lastSeenPos = null;
    this._lastSeenQuat = null;
    this._idleSince = -Infinity; // forces a sort on the very first updateFrame, even with zero camera movement
    this._idleDelayMs = 140;
    this._dirty = true;
    this._moveEpsSq = 1e-6;

    // Off-main-thread sort: the worker only ever computes and returns a
    // reorder of splat INDICES (never touches the splat data itself, which
    // stays untouched in srcInterleaved) -- see maybeResort for how this
    // lets it run continuously in the background *while the camera moves*,
    // without ever blocking the main thread, so the order for wherever the
    // camera ends up is usually already computed by the time it actually
    // settles. Ported from PlayCanvas's own GSplatSorter/SortWorker (verified
    // by reading their actual bundled source, not guessed) -- same adaptive
    // chunked pre-binning, see splat_sort_worker.js. Falls back to the
    // original synchronous resort()/maybeResort() below when a Worker can't
    // be created at all (very old/locked-down browsers).
    this._worker = null;
    this._workerBusy = false;
    this._pendingOrder = null; // stashed here, only applied once idle -- see maybeResort
    if (window.Worker) {
      try {
        this._worker = new Worker('/assets/openproject_spatial_viewer/splat_sort_worker.js');
        var self = this;
        this._worker.onmessage = function(ev) {
          self._workerBusy = false;
          // Kept as a Uint32Array view over the transferred buffer (not
          // copied) until maybeResort actually consumes it below -- the
          // buffer is handed back to the worker's pool right after that, so
          // steady-state navigation never forces the worker to allocate a
          // fresh multi-megabyte order array per resort (see
          // splat_sort_worker.js's 'release' message).
          if (ev.data && ev.data.type === 'order') self._pendingOrder = new Uint32Array(ev.data.order);
        };
        this._worker.onerror = function(err) {
          console.warn('[SpatialViewer] splat sort worker failed, falling back to main-thread sort:', err && err.message);
          self._worker = null;
        };
        // A fresh copy, sized exactly to the logical (possibly subarray'd)
        // view -- transferring positions.buffer directly would hand the
        // worker whatever backing allocation it happens to share, which can
        // be larger than the n*3 floats actually in use.
        var centersCopy = new Float32Array(positions);
        this._worker.postMessage({ type: 'init', centers: centersCopy.buffer }, [centersCopy.buffer]);
      } catch (err) {
        console.warn('[SpatialViewer] could not create splat sort worker, falling back to main-thread sort:', err);
        this._worker = null;
      }
    }

    this._applyOrder(this._order); // initial fill, unsorted (still correct, just not depth-ordered until the first resort)
  }

  // Copies source data into the GPU-bound interleaved buffer in the given
  // draw order (order[slot] = source splat index), as one contiguous
  // per-splat run (see the constructor's note on why this is interleaved).
  SplatRenderer.prototype._applyOrder = function(order) {
    var n = this.count, STRIDE = this.STRIDE;
    var src = this.srcInterleaved, dst = this.dataBuffer.array;
    for (var slot = 0; slot < n; slot++) {
      var so = order[slot] * STRIDE, doff = slot * STRIDE;
      for (var c = 0; c < STRIDE; c++) dst[doff + c] = src[so + c];
    }
    this.dataBuffer.needsUpdate = true;
  };

  // O(n) back-to-front depth sort via bucket/counting sort (never a
  // comparator-based Array.sort -- too slow at a million-plus elements to
  // run on the main thread at interactive rates). Buckets the view-space
  // depth of every splat, counting-sorts by bucket, then physically
  // reorders the interleaved GPU buffer into that order. Reordering the
  // full per-splat record (not just a lightweight index) costs more per
  // call, but keeps the shader simple (no data-texture indirection) --
  // affordable specifically because resort calls are debounced on camera
  // idle, not run every frame (see maybeResort).
  SplatRenderer.prototype.resort = function(camera) {
    var n = this.count;
    if (n < 2) return;
    var mv = this._tmpMatrix.multiplyMatrices(camera.matrixWorldInverse, this.mesh.matrixWorld);
    var e = mv.elements;
    var e2 = e[2], e6 = e[6], e10 = e[10], e14 = e[14];
    var src = this.srcInterleaved, STRIDE = this.STRIDE, depths = this._depths;
    var minD = Infinity, maxD = -Infinity;
    for (var i = 0; i < n; i++) {
      var o = i * STRIDE;
      var d = e2 * src[o] + e6 * src[o + 1] + e10 * src[o + 2] + e14;
      depths[i] = d;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    var range = Math.max(1e-6, maxD - minD);
    var BUCKETS = this._BUCKETS, bucketOf = this._bucketOf, counts = this._counts;
    counts.fill(0);
    for (var j = 0; j < n; j++) {
      var bk = Math.min(BUCKETS - 1, Math.max(0, ((depths[j] - minD) / range * BUCKETS) | 0));
      bucketOf[j] = bk;
      counts[bk + 1]++;
    }
    for (var bi = 0; bi < BUCKETS; bi++) counts[bi + 1] += counts[bi];
    // Ascending bucket = most negative view-space Z first = farthest first
    // = correct back-to-front order for standard "over" alpha blending.
    var cursor = counts.slice();
    var order = this._order;
    for (var k = 0; k < n; k++) {
      var b = bucketOf[k];
      order[cursor[b]++] = k;
    }
    this._applyOrder(order);
  };

  // The direction (in the splat data's own local space) along which depth is
  // measured for sorting: row 2 of camera.matrixWorldInverse * mesh.matrixWorld,
  // normalized. Folds in the mesh's own transform (non-identity for a
  // glTF-embedded KHR_gaussian_splatting primitive, see
  // _parseGltfGaussianSplatting), same vector resort() has always used for
  // this -- just factored out so the worker path (below) and the fallback
  // path can share it.
  SplatRenderer.prototype._sortDirection = function(camera) {
    var mv = this._tmpMatrix.multiplyMatrices(camera.matrixWorldInverse, this.mesh.matrixWorld);
    var e = mv.elements;
    return this._tmpDir.set(e[2], e[6], e[10]).normalize();
  };

  // Asks the worker to compute a fresh order for the current camera state.
  // Never touches srcInterleaved/dataBuffer itself -- see onmessage in the
  // constructor, which only stashes the result in _pendingOrder. Applying it
  // (the actual expensive part, _applyOrder's copy) is a separate, later
  // step -- see maybeResort below for why.
  SplatRenderer.prototype._requestWorkerSort = function(camera) {
    this._workerBusy = true;
    var dir = this._sortDirection(camera);
    var p = camera.position;
    // Remembered so maybeResort can tell, once the reply lands, whether it
    // was actually computed for where the camera ended up or for a slightly
    // earlier position passed through while the worker was still busy with
    // this very request -- see maybeResort's post-apply check.
    this._requestedPos = (this._requestedPos || new THREE.Vector3()).copy(p);
    this._requestedDir = (this._requestedDir || new THREE.Vector3()).copy(dir);
    this._worker.postMessage({
      type: 'camera',
      position: { x: p.x, y: p.y, z: p.z },
      direction: { x: dir.x, y: dir.y, z: dir.z }
    });
  };

  // Still resorts on IDLE, not on movement -- a tempting first instinct with
  // a worker available is "just apply every order as soon as it arrives,
  // since the sort math is off-thread now." That doesn't actually help:
  // _applyOrder's interleaved-buffer COPY (not the O(n) bucket sort the
  // worker now does) is the expensive part (measured ~70-150ms at this
  // renderer's point budget -- see _applyOrder/the constructor), and that
  // copy still has to happen on the main thread regardless of where the sort
  // itself runs. Applying every reply while the camera is still moving would
  // mean a multi-frame stall *repeating throughout the whole gesture* --
  // worse than before, not better.
  //
  // What the worker DOES change: while the camera is moving, this keeps
  // asking it to compute a fresh order in the background (cheap -- just a
  // postMessage, no main-thread blocking) via _pendingOrder, instead of doing
  // nothing until the camera stops. By the time the camera has been idle for
  // _idleDelayMs, the worker has very likely already finished computing the
  // order for that final resting view during the motion/debounce window, so
  // applying it only pays the copy cost, not copy+sort-compute. Same number
  // of (still real) hitches as before -- one per idle-settle -- just a
  // smaller one each time.
  SplatRenderer.prototype.maybeResort = function(camera) {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var p = camera.position, q = camera.quaternion;
    var moved = !this._lastSeenPos ||
      this._lastSeenPos.distanceToSquared(p) > this._moveEpsSq ||
      (1 - Math.abs(this._lastSeenQuat.dot(q))) > 1e-6;

    if (moved) {
      this._lastSeenPos = (this._lastSeenPos || new THREE.Vector3()).copy(p);
      this._lastSeenQuat = (this._lastSeenQuat || new THREE.Quaternion()).copy(q);
      this._idleSince = now;
      this._dirty = true;
      if (this._worker && !this._workerBusy) this._requestWorkerSort(camera);
      return;
    }
    if (!this._dirty) return; // already sorted for this resting view
    if (now - this._idleSince < this._idleDelayMs) return; // still inside the debounce window

    if (this._worker) {
      if (this._pendingOrder) {
        var appliedBuf = this._pendingOrder.buffer;
        this._applyOrder(this._pendingOrder);
        this._pendingOrder = null;
        // Hand the buffer back to the worker's pool now that its contents
        // have been fully read -- see splat_sort_worker.js's 'release'
        // handler. Keeps steady-state memory churn bounded during long
        // navigation sessions instead of a fresh allocation per resort.
        this._worker.postMessage({ type: 'release', buffer: appliedBuf }, [appliedBuf]);
        // The order just applied was computed for whatever position/
        // direction _requestWorkerSort last sent -- if the worker was still
        // busy with that request while the camera kept drifting a little
        // more before actually settling (routine while continuously
        // orbiting: requests are only sent when the worker is free, so the
        // last couple of moved-frames right before stopping can be skipped),
        // what we just applied is for a slightly stale viewpoint, not the
        // true final one. Silently calling that "done" (clearing _dirty)
        // is exactly how a depth-sensitive region could end up stuck on a
        // not-quite-right order after the camera visibly stops -- catch up
        // with one more request instead, and leave _dirty set so this is
        // re-checked once THAT reply lands too.
        var dirNow = this._sortDirection(camera);
        var stale = !this._requestedPos ||
          this._requestedPos.distanceToSquared(p) > this._moveEpsSq ||
          (1 - Math.abs(this._requestedDir.dot(dirNow))) > 1e-6;
        if (stale && !this._workerBusy) {
          this._requestWorkerSort(camera);
        } else {
          this._dirty = false;
        }
      } else if (!this._workerBusy) {
        // Nothing computed yet for this view (e.g. the very first frame) --
        // ask once; re-checked next tick once the reply lands.
        this._requestWorkerSort(camera);
      }
      return;
    }

    this.resort(camera);
    this._dirty = false;
  };

  // projCamera (optional) supplies the projection matrix used for the
  // focal/viewport uniforms -- normally the same as camera, but during a
  // WebXR session the caller passes one eye's sub-camera here instead (see
  // initThree's render loop), since the flat `camera`'s own symmetric
  // projection doesn't match either eye's actual asymmetric one. `camera`
  // itself is still used for the depth-sort direction regardless -- three.js
  // keeps its matrixWorld synced to the head's averaged pose in XR, so it
  // stays correct for that purpose either way.
  SplatRenderer.prototype.updateFrame = function(camera, viewportW, viewportH, projCamera) {
    var pc = projCamera || camera;
    var u = this.mesh.material.uniforms;
    u.focal.value.set(
      pc.projectionMatrix.elements[0] * viewportW * 0.5,
      pc.projectionMatrix.elements[5] * viewportH * 0.5
    );
    u.viewport.value.set(viewportW, viewportH);
    this.maybeResort(camera);
  };

  // ---- True Gaussian-splat rendering, texture-indexed data (WebGL2) ------
  // The non-texture SplatRenderer above reorders every splat's full 37-float
  // record on every resort, which is the dominant cost of a resort (not the
  // O(n) bucket sort -- see its own comments). PlayCanvas's own splat
  // renderer (the actual production code behind the reference viewer the
  // user compared this against -- read directly, not guessed) avoids that
  // cost entirely a different way: splat data lives in textures, indexed by
  // each splat's ORIGINAL id and never touched again after upload; the only
  // thing a resort reorders is a tiny per-instance index telling each GPU
  // instance which texel to read. Ported here using plain GLSL ES 1.00
  // `texture2D` (not GLSL3 `texelFetch` + integer textures, which is what
  // PlayCanvas's WebGL2 path actually uses) sampled at an exact texel-center
  // UV -- a much older, lower-risk technique (predates GLSL3 entirely, long
  // used for exactly this "treat a texture as a lookup array" purpose) that
  // still gets the same result: the reordered-per-resort data shrinks from
  // 37 floats/splat to 1.
  //
  // Requires WebGL2 (floating-point textures and vertex texture fetch are
  // both guaranteed there, neither is on plain WebGL1) and a Worker (see
  // _buildTrueSplats) -- SplatRenderer above remains the automatic fallback
  // when either is unavailable, untouched.
  function splatTexLayout(n) {
    var w = Math.max(1, Math.ceil(Math.sqrt(n)));
    var h = Math.max(1, Math.ceil(n / w));
    return { width: w, height: h };
  }

  function makeSplatDataTexture(data, width, height) {
    var tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false; // plain row-major lookup table, not an image
    tex.needsUpdate = true;
    return tex;
  }

  // Same math as SPLAT_VERTEX_SHADER (copied verbatim from "vec4 mvPosition ="
  // onward -- see that shader for how/why it's verified) -- the only
  // difference is how center/covA/covB/colorOpacity/sh1-8 are obtained: a
  // texture2D lookup per splat instead of a per-instance attribute.
  var SPLAT_VERTEX_SHADER_TEX = [
    'precision highp float;',
    'attribute vec2 corner;',
    'attribute float sourceIndex;', // the ONLY thing a resort ever rewrites here
    'uniform vec2 texSize;',
    'uniform sampler2D texCenter;',        // xyz = position
    'uniform sampler2D texCovA;',          // xyz = Sxx, Sxy, Sxz
    'uniform sampler2D texCovB;',          // xyz = Syy, Syz, Szz
    'uniform sampler2D texColorOpacity;',  // rgb = RAW DC coefficient, a = opacity
    'uniform sampler2D texSH1;',
    'uniform sampler2D texSH2;',
    'uniform sampler2D texSH3;',
    'uniform sampler2D texSH4;',
    'uniform sampler2D texSH5;',
    'uniform sampler2D texSH6;',
    'uniform sampler2D texSH7;',
    'uniform sampler2D texSH8;',
    'uniform vec2 focal;',    // fx, fy in pixels
    'uniform vec2 viewport;', // drawing-buffer size in pixels
    'varying vec4 vColor;',
    'varying vec2 vPos;',
    // Exact texel-center UV for a row-major, index = row*texSize.x + col
    // layout -- texture2D at an exact texel center with NEAREST filtering
    // reliably returns that one texel, independent of texture size.
    'vec2 splatTexUV(float index) {',
    '  float col = mod(index, texSize.x);',
    '  float row = floor(index / texSize.x);',
    '  return (vec2(col, row) + 0.5) / texSize;',
    '}',
    'void main() {',
    '  vec2 suv = splatTexUV(sourceIndex);',
    '  vec3 center = texture2D(texCenter, suv).xyz;',
    '  vec3 covA = texture2D(texCovA, suv).xyz;',
    '  vec3 covB = texture2D(texCovB, suv).xyz;',
    '  vec4 colorOpacity = texture2D(texColorOpacity, suv);',
    '  vec3 sh1 = texture2D(texSH1, suv).xyz;',
    '  vec3 sh2 = texture2D(texSH2, suv).xyz;',
    '  vec3 sh3 = texture2D(texSH3, suv).xyz;',
    '  vec3 sh4 = texture2D(texSH4, suv).xyz;',
    '  vec3 sh5 = texture2D(texSH5, suv).xyz;',
    '  vec3 sh6 = texture2D(texSH6, suv).xyz;',
    '  vec3 sh7 = texture2D(texSH7, suv).xyz;',
    '  vec3 sh8 = texture2D(texSH8, suv).xyz;',
    '  vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);',
    '  float zc = mvPosition.z;',
    '  if (zc > -0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }',
    '  mat3 Vrk = mat3(',
    '    covA.x, covA.y, covA.z,',
    '    covA.y, covB.x, covB.y,',
    '    covA.z, covB.y, covB.z',
    '  );',
    '  mat3 W = mat3(modelViewMatrix);',
    '  mat3 J = mat3(',
    '    focal.x / -zc, 0.0, 0.0,',
    '    0.0, focal.y / -zc, 0.0,',
    '    (focal.x * mvPosition.x) / (zc * zc), (focal.y * mvPosition.y) / (zc * zc), 0.0',
    '  );',
    '  mat3 T = J * W;',
    '  mat3 cov2d = T * Vrk * transpose(T);',
    '  float a = cov2d[0][0] + 0.25;',
    '  float b = cov2d[0][1];',
    '  float c = cov2d[1][1] + 0.25;',
    '  float mid = 0.5 * (a + c);',
    '  float diff = 0.5 * (a - c);',
    '  float rad = sqrt(max(0.0, diff * diff + b * b));',
    '  float lambda1 = mid + rad;',
    '  float lambda2 = max(mid - rad, 0.01);',
    '  vec2 eig1 = (abs(b) > 1e-4) ? normalize(vec2(b, lambda1 - a)) : (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0));',
    '  vec2 eig2 = vec2(-eig1.y, eig1.x);',
    // See SPLAT_VERTEX_SHADER's matching comment -- same viewport-proportional
    // clamp, not a large fixed constant.
    '  float maxR = min(min(viewport.x, viewport.y), 1024.0);',
    '  float r1 = min(sqrt(lambda1) * 3.0, maxR);',
    '  float r2 = min(sqrt(lambda2) * 3.0, maxR);',
    '  vec2 screenOffsetPx = corner.x * eig1 * r1 + corner.y * eig2 * r2;',
    '  vec4 clip = projectionMatrix * mvPosition;',
    '  clip.xy += screenOffsetPx * (2.0 / viewport) * clip.w;',
    '  gl_Position = clip;',
    '  vec3 worldCenter = (modelMatrix * vec4(center, 1.0)).xyz;',
    '  vec3 dir = normalize(worldCenter - cameraPosition);',
    '  float dx = dir.x, dy = dir.y, dz = dir.z;',
    '  float dxx = dx * dx, dyy = dy * dy, dzz = dz * dz;',
    '  float dxy = dx * dy, dyz = dy * dz, dxz = dx * dz;',
    '  vec3 col = 0.28209479177387814 * colorOpacity.rgb',
    '    + 0.4886025119029199 * (-dy * sh1 + dz * sh2 - dx * sh3)',
    '    + 1.0925484305920792 * dxy * sh4',
    '    - 1.0925484305920792 * dyz * sh5',
    '    + 0.31539156525252005 * (2.0 * dzz - dxx - dyy) * sh6',
    '    - 1.0925484305920792 * dxz * sh7',
    '    + 0.5462742152960396 * (dxx - dyy) * sh8',
    '    + 0.5;',
    '  vColor = vec4(clamp(col, 0.0, 1.0), colorOpacity.a);',
    '  vPos = corner * 3.0;',
    '}'
  ].join('\n');

  function SplatRendererTex(positions, cov6, colors, sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8, colorSpaceLinear) {
    var n = positions.length / 3;
    this.count = n;
    var layout = splatTexLayout(n);
    var W = layout.width, H = layout.height, texN = W * H;
    this._texW = W;

    function buildTex(filler) {
      var data = new Float32Array(texN * 4);
      for (var i = 0; i < n; i++) filler(data, i);
      return makeSplatDataTexture(data, W, H);
    }

    var texCenter = buildTex(function(d, i) {
      var o = i * 4; d[o] = positions[i * 3]; d[o + 1] = positions[i * 3 + 1]; d[o + 2] = positions[i * 3 + 2];
    });
    var texCovA = buildTex(function(d, i) {
      var o = i * 4; d[o] = cov6[i * 6]; d[o + 1] = cov6[i * 6 + 1]; d[o + 2] = cov6[i * 6 + 2];
    });
    var texCovB = buildTex(function(d, i) {
      var o = i * 4; d[o] = cov6[i * 6 + 3]; d[o + 1] = cov6[i * 6 + 4]; d[o + 2] = cov6[i * 6 + 5];
    });
    var texColorOpacity = buildTex(function(d, i) {
      var o = i * 4; d[o] = colors[i * 4]; d[o + 1] = colors[i * 4 + 1]; d[o + 2] = colors[i * 4 + 2]; d[o + 3] = colors[i * 4 + 3];
    });
    var shAll = [sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8];
    var shTextures = shAll.map(function(sh) {
      return buildTex(function(d, i) { var o = i * 4; d[o] = sh[i * 3]; d[o + 1] = sh[i * 3 + 1]; d[o + 2] = sh[i * 3 + 2]; });
    });

    var geom = new THREE.InstancedBufferGeometry();
    geom.instanceCount = n;
    geom.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 2));
    geom.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));

    // The only per-instance data a resort ever touches -- see the comment
    // block above. Float, not an integer attribute type: GLSL ES 1.00 (no
    // GLSL3 needed here, see above) has no integer vertex attributes, and a
    // highp float exactly represents every integer up to 2^24, far above
    // any splat count this viewer will ever see.
    this._orderArray = new Float32Array(n);
    for (var oi = 0; oi < n; oi++) this._orderArray[oi] = oi;
    this._orderAttr = new THREE.InstancedBufferAttribute(this._orderArray, 1);
    this._orderAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('sourceIndex', this._orderAttr);

    // Same reasoning as SplatRenderer's constructor: this geometry has no
    // attribute named "position" either (the quad corner is "corner", real
    // per-splat positions only exist in the data texture), so both of these
    // must be set explicitly from the real splat positions.
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i < n; i++) {
      var px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
    geom.boundingSphere = new THREE.Sphere();
    geom.boundingBox.getBoundingSphere(geom.boundingSphere);
    geom.boundingSphere.radius *= 1.15;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        focal: { value: new THREE.Vector2(1000, 1000) },
        viewport: { value: new THREE.Vector2(1000, 1000) },
        opacity: { value: 1.0 },
        linearColor: { value: colorSpaceLinear ? 1.0 : 0.0 },
        texSize: { value: new THREE.Vector2(W, H) },
        texCenter: { value: texCenter },
        texCovA: { value: texCovA },
        texCovB: { value: texCovB },
        texColorOpacity: { value: texColorOpacity },
        texSH1: { value: shTextures[0] }, texSH2: { value: shTextures[1] },
        texSH3: { value: shTextures[2] }, texSH4: { value: shTextures[3] },
        texSH5: { value: shTextures[4] }, texSH6: { value: shTextures[5] },
        texSH7: { value: shTextures[6] }, texSH8: { value: shTextures[7] }
      },
      vertexShader: SPLAT_VERTEX_SHADER_TEX,
      fragmentShader: SPLAT_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.raycast = function() {};
    this.mesh.frustumCulled = true;

    this._lastSeenPos = null;
    this._lastSeenQuat = null;
    this._moveEpsSq = 1e-6;
    this._tmpMatrix = new THREE.Matrix4();
    this._tmpDir = new THREE.Vector3();
    this._workerBusy = false;

    // Reordering is now 1 float/splat instead of 37 -- cheap enough to apply
    // on every reply as it arrives, no idle-debounce needed. This is the
    // actual point of this renderer; see SplatRenderer.maybeResort for why
    // the non-texture version still has to debounce even with the same
    // worker doing the sort math.
    var self = this;
    this._worker = new Worker('/assets/openproject_spatial_viewer/splat_sort_worker.js');
    this._worker.onmessage = function(ev) {
      self._workerBusy = false;
      if (ev.data && ev.data.type === 'order') {
        var buf = ev.data.order;
        self._applyOrder(new Uint32Array(buf));
        // Return the buffer to the worker's pool right after reading it --
        // see splat_sort_worker.js's 'release' handler and the comment on
        // SplatRenderer's onmessage above for why this matters during long
        // navigation sessions.
        self._worker.postMessage({ type: 'release', buffer: buf }, [buf]);
      }
    };
    this._worker.onerror = function(err) {
      console.warn('[SpatialViewer] splat sort worker failed:', err && err.message);
    };
    var centersCopy = new Float32Array(positions);
    this._worker.postMessage({ type: 'init', centers: centersCopy.buffer }, [centersCopy.buffer]);
  }

  SplatRendererTex.prototype._applyOrder = function(order) {
    var arr = this._orderArray;
    for (var i = 0; i < order.length; i++) arr[i] = order[i];
    this._orderAttr.needsUpdate = true;
  };

  SplatRendererTex.prototype._sortDirection = function(camera) {
    var mv = this._tmpMatrix.multiplyMatrices(camera.matrixWorldInverse, this.mesh.matrixWorld);
    var e = mv.elements;
    return this._tmpDir.set(e[2], e[6], e[10]).normalize();
  };

  // Minimum time between resort requests while the camera keeps moving. A
  // resort being one frame (<16ms) stale during continuous motion is
  // visually imperceptible (same reasoning as the epsilon above), but
  // requesting one on literally every moved frame means every single frame
  // of a long drag/orbit gesture round-trips a postMessage and runs a full
  // bucket sort over every splat in the worker -- at several million splats,
  // sustained over a long navigation session, that adds up to real CPU and
  // allocation churn for no visible benefit. Throttling to ~12/sec keeps
  // depth order visually current while cutting that load by 4-5x.
  SplatRendererTex.prototype._RESORT_MIN_INTERVAL_MS = 80;

  SplatRendererTex.prototype.maybeResort = function(camera) {
    if (this._workerBusy) return;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (this._lastResortRequestAt && (now - this._lastResortRequestAt) < this._RESORT_MIN_INTERVAL_MS) return;
    var p = camera.position, q = camera.quaternion;
    var moved = !this._lastSeenPos ||
      this._lastSeenPos.distanceToSquared(p) > this._moveEpsSq ||
      (1 - Math.abs(this._lastSeenQuat.dot(q))) > 1e-6;
    if (!moved) return;
    this._lastSeenPos = (this._lastSeenPos || new THREE.Vector3()).copy(p);
    this._lastSeenQuat = (this._lastSeenQuat || new THREE.Quaternion()).copy(q);
    this._lastResortRequestAt = now;
    this._workerBusy = true;
    var dir = this._sortDirection(camera);
    this._worker.postMessage({
      type: 'camera',
      position: { x: p.x, y: p.y, z: p.z },
      direction: { x: dir.x, y: dir.y, z: dir.z }
    });
  };

  // See SplatRenderer.prototype.updateFrame's comment for projCamera.
  SplatRendererTex.prototype.updateFrame = function(camera, viewportW, viewportH, projCamera) {
    var pc = projCamera || camera;
    var u = this.mesh.material.uniforms;
    u.focal.value.set(
      pc.projectionMatrix.elements[0] * viewportW * 0.5,
      pc.projectionMatrix.elements[5] * viewportH * 0.5
    );
    u.viewport.value.set(viewportW, viewportH);
    this.maybeResort(camera);
  };

  // Builds the renderer, registers it for the per-frame focal/sort updates
  // (see the render loop in initThree), and returns the THREE.Mesh to add
  // to the scene -- same call shape as _buildSplatPoints/_buildPointCloud.
  // Prefers the texture-indexed renderer (SplatRendererTex) -- WebGL2 and a
  // Worker are both required for a real benefit from it (floating-point
  // vertex-texture-fetch needs WebGL2; without a worker there's no
  // background resort to feed it), falling back to the original
  // SplatRenderer (which has its own, separate WebGL1-safe worker-or-not
  // fallback already) when either is missing.
  SpatialViewerApp.prototype._buildTrueSplats = function(positions, cov6, colors, sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8, colorSpaceLinear) {
    var splat;
    var canUseTex = !!(window.Worker && this.renderer && this.renderer.capabilities && this.renderer.capabilities.isWebGL2);
    if (canUseTex) {
      try {
        splat = new SplatRendererTex(positions, cov6, colors, sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8, colorSpaceLinear);
      } catch (err) {
        console.warn('[SpatialViewer] texture-indexed splat renderer failed, falling back:', err);
        splat = null;
      }
    }
    if (!splat) {
      splat = new SplatRenderer(positions, cov6, colors, sh1, sh2, sh3, sh4, sh5, sh6, sh7, sh8, colorSpaceLinear);
    }
    this._splatRenderers = this._splatRenderers || [];
    this._splatRenderers.push(splat);
    return splat.mesh;
  };

  // The decimation cap passed to parseSOG/parseSplatPLY/
  // _parseGltfGaussianSplatting. SplatRendererTex no longer pays resort cost
  // proportional to per-splat payload (see its own comments), so the point
  // count that was previously capped specifically to bound THAT cost can be
  // much higher when it's actually going to be used; same check
  // _buildTrueSplats itself uses to choose between the two renderers.
  // Keeping the original (lower) TRUE_SPLAT_MAX_POINTS for the SplatRenderer
  // fallback matters: that renderer still reorders the full per-splat record
  // on every resort, so a higher cap there would make its settle-hitch worse,
  // not better.
  SpatialViewerApp.prototype._splatPointCap = function() {
    var canUseTex = !!(window.Worker && this.renderer && this.renderer.capabilities && this.renderer.capabilities.isWebGL2);
    // 4,000,000 matches the existing LAS point-cloud cap (parseLAS) --
    // already an accepted, working budget in this viewer for a
    // per-point/per-splat GPU workload of this general shape.
    return canUseTex ? 4000000 : TRUE_SPLAT_MAX_POINTS;
  };

  SpatialViewerApp.prototype._parseModel = function(buffer, format) {
    var self = this;
    self.showLoader('Parsing 3D geometry...');

    // .sog is itself a zip (meta.json + WebP textures) -- must be checked
    // before the generic isZipBuffer/_parseBundle branch below, which would
    // otherwise mistake it for an OBJ/glTF/PLY archive and reject it.
    if (format === 'sog') {
      // Scale + rotation are required core fields in the SOG spec (unlike
      // shN), so a conformant .sog always has what true-splat rendering needs.
      parseSOG(buffer, self._splatPointCap()).then(function(data) {
        self.onModelLoaded(self._buildTrueSplats(data.positions, data.cov6, data.colors,
          data.sh1, data.sh2, data.sh3, data.sh4, data.sh5, data.sh6, data.sh7, data.sh8));
      }).catch(function(err) {
        console.error('[SpatialViewer] .sog parse failed:', err);
        self._parseError('gaussian splat (.sog) unreadable: ' + (err && err.message || err));
      });
    } else if (isZipBuffer(buffer)) {
      self._parseBundle(buffer);
    } else if (format === 'glb' || format === 'gltf') {
      self._parseGltf(buffer);
    } else if (format === 'obj') {
      self.onModelLoaded(new THREE.OBJLoader().parse(new TextDecoder('utf-8').decode(buffer)));
    } else if (format === 'ply' || format === 'gaussian_splat' || format === 'splat' || format === 'ksplat') {
      // Try true-splat data first (scale_*/rot_*/opacity/f_dc_* -- a 3DGS-
      // trained .ply); parseSplatPLY returns null (not an error) when those
      // properties aren't present, e.g. a plain colored point-cloud .ply
      // with no Gaussian training data -- fall back to the point-cloud
      // approximation for that case, same as before.
      var splatData = null;
      try { splatData = parseSplatPLY(buffer, self._splatPointCap()); }
      catch (e) { console.warn('[SpatialViewer] 3DGS .ply parse failed, falling back to point cloud:', e); }

      if (splatData) {
        self.onModelLoaded(self._buildTrueSplats(splatData.positions, splatData.cov6, splatData.colors,
          splatData.sh1, splatData.sh2, splatData.sh3, splatData.sh4, splatData.sh5, splatData.sh6, splatData.sh7, splatData.sh8));
      } else {
        var plyGeom = new THREE.PLYLoader().parse(buffer);
        var plyPos = plyGeom.getAttribute('position').array;
        var plyCol = plyGeom.hasAttribute('color') ? plyGeom.getAttribute('color').array : null;
        self.onModelLoaded(self._buildSplatPoints(plyPos, plyCol));
      }
    } else if (format === 'las' || format === 'laz' || format === 'e57') {
      try {
        self.onModelLoaded(self._buildPointCloud(parseLAS(buffer)));
      } catch (e) {
        console.error('[SpatialViewer] LAS parse failed:', e);
        self._parseError('point cloud unreadable: ' + (e && e.message || e));
      }
    } else if (format === 'ifc') {
      self.parseIfcBuffer(buffer);
    } else if (self._loadingLayerId != null) {
      self._parseError('unsupported layer format: ' + format);
    } else {
      self.hideLoader();
      self.createDemoModel();
    }
  };

  // ---- Zipped model bundles (OBJ/MTL/textures, multi-file glTF) ----------

  SpatialViewerApp.prototype._revokeBundleUrls = function() {
    (this._bundleUrls || []).forEach(function(u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    this._bundleUrls = [];
  };

  SpatialViewerApp.prototype._parseBundle = function(buffer) {
    var self = this;
    self.showLoader('Unpacking model archive…');
    self._revokeBundleUrls();

    unzipBuffer(buffer).then(function(files) {
      // Drop macOS Finder cruft (__MACOSX/._foo AppleDouble forks, .DS_Store).
      var names = Object.keys(files).filter(function(n) {
        return n.indexOf('__MACOSX/') === -1 && n.split('/').pop().charAt(0) !== '.';
      });
      // shallowest match wins (top-level model file before one nested deep)
      var pick = function(re) {
        return names.filter(function(n) { return re.test(n); })
                    .sort(function(a, b) { return a.split('/').length - b.split('/').length || a.length - b.length; })[0];
      };
      var obj = pick(/\.obj$/i), glb = pick(/\.glb$/i), gltf = pick(/\.gltf$/i), ply = pick(/\.ply$/i);

      if (obj) { self._loadObjBundle(files, obj); return; }
      if (glb) { self._parseGltf(toArrayBuffer(files[glb])); return; }
      if (gltf) { self._loadGltfBundle(files, gltf); return; }
      if (ply) { self._parseModel(toArrayBuffer(files[ply]), 'ply'); return; }
      self._parseError('the archive contains no .obj, .glb, .gltf or .ply file');
    }).catch(function(err) {
      console.error('[SpatialViewer] bundle error:', err);
      self._parseError('archive error: ' + (err && err.message || err));
    });
  };

  // Build a LoadingManager that resolves every relative resource path referenced
  // by a bundled file (textures in an .mtl, .bin/images in a .gltf) to a blob URL
  // of the matching zip entry. Matches on full path first, then on basename.
  SpatialViewerApp.prototype._bundleManager = function(files, baseDir) {
    var self = this;
    self._bundleUrls = self._bundleUrls || [];

    var MIME = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.bmp': 'image/bmp', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
      '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2'
    };
    var norm = function(s) { return String(s).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(); };
    var byPath = {}, byBase = {};
    Object.keys(files).forEach(function(n) {
      var k = norm(n);
      byPath[k] = files[n];
      byBase[k.split('/').pop()] = files[n];
    });
    var find = function(ref) {
      var r = norm(ref);
      return byPath[r] || byBase[r.split('/').pop()] || null;
    };

    var manager = new THREE.LoadingManager();
    manager.setURLModifier(function(url) {
      if (/^(blob:|data:|https?:)/i.test(url)) return url;
      var u8 = find(url);
      if (!u8) { console.warn('[SpatialViewer] not in bundle:', url); return url; }
      var ext = (url.toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
      var blobUrl = URL.createObjectURL(new Blob([u8], { type: MIME[ext] || 'application/octet-stream' }));
      self._bundleUrls.push(blobUrl);
      return blobUrl;
    });
    manager._bundleFind = find; // reused by the callers
    return manager;
  };

  SpatialViewerApp.prototype._loadObjBundle = function(files, objName) {
    var self = this;
    var dec = new TextDecoder('utf-8');
    var baseDir = objName.replace(/\\/g, '/').replace(/[^/]*$/, ''); // '' or 'sub/'
    var manager = this._bundleManager(files, baseDir);

    var objText = dec.decode(files[objName]);
    var materials = null;
    var mtlRef = (objText.match(/^\s*mtllib\s+(.+?)\s*$/mi) || [])[1];
    if (mtlRef) {
      var mtlU8 = manager._bundleFind(mtlRef);
      if (mtlU8) {
        try {
          materials = new THREE.MTLLoader(manager).parse(dec.decode(mtlU8), baseDir);
          materials.preload();
        } catch (e) {
          console.warn('[SpatialViewer] MTL parse failed:', e);
          materials = null;
        }
      } else {
        console.warn('[SpatialViewer] .mtl referenced by the OBJ is not in the archive:', mtlRef);
      }
    }

    var loader = new THREE.OBJLoader(manager);
    if (materials) loader.setMaterials(materials);
    try {
      self.onModelLoaded(loader.parse(objText));
    } catch (e) {
      console.error('[SpatialViewer] OBJ parse failed:', e);
      self._parseError('OBJ parse: ' + (e && e.message || e));
    }
  };

  SpatialViewerApp.prototype._loadGltfBundle = function(files, gltfName) {
    var self = this;
    var baseDir = gltfName.replace(/\\/g, '/').replace(/[^/]*$/, '');
    var manager = this._bundleManager(files, baseDir);
    var json = new TextDecoder('utf-8').decode(files[gltfName]);
    new THREE.GLTFLoader(manager).parse(json, baseDir,
      function(gltf) {
        try { self.onModelLoaded(gltf.scene); }
        catch (e) { console.error(e); self.showLoader('The model loaded but could not be displayed: ' + (e && e.message || e)); }
      },
      function(err) {
        console.error('[SpatialViewer] bundled glTF parse error:', err);
        self._parseError('glTF parse: ' + (err && err.message || err));
      });
  };

  // A text .gltf document can point at companion files (scene.bin, textures/*)
  // via relative `uri`s. The viewer only ever receives the single uploaded
  // file, so those references cannot be resolved. Returns the list of external
  // resources, or [] for a self-contained file / binary .glb.
  SpatialViewerApp.prototype._gltfExternalRefs = function(buffer) {
    // Binary .glb starts with the magic number 0x46546C67 ("glTF") — no text
    // to inspect, and its resources are always embedded.
    var dv = new DataView(buffer);
    if (buffer.byteLength >= 4 && dv.getUint32(0, true) === 0x46546C67) return [];

    var gltf;
    try { gltf = JSON.parse(new TextDecoder('utf-8').decode(buffer)); }
    catch (e) { return []; }

    var refs = [];
    ['buffers', 'images'].forEach(function(key) {
      (gltf[key] || []).forEach(function(entry) {
        var uri = entry && entry.uri;
        if (typeof uri === 'string' && uri.slice(0, 5) !== 'data:') refs.push(uri);
      });
    });
    return refs;
  };

  // The glTF JSON document's top-level `extensionsUsed`/`extensionsRequired`
  // arrays, read directly rather than through GLTFLoader (which silently
  // ignores any extension it doesn't recognize and reports nothing) -- used
  // to explain an otherwise-mysterious "model loaded but nothing shows up"
  // result. Handles both binary .glb (JSON is the first chunk after the
  // 12-byte header) and plain-text .gltf; returns [] rather than throwing on
  // anything unexpected.
  SpatialViewerApp.prototype._gltfUsedExtensions = function(buffer) {
    try {
      var dv = new DataView(buffer);
      var json;
      if (buffer.byteLength >= 4 && dv.getUint32(0, true) === 0x46546C67) {
        if (buffer.byteLength < 20) return [];
        var chunkLength = dv.getUint32(12, true);
        var chunkType = dv.getUint32(16, true);
        if (chunkType !== 0x4E4F534A) return []; // not a JSON chunk
        json = JSON.parse(new TextDecoder('utf-8').decode(buffer.slice(20, 20 + chunkLength)));
      } else {
        json = JSON.parse(new TextDecoder('utf-8').decode(buffer));
      }
      var names = (json.extensionsUsed || []).concat(json.extensionsRequired || []);
      return names.filter(function(n, i) { return names.indexOf(n) === i; }); // de-dup
    } catch (e) { return []; }
  };

  // ---- glTF-embedded Gaussian Splatting (KHR_gaussian_splatting) ---------
  // Ratified Khronos extension for storing 3D Gaussian splats directly in a
  // glTF/GLB mesh primitive (POSITION + several "KHR_gaussian_splatting:*"
  // attribute semantics on a POINTS-mode primitive). Spec:
  // https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_gaussian_splatting
  //
  // THREE.GLTFLoader (vendored here) has no idea this extension exists --
  // it just logs "Unknown extension" and drops whatever that primitive
  // described, which for a file that stores ALL its geometry this way means
  // "parsed fine" but an empty, mesh-less scene (see _parseGltf's
  // reportEmptyResult). This reads the glTF JSON + binary buffer directly
  // and builds true splats (SplatRenderer), the same approach already used
  // for .sog/3DGS-.ply, bypassing GLTFLoader entirely for these primitives.
  //
  // Unlike .sog/.ply, no axis-flip/chirality correction is needed here: the
  // glTF coordinate system (+Y up, +Z front, right-handed) already matches
  // three.js's, and the spec explicitly recommends training/exporting
  // directly into it.
  var GLTF_COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  var GLTF_TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

  function readGltfComponent(dv, offset, componentType, normalized) {
    switch (componentType) {
      case 5120: { var v1 = dv.getInt8(offset); return normalized ? Math.max(v1 / 127, -1) : v1; }
      case 5121: { var v2 = dv.getUint8(offset); return normalized ? v2 / 255 : v2; }
      case 5122: { var v3 = dv.getInt16(offset, true); return normalized ? Math.max(v3 / 32767, -1) : v3; }
      case 5123: { var v4 = dv.getUint16(offset, true); return normalized ? v4 / 65535 : v4; }
      case 5125: return dv.getUint32(offset, true);
      case 5126: return dv.getFloat32(offset, true);
      default: return 0;
    }
  }

  // Resolves one accessor to a flat Float32Array (count * numComponents).
  // Returns null (never throws) for anything this doesn't handle: a sparse
  // accessor, an unknown component/element type, or data that would read
  // past the buffer -- callers treat null as "skip this primitive".
  function readGltfAccessor(json, buffers, accIndex) {
    if (accIndex == null) return null;
    var acc = json.accessors && json.accessors[accIndex];
    if (!acc || acc.sparse || acc.bufferView == null) return null;
    var bv = json.bufferViews && json.bufferViews[acc.bufferView];
    if (!bv) return null;
    var buf = buffers[bv.buffer];
    if (!buf) return null;
    var compSize = GLTF_COMPONENT_SIZE[acc.componentType];
    var numComp = GLTF_TYPE_COMPONENTS[acc.type];
    if (!compSize || !numComp) return null;
    var elementSize = compSize * numComp;
    var stride = bv.byteStride || elementSize;
    var base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    if (base + stride * Math.max(0, acc.count - 1) + elementSize > buf.byteLength) return null;
    var dv = new DataView(buf);
    var normalized = !!acc.normalized;
    var out = new Float32Array(acc.count * numComp);
    for (var i = 0; i < acc.count; i++) {
      var elOff = base + i * stride;
      for (var c = 0; c < numComp; c++) {
        out[i * numComp + c] = readGltfComponent(dv, elOff + c * compSize, acc.componentType, normalized);
      }
    }
    return out;
  }

  // buffers[i] -> ArrayBuffer, for the common cases here: the implicit GLB
  // binary chunk (buffer 0 with no `uri`) and a `data:` URI (plain .gltf
  // with everything embedded inline). An external-file `uri` resolves to
  // null, but _parseGltf already rejects those before this ever runs.
  function resolveGltfBuffers(json, glbBinChunk) {
    return (json.buffers || []).map(function(b) {
      if (!b.uri) return glbBinChunk;
      if (b.uri.slice(0, 5) === 'data:') {
        try {
          var comma = b.uri.indexOf(',');
          var bin = atob(b.uri.slice(comma + 1));
          var bytes = new Uint8Array(bin.length);
          for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
          return bytes.buffer;
        } catch (e) { return null; }
      }
      return null;
    });
  }

  // Walks the active scene's node hierarchy, returning { meshIndex:
  // [THREE.Matrix4, ...] } -- the accumulated world transform of every node
  // that instantiates that mesh (a mesh can be referenced by more than one
  // node). Needed because a splat primitive's effective position/covariance
  // depend on its containing node's global transform (see the spec's
  // Sigma = M*C*C^T*M^T), which this viewer applies via the mesh's own
  // position/quaternion/scale rather than by baking it into the data.
  function gltfMeshNodeMatrices(json) {
    var byMesh = {};
    var nodes = json.nodes || [];
    function localMatrix(node) {
      var m = new THREE.Matrix4();
      if (node.matrix) { m.fromArray(node.matrix); return m; }
      var t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
      m.compose(new THREE.Vector3(t[0], t[1], t[2]), new THREE.Quaternion(r[0], r[1], r[2], r[3]), new THREE.Vector3(s[0], s[1], s[2]));
      return m;
    }
    function visit(idx, parentWorld) {
      var node = nodes[idx];
      if (!node) return;
      var world = parentWorld.clone().multiply(localMatrix(node));
      if (node.mesh != null) (byMesh[node.mesh] = byMesh[node.mesh] || []).push(world);
      (node.children || []).forEach(function(ci) { visit(ci, world); });
    }
    var scene = (json.scenes || [])[json.scene || 0] || { nodes: [] };
    (scene.nodes || []).forEach(function(ni) { visit(ni, new THREE.Matrix4()); });
    return byMesh;
  }

  // Parses every KHR_gaussian_splatting primitive in the file into the same
  // shape _buildTrueSplats expects, one entry per (primitive x instantiating
  // node) pair, each already carrying its own world position/quaternion/
  // scale. Returns null (not an error) when the file doesn't actually use
  // the extension, or no primitive could be decoded, so _parseGltf can fall
  // back to the normal GLTFLoader mesh path unchanged.
  SpatialViewerApp.prototype._parseGltfGaussianSplatting = function(buffer, maxPoints) {
    var dv = new DataView(buffer);
    var json, binChunk = null;
    if (buffer.byteLength >= 12 && dv.getUint32(0, true) === 0x46546C67) {
      if (buffer.byteLength < 20) return null;
      var jsonChunkLen = dv.getUint32(12, true);
      if (dv.getUint32(16, true) !== 0x4E4F534A) return null;
      json = JSON.parse(new TextDecoder('utf-8').decode(buffer.slice(20, 20 + jsonChunkLen)));
      var afterJson = 20 + jsonChunkLen;
      if (afterJson + 8 <= buffer.byteLength) {
        var binLen = dv.getUint32(afterJson, true);
        var binType = dv.getUint32(afterJson + 4, true);
        if (binType === 0x004e4942) binChunk = buffer.slice(afterJson + 8, afterJson + 8 + binLen); // 'BIN\0'
      }
    } else {
      json = JSON.parse(new TextDecoder('utf-8').decode(buffer));
    }
    if (!json || !json.extensionsUsed || json.extensionsUsed.indexOf('KHR_gaussian_splatting') === -1) return null;

    var buffers = resolveGltfBuffers(json, binChunk);
    var meshNodeMatrices = gltfMeshNodeMatrices(json);
    var results = [];

    (json.meshes || []).forEach(function(mesh, meshIndex) {
      (mesh.primitives || []).forEach(function(prim) {
        var ext = prim.extensions && prim.extensions.KHR_gaussian_splatting;
        if (!ext || prim.mode !== 0) return; // mode MUST be POINTS (0) per spec
        var attrs = prim.attributes || {};
        var posAcc = readGltfAccessor(json, buffers, attrs.POSITION);
        var rotAcc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:ROTATION']);
        var scaleAcc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SCALE']);
        var opAcc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:OPACITY']);
        var dc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_0_COEF_0']);
        if (!posAcc || !rotAcc || !scaleAcc || !opAcc || !dc) {
          console.warn('[SpatialViewer] KHR_gaussian_splatting primitive is missing a required attribute (or uses an accessor layout this viewer cannot read) -- skipping it');
          return;
        }
        var n = posAcc.length / 3;

        // Degree 1+2 only -- same cap as .sog/.ply, see SplatRenderer/
        // TRUE_SPLAT_MAX_POINTS for why. Each SH degree is all-or-nothing
        // per spec, so only probe degree 2 once degree 1 is confirmed whole.
        var sh1Acc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_1_COEF_0']);
        var sh2Acc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_1_COEF_1']);
        var sh3Acc = readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_1_COEF_2']);
        var hasDeg1 = !!(sh1Acc && sh2Acc && sh3Acc);
        var sh4Acc = hasDeg1 ? readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_2_COEF_0']) : null;
        var sh5Acc = hasDeg1 ? readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_2_COEF_1']) : null;
        var sh6Acc = hasDeg1 ? readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_2_COEF_2']) : null;
        var sh7Acc = hasDeg1 ? readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_2_COEF_3']) : null;
        var sh8Acc = hasDeg1 ? readGltfAccessor(json, buffers, attrs['KHR_gaussian_splatting:SH_DEGREE_2_COEF_4']) : null;
        var hasDeg2 = hasDeg1 && !!(sh4Acc && sh5Acc && sh6Acc && sh7Acc && sh8Acc);

        var zero3 = new Float32Array(n * 3);
        var srcSh = hasDeg1
          ? [sh1Acc, sh2Acc, sh3Acc,
             hasDeg2 ? sh4Acc : zero3, hasDeg2 ? sh5Acc : zero3, hasDeg2 ? sh6Acc : zero3,
             hasDeg2 ? sh7Acc : zero3, hasDeg2 ? sh8Acc : zero3]
          : [zero3, zero3, zero3, zero3, zero3, zero3, zero3, zero3];

        // Same decimation + scale-compensation as parseSOG/parseSplatPLY
        // (see their comments): thinning without growing the survivors
        // leaves visible gaps.
        var cap = maxPoints || TRUE_SPLAT_MAX_POINTS;
        var step = n > cap ? Math.ceil(n / cap) : 1;
        var scaleComp = step > 1 ? Math.cbrt(step) : 1;
        var outN = Math.floor((n + step - 1) / step);

        var positions = new Float32Array(outN * 3), cov6 = new Float32Array(outN * 6), colors = new Float32Array(outN * 4);
        var outSh = [];
        for (var oi = 0; oi < 8; oi++) outSh.push(new Float32Array(outN * 3));

        var k = 0;
        for (var i = 0; i < n; i += step) {
          positions[k * 3] = posAcc[i * 3]; positions[k * 3 + 1] = posAcc[i * 3 + 1]; positions[k * 3 + 2] = posAcc[i * 3 + 2];

          // glTF VEC4 quaternions are always (x, y, z, w).
          var qx = rotAcc[i * 4], qy = rotAcc[i * 4 + 1], qz = rotAcc[i * 4 + 2], qw = rotAcc[i * 4 + 3];
          var qlen = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) || 1;
          qw /= qlen; qx /= qlen; qy /= qlen; qz /= qlen;

          var sx = scaleAcc[i * 3] * scaleComp, sy = scaleAcc[i * 3 + 1] * scaleComp, sz = scaleAcc[i * 3 + 2] * scaleComp;

          // No axis-flip sign fix-up here (unlike .sog/.ply) -- the glTF
          // coordinate system already matches three.js's.
          var c6 = quatScaleToCovariance6(sx, sy, sz, qw, qx, qy, qz);
          cov6[k * 6] = c6[0]; cov6[k * 6 + 1] = c6[1]; cov6[k * 6 + 2] = c6[2];
          cov6[k * 6 + 3] = c6[3]; cov6[k * 6 + 4] = c6[4]; cov6[k * 6 + 5] = c6[5];

          // Raw DC coefficient, same "shader applies SH_C0 + 0.5" convention
          // as .sog/.ply.
          colors[k * 4] = dc[i * 3]; colors[k * 4 + 1] = dc[i * 3 + 1]; colors[k * 4 + 2] = dc[i * 3 + 2];
          // Linear [0,1] opacity per spec -- unlike 3DGS .ply's logit, no
          // sigmoid needed.
          colors[k * 4 + 3] = opAcc[i];

          for (var s = 0; s < 8; s++) {
            outSh[s][k * 3] = srcSh[s][i * 3]; outSh[s][k * 3 + 1] = srcSh[s][i * 3 + 1]; outSh[s][k * 3 + 2] = srcSh[s][i * 3 + 2];
          }
          k++;
        }

        var matrices = meshNodeMatrices[meshIndex] || [new THREE.Matrix4()];
        matrices.forEach(function(worldMatrix) {
          var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
          worldMatrix.decompose(pos, quat, scl);
          results.push({
            positions: positions.subarray(0, k * 3), cov6: cov6.subarray(0, k * 6), colors: colors.subarray(0, k * 4),
            sh1: outSh[0].subarray(0, k * 3), sh2: outSh[1].subarray(0, k * 3), sh3: outSh[2].subarray(0, k * 3),
            sh4: outSh[3].subarray(0, k * 3), sh5: outSh[4].subarray(0, k * 3), sh6: outSh[5].subarray(0, k * 3),
            sh7: outSh[6].subarray(0, k * 3), sh8: outSh[7].subarray(0, k * 3),
            position: pos, quaternion: quat, scale: scl,
            colorSpaceLinear: ext.colorSpace === 'lin_rec709_display'
          });
        });
      });
    });

    return results.length ? results : null;
  };

  // (7) Parse GLB/GLTF in a Web Worker so the main thread does not freeze.
  // Falls back to a main-thread GLTFLoader.parse() on any failure (e.g. the GLB
  // has textures / KHR extensions the worker path can't handle).
  SpatialViewerApp.prototype._parseGltf = function(buffer) {
    var self = this;

    var refs = this._gltfExternalRefs(buffer);
    if (refs.length) {
      var shown = refs.slice(0, 3).join(', ') + (refs.length > 3 ? ', …' : '');
      console.warn('[SpatialViewer] glTF references external resources:', refs);
      this._parseError(
        'this .gltf needs ' + refs.length + ' external file(s) that were not uploaded (' +
        shown + ') — upload a self-contained .glb, or a .zip with the .gltf + .bin + textures');
      return;
    }

    // Captured up front: the worker path below transfers `buffer` itself
    // (postMessage's transfer list), which detaches it in this thread, so it
    // can no longer be read by the time the worker's response arrives.
    var usedExt = this._gltfUsedExtensions(buffer);

    if (usedExt.indexOf('KHR_gaussian_splatting') !== -1) {
      var splats = null;
      try { splats = self._parseGltfGaussianSplatting(buffer, self._splatPointCap()); }
      catch (err) {
        console.warn('[SpatialViewer] KHR_gaussian_splatting parse failed, falling back to the normal glTF path:', err);
      }
      if (splats) {
        var group = new THREE.Group();
        splats.forEach(function(s) {
          var meshObj = self._buildTrueSplats(s.positions, s.cov6, s.colors,
            s.sh1, s.sh2, s.sh3, s.sh4, s.sh5, s.sh6, s.sh7, s.sh8, s.colorSpaceLinear);
          meshObj.position.copy(s.position);
          meshObj.quaternion.copy(s.quaternion);
          meshObj.scale.copy(s.scale);
          group.add(meshObj);
        });
        self.onModelLoaded(group);
        return;
      }
      // Fall through to the normal GLTFLoader-based path below only as a
      // last resort (e.g. an unexpected accessor layout this parser can't
      // read) -- better a best-effort attempt than nothing at all.
    }

    function hasGeometry(obj) {
      var found = false;
      obj.traverse(function(child) { if (child.isMesh || child.isPoints) found = true; });
      return found;
    }

    // GLTFLoader doesn't error on an extension it doesn't understand -- it
    // just drops whatever that extension described, which for a file that
    // stores ALL its geometry through one (e.g. native glTF Gaussian
    // Splatting) means "parsed fine" but an empty, mesh-less scene. Silently
    // falling through to onModelLoaded's generic empty-model fallback would
    // just show an unexplained blank viewport, so this is reported as its
    // own specific error instead.
    function reportEmptyResult() {
      var splatExt = usedExt.filter(function(e) { return /gaussian_splatting/i.test(e); });
      if (splatExt.length) {
        self._parseError(
          'this glTF/GLB stores its geometry via the "' + splatExt.join('", "') + '" extension' +
          (splatExt.length > 1 ? 's' : '') + ' (native glTF Gaussian Splatting) -- not supported ' +
          'yet (it is a very new, not-yet-finalized Khronos extension). Export/upload as .sog, ' +
          '.ply or .splat instead for full true-splat rendering.');
      } else {
        self._parseError('this glTF/GLB has no mesh or point data to display' +
          (usedExt.length ? ' (uses extension(s): ' + usedExt.join(', ') + ')' : ''));
      }
    }

    function mainThreadParse(buf) {
      self.showLoader('Parsing 3D geometry (the page may briefly freeze)...');
      var parsed = false;
      try {
        new THREE.GLTFLoader().parse(buf, '',
          function(gltf) {
            // GLTFLoader wraps its onLoad callback in a .catch(onError), so an
            // exception thrown *here* (while adding the model to the scene, BVH,
            // …) would otherwise be reported as a bogus "parse error". Handle it
            // separately and let the real stack surface.
            parsed = true;
            try {
              if (!hasGeometry(gltf.scene)) { reportEmptyResult(); return; }
              self.onModelLoaded(gltf.scene);
            } catch (err) {
              console.error('[SpatialViewer] Post-load processing failed:', err);
              self.showLoader('The model loaded but could not be displayed: ' +
                (err && err.message || err));
            }
          },
          function(err) {
            if (parsed) return; // already past parsing — error came from onLoad
            console.error('[SpatialViewer] GLTF parse error:', err);
            self._parseError('glTF parse: ' + (err && err.message || err) +
              ' (a very large / detailed model may have run out of memory — try a decimated export)');
          });
      } catch (err) {
        console.error('[SpatialViewer] GLTFLoader.parse threw:', err);
        self._parseError('glTF parse: ' + (err && err.message || err));
      }
    }

    function recoverAndFallback() {
      if (self._modelBlob) {
        self._modelBlob.arrayBuffer()
          .then(mainThreadParse)
          .catch(function(err) { self._parseError('load error: ' + (err && err.message || err)); });
      } else {
        self._parseError('background parse failed');
      }
    }

    if (!window.Worker) { mainThreadParse(buffer); return; }

    var worker;
    try {
      worker = new Worker('/assets/openproject_spatial_viewer/gltf_worker.js');
    } catch (err) {
      console.warn('[SpatialViewer] GLTF worker unavailable, parsing on main thread:', err);
      mainThreadParse(buffer);
      return;
    }

    self._gltfWorker = worker;
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      console.warn('[SpatialViewer] GLTF worker timed out; falling back to main thread');
      try { worker.terminate(); } catch (e) {}
      recoverAndFallback();
    }, 120000);

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (e) {}
      fn();
    }

    worker.onmessage = function(ev) {
      var d = ev.data || {};
      if (d.type === 'done') {
        finish(function() {
          try {
            if (!d.meshes || !d.meshes.length) { reportEmptyResult(); return; }
            self.onModelLoaded(self._rebuildFromWorker(d.meshes));
          } catch (err) {
            console.error('[SpatialViewer] Rebuilding worker meshes failed:', err);
            recoverAndFallback();
          }
        });
      } else if (d.type === 'error') {
        console.warn('[SpatialViewer] Worker parse failed (' + d.error + '); falling back to main thread');
        finish(recoverAndFallback);
      }
    };
    worker.onerror = function(err) {
      console.warn('[SpatialViewer] Worker error; falling back to main thread:', err && err.message);
      finish(recoverAndFallback);
    };

    self.showLoader('Parsing 3D geometry in the background...');
    worker.postMessage(
      { type: 'parse', buffer: buffer, bundleUrl: '/assets/openproject_spatial_viewer/vendor.bundle.js' },
      [buffer]
    );
  };

  SpatialViewerApp.prototype._rebuildFromWorker = function(meshesData) {
    var group = new THREE.Group();
    (meshesData || []).forEach(function(md) {
      var geom = new THREE.BufferGeometry();
      Object.keys(md.attributes || {}).forEach(function(name) {
        var d = md.attributes[name];
        geom.setAttribute(name, new THREE.BufferAttribute(new Float32Array(d.buffer), d.itemSize));
      });
      if (md.index) {
        var Ctor = (md.index.ctor === 'Uint16Array') ? Uint16Array : Uint32Array;
        geom.setIndex(new THREE.BufferAttribute(new Ctor(md.index.buffer), 1));
      }
      if (!(md.attributes && md.attributes.normal) && !md.isPoints) geom.computeVertexNormals();

      var mp = md.material || {};
      var obj;
      if (md.isPoints) {
        obj = new THREE.Points(geom, new THREE.PointsMaterial({
          size: 0.05,
          color: mp.color != null ? mp.color : 0x38bdf8,
          vertexColors: !!mp.vertexColors
        }));
      } else {
        obj = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
          color: mp.color != null ? mp.color : 0xb8c0cc,
          metalness: mp.metalness != null ? mp.metalness : 0.1,
          roughness: mp.roughness != null ? mp.roughness : 0.85,
          transparent: !!mp.transparent,
          opacity: mp.opacity != null ? mp.opacity : 1,
          vertexColors: !!mp.vertexColors,
          side: mp.doubleSided ? THREE.DoubleSide : THREE.FrontSide
        }));
      }
      obj.name = md.name || '';
      obj.matrixAutoUpdate = false;
      if (md.matrixWorld && md.matrixWorld.length === 16) obj.matrix.fromArray(md.matrixWorld);
      group.add(obj);
    });
    return group;
  };

  // (1) Drop shadows / high-DPI rendering for heavy models.
  SpatialViewerApp.prototype._applyPerformanceMode = function() {
    if (!this.renderer) return;

    // On the first heavy model of the session, drop shadows and HiDPI to keep
    // the frame-rate usable. This is a one-time nudge to the stored settings —
    // the user can turn them back on in the Render panel and it sticks.
    if (this.heavyMode && !this._heavyDefaultsApplied) {
      this._heavyDefaultsApplied = true;
      this.renderSettings.shadows = 'off';
      this.renderSettings.hiDpi = false;
      this.showTooltip('Large model — shadows and high-DPI turned off for performance. Re-enable them in the Render panel.');
      var self = this;
      setTimeout(function() {
        var t = document.getElementById('drawingTooltip');
        if (t && self.currentTool === 'orbit') t.style.display = 'none';
      }, 6000);
    }

    this._applyRenderSettings();
  };

  /**
   * Attempt to parse IFC data. IFC is a STEP text format — we extract
   * coordinate data from IFCCARTESIANPOINT entities and build a point cloud
   * as a basic visualization. For full BIM hierarchy, use OpenProject's BIM module.
   */
  SpatialViewerApp.prototype.parseIfcBuffer = function(buffer) {
    var self = this;
    try {
      var text = new TextDecoder('utf-8').decode(buffer);

      // First, try to parse as GLTF/GLB in case server converted it
      if (buffer.byteLength >= 4) {
        var magic = new Uint32Array(buffer.slice(0, 4))[0];
        if (magic === 0x46546C67) { // glTF magic number
          var gltfLoader = new THREE.GLTFLoader();
          gltfLoader.parse(buffer, '',
            function(gltf) { self.onModelLoaded(gltf.scene); },
            function() { self.extractIfcGeometry(text); }
          );
          return;
        }
      }

      self.extractIfcGeometry(text);
    } catch(err) {
      console.error('[SpatialViewer] IFC parse error:', err);
      self.showLoader('Error parsing IFC file: ' + (err.message || err));
    }
  };

  /**
   * Extract geometry from IFC STEP text by finding IFCCARTESIANPOINT entries
   * and rendering them as a point cloud. This gives a basic structural overview.
   */
  SpatialViewerApp.prototype.extractIfcGeometry = function(text) {
    var self = this;
    self.showLoader('Extracting IFC geometry...');

    // Extract all IFCCARTESIANPOINT((x,y,z)) coordinates
    var regex = /IFCCARTESIANPOINT\s*\(\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\)/gi;
    var match;
    var points = [];
    var seen = {};

    while ((match = regex.exec(text)) !== null) {
      var x = parseFloat(match[1]);
      var y = parseFloat(match[2]);
      var z = parseFloat(match[3]);
      if (isNaN(x) || isNaN(y) || isNaN(z)) continue;
      // Deduplicate very close points
      var key = Math.round(x * 100) + ',' + Math.round(y * 100) + ',' + Math.round(z * 100);
      if (seen[key]) continue;
      seen[key] = true;
      points.push(x, y, z);
    }

    if (points.length < 9) {
      self.showLoader('IFC file contains insufficient geometry data (' + (points.length / 3) + ' points). For full IFC visualization, please convert to GLB or use the BIM module.');
      return;
    }

    var positions = new Float32Array(points);
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    var material = new THREE.PointsMaterial({
      size: 0.15,
      color: 0x38bdf8,
      sizeAttenuation: true
    });

    var cloud = new THREE.Points(geometry, material);
    console.log('[SpatialViewer] IFC: extracted ' + (points.length / 3) + ' unique 3D points');
    self.onModelLoaded(cloud);
  };

  // Some exporters (and some corrupt downloads) leave NaN/Infinity in vertex
  // positions. three then reports "computed radius is NaN" and the whole model
  // vanishes. Collapse any triangle that touches a non-finite vertex so the
  // rest of the mesh still renders.
  SpatialViewerApp.prototype._sanitizeModelGeometry = function() {
    var fixed = 0;
    (this.modelMeshObjects || []).forEach(function(m) {
      var g = m.geometry;
      var pos = g && g.attributes && g.attributes.position;
      if (!pos || !pos.array) return;
      var arr = pos.array;
      var meshFixed = 0;

      if (g.index && g.index.array) {
        var idx = g.index.array;
        for (var t = 0; t + 2 < idx.length; t += 3) {
          var bad = false;
          for (var k = 0; k < 3 && !bad; k++) {
            var vi = idx[t + k] * 3;
            if (!isFinite(arr[vi]) || !isFinite(arr[vi + 1]) || !isFinite(arr[vi + 2])) bad = true;
          }
          if (bad) { idx[t + 1] = idx[t]; idx[t + 2] = idx[t]; meshFixed++; }
        }
        if (meshFixed) g.index.needsUpdate = true;
      } else {
        for (var i = 0; i + 8 < arr.length; i += 9) {
          var nan = false;
          for (var j = 0; j < 9 && !nan; j++) if (!isFinite(arr[i + j])) nan = true;
          if (nan) { for (var j2 = 0; j2 < 9; j2++) arr[i + j2] = 0; meshFixed++; }
        }
        if (meshFixed) pos.needsUpdate = true;
      }

      if (meshFixed) {
        g.boundingBox = null;
        g.boundingSphere = null;
        fixed += meshFixed;
      }
    });
    return fixed;
  };

  SpatialViewerApp.prototype.onModelLoaded = function(object) {
    var layerId = this._loadingLayerId;
    var layered = (layerId != null);

    this.modelObject = object;
    this.scene.add(object);

    this._bvhReady = false; // rebuild BVH for the new geometry on next tool use
    this._setLassoHighlight(null); // any old highlight references the old geometry
    // During this call modelMeshObjects holds only this layer's meshes (so
    // sanitize / BVH / bbox scope to it); _harvestLayer then merges the set.
    var thisLayerMeshes = [];
    this.modelMeshObjects = thisLayerMeshes;
    this._lastLayerMeshes = thisLayerMeshes;
    var self = this;
    var heavy = !!this.heavyMode;
    var triangles = 0;

    object.traverse(function(child) {
      if (child.isMesh || child.isPoints) {
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(function(m) { m.clippingPlanes = self.clipPlanes; });
          } else {
            child.material.clippingPlanes = self.clipPlanes;
          }
        }
        thisLayerMeshes.push(child);

        var g = child.geometry;
        if (g && g.index) triangles += g.index.count / 3;
        else if (g && g.attributes && g.attributes.position) triangles += g.attributes.position.count / 3;
      }
    });

    // Reject NaN / non-finite vertex data before it poisons the camera, the
    // bounding box and the BVH (symptom: "computed radius is NaN", blank view).
    var cleaned = this._sanitizeModelGeometry();
    if (cleaned) console.warn('[SpatialViewer] removed ' + cleaned + ' non-finite vertices from the model');

    // (1) Escalate to heavy mode if the mesh is dense even when the file is small.
    if (!heavy && triangles > 4000000) {
      heavy = this.heavyMode = true;
    }
    this._applyPerformanceMode();
    this._modelBlob = null; // release the downloaded bytes

    // Build the BVH now for light models (cheap); defer it for heavy ones to
    // the first time a drawing tool is used.
    if (!heavy) this._ensureBVH();

    var box = new THREE.Box3().setFromObject(object);
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z);
    if (!isFinite(maxDim) || maxDim <= 0) {
      console.error('[SpatialViewer] model bounding box is not finite — falling back to a default view');
      box = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
      center = new THREE.Vector3();
      maxDim = 20;
    }

    // Frame the camera on the FIRST layer only — later layers are already in
    // the same coordinate system, so we keep the user's current viewpoint.
    if (!this._framed) {
      this._framed = true;
      this.modelRadius = maxDim;
      this.surfaceOffset = 0;
      if (this.raycaster) this.raycaster.params.Points.threshold = maxDim * 0.01;

      // Open on the saved "start view" (camera position + orbit target) when
      // the model has one, otherwise auto fit-to-view as before.
      var startView = this.projectData && this.projectData.settings && this.projectData.settings.start_view;
      if (startView && startView.position && startView.target) {
        this.controls.target.set(startView.target.x, startView.target.y, startView.target.z);
        this.camera.position.set(startView.position.x, startView.position.y, startView.position.z);
      } else {
        this.controls.target.copy(center);
        this.camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 1.2, center.z + maxDim * 1.5);
      }
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this._updateClip(true);

      try {
        this._fitShadowsToModel(box, center, maxDim);
        this._homeView = { position: this.camera.position.clone(), target: this.controls.target.clone() };
      } catch (e) { console.warn('[SpatialViewer] shadow fit failed:', e); }
    } else {
      // keep modelRadius representative of the biggest layer
      this.modelRadius = Math.max(this.modelRadius || 0, maxDim);
    }

    try { this._applyRenderSettings(); }
    catch (e) { console.warn('[SpatialViewer] post-load render setup failed:', e); }

    this.renderExisting3DAnnotations();

    if (layered) {
      this._harvestLayer(layerId);
    } else {
      this.hideLoader();
    }

    // One-time navigation hint.
    if (this.currentTool === 'orbit' && !this._navHintShown) {
      this._navHintShown = true;
      this.showTooltip('Drag to orbit · scroll to zoom to cursor · <b>W A S D</b> move · <b>R</b> / <b>F</b> up · down · Shift = faster');
      var self = this;
      setTimeout(function() {
        var t = document.getElementById('drawingTooltip');
        if (t && self.currentTool === 'orbit') t.style.display = 'none';
      }, 7000);
    }
  };

  SpatialViewerApp.prototype.createDemoModel = function() {
    this.hideLoader();
    var group = new THREE.Group();
    var mainMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.4, metalness: 0.1 });
    var colMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.6 });
    for (var f = 0; f < 3; f++) {
      var floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 12), mainMat);
      floor.position.set(0, f * 4, 0);
      group.add(floor);
      for (var x = -7; x <= 7; x += 7) {
        for (var z = -5; z <= 5; z += 5) {
          var col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 3.6, 16), colMat);
          col.position.set(x, f * 4 + 2, z);
          group.add(col);
        }
      }
    }
    this.onModelLoaded(group);
  };

  SpatialViewerApp.prototype.initEvents = function() {
    // Bind DOM listeners at most once per #spatialViewerApp node. Without this,
    // a second init on the same node (Turbo re-render race) would attach every
    // handler twice — e.g. the side-panel toggle would fire toggle() twice and
    // appear dead.
    if (this.container.dataset.spatialListeners === '1') return;
    this.container.dataset.spatialListeners = '1';

    var self = this;
    this._resizeHandler = function() {
      var w = self.viewport.clientWidth;
      var h = self.viewport.clientHeight;
      if (w > 0 && h > 0) {
        self.camera.aspect = w / h;
        self.camera.updateProjectionMatrix();
        self.renderer.setSize(w, h);
      }
    };
    window.addEventListener('resize', this._resizeHandler);

    this.viewport.addEventListener('pointerdown', function(e) { self.onPointerDown(e); });
    this.viewport.addEventListener('pointermove', function(e) { self.onPointerMove(e); });
    this.viewport.addEventListener('pointerup', function(e) { self.onPointerUp(e); });
    this.viewport.addEventListener('pointercancel', function(e) { self.onPointerUp(e); });

    // Zoom toward the point under the cursor (passive:false so we can preventDefault).
    this.viewport.addEventListener('wheel', function(e) { self._onWheel(e); }, { passive: false });

    // WASD + R/F fly navigation. Bound on window so it works as soon as the
    // pointer is over the viewer, but ignored while typing in a field.
    var isTyping = function(t) {
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    this._navKeyDown = function(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      var k = (e.key || '').toLowerCase();
      if ('wasdrf'.indexOf(k) === -1 || k.length !== 1) return;
      self._navKeys[k] = true;
      self._navShift = e.shiftKey;
      e.preventDefault();
    };
    this._navKeyUp = function(e) {
      var k = (e.key || '').toLowerCase();
      if (self._navKeys[k]) delete self._navKeys[k];
      self._navShift = e.shiftKey;
    };
    this._navBlur = function() { self._navKeys = Object.create(null); };
    window.addEventListener('keydown', this._navKeyDown);
    window.addEventListener('keyup', this._navKeyUp);
    window.addEventListener('blur', this._navBlur);
    // NOTE: deliberately no 'lostpointercapture' listener. It bubbles, and
    // OrbitControls captures the pointer on the canvas first; re-capturing
    // would fire it and abort the stroke after a couple of points.
  };

  // ---- Navigation: zoom-to-cursor + WASD/RF fly ------------------------

  // Keep near/far tight around the current viewing distance so you can zoom
  // right up to a surface without it clipping, and keep good depth precision.
  SpatialViewerApp.prototype._updateClip = function(force) {
    if (!this.camera || !this.controls) return;
    var d = this.camera.position.distanceTo(this.controls.target) || 1;
    var r = this.modelRadius || d;
    var near = Math.max(1e-4, Math.min(r / 500, d * 0.02));
    var far = Math.max(d + r * 4, r * 8, 100);
    // Only touch the projection matrix on a meaningful change (avoids per-frame
    // churn while flying with the keys).
    if (force ||
        Math.abs(near - this.camera.near) > near * 0.2 ||
        Math.abs(far - this.camera.far) > far * 0.2) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  };

  // Wheel: dolly toward the world point under the cursor. Both the camera and
  // the orbit target are scaled about that point, so it stays pinned on screen
  // and there is always distance left to cover — no "stuck" zoom.
  SpatialViewerApp.prototype._onWheel = function(e) {
    if (!this.controls || !this.camera) return;
    e.preventDefault();
    if (this.isDrawing) return;

    var rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    var pivot = null;
    var meshes = this._visibleRaycastTargets();
    if (meshes.length) {
      this._ensureBVH(); // keep the per-wheel raycast cheap on big meshes
      var hit = this.raycaster.intersectObjects(meshes, true)[0];
      if (hit) pivot = hit.point.clone();
    }
    if (!pivot) {
      // no surface under the cursor: use the plane through the orbit target
      var n = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.controls.target);
      pivot = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (!pivot) return;
    }

    // deltaMode 1 = lines, 0 = pixels; normalise to roughly one "notch" = 1.
    var notches = e.deltaY / (e.deltaMode === 1 ? 3 : 100);
    var factor = Math.pow(1.18, notches);   // <1 zoom in, >1 zoom out

    var camOff = this.camera.position.clone().sub(pivot);
    var tgtOff = this.controls.target.clone().sub(pivot);
    var r = this.modelRadius || camOff.length() || 10;
    var origLen = camOff.length() || 1e-6;
    var newLen = Math.max(r * 3e-4, Math.min(r * 60, origLen * factor));
    var eff = newLen / origLen;

    this.camera.position.copy(pivot).add(camOff.multiplyScalar(eff));
    this.controls.target.copy(pivot).add(tgtOff.multiplyScalar(eff));
    this.controls.update();
    this._updateClip();
  };

  // Per-frame WASD / R-F movement. Camera and target move together (pan+dolly),
  // so orbiting afterwards still pivots around what you flew to.
  SpatialViewerApp.prototype._processNavKeys = function(dt) {
    var keys = this._navKeys;
    if (!keys) return;
    var kw = keys.w, ks = keys.s, ka = keys.a, kd = keys.d, kr = keys.r, kf = keys.f;
    if (!(kw || ks || ka || kd || kr || kf)) return;
    if (!this.controls || !this.camera) return;
    // Never move the camera mid-stroke: the lasso/draw/measure tools freeze a
    // "selection" camera matrix for their screen-space math on the first
    // sample and only refresh it when the gesture ends — moving the camera
    // while held (e.g. a stray WASD key) desyncs that frozen matrix from the
    // live one and the lasso fill renders offset from what you're drawing.
    if (this.isDrawing) return;

    var n = this._nav;
    this.camera.getWorldDirection(n.fwd).normalize();
    n.right.crossVectors(n.fwd, n.worldUp);
    if (n.right.lengthSq() < 1e-8) n.right.set(1, 0, 0); // looking straight up/down
    n.right.normalize();

    n.move.set(0, 0, 0);
    if (kw) n.move.add(n.fwd);
    if (ks) n.move.sub(n.fwd);
    if (kd) n.move.add(n.right);
    if (ka) n.move.sub(n.right);
    if (kr) n.move.add(n.worldUp);
    if (kf) n.move.sub(n.worldUp);
    if (n.move.lengthSq() < 1e-8) return;

    // Scale by the current viewing distance too, so keys stay usable whether
    // you are far out or nosed up against a wall.
    var d = this.camera.position.distanceTo(this.controls.target) || 1;
    var reach = Math.min(this.modelRadius || 10, d * 1.5) || 10;
    var speed = reach * (this._navShift ? 2.4 : 0.8);
    n.move.normalize().multiplyScalar(speed * dt);

    this.camera.position.add(n.move);
    this.controls.target.add(n.move);
    this._updateClip();
  };

  // Per-frame VR thumbstick locomotion. OrbitControls does nothing in VR (head
  // tracking drives the camera), so without this the player is stuck wherever
  // they stood when the session started. Moves/turns the `xrDolly` rig the
  // camera is parented to, not the camera itself.
  //   left stick  -> move, relative to where the headset is currently facing
  //   right stick X -> snap-turn (comfort default, in 30° steps)
  //   right stick Y -> move up / down
  SpatialViewerApp.prototype._processXRInput = function(dt) {
    var session = this._xrSession;
    if (!session || !session.inputSources || !this.xrDolly || !this.camera) return;

    var DEAD = 0.15;
    var moveX = 0, moveY = 0, turnX = 0, liftY = 0, haveStick = false;

    session.inputSources.forEach(function(src) {
      var gp = src && src.gamepad;
      if (!gp || !gp.axes || gp.axes.length < 2) return;
      // xr-standard mapping puts the thumbstick at axes[2]/[3] when a
      // touchpad also occupies axes[0]/[1]; fall back to [0]/[1] otherwise.
      var ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0];
      var ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1];
      if (Math.abs(ax) < DEAD) ax = 0;
      if (Math.abs(ay) < DEAD) ay = 0;
      if (!ax && !ay) return;
      haveStick = true;

      if (src.handedness === 'right') { turnX = ax; liftY = -ay; }
      else { moveX = ax; moveY = ay; } // 'left', or 'none' on a single-controller setup
    });
    if (!haveStick) return;

    var n = this._nav;

    // Snap-turn: rotate the dolly around the head's current world position so
    // turning feels like turning in place rather than orbiting around it.
    if (Math.abs(turnX) > 0.6) {
      if (!this._xrTurnArmed) {
        this._xrTurnArmed = true;
        var angle = (turnX > 0 ? -1 : 1) * (Math.PI / 6); // 30°
        this.camera.getWorldPosition(n.xrHead);
        this.xrDolly.position.sub(n.xrHead).applyAxisAngle(n.worldUp, angle).add(n.xrHead);
        this.xrDolly.rotateY(angle);
      }
    } else if (Math.abs(turnX) < 0.3) {
      this._xrTurnArmed = false;
    }

    if (moveX || moveY || liftY) {
      this.camera.getWorldDirection(n.fwd);
      n.fwd.y = 0;
      if (n.fwd.lengthSq() < 1e-6) n.fwd.set(0, 0, -1); else n.fwd.normalize();
      n.right.crossVectors(n.fwd, n.worldUp).normalize();

      var speed = (this.modelRadius || 10) * 0.8;
      n.move.set(0, liftY * speed * dt, 0)
        .addScaledVector(n.fwd, -moveY * speed * dt)
        .addScaledVector(n.right, moveX * speed * dt);
      this.xrDolly.position.add(n.move);
    }
  };

  // Build BVH bounds trees for the model meshes (once). Synchronous: a one-time
  // freeze of up to ~1-2 s on very large models, triggered when a tool that
  // needs surface raycasts is first used.
  SpatialViewerApp.prototype._ensureBVH = function() {
    if (this._bvhReady) return;
    installBVH(); // in case the library finished loading after initThree
    if (!THREE.__bvhInstalled) return; // library not ready yet — retry next call
    this._bvhReady = true;
    if (!this.modelMeshObjects) return;

    var todo = this.modelMeshObjects.filter(function(m) {
      if (!m.isMesh || !m.geometry || m.geometry.boundsTree) return false;
      var pos = m.geometry.attributes && m.geometry.attributes.position;
      return pos && pos.count > 30 && pos.count <= 9000000;
    });
    if (!todo.length) return;

    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    todo.forEach(function(m) {
      try { m.geometry.computeBoundsTree({ maxLeafTris: 12 }); } catch (e) {
        console.warn('[SpatialViewer] computeBoundsTree failed:', e);
      }
    });
    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    console.log('[SpatialViewer] BVH: ' + todo.length + ' tree(s) in ' + Math.round(t1 - t0) + ' ms');
  };

  // Only raycasts against layers that are actually visible right now.
  // THREE.Raycaster.intersectObjects does not check an object's own (or its
  // ancestors') .visible flag -- that's purely a rendering-time concern --
  // so without this, hiding a layer in the panel only stopped it from being
  // drawn, not from being hit: a pin/lasso/measurement click (or, via
  // _onWheel, a scroll-zoom pivot) could silently land on a hidden layer's
  // surface, which is wrong whenever two layers cover different areas of
  // the same scene (common -- e.g. a point cloud and a mesh rarely have
  // identical coverage). Shared by every raycast call site in this file --
  // see _onWheel for the other one; _raycastAt was previously the only one
  // filtered, which is why a wheel-zoom near a hidden layer could still
  // pivot on it even after that fix.
  SpatialViewerApp.prototype._visibleRaycastTargets = function() {
    return (this.modelMeshObjects || []).filter(function(m) {
      var lg = m.userData && m.userData.layerVisibilityGroup;
      return !lg || lg.visible !== false;
    });
  };

  SpatialViewerApp.prototype._raycastAt = function(clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    var intersects = this.raycaster.intersectObjects(this._visibleRaycastTargets(), true);
    if (!intersects.length) return null;

    // Prefer the nearest FRONT-facing hit over the raw nearest one.
    // Real-world scanned/photogrammetric meshes routinely have noisy,
    // near-duplicate or interior geometry (thin double surfaces, stitching
    // artifacts); when the material renders double-sided, a stray
    // back-facing triangle from one of those artifacts can end up slightly
    // closer to the camera than the true outer surface at some pixels but
    // not others. The raw nearest hit then intermittently lands on that
    // artifact instead of the real surface -- a GENUINE ray-mesh
    // intersection, so it looks correct from the exact angle it was picked
    // at, but visibly detached from the surface from any other angle. This
    // doesn't fully fix noisy mesh data (nothing in a raycaster can), but it
    // removes the most common, well-understood cause of it.
    var rayDir = this.raycaster.ray.direction;
    for (var i = 0; i < intersects.length; i++) {
      var hit = intersects[i];
      if (!hit.face) return hit; // no face info (e.g. a Points object) -- nothing to prefer
      var worldNormal = hit.face.normal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      if (worldNormal.dot(rayDir) < 0) return hit; // front-facing: normal points back toward the ray origin
    }
    return intersects[0]; // nothing front-facing (e.g. camera inside the mesh) -- fall back to nearest
  };

  SpatialViewerApp.prototype.getIntersection = function(e) {
    return this._raycastAt(e.clientX, e.clientY);
  };

  // World-space surface normal at a ray hit (identity if unavailable).
  SpatialViewerApp.prototype._hitNormal = function(hit) {
    if (hit.face && hit.face.normal && hit.object) {
      var n = hit.face.normal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
      if (n.lengthSq() > 1e-10) return n.normalize();
    }
    return new THREE.Vector3().subVectors(this.camera.position, hit.point).normalize();
  };

  // The hit point, essentially ON the surface (drawn lines use depthTest:false
  // so they never z-fight and need no visible lift).
  SpatialViewerApp.prototype._surfacePoint = function(hit) {
    var off = this.surfaceOffset || 0;
    if (off <= 0) return hit.point.clone();
    return hit.point.clone().addScaledVector(this._hitNormal(hit), off);
  };

  // ---- 2D overlay used to draw the lasso outline -------------------------
  // The lasso is a screen-space gesture: drawing it on a 2D canvas keeps it
  // dense, always closed and exactly under the cursor, with zero raycasting.
  SpatialViewerApp.prototype._ensureLassoOverlay = function() {
    if (this.lassoOverlay && this.lassoOverlay.parentNode) return this.lassoOverlay;
    var c = document.createElement('canvas');
    c.className = 'lasso-overlay';
    c.style.position = 'absolute';
    c.style.left = '0';
    c.style.top = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.pointerEvents = 'none';
    c.style.zIndex = '40';
    this.viewport.appendChild(c);
    this.lassoOverlay = c;
    return c;
  };

  SpatialViewerApp.prototype._drawLassoOverlay = function(path, closed) {
    var c = this._ensureLassoOverlay();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!path || path.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (var i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    if (closed) ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.activeColor;
    ctx.stroke();
  };

  SpatialViewerApp.prototype._clearLassoOverlay = function() {
    if (!this.lassoOverlay) return;
    var ctx = this.lassoOverlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.lassoOverlay.width, this.lassoOverlay.height);
  };

  SpatialViewerApp.prototype._viewportPoint = function(clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  SpatialViewerApp.prototype.onPointerDown = function(e) {
    // Recorded unconditionally (even in orbit mode, which returns right
    // below) so onPointerUp can tell a plain click on a label card from the
    // end of an orbit drag -- see the label-click check there.
    this._pdownClient = { x: e.clientX, y: e.clientY };
    if (this.currentTool === 'orbit' || e.button !== 0) return;

    var isLasso = this.currentTool === 'lasso';

    // The lasso needs no surface hit to start — it is a screen gesture.
    var hit = isLasso ? null : this.getIntersection(e);
    if (!isLasso && !hit) return;

    if (this.currentTool === 'pin') {
      this.place3DPin(hit.point, this._hitNormal(hit));
      return;
    }
    if (this.currentTool === 'measure') {
      if (!this.measureStartPoint) {
        this.measureStartPoint = hit.point.clone();
        this.showTooltip('Point 1 selected. Click second point to measure.');
      } else {
        this.finishMeasurement(this.measureStartPoint, hit.point);
        this.measureStartPoint = null;
      }
      return;
    }
    if (this.currentTool !== 'draw' && !isLasso) return;

    this.isDrawing = true;
    this.controls.enabled = false;
    this._setLassoHighlight(null);
    // Capture the pointer so the stroke keeps going (and pointerup still fires)
    // even if the cursor leaves the viewport.
    // Capture on the CANVAS — the same element OrbitControls uses — so there is
    // no capture transfer (which would fire lostpointercapture and kill the
    // stroke). Events still bubble to our listeners on the viewport.
    try { if (e.pointerId != null) this.canvas.setPointerCapture(e.pointerId); } catch (ignore) {}
    this._activePointerId = (e.pointerId != null) ? e.pointerId : null;
    this._pointerClient = { x: e.clientX, y: e.clientY };
    this._lastSampleClient = { x: e.clientX, y: e.clientY };

    if (isLasso) {
      this.lassoScreenPath = [this._viewportPoint(e.clientX, e.clientY)];
      this._lassoHlFrame = 0;
      this._drawLassoOverlay(this.lassoScreenPath, true);
    } else {
      this.currentDrawingPoints = [this._surfacePoint(hit)];
      this._updateOutline(this.currentDrawingPoints, false);
    }
  };

  SpatialViewerApp.prototype.onPointerMove = function(e) {
    this._pointerClient = { x: e.clientX, y: e.clientY };
    if (!this.isDrawing) return;
    var list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    var n = list.length, cap = 24, stride = n > cap ? Math.ceil(n / cap) : 1;
    for (var i = 0; i < n; i += stride) {
      this._sampleDrawPoint(list[i].clientX, list[i].clientY);
    }
  };

  SpatialViewerApp.prototype._sampleDrawPoint = function(clientX, clientY) {
    if (this.currentTool === 'lasso') return this._sampleLassoScreen(clientX, clientY);
    return this._sampleDrawSurface(clientX, clientY);
  };

  // Lasso: pure screen-space path, interpolated to ~2 px. No raycasting, so it
  // stays dense on any model regardless of triangle count.
  SpatialViewerApp.prototype._sampleLassoScreen = function(clientX, clientY) {
    var path = this.lassoScreenPath;
    if (!path) return;
    if (path.length >= 4000) return;

    var p = this._viewportPoint(clientX, clientY);
    var last = path[path.length - 1];
    var dx = p.x - last.x, dy = p.y - last.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var minPx = 2;
    if (dist < minPx) return;

    var steps = Math.min(Math.floor(dist / minPx), 600);
    for (var s = 1; s <= steps; s++) {
      var t = (s * minPx) / dist;
      path.push({ x: last.x + dx * t, y: last.y + dy * t });
    }
    path.push(p);
    this._lastSampleClient = { x: clientX, y: clientY };

    this._drawLassoOverlay(path, true);
    // Live surface highlight, refreshed every few samples (coarse grid — kept
    // snappy while the pointer is still moving; _finishLasso rebuilds it at
    // full quality once the stroke ends).
    if ((++this._lassoHlFrame % 4) === 0) {
      this._buildLassoFill(path, this.activeColor, false);
    }
  };

  // Free-hand polyline on the surface: still needs a ray per point, but the
  // number of rays per event is capped so a heavy mesh cannot stall the UI.
  SpatialViewerApp.prototype._sampleDrawSurface = function(clientX, clientY) {
    if (this.currentDrawingPoints.length >= 4000) return;
    var minPx = 5;
    var last = this._lastSampleClient;
    if (!last) { this._addSampleRay(clientX, clientY); return; }

    var dx = clientX - last.x, dy = clientY - last.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minPx) return;

    var steps = Math.min(Math.floor(dist / minPx), 8); // hard ray budget
    var added = false;
    for (var s = 1; s <= steps; s++) {
      var t = (s * minPx) / dist;
      if (this._addSampleRay(last.x + dx * t, last.y + dy * t)) added = true;
    }
    if (this._addSampleRay(clientX, clientY)) added = true;
    if (added) this._updateOutline(this.currentDrawingPoints, false);
  };

  SpatialViewerApp.prototype._addSampleRay = function(clientX, clientY) {
    var hit = this._raycastAt(clientX, clientY);
    if (!hit) return false;
    this._lastSampleClient = { x: clientX, y: clientY };
    this.currentDrawingPoints.push(this._surfacePoint(hit));
    return true;
  };

  SpatialViewerApp.prototype.onPointerUp = function(e) {
    // Clicking a lasso's label card (in orbit/navigate mode, i.e. no drawing
    // tool active) opens the same annotation detail view as clicking its
    // entry in the side panel's list -- same behavior, two entry points.
    // Gated on "didn't drag" (a small pixel threshold since the pointer
    // down) so releasing an orbit drag on top of a card doesn't trigger it.
    if (this.currentTool === 'orbit' && e && !this.isDrawing) {
      var moved = this._pdownClient &&
        (Math.abs(e.clientX - this._pdownClient.x) > 5 || Math.abs(e.clientY - this._pdownClient.y) > 5);
      if (!moved) {
        var hitAnnotation = this._raycastAnnotationLabels(e.clientX, e.clientY);
        if (hitAnnotation) { this.openAnnotationDetail(hitAnnotation); return; }
      }
    }
    if (!this.isDrawing) return;
    this.isDrawing = false;
    // Restore orbiting only if the orbit tool is active — leaving it enabled
    // while a drawing tool is selected let OrbitControls grab the pointer on
    // the next stroke.
    this.controls.enabled = (this.currentTool === 'orbit');
    try {
      if (this._activePointerId != null) this.canvas.releasePointerCapture(this._activePointerId);
    } catch (ignore) {}
    this._activePointerId = null;

    if (this.currentTool === 'lasso') return this._finishLasso();

    var pts = this.currentDrawingPoints || [];
    if (pts.length < 2) { this.clearTempMarkup(); return; }
    this._updateOutline(pts, false);
    this.openAnnotationModal({
      type: 'draw_polyline',
      closed: false,
      points: pts.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    });
  };

  SpatialViewerApp.prototype._finishLasso = function() {
    var path = this.lassoScreenPath || [];
    if (path.length < 3) { this._clearLassoOverlay(); this.clearTempMarkup(); return; }

    this._drawLassoOverlay(path, true);
    this._buildLassoFill(path, this.activeColor, true);

    // Now (once) turn a down-sampled screen ring into 3D points for storage.
    // The 2D overlay stays on screen as the outline until the form is closed.
    // 220 matches the polygon resolution _buildLassoFill itself uses
    // (downsamplePolyPx's cap) -- it used to be 64, a leftover from the old
    // GLSL-shader lasso where the ring fed a fixed-size uniform array. That
    // constraint is gone now that the inside-test runs in plain JS, but the
    // low cap stayed, so the *stored* ring was a coarser approximation of the
    // drawn shape than the live fill: re-selecting the surface from it after
    // save (showAnnotationSurface -> _selectSurfaceInLasso) rebuilt a visibly
    // different, "cut-corners" polygon -- looked aligned while drawing,
    // misaligned once saved.
    var ring = this._screenPathToWorldRing(path, 220);
    if (ring.length < 3) { this._clearLassoOverlay(); this.clearTempMarkup(); return; }

    this.currentDrawingPoints = ring;
    console.log('[SpatialViewer] lasso: ' + path.length + ' screen points -> ' + ring.length + ' 3D points');

    // `points` (the ring) is kept for legacy-annotation fallback / potential
    // re-editing; `fill_*` is what actually gets displayed on reload now --
    // the exact triangulated surface patch the user just saw, stored as real
    // 3D points so no raycasting or camera-dependent reprojection is needed
    // to show it correctly again later (see _buildLassoFillFromGrid).
    var gd = {
      type: 'lasso_selection',
      closed: true,
      points: ring.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    };
    var fg = this._lastLassoGrid;
    if (fg && fg.grid && fg.rows && fg.cols) {
      gd.fill_rows = fg.rows;
      gd.fill_cols = fg.cols;
      gd.fill_grid = fg.grid.map(function(p) {
        return p ? [round5(p.x), round5(p.y), round5(p.z)] : null;
      });
    }

    this.openAnnotationModal(gd);
  };

  // Down-sample the screen ring and project it onto the model; points that miss
  // the mesh fall back to the focal plane so the stored ring always has the
  // shape that was drawn. Uses the same even (float-stride) spacing as
  // downsamplePolyPx -- an earlier integer stride (floor(n/maxPoints)) could
  // stop short of the end of the path whenever maxPoints didn't divide n
  // evenly (e.g. 1000 points at a stride of floor(1000/220)=4 only reaches
  // index 876, silently dropping the last ~12% of the drawn stroke and
  // closing the polygon across the gap instead of the actual shape).
  SpatialViewerApp.prototype._screenPathToWorldRing = function(path, maxPoints) {
    this._ensureBVH();
    var rect = this.canvas.getBoundingClientRect();
    var n = path.length;
    if (n === 0) return [];

    var planeNormal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      planeNormal, (this.controls ? this.controls.target : new THREE.Vector3()).clone()
    );

    var count = Math.min(maxPoints, n);
    var stride = n / count;
    var pts = new Array(count);
    var planeFallback = new Array(count);
    var anyHit = false;
    for (var i = 0; i < count; i++) {
      var p = path[Math.min(n - 1, Math.floor(i * stride))];
      var hit = this._raycastAt(rect.left + p.x, rect.top + p.y); // also aims this.raycaster.ray at this pixel
      if (hit) { pts[i] = this._surfacePoint(hit); anyHit = true; }
      else { pts[i] = null; planeFallback[i] = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()); }
    }

    // Sparse point-cloud/splat layers have real gaps between rendered discs --
    // a raycast miss there doesn't mean "off the model" the way it would for a
    // solid mesh. Snapping every miss straight to this camera-facing plane
    // used to land on the right screen pixel from the exact viewpoint the
    // lasso was drawn from, but at the wrong real-world depth -- so
    // reprojecting the saved ring from a different angle/zoom made those
    // stretches of the outline visibly detach from the actual points.
    // Borrowing the nearest successful hit along the path instead keeps every
    // ring vertex glued to real geometry; the plane is now only a last resort,
    // for the (rare) case where literally nothing in the whole stroke hit
    // anything.
    var out = [];
    for (var j = 0; j < count; j++) {
      if (pts[j]) { out.push(pts[j]); continue; }
      if (anyHit) {
        var before = null, after = null;
        for (var b = j - 1; b >= 0; b--) { if (pts[b]) { before = pts[b]; break; } }
        for (var a = j + 1; a < count; a++) { if (pts[a]) { after = pts[a]; break; } }
        if (before || after) out.push((before || after).clone());
      } else if (planeFallback[j]) {
        out.push(planeFallback[j]);
      }
    }
    return out;
  };

  // Outline preview. When closed (lasso) the ring is explicitly closed by
  // repeating the first point (more reliable than LineLoop across drivers).
  SpatialViewerApp.prototype._updateOutline = function(points, closed) {
    if (this.currentDrawingLine) {
      this.tempMarkupGroup.remove(this.currentDrawingLine);
      this.currentDrawingLine.geometry.dispose();
      this.currentDrawingLine = null;
    }
    var pts = (closed && points.length > 2) ? points.concat([points[0]]) : points;
    var geom = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(this.activeColor), depthTest: false, transparent: true
    });
    this.currentDrawingLine = new THREE.Line(geom, mat);
    this.currentDrawingLine.renderOrder = 999;
    this.tempMarkupGroup.add(this.currentDrawingLine);
  };

  SpatialViewerApp.prototype._setLassoHighlight = function(objOrNull) {
    if (!this.lassoHighlightGroup) return;
    var g = this.lassoHighlightGroup;
    while (g.children.length) {
      var c = g.children[0];
      c.traverse(function(n) {
        // geometry is SHARED with the model — never dispose it here
        if (n.geometry && !n.userData._sharedGeometry) n.geometry.dispose();
        if (n.material && n.material.dispose) n.material.dispose();
      });
      g.remove(c);
    }
    this._lassoHl = objOrNull || null;
    if (objOrNull) g.add(objOrNull);
  };

  // World point -> canvas-relative CSS pixel (same convention as _viewportPoint
  // / this.lassoScreenPath), via the given camera.
  SpatialViewerApp.prototype._worldToPixel = function(worldPt, camera) {
    var p = worldPt.clone().project(camera || this.camera);
    var w = this.viewport.clientWidth || 1, h = this.viewport.clientHeight || 1;
    return { x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h };
  };

  // Build the lasso fill by casting a grid of rays (one per sample point
  // inside the screen-space polygon) at the model and meshing the hits into a
  // triangle patch. `quality=false` uses a coarser grid for snappy live-drag
  // updates; `_finishLasso` and replay (`_selectSurfaceInLasso`) ask for the
  // finer one since they only run once. `screenPathPx` is in the same
  // canvas-relative CSS-pixel space as `this.lassoScreenPath`.
  SpatialViewerApp.prototype._buildLassoFill = function(screenPathPx, color, quality) {
    this._lastLassoGrid = null; // avoid a stale grid surviving an early return below
    if (!screenPathPx || screenPathPx.length < 3 || !this.modelMeshObjects || !this.modelMeshObjects.length) {
      this._setLassoHighlight(null);
      return;
    }
    this._ensureBVH();

    var rect = this.canvas.getBoundingClientRect();
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < screenPathPx.length; i++) {
      var p = screenPathPx[i];
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    var bboxW = Math.max(1, maxX - minX), bboxH = Math.max(1, maxY - minY);

    var targetSamples = quality ? 2600 : 900;
    var step = Math.sqrt((bboxW * bboxH) / targetSamples);
    step = Math.max(quality ? 3 : 5, Math.min(22, step));

    var cols = Math.min(90, Math.max(2, Math.ceil(bboxW / step) + 1));
    var rows = Math.min(90, Math.max(2, Math.ceil(bboxH / step) + 1));
    var stepX = bboxW / (cols - 1), stepY = bboxH / (rows - 1);
    var poly = downsamplePolyPx(screenPathPx, 220);

    var grid = new Array(cols * rows);
    var any = false;
    for (var gy = 0; gy < rows; gy++) {
      var py = minY + gy * stepY;
      for (var gx = 0; gx < cols; gx++) {
        var px = minX + gx * stepX;
        var idx = gy * cols + gx;
        if (!pointInPolygon(px, py, poly)) { grid[idx] = null; continue; }
        var hit = this._raycastAt(rect.left + px, rect.top + py);
        if (hit) { grid[idx] = hit.point.clone(); any = true; } else { grid[idx] = null; }
      }
    }
    if (!any) { this._setLassoHighlight(null); this._lastLassoGrid = null; return; }

    // Stashed so _finishLasso can persist this exact grid (see
    // _buildLassoFillFromGrid) -- the saved annotation then re-displays this
    // same surface patch forever, with no raycasting or camera-dependent
    // reprojection involved on reload.
    this._lastLassoGrid = { grid: grid, rows: rows, cols: cols };

    var positions = triangulateLassoGrid(grid, rows, cols);
    if (!positions.length) { this._setLassoHighlight(null); return; }
    this._setLassoHighlight(this._lassoMeshGroup(positions, color));
  };

  // Shared mesh/material construction for a lasso fill patch, given its
  // already-triangulated vertex positions (flat [x,y,z,...] array).
  SpatialViewerApp.prototype._lassoMeshGroup = function(positions, color) {
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();

    var mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthTest: true, depthWrite: false,
      // Every vertex already sits exactly on the real surface — this just
      // nudges the depth comparison so the patch wins the z-fight against it.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
    mesh.renderOrder = 997;
    mesh.frustumCulled = false;

    var group = new THREE.Group();
    group.add(mesh);
    return group;
  };

  // Rebuilds a SAVED lasso fill directly from its stored grid of 3D hit
  // points -- no raycasting, no screen-space reprojection, no dependency on
  // the current (or restored) camera at all. The patch is the same real
  // surface geometry that was selected when it was drawn, so it stays
  // correctly anchored to the surface from any viewing angle, exactly like
  // the live fill the user saw while drawing it.
  SpatialViewerApp.prototype._buildLassoFillFromGrid = function(gridData, color) {
    if (!gridData || !gridData.grid || !gridData.rows || !gridData.cols) return false;
    var positions = triangulateLassoGrid(gridData.grid, gridData.rows, gridData.cols);
    if (!positions.length) return false;
    this._setLassoHighlight(this._lassoMeshGroup(positions, color));
    return true;
  };

  // Same fill, driven by a stored 3D ring: project it to screen pixels through
  // `camera` (the viewer has just flown back to the annotation's saved
  // viewpoint, so this is effectively the same view the ring was drawn in)
  // and run the same raycast grid.
  SpatialViewerApp.prototype._selectSurfaceInLasso = function(ring3d, camera, color) {
    if (!ring3d || ring3d.length < 3) return;
    camera = camera || this.camera;
    camera.updateMatrixWorld();
    this.scene.updateMatrixWorld(true);

    var self = this;
    var pixelPoly = ring3d.map(function(v) { return self._worldToPixel(v, camera); });
    this._buildLassoFill(pixelPoly, color, true);
  };

  SpatialViewerApp.prototype.place3DPin = function(point, normal) {
    var g = new THREE.ConeGeometry(0.2, 0.6, 16);
    g.translate(0, 0.3, 0); g.rotateX(Math.PI);
    var mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(this.activeColor), roughness: 0.2 }));
    mesh.position.copy(point);
    mesh.quaternion.copy(pinQuaternionFromNormal(normal));
    this.tempMarkupGroup.add(mesh);
    this.openAnnotationModal({ type: 'pin', points: [{x:point.x,y:point.y,z:point.z}], normal: {x:normal.x,y:normal.y,z:normal.z} });
  };

  SpatialViewerApp.prototype.finishMeasurement = function(ptA, ptB) {
    var dist = ptA.distanceTo(ptB).toFixed(2);
    var geom = new THREE.BufferGeometry().setFromPoints([ptA, ptB]);
    var mat = new THREE.LineDashedMaterial({ color: 0xf59e0b, dashSize: 0.2, gapSize: 0.1 });
    var line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    this.tempMarkupGroup.add(line);
    this.openAnnotationModal({ type: 'measurement', points: [{x:ptA.x,y:ptA.y,z:ptA.z},{x:ptB.x,y:ptB.y,z:ptB.z}], dist: dist });
  };

  SpatialViewerApp.prototype.captureSnapshot = function() {
    // Every call site adds the new annotation's geometry (pin cone, outline,
    // lasso fill) to the scene and calls this SYNCHRONOUSLY right after, in
    // the same pointerup handler -- before the browser's next vsync, i.e.
    // before setAnimationLoop gets to render a frame that actually contains
    // it. Without forcing a render here first, toDataURL() reads back
    // whatever the PREVIOUS frame already had in the buffer, which is from
    // before this annotation's geometry existed -- the thumbnail then shows
    // the model without the very thing it's supposed to be a preview of.
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
    return this.renderer.domElement.toDataURL('image/png');
  };

  // Opens the inline "New Work Package" panel beside the viewer (BCF-style
  // split view) instead of a modal overlay.
  SpatialViewerApp.prototype.openAnnotationModal = function(gd) {
    this.pendingGeometry = gd;
    this.pendingThumbnail = this.captureSnapshot();
    // Captured HERE (geometry-finalization time), not later in
    // saveAnnotation() -- the create panel stays open (and nothing stops the
    // user switching to the orbit tool to inspect the model) for as long as
    // they're filling in the subject/description/etc. before clicking Save.
    // For a lasso selection specifically, this is what made a save "look
    // aligned while drawing, misaligned once saved": the stored ring is tied
    // to the exact viewpoint it was raycast from, but reading the camera
    // fresh at save time could capture a DIFFERENT viewpoint (if the user
    // had rotated the view in between) -- flying back to that wrong
    // viewpoint on reload and reprojecting the (unrelated) ring through it
    // is pure parallax error. Pin/polyline/measurement annotations have the
    // same gap, just no reprojection step to make it visible.
    this.pendingCameraViewpoint = {
      eye: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      up: [this.camera.up.x, this.camera.up.y, this.camera.up.z]
    };
    this._detailAnnotation = null; // leave any open detail view

    var panel = document.getElementById('spatialSidePanel');
    var snap = document.getElementById('caSnapshot');
    var subject = document.getElementById('caSubject');
    var descInput = document.getElementById('caDesc');
    var titleEl = document.getElementById('createPanelTitle');

    if (snap) snap.src = this.pendingThumbnail;

    var labels = {
      pin: '3D pin', draw_polyline: 'Mesh drawing',
      lasso_selection: 'Mesh region', measurement: 'Measurement'
    };
    var suggested = gd.type === 'measurement'
      ? ('Measurement: ' + gd.dist + ' m')
      : ((labels[gd.type] || 'Annotation') + ' — ' + (this.projectData && this.projectData.title ? this.projectData.title : '3D model'));

    if (subject) subject.value = suggested;
    if (descInput) descInput.value = '';
    if (titleEl) titleEl.innerText = 'New Work Package';

    // Reset the optional standard fields to their neutral default so a value
    // left over from a previous annotation is not silently reused.
    ['caStatus', 'caPriority', 'caAssignee', 'caAccountable', 'caCategory',
     'caVersion', 'caParent', 'caStartDate', 'caDueDate', 'caEstimatedHours']
      .forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });

    // Reset mode to "new"
    var newRadio = document.querySelector('input[name="caMode"][value="new"]');
    if (newRadio) { newRadio.checked = true; this.updateCreateMode('new'); }

    var typeEl = document.getElementById('caType');
    this._renderCustomFieldsForType(typeEl ? typeEl.value : null);

    this.openSidePanel();
    if (panel) { panel.classList.remove('detailing'); panel.classList.add('creating'); }
    if (subject) subject.focus();
  };

  // ---- Side panel ---------------------------------------------------------
  // State is read back from the DOM on every toggle instead of being kept in an
  // instance flag: a stale flag (e.g. a second viewer instance, or a re-init)
  // would otherwise make every click compute "open -> closed" and the panel
  // could never come back.
  function panelWidthPref() {
    var stored = null;
    try { stored = window.localStorage.getItem('spatialViewer.panelWidth'); } catch (e) {}
    return Math.min(900, Math.max(280, parseInt(stored, 10) || 380));
  }

  function isSidePanelOpen() {
    var sp = document.getElementById('spatialSidePanel');
    if (!sp) return false;
    if (sp.classList.contains('collapsed')) return false;
    var cs = window.getComputedStyle(sp);
    return cs.display !== 'none' && parseFloat(cs.width) > 1;
  }

  function setSidePanelOpen(open, width) {
    var sp = document.getElementById('spatialSidePanel');
    if (!sp) return;
    var app = window.spatialViewerApp;

    if (open) {
      sp.classList.remove('collapsed');
      // Inline styles: no stylesheet rule can keep it hidden.
      sp.style.display = 'flex';
      sp.style.width = (width || panelWidthPref()) + 'px';
      sp.style.minWidth = '';
      // A stale "creating" / "detailing" class would bring the panel back on a
      // sub-view instead of the tabs.
      if (!app || !app.pendingGeometry) sp.classList.remove('creating');
      if (!app || !app._detailAnnotation) sp.classList.remove('detailing');
    } else {
      sp.classList.add('collapsed');
      sp.style.display = 'none';
      sp.style.width = '0px';
    }

    var btn = document.getElementById('btnSidePanelToggle');
    if (btn) {
      if (open) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    if (app) {
      app._panelOpen = open;
      if (app._resizeHandler) app._resizeHandler();
    }
    var cs = window.getComputedStyle(sp);
    console.log('[SpatialViewer] side panel ' + (open ? 'OPEN' : 'CLOSED') +
      ' (display=' + cs.display + ', width=' + cs.width + ')');
  }

  SpatialViewerApp.prototype._initSidePanel = function() {
    var self = this;
    var sp = document.getElementById('spatialSidePanel');
    if (!sp) return;
    this.sidePanel = sp;
    this._panelWidth = panelWidthPref();
    setSidePanelOpen(isSidePanelOpen(), this._panelWidth);

    // Bind once, and deliberately NOT through the app instance: the handler
    // only talks to the DOM, so a stale viewer instance cannot break it.
    var btn = document.getElementById('btnSidePanelToggle');
    if (btn && btn.dataset.spatialToggleBound !== '1') {
      btn.dataset.spatialToggleBound = '1';
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        setSidePanelOpen(!isSidePanelOpen());
      });
    }

    if (!sp.querySelector('.side-panel-resizer')) {
      var grip = document.createElement('div');
      grip.className = 'side-panel-resizer';
      grip.title = 'Drag to resize';
      sp.insertBefore(grip, sp.firstChild);

      var dragging = false, pid = null;
      grip.addEventListener('pointerdown', function(e) {
        dragging = true;
        pid = (e.pointerId != null) ? e.pointerId : null;
        grip.classList.add('dragging');
        try { if (pid != null) grip.setPointerCapture(pid); } catch (ignore) {}
        e.preventDefault();
        e.stopPropagation();
      });
      grip.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        var right = sp.getBoundingClientRect().right;
        self._panelWidth = Math.min(900, Math.max(280, Math.round(right - e.clientX)));
        sp.style.width = self._panelWidth + 'px';
        if (self._resizeHandler) self._resizeHandler();
        e.preventDefault();
      });
      var endDrag = function() {
        if (!dragging) return;
        dragging = false;
        grip.classList.remove('dragging');
        try { if (pid != null) grip.releasePointerCapture(pid); } catch (ignore) {}
        pid = null;
        try { window.localStorage.setItem('spatialViewer.panelWidth', String(self._panelWidth)); } catch (e) {}
      };
      grip.addEventListener('pointerup', endDrag);
      grip.addEventListener('pointercancel', endDrag);
    }
  };

  SpatialViewerApp.prototype._applyPanelState = function() {
    setSidePanelOpen(isSidePanelOpen(), this._panelWidth);
  };

  // Both derive the current state from the DOM, so they can never desynchronise.
  SpatialViewerApp.prototype.toggleSidePanel = function() {
    setSidePanelOpen(!isSidePanelOpen(), this._panelWidth);
  };

  SpatialViewerApp.prototype.openSidePanel = function() {
    if (isSidePanelOpen()) return;
    setSidePanelOpen(true, this._panelWidth);
  };

  SpatialViewerApp.prototype.updateCreateMode = function(mode) {
    var ng = document.getElementById('caNewGroup');
    var eg = document.getElementById('caExistingGroup');
    if (ng) ng.style.display = (mode === 'existing') ? 'none' : 'block';
    if (eg) eg.style.display = (mode === 'existing') ? 'block' : 'none';
  };

  // A field's current value, serialized the same way whether it's freshly
  // rendered, prefilled, or edited by the user -- used both to build a
  // before/after snapshot (see openAnnotationDetail/saveWorkPackageEdits)
  // and, with cfFieldValueForPayload, to collect what actually gets sent.
  function cfFieldValueForSnapshot(field) {
    if (field.dataset.cfFormat === 'bool') return field.checked ? '1' : '0';
    if (field.dataset.cfMulti) {
      return Array.prototype.map.call(field.selectedOptions || [], function(o) { return o.value; }).join('\u0000');
    }
    return field.value;
  }

  // One <input>/<select>/<textarea> per custom field enabled for the given
  // Work Package type (custom fields are enabled per project+type in
  // OpenProject -- see @custom_fields_by_type / this.customFieldsByType).
  // Replaces whatever was previously rendered into `hostId`.
  // data-cf-id/data-cf-format (and data-cf-multi for a multi-value select)
  // are how saveAnnotation/saveWorkPackageEdits collect the values back out
  // generically. `prefill`, when given, is a WP's current
  // `{ custom_field_id: [raw value string, ...] }` (see
  // SpatialAnnotation#work_package_detail_payload) -- used by the "edit
  // linked Work Package" panel, omitted for the "create new" one.
  // Returns a snapshot ({ cfId: serialized value }) of what ended up
  // rendered, for the caller to diff later edits against.
  SpatialViewerApp.prototype._renderCustomFieldsForType = function(typeId, hostId, prefill) {
    var host = document.getElementById(hostId || 'caCustomFields');
    var snapshot = {};
    if (!host) return snapshot;
    host.innerHTML = '';

    var fields = this.customFieldsByType[typeId] || this.customFieldsByType[String(typeId)] || [];
    if (!fields.length) return snapshot;

    var section = document.createElement('p');
    section.className = 'create-panel-section';
    section.textContent = 'Type-specific fields';
    host.appendChild(section);

    fields.forEach(function(cf) {
      var group = document.createElement('div');
      group.className = 'form-group';

      var label = document.createElement('label');
      label.textContent = cf.name + (cf.required ? ' *' : '');
      group.appendChild(label);

      var existing = (prefill && prefill[cf.id]) || [];
      var field;
      if (cf.format === 'text') {
        field = document.createElement('textarea');
        field.className = 'form-textarea';
        field.rows = 3;
        field.value = existing[0] || '';
      } else if (cf.format === 'bool') {
        // Laid out inline with its own label text instead of the shared
        // <label> above (a bare checkbox next to a label reads oddly).
        group.innerHTML = '';
        var boolLabel = document.createElement('label');
        boolLabel.className = 'form-check-label';
        field = document.createElement('input');
        field.type = 'checkbox';
        field.checked = existing[0] === '1' || existing[0] === 't';
        boolLabel.appendChild(field);
        boolLabel.appendChild(document.createTextNode(' ' + cf.name + (cf.required ? ' *' : '')));
        group.appendChild(boolLabel);
      } else if (cf.format === 'list' || cf.format === 'user' || cf.format === 'version') {
        field = document.createElement('select');
        field.className = 'form-select';
        if (cf.multi_value) field.multiple = true;
        if (!cf.required && !cf.multi_value) {
          var blank = document.createElement('option');
          blank.value = '';
          blank.textContent = (cf.format === 'user') ? 'Unassigned' : 'None';
          field.appendChild(blank);
        }
        (cf.options || []).forEach(function(opt) {
          // [label, value] or [label, value, groupLabel] (version: project name).
          var o = document.createElement('option');
          o.value = opt[1];
          o.textContent = opt[0];
          if (existing.indexOf(opt[1]) !== -1) o.selected = true;
          field.appendChild(o);
        });
      } else {
        field = document.createElement('input');
        field.type = (cf.format === 'int' || cf.format === 'float') ? 'number' :
          (cf.format === 'date') ? 'date' : 'text';
        if (cf.format === 'float') field.step = 'any';
        field.className = 'form-input';
        field.value = existing[0] || '';
      }
      field.dataset.cfId = cf.id;
      field.dataset.cfFormat = cf.format;
      if (cf.multi_value) field.dataset.cfMulti = '1';
      group.appendChild(field);

      host.appendChild(group);
      snapshot[cf.id] = cfFieldValueForSnapshot(field);
    });

    return snapshot;
  };

  // Reads back every custom field currently rendered in `hostId` (see
  // _renderCustomFieldsForType), as { cfId: value } ready for the
  // custom_field_values param -- value is a plain string, or an array for a
  // multi-value field. When `snapshot` is given, a field whose current
  // value still matches it is skipped (so an edit only sends what actually
  // changed); omit it to collect everything unconditionally (the "create
  // new work package" panel has no prior state to diff against).
  SpatialViewerApp.prototype._collectCustomFieldValues = function(hostId, snapshot) {
    var out = {};
    document.querySelectorAll('#' + hostId + ' [data-cf-id]').forEach(function(field) {
      var id = field.dataset.cfId;
      if (snapshot && cfFieldValueForSnapshot(field) === (snapshot[id] || '')) return;
      if (field.dataset.cfFormat === 'bool') {
        out[id] = field.checked ? '1' : '0';
      } else if (field.dataset.cfMulti) {
        out[id] = Array.prototype.map.call(field.selectedOptions || [], function(o) { return o.value; });
      } else if (field.value !== '' || snapshot) {
        // Blank with no snapshot (brand new WP): nothing filled in, skip it.
        // Blank where a snapshot existed (editing): the field had a value
        // and the user cleared it -- send the empty string to actually
        // clear it server-side, rather than silently leaving it unchanged.
        out[id] = field.value;
      }
    });
    return out;
  };

  // keepLassoHighlight: true right after a successful save, so the fill the
  // user already saw while drawing (verified correct) is left exactly as is
  // instead of being torn down and rebuilt from the stored ring -- see
  // saveAnnotation.
  SpatialViewerApp.prototype.closeAnnotationForm = function(keepLassoHighlight) {
    var panel = document.getElementById('spatialSidePanel');
    if (panel) panel.classList.remove('creating');
    this.clearTempMarkup();
    this._clearLassoOverlay();
    if (!keepLassoHighlight) this._setLassoHighlight(null);
    this.lassoScreenPath = null;
    this.pendingGeometry = null;
    this.pendingCameraViewpoint = null;
    this._lastLassoGrid = null;
  };

  SpatialViewerApp.prototype.saveAnnotation = function() {
    var self = this;
    var gd = this.pendingGeometry;
    if (!gd) return;

    var mode = (document.querySelector('input[name="caMode"]:checked') || {}).value || 'new';
    var subject = (document.getElementById('caSubject').value || '').trim();
    var desc = document.getElementById('caDesc').value;
    var val = function(id) {
      var el = document.getElementById(id);
      return el && el.value ? el.value : '';
    };
    var existingWpId = val('caExistingWp');

    if (mode === 'existing' && !existingWpId) { alert('Select a Work Package to link.'); return; }
    if (mode === 'new' && !subject) { alert('Enter a subject for the Work Package.'); return; }

    // Every custom field rendered for the currently-selected type -- no
    // prior state to diff against for a brand new work package.
    var customFieldValues = this._collectCustomFieldValues('caCustomFields', null);

    var payload = {
      spatial_annotation: {
        title: (mode === 'new' ? subject : (subject || 'Annotation')),
        description: desc,
        annotation_type: gd.type,
        color: this.activeColor,
        work_package_id: (mode === 'existing') ? existingWpId : null,
        thumbnail_base64: this.pendingThumbnail,
        // Captured back in openAnnotationModal (geometry-finalization time),
        // not read fresh here -- see that function's comment.
        camera_viewpoint: this.pendingCameraViewpoint,
        geometry_data: gd
      },
      create_work_package: (mode === 'new') ? 'true' : 'false',
      wp_subject: subject,
      wp_description: desc,
      wp_type_id: val('caType'),
      wp_status_id: val('caStatus'),
      wp_priority_id: val('caPriority'),
      wp_assigned_to_id: val('caAssignee'),
      wp_responsible_id: val('caAccountable'),
      wp_category_id: val('caCategory'),
      wp_version_id: val('caVersion'),
      wp_parent_id: val('caParent'),
      wp_start_date: val('caStartDate'),
      wp_due_date: val('caDueDate'),
      wp_estimated_hours: val('caEstimatedHours'),
      wp_custom_field_values: customFieldValues
    };

    var saveBtn = document.getElementById('caSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerText = 'Creating…'; }

    fetch(this.apiUrl.replace('/api_data', '/spatial_annotations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Create'; }
      if (result.success) {
        // For a freshly-created lasso, the fill already on screen is the one
        // the user just saw while drawing -- keep that exact mesh instead of
        // tearing it down and rebuilding it from the stored (re-sampled)
        // ring via showAnnotationSurface, which only needs to run when an
        // OLDER annotation is reopened from a different camera angle.
        var keepLiveFill = gd.type === 'lasso_selection';
        self.closeAnnotationForm(keepLiveFill);
        self.projectData.annotations.unshift(result.annotation);
        self.renderAnnotationsList(self.projectData.annotations);
        self.renderExisting3DAnnotations();
        if (!keepLiveFill) self.showAnnotationSurface(result.annotation);
        var c = document.getElementById('annotationCountHeader');
        if (c) c.innerText = self.projectData.annotations.length;
        var annTab = document.querySelector('.tab-btn[data-tab="annotationsTab"]');
        if (annTab) annTab.click();
      } else {
        alert('Save error: ' + (result.errors || []).join(', '));
      }
    })
    .catch(function(err) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Create'; }
      alert('Network error: ' + err);
    });
  };

  // ---- Lasso annotation label cards ---------------------------------------
  // A small always-camera-facing, semi-transparent card shown beside each
  // saved lasso selection (title / linked WP type / description), connected
  // to the selection's ring centroid by a line, colored from the
  // annotation's own color. Built once per renderExisting3DAnnotations call
  // (as a CanvasTexture, the same dependency-free "draw on a 2D canvas,
  // upload as a texture" technique already used for the lasso's screen-space
  // drag overlay); billboard orientation and distance-based scale are then
  // updated every frame in _updateAnnotationLabels, never rebuilt.

  // Greedy word-wrap against actual measured text width (ctx.font must
  // already be set to the font this will be drawn with by the caller -- this
  // sets it too, so a caller can rely on ctx.font being correct afterward).
  // Truncates with an ellipsis if the text doesn't fit in maxLines.
  function wrapCanvasTextLines(ctx, text, font, maxWidth, maxLines) {
    ctx.font = font;
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length && lines.length < maxLines; i++) {
      var word = words[i];
      // A single word wider than the box on its own (long URL, long compound
      // word) can never be split onto a new line -- hard-truncate just that
      // word so it can't overflow the card's edges.
      while (word.length > 1 && ctx.measureText(word).width > maxWidth) word = word.slice(0, -1);
      var test = cur ? cur + ' ' + word : word;
      if (cur && ctx.measureText(test).width > maxWidth) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    var consumedAllWords = lines.join(' ').split(/\s+/).length >= words.length;
    if (!consumedAllWords && lines.length) {
      var last = lines[lines.length - 1];
      while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }

  // Renders the card's content (rounded semi-transparent rect in the
  // annotation's own color, title/type/description with a dark text halo so
  // it stays legible over any fill color) onto a fixed-size canvas.
  function buildAnnotationLabelCanvas(a, colorHex) {
    var W = 512, H = 300, pad = 32;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    var c = new THREE.Color(colorHex);
    var rgb = Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);

    ctx.beginPath();
    var x = 6, y = 6, w = W - 12, h = H - 12, r = 22;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(' + rgb + ',0.72)';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();

    function drawTextHalo(text, tx, ty) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(text, tx, ty);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, tx, ty);
    }

    ctx.textBaseline = 'alphabetic';
    var cy = pad + 28;

    var titleLines = wrapCanvasTextLines(ctx, a.title || '(untitled)', 'bold 32px sans-serif', W - pad * 2, 2);
    titleLines.forEach(function(line) { drawTextHalo(line, pad, cy); cy += 38; });

    if (a.work_package_type) {
      cy += 4;
      ctx.font = '600 22px sans-serif';
      drawTextHalo(String(a.work_package_type).toUpperCase(), pad, cy);
      cy += 32;
    }

    if (a.description) {
      cy += 6;
      var maxDescLines = Math.max(1, Math.floor((H - pad - cy) / 28));
      var descLines = wrapCanvasTextLines(ctx, a.description, '24px sans-serif', W - pad * 2, maxDescLines);
      descLines.forEach(function(line) { drawTextHalo(line, pad, cy); cy += 28; });
    }

    return canvas;
  }

  SpatialViewerApp.prototype.renderExisting3DAnnotations = function() {
    // Dispose the previous build's GPU resources (geometry/material/canvas
    // textures) before discarding them -- plain .remove() leaves them
    // referenced by the renderer's internal WeakMap-keyed state until the
    // object itself is GC'd, and this runs on every save/reload, not just
    // once (see _setLassoHighlight for the same pattern already used for the
    // lasso fill highlight).
    while (this.annotationsGroup.children.length > 0) {
      var oldChild = this.annotationsGroup.children[0];
      oldChild.traverse(function(n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          if (n.material.map) n.material.map.dispose();
          if (n.material.dispose) n.material.dispose();
        }
      });
      this.annotationsGroup.remove(oldChild);
    }
    this._annotationLabels = [];
    if (!this.projectData || !this.projectData.annotations) return;
    var self = this;
    this.projectData.annotations.forEach(function(a) {
      var col = new THREE.Color(a.color || '#3b82f6');
      var gd = a.geometry_data;
      if (!gd) return;
      if (a.annotation_type === 'pin' && gd.points && gd.points[0]) {
        var pt = gd.points[0];
        var g = new THREE.ConeGeometry(0.25, 0.7, 16);
        g.translate(0, 0.35, 0); g.rotateX(Math.PI);
        var cone = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.3 }));
        cone.position.set(pt.x, pt.y, pt.z);
        cone.quaternion.copy(pinQuaternionFromNormal(gd.normal));
        cone.userData = { annotation: a };
        self.annotationsGroup.add(cone);
      } else if (a.annotation_type === 'lasso_selection' && gd.points && gd.points.length >= 3) {
        var ring = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
        var loop = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(ring.concat([ring[0]])),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true })
        );
        loop.renderOrder = 998;
        loop.userData = { annotation: a };
        self.annotationsGroup.add(loop);
        // The translucent surface highlight is rebuilt on demand (flyToAnnotation)
        // from the annotation's stored viewpoint — recomputing it for every
        // annotation on load would be too costly on large models.

        // Label card: title/type/description, billboarded every frame by
        // _updateAnnotationLabels (fixed real-world size -- see
        // ANNOTATION_LABEL_WIDTH_M there), connected to the ring's centroid
        // by a line updated the same way.
        var centroid = new THREE.Vector3();
        ring.forEach(function(p) { centroid.add(p); });
        centroid.divideScalar(ring.length);
        var ringRadius = 0;
        ring.forEach(function(p) { ringRadius = Math.max(ringRadius, p.distanceTo(centroid)); });

        var labelCanvas = buildAnnotationLabelCanvas(a, a.color || '#3b82f6');
        var tex = new THREE.CanvasTexture(labelCanvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        var aspect = labelCanvas.width / labelCanvas.height;
        // Geometry is built 1 world unit WIDE at scale 1, so group.scale (set
        // uniformly in _updateAnnotationLabels) directly IS the card's real
        // width in meters -- see ANNOTATION_LABEL_WIDTH_M there.
        var plane = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1 / aspect),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide })
        );
        plane.renderOrder = 1000;
        var labelGroup = new THREE.Group();
        labelGroup.add(plane);
        labelGroup.userData = { annotation: a };
        labelGroup.visible = self._labelsVisible !== false;
        self.annotationsGroup.add(labelGroup);

        var connLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([centroid.clone(), centroid.clone()]),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.85 })
        );
        connLine.renderOrder = 998;
        connLine.userData = { annotation: a };
        connLine.visible = self._labelsVisible !== false;
        self.annotationsGroup.add(connLine);

        self._annotationLabels.push({ group: labelGroup, line: connLine, plane: plane, centroid: centroid, ringRadius: ringRadius, annotation: a });
      } else if (a.annotation_type === 'draw_polyline' && gd.points) {
        var pts = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
        var line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true })
        );
        line.renderOrder = 999;
        line.userData = { annotation: a };
        self.annotationsGroup.add(line);
      }
    });
  };

  // Fixed real-world width (meters) of every label card -- it is a physical
  // object placed in the scene, not a screen-space UI overlay, so its
  // on-screen size shrinks with distance purely through normal perspective
  // projection (same as the pin cone's fixed 0.25 radius elsewhere in this
  // file). Deliberately NOT distance-scaled: an earlier version scaled world
  // size up with distance to keep apparent screen size constant, with a
  // floor (MIN_SIZE) to stop text from vanishing -- but that floor meant the
  // card visibly stopped shrinking past a certain distance instead of
  // receding like everything else in the scene, which is what was reported
  // as a bug.
  var ANNOTATION_LABEL_WIDTH_M = 0.6;

  // Billboards every live lasso label card to face the camera and keeps its
  // connecting line anchored to the (fixed) ring centroid and the (moving)
  // label position. Called every frame from the render loop -- cheap even
  // for many annotations, since it only updates existing transforms/
  // attributes, never rebuilds geometry or the canvas texture.
  SpatialViewerApp.prototype._updateAnnotationLabels = function() {
    var labels = this._annotationLabels;
    if (!labels || !labels.length) return;
    var camera = this.camera;
    if (!camera) return;
    var camRight = (this._annLabelTmpRight || (this._annLabelTmpRight = new THREE.Vector3()));
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    var labelPos = (this._annLabelTmpPos || (this._annLabelTmpPos = new THREE.Vector3()));
    var size = ANNOTATION_LABEL_WIDTH_M;
    var offset0 = size * 0.75;
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      labelPos.copy(L.centroid).addScaledVector(camRight, L.ringRadius + offset0);

      L.group.position.copy(labelPos);
      L.group.quaternion.copy(camera.quaternion);
      L.group.scale.set(size, size, size);

      var arr = L.line.geometry.attributes.position.array;
      arr[0] = L.centroid.x; arr[1] = L.centroid.y; arr[2] = L.centroid.z;
      arr[3] = labelPos.x; arr[4] = labelPos.y; arr[5] = labelPos.z;
      L.line.geometry.attributes.position.needsUpdate = true;
    }
  };

  // Hit-tests a click against every live label card's plane (not the model
  // mesh -- see _raycastAt/_visibleRaycastTargets for that, a separate,
  // unrelated target list). Returns the matching annotation, or null.
  SpatialViewerApp.prototype._raycastAnnotationLabels = function(clientX, clientY) {
    var labels = this._annotationLabels;
    if (!labels || !labels.length || this._labelsVisible === false) return null;
    var rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    var planes = labels.map(function(L) { return L.plane; });
    var hits = this.raycaster.intersectObjects(planes, false);
    return hits.length ? hits[0].object.parent.userData.annotation : null;
  };

  // Re-project a saved lasso annotation's 3D ring through the current camera
  // and tint the model surface inside it (the same filled highlight shown while
  // drawing). Rebuilt each time so it matches the current viewpoint.
  SpatialViewerApp.prototype.showAnnotationSurface = function(a) {
    this._setLassoHighlight(null);
    if (!a || a.annotation_type !== 'lasso_selection') return;
    var gd = a.geometry_data;
    if (!gd) return;

    // Preferred path: the exact surface patch stored at save time, replayed
    // directly with no raycasting or camera-dependent reprojection -- always
    // anchored to the real geometry, from any viewing angle.
    if (gd.fill_grid && gd.fill_rows && gd.fill_cols) {
      var grid = gd.fill_grid.map(function(p) { return p ? { x: p[0], y: p[1], z: p[2] } : null; });
      if (this._buildLassoFillFromGrid({ grid: grid, rows: gd.fill_rows, cols: gd.fill_cols }, a.color || '#3b82f6')) {
        return;
      }
    }

    // Fallback for annotations saved before fill_grid existed: reprojects
    // the stored ring through the current camera and re-raycasts -- only as
    // correct as the camera's reproduction of the original viewpoint (see
    // _selectSurfaceInLasso).
    if (!gd.points || gd.points.length < 3) return;
    var ring = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
    this._selectSurfaceInLasso(ring, this.camera, a.color || '#3b82f6');
  };

  SpatialViewerApp.prototype.flyToAnnotation = function(a) {
    var self = this;
    var showSelection = function() { self.showAnnotationSurface(a); };

    if (!a.camera_viewpoint || !a.camera_viewpoint.eye) { showSelection(); return; }

    var startPos = this.camera.position.clone();
    var endPos = new THREE.Vector3(a.camera_viewpoint.eye[0], a.camera_viewpoint.eye[1], a.camera_viewpoint.eye[2]);
    var startTarget = this.controls.target.clone();
    var endTarget = new THREE.Vector3(a.camera_viewpoint.target[0], a.camera_viewpoint.target[1], a.camera_viewpoint.target[2]);
    var progress = 0;
    (function fly() {
      progress += 0.04;
      self.camera.position.lerpVectors(startPos, endPos, progress);
      self.controls.target.lerpVectors(startTarget, endTarget, progress);
      self.controls.update();
      if (progress < 1) requestAnimationFrame(fly);
      else showSelection(); // recompute the surface selection from this viewpoint
    })();
  };

  SpatialViewerApp.prototype.renderAnnotationsList = function(annotations) {
    var list = document.getElementById('annotationsList');
    if (!list) return;
    list.innerHTML = '';
    if (!annotations || annotations.length === 0) {
      list.innerHTML = '<div class="text-muted small text-center p-3">No 3D annotations yet.</div>';
      return;
    }
    var self = this;
    annotations.forEach(function(a) {
      var card = document.createElement('div');
      card.className = 'annotation-card';

      var wpLabel = a.work_package_id
        ? ('WP #' + a.work_package_id + (a.work_package_status ? ' · ' + esc(a.work_package_status) : ''))
        : '';

      var html = '';
      if (a.snapshot_url) {
        html += '<img class="annotation-thumb" src="' + esc(a.snapshot_url) + '" alt="viewpoint snapshot">';
      }
      html += '<div class="annotation-card-body">' +
        '<div class="annotation-card-header">' +
          '<span class="annotation-title">' + esc(a.title) + '</span>' +
          '<span class="annotation-type-badge" style="background:' + esc(a.color || '#3b82f6') + ';color:#fff;">' +
            esc(String(a.annotation_type || '').toUpperCase()) + '</span>' +
        '</div>' +
        (a.description ? '<div class="annotation-desc">' + esc(a.description) + '</div>' : '') +
        (a.area != null ? '<div class="text-muted small">Area: ' + esc(a.area.toFixed(2)) + ' m²</div>' : '') +
        (a.work_package_id
          ? '<a class="annotation-wp-link" href="' + esc(a.work_package_url || ('/work_packages/' + a.work_package_id)) +
              '" target="_blank" rel="noopener" title="' + esc(a.work_package_subject || '') + '">' +
              '<i class="icon-relations"></i> ' + esc(wpLabel) + '</a>'
          : '') +
        '<div class="annotation-meta"><span>' + esc(a.author_name || '') + '</span><span>' + esc(a.created_at || '') + '</span></div>' +
      '</div>';

      card.innerHTML = html;

      // Click the card -> full annotation detail (also restores the viewpoint).
      // Click the WP link -> straight to the Work Package (new tab).
      card.addEventListener('click', function(e) {
        if (e.target.closest && e.target.closest('.annotation-wp-link')) return;
        self.openAnnotationDetail(a);
      });
      list.appendChild(card);
    });
  };

  // ---- Annotation detail (view + edit annotation / edit linked WP) --------

  SpatialViewerApp.prototype._annUrl = function(id) {
    return this.apiUrl.replace('/api_data', '/spatial_annotations') + (id != null ? '/' + id : '');
  };

  SpatialViewerApp.prototype.openAnnotationDetail = function(a) {
    var self = this;
    this._detailAnnotation = a;
    var $ = function(id) { return document.getElementById(id); };
    var setv = function(id, v) { var el = $(id); if (el) el.value = (v == null ? '' : v); };
    var wp = a.work_package || {};

    var snap = $('adSnapshot');
    if (snap) {
      if (a.snapshot_url) { snap.src = a.snapshot_url; snap.style.display = ''; }
      else { snap.removeAttribute('src'); snap.style.display = 'none'; }
    }
    if ($('adTypeBadge')) {
      $('adTypeBadge').textContent = String(a.annotation_type || '').toUpperCase();
      $('adTypeBadge').style.background = a.color || '#3b82f6';
      $('adTypeBadge').style.color = '#fff';
    }
    if ($('adAuthor')) $('adAuthor').textContent = a.author_name || '';
    if ($('adDate')) $('adDate').textContent = a.created_at || '';

    setv('adTitle', a.title);
    setv('adDesc', a.description);
    var areaGroup = $('adAreaGroup');
    if (areaGroup) {
      var hasArea = a.area != null;
      areaGroup.style.display = hasArea ? '' : 'none';
      if (hasArea) setv('adArea', a.area.toFixed(2) + ' m²');
    }
    this._adColor = a.color || '#3b82f6';
    document.querySelectorAll('#adColorGroup .color-dot').forEach(function(d) {
      d.classList.toggle('active', (d.dataset.color || '').toLowerCase() === self._adColor.toLowerCase());
    });

    var hasWp = !!a.work_package_id;
    if ($('adWpFields')) $('adWpFields').style.display = hasWp ? '' : 'none';
    if ($('adWpNum')) $('adWpNum').textContent = hasWp ? ('#' + a.work_package_id) : '(none linked)';
    var openLink = $('adWpOpen');
    if (openLink) {
      openLink.style.display = hasWp ? '' : 'none';
      openLink.href = a.work_package_url || ('/work_packages/' + a.work_package_id);
    }
    this._detailWpFields = {
      adWpSubject: 'subject', adWpDesc: 'description', adWpType: 'type_id',
      adWpStatus: 'status_id', adWpAssignee: 'assigned_to_id', adWpAccountable: 'responsible_id',
      adWpPriority: 'priority_id', adWpCategory: 'category_id', adWpVersion: 'version_id',
      adWpParent: 'parent_id', adWpStartDate: 'start_date', adWpDueDate: 'due_date',
      adWpEstimatedHours: 'estimated_hours'
    };
    if (hasWp) {
      setv('adWpSubject', wp.subject != null ? wp.subject : a.work_package_subject);
      setv('adWpDesc', wp.description);
      setv('adWpType', wp.type_id);
      setv('adWpStatus', wp.status_id);
      setv('adWpAssignee', wp.assigned_to_id);
      setv('adWpAccountable', wp.responsible_id);
      setv('adWpPriority', wp.priority_id);
      setv('adWpCategory', wp.category_id);
      setv('adWpVersion', wp.version_id);
      // The parent may not be in the (capped) options list — add it so the
      // prefill sticks and an unchanged parent is never accidentally cleared.
      var parentSel = $('adWpParent');
      if (parentSel && wp.parent_id && !parentSel.querySelector('option[value="' + wp.parent_id + '"]')) {
        var o = document.createElement('option');
        o.value = wp.parent_id;
        o.textContent = '#' + wp.parent_id;
        parentSel.appendChild(o);
      }
      setv('adWpParent', wp.parent_id);
      setv('adWpStartDate', wp.start_date);
      setv('adWpDueDate', wp.due_date);
      setv('adWpEstimatedHours', wp.estimated_hours);
      // Snapshot the rendered values so we can send only what actually changed.
      this._detailWpSnapshot = {};
      var snapF = this;
      Object.keys(this._detailWpFields).forEach(function(id) {
        var el = document.getElementById(id);
        snapF._detailWpSnapshot[id] = el ? el.value : '';
      });
      // Prefilled from the WP's current values; the returned snapshot is
      // what saveWorkPackageEdits diffs later edits against.
      this._detailWpCustomSnapshot =
        this._renderCustomFieldsForType(wp.type_id, 'adWpCustomFields', wp.custom_field_values);
    }

    var panel = document.getElementById('spatialSidePanel');
    this.openSidePanel();
    if (panel) { panel.classList.remove('creating'); panel.classList.add('detailing'); }
    this.flyToAnnotation(a);
  };

  SpatialViewerApp.prototype.closeAnnotationDetail = function() {
    this._detailAnnotation = null;
    var panel = document.getElementById('spatialSidePanel');
    if (panel) panel.classList.remove('detailing');
    this._setLassoHighlight(null);
    var annTab = document.querySelector('.tab-btn[data-tab="annotationsTab"]');
    if (annTab) annTab.click();
  };

  // Persist the updated annotation into projectData + refresh the views.
  SpatialViewerApp.prototype._applyUpdatedAnnotation = function(updated, keepView) {
    if (!updated || !this.projectData || !this.projectData.annotations) return;
    var list = this.projectData.annotations;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === updated.id) { list[i] = updated; break; }
    }
    this._detailAnnotation = updated;
    this.renderAnnotationsList(list);
    this.renderExisting3DAnnotations();
    if (!keepView) this.showAnnotationSurface(updated);
  };

  SpatialViewerApp.prototype._sendAnnotation = function(method, payload, btn, onOk) {
    var self = this;
    var a = this._detailAnnotation;
    if (!a) return;
    var label = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = 'Saving…'; }

    fetch(this._annUrl(a.id), {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: payload ? JSON.stringify(payload) : null
    })
      .then(function(r) { return r.json().catch(function() { return {}; }); })
      .then(function(res) {
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
        if (res && res.success) { onOk(res); }
        else { alert('Save failed: ' + ((res && res.errors) || ['unknown error']).join(', ')); }
      })
      .catch(function(err) {
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
        alert('Network error: ' + err);
      });
  };

  SpatialViewerApp.prototype.saveAnnotationEdits = function() {
    var t = (document.getElementById('adTitle').value || '').trim();
    if (!t) { alert('The annotation needs a title.'); return; }
    var payload = {
      spatial_annotation: {
        title: t,
        description: document.getElementById('adDesc').value,
        color: this._adColor || '#3b82f6'
      }
    };
    var self = this;
    this._sendAnnotation('PATCH', payload, document.getElementById('adSaveAnnBtn'), function(res) {
      self._applyUpdatedAnnotation(res.annotation);
      self.showTooltip('Annotation saved.');
    });
  };

  SpatialViewerApp.prototype.saveWorkPackageEdits = function() {
    var a = this._detailAnnotation;
    if (!a || !a.work_package_id) return;
    var fields = this._detailWpFields || {};
    var snap = this._detailWpSnapshot || {};

    var wpPayload = {};
    Object.keys(fields).forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.value !== (snap[id] || '')) wpPayload[fields[id]] = el.value;
    });
    var customFieldValues = this._collectCustomFieldValues('adWpCustomFields', this._detailWpCustomSnapshot || {});
    if (Object.keys(customFieldValues).length) wpPayload.custom_field_values = customFieldValues;
    if (!Object.keys(wpPayload).length) { this.showTooltip('No work package changes to save.'); return; }

    var self = this;
    this._sendAnnotation('PATCH', { work_package: wpPayload }, document.getElementById('adSaveWpBtn'), function(res) {
      self._applyUpdatedAnnotation(res.annotation, true);
      // The fields on screen are now the saved truth — re-baseline both snapshots.
      Object.keys(fields).forEach(function(id) {
        var el = document.getElementById(id);
        self._detailWpSnapshot[id] = el ? el.value : '';
      });
      document.querySelectorAll('#adWpCustomFields [data-cf-id]').forEach(function(field) {
        self._detailWpCustomSnapshot[field.dataset.cfId] = cfFieldValueForSnapshot(field);
      });
      self.showTooltip('Work package saved.');
    });
  };

  SpatialViewerApp.prototype.deleteAnnotationFromDetail = function() {
    var self = this;
    var a = this._detailAnnotation;
    if (!a) return;
    if (!window.confirm('Delete this 3D annotation? The linked Work Package is not deleted.')) return;
    this._sendAnnotation('DELETE', null, document.getElementById('adDeleteBtn'), function() {
      if (self.projectData && self.projectData.annotations) {
        self.projectData.annotations = self.projectData.annotations.filter(function(x) { return x.id !== a.id; });
        var c = document.getElementById('annotationCountHeader');
        if (c) c.textContent = self.projectData.annotations.length;
      }
      self._setLassoHighlight(null);
      self.closeAnnotationDetail();
      self.renderAnnotationsList(self.projectData.annotations);
      self.renderExisting3DAnnotations();
    });
  };

  SpatialViewerApp.prototype._initAnnotationDetail = function() {
    var self = this;
    var bind = function(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('adBackBtn', function() { self.closeAnnotationDetail(); });
    bind('adCloseBtn', function() { self.closeAnnotationDetail(); });
    bind('adSaveAnnBtn', function() { self.saveAnnotationEdits(); });
    bind('adSaveWpBtn', function() { self.saveWorkPackageEdits(); });
    bind('adDeleteBtn', function() { self.deleteAnnotationFromDetail(); });
    var adWpType = document.getElementById('adWpType');
    if (adWpType) {
      adWpType.addEventListener('change', function() {
        // Switching type changes which custom fields are even available (per
        // project+type, see customFieldsByType) -- start that section fresh
        // rather than prefilling with values from the WP's PREVIOUS type.
        self._detailWpCustomSnapshot = self._renderCustomFieldsForType(adWpType.value, 'adWpCustomFields', null);
      });
    }
    document.querySelectorAll('#adColorGroup .color-dot').forEach(function(dot) {
      dot.addEventListener('click', function() {
        document.querySelectorAll('#adColorGroup .color-dot').forEach(function(d) { d.classList.remove('active'); });
        dot.classList.add('active');
        self._adColor = dot.dataset.color;
      });
    });
  };

  SpatialViewerApp.prototype.renderWorkPackagesList = function(wps) {
    var list = document.getElementById('workPackagesList');
    if (!list) return;
    list.innerHTML = '';
    if (!wps || wps.length === 0) {
      list.innerHTML = '<div class="text-muted small text-center p-3">No Work Packages.</div>';
      return;
    }
    wps.forEach(function(wp) {
      var card = document.createElement('a');
      card.className = 'annotation-card';
      card.href = '/work_packages/' + wp.id;
      card.target = '_blank';
      card.rel = 'noopener';
      card.style.display = 'block';
      card.style.textDecoration = 'none';
      card.innerHTML = '<div class="annotation-card-body">' +
        '<div class="annotation-card-header"><span class="annotation-title">#' + wp.id + ' – ' + esc(wp.subject) + '</span>' +
        '<span class="badge -info">' + esc(wp.type || 'Task') + '</span></div>' +
        '<div class="annotation-meta"><span>Status: ' + esc(wp.status || 'New') + '</span><span>Assignee: ' + esc(wp.assigned_to || '-') + '</span></div>' +
        '</div>';
      list.appendChild(card);
    });
  };

  SpatialViewerApp.prototype.initUI = function() {
    if (this.container.dataset.spatialUi === '1') return;
    this.container.dataset.spatialUi = '1';

    var self = this;
    document.querySelectorAll('.tool-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tool-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        self.currentTool = btn.dataset.tool;
        self.controls.enabled = (self.currentTool === 'orbit');
        self.updateTooltip();
        if (self.currentTool !== 'orbit') self._ensureBVH();
      });
    });
    var orbitBtn = document.getElementById('toolOrbit');
    if (orbitBtn) orbitBtn.classList.add('active');

    var viewsBtn = document.getElementById('btnViews');
    var viewsMenu = document.getElementById('viewsDropdownMenu');
    if (viewsBtn && viewsMenu) {
      viewsBtn.addEventListener('click', function() { viewsMenu.classList.toggle('show'); });
      document.addEventListener('click', function(e) { if (!viewsBtn.contains(e.target)) viewsMenu.classList.remove('show'); });
      viewsMenu.querySelectorAll('a').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          var v = a.dataset.view, t = self.controls.target;
          if (v === 'top') self.camera.position.set(t.x, t.y + 20, t.z);
          if (v === 'front') self.camera.position.set(t.x, t.y, t.z + 20);
          if (v === 'right') self.camera.position.set(t.x + 20, t.y, t.z);
          if (v === 'iso') self.camera.position.set(t.x + 15, t.y + 15, t.z + 15);
          self.controls.update();
          viewsMenu.classList.remove('show');
        });
      });
    }

    var navMenuBtn = document.getElementById('btnNavMenu');
    var navMenu = document.getElementById('navDropdownMenu');
    if (navMenuBtn && navMenu) {
      navMenuBtn.addEventListener('click', function(e) { e.stopPropagation(); navMenu.classList.toggle('show'); });
      document.addEventListener('click', function(e) { if (!navMenuBtn.contains(e.target)) navMenu.classList.remove('show'); });
    }
    var setStartBtn = document.getElementById('btnSetStartView');
    if (setStartBtn) setStartBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (navMenu) navMenu.classList.remove('show');
      self._setCurrentViewAsStart();
    });
    var clearStartBtn = document.getElementById('btnClearStartView');
    if (clearStartBtn) clearStartBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (navMenu) navMenu.classList.remove('show');
      self._clearStartView();
    });

    var clearBtn = document.getElementById('toolClear');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      self.clearTempMarkup();
      self._clearLassoOverlay();
      self._setLassoHighlight(null);
      self.lassoScreenPath = null;
    });

    var sliceBtn = document.getElementById('btnSliceToggle');
    var slicePanel = document.getElementById('slicingPanel');
    var closeSliceBtn = document.getElementById('closeSliceBtn');
    if (sliceBtn && slicePanel) sliceBtn.addEventListener('click', function() { slicePanel.style.display = slicePanel.style.display === 'none' ? 'block' : 'none'; });
    if (closeSliceBtn && slicePanel) closeSliceBtn.addEventListener('click', function() { slicePanel.style.display = 'none'; });

    var layersBtn = document.getElementById('btnLayers');
    var layersPanel = document.getElementById('layerPanel');
    var closeLayersBtn = document.getElementById('closeLayerBtn');
    if (layersBtn && layersPanel) layersBtn.addEventListener('click', function() {
      var open = layersPanel.style.display === 'none' || !layersPanel.style.display;
      layersPanel.style.display = open ? 'block' : 'none';
      layersBtn.classList.toggle('active', open);
    });
    if (closeLayersBtn && layersPanel) closeLayersBtn.addEventListener('click', function() {
      layersPanel.style.display = 'none';
      if (layersBtn) layersBtn.classList.remove('active');
    });

    var labelsBtn = document.getElementById('btnAnnotationLabels');
    if (labelsBtn) {
      labelsBtn.classList.toggle('active', this._labelsVisible);
      labelsBtn.addEventListener('click', function() {
        self._labelsVisible = !self._labelsVisible;
        labelsBtn.classList.toggle('active', self._labelsVisible);
        (self._annotationLabels || []).forEach(function(L) {
          L.group.visible = self._labelsVisible;
          L.line.visible = self._labelsVisible;
        });
      });
    }

    this._initRenderPanel();

    var clipX = document.getElementById('clipX'), clipY = document.getElementById('clipY'), clipZ = document.getElementById('clipZ');
    var resetClip = document.getElementById('resetClipBtn');
    if (clipX) clipX.addEventListener('input', function(e) { self.clipPlanes[0].constant = parseFloat(e.target.value); });
    if (clipY) clipY.addEventListener('input', function(e) { self.clipPlanes[1].constant = parseFloat(e.target.value); });
    if (clipZ) clipZ.addEventListener('input', function(e) { self.clipPlanes[2].constant = parseFloat(e.target.value); });
    if (resetClip) resetClip.addEventListener('click', function() {
      self.clipPlanes[0].constant = self.clipPlanes[1].constant = self.clipPlanes[2].constant = 1000;
      if (clipX) clipX.value = 50; if (clipY) clipY.value = 50; if (clipZ) clipZ.value = 50;
    });

    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        var tt = document.getElementById(btn.dataset.tab);
        if (tt) tt.classList.add('active');
      });
    });

    this._initSidePanel();
    this._initAnnotationDetail();

    // Inline "New Work Package" create panel
    var caCancel = document.getElementById('caCancelBtn');
    var caCancel2 = document.getElementById('caCancelBtn2');
    var caSave = document.getElementById('caSaveBtn');
    if (caCancel) caCancel.addEventListener('click', function() { self.closeAnnotationForm(); });
    if (caCancel2) caCancel2.addEventListener('click', function() { self.closeAnnotationForm(); });
    if (caSave) caSave.addEventListener('click', function() { self.saveAnnotation(); });

    document.querySelectorAll('input[name="caMode"]').forEach(function(r) {
      r.addEventListener('change', function() { self.updateCreateMode(r.value); });
    });

    var caType = document.getElementById('caType');
    if (caType) caType.addEventListener('change', function() { self._renderCustomFieldsForType(caType.value); });

    document.querySelectorAll('.color-dot').forEach(function(dot) {
      dot.addEventListener('click', function() {
        document.querySelectorAll('.color-dot').forEach(function(d) { d.classList.remove('active'); });
        dot.classList.add('active');
        self.activeColor = dot.dataset.color;
      });
    });

    this.initVR();
  };

  // ---- WebXR / VR headsets --------------------------------------------------
  SpatialViewerApp.prototype.initVR = function() {
    var self = this;
    var btn = document.getElementById('btnVR');
    if (!btn) return;

    // WebXR needs a secure context (HTTPS or localhost) and browser support.
    if (!window.isSecureContext || !navigator.xr || !navigator.xr.isSessionSupported) {
      btn.style.display = 'none';
      return;
    }

    btn.disabled = true;
    btn.title = 'Checking VR support...';

    var ENTER_TITLE = 'Enter VR — left stick: move, right stick: turn (snap) / up-down';

    navigator.xr.isSessionSupported('immersive-vr').then(function(supported) {
      if (!supported) { btn.style.display = 'none'; return; }
      btn.style.display = '';
      btn.disabled = false;
      btn.title = ENTER_TITLE;
    }).catch(function() { btn.style.display = 'none'; });

    function endVR() {
      if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
    }

    function onSessionEnded() {
      if (self._xrSession) self._xrSession.removeEventListener('end', onSessionEnded);
      self._xrSession = null;
      self._xrTurnArmed = false;
      self.xrDolly.position.set(0, 0, 0);
      self.xrDolly.rotation.set(0, 0, 0);
      btn.disabled = false;
      btn.classList.remove('active');
      btn.title = ENTER_TITLE;
    }

    btn.addEventListener('click', function() {
      if (self._xrSession) { endVR(); return; }

      btn.disabled = true;
      navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      }).then(function(session) {
        self._xrSession = session;
        session.addEventListener('end', onSessionEnded);

        // Stand the player ~1.6 m below and 3 m back from the current focus
        // point so the model is in front of them on entry.
        var t = self.controls ? self.controls.target : new THREE.Vector3();
        self.xrDolly.position.set(t.x, t.y - 1.6, t.z + 3);
        self.xrDolly.rotation.set(0, 0, 0);
        self._xrTurnArmed = false;

        try { self.renderer.xr.setReferenceSpaceType('local-floor'); } catch (ignore) {}
        return self.renderer.xr.setSession(session).then(function() {
          btn.disabled = false;
          btn.classList.add('active');
          btn.title = 'Exit VR';
        });
      }).catch(function(err) {
        console.error('[SpatialViewer] Could not start VR session:', err);
        if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
        self._xrSession = null;
        self.xrDolly.position.set(0, 0, 0);
        self.xrDolly.rotation.set(0, 0, 0);
        btn.disabled = false;
        btn.classList.remove('active');
        btn.title = ENTER_TITLE;
        alert('Could not start VR: ' + (err.message || err));
      });
    });
  };

  SpatialViewerApp.prototype.updateTooltip = function() {
    var tip = document.getElementById('drawingTooltip');
    if (!tip) return;
    var msgs = { pin: 'Click on the surface to place a 3D pin.', draw: 'Click and drag along the surface to draw a polyline.', lasso: 'Drag around a region — the outline closes as you draw and the model surface inside it is highlighted.', measure: 'Click first point then second point to measure.' };
    if (msgs[this.currentTool]) { tip.innerText = msgs[this.currentTool]; tip.style.display = 'block'; }
    else { tip.style.display = 'none'; }
  };

  SpatialViewerApp.prototype.showTooltip = function(text) {
    var tip = document.getElementById('drawingTooltip');
    if (tip) { tip.innerHTML = text; tip.style.display = 'block'; }
  };

  SpatialViewerApp.prototype.clearTempMarkup = function() {
    while (this.tempMarkupGroup.children.length > 0) {
      var c = this.tempMarkupGroup.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material.dispose) c.material.dispose();
      this.tempMarkupGroup.remove(c);
    }
    this.currentDrawingLine = null;
    this.currentDrawingPoints = [];
  };

  // Back-compat alias
  SpatialViewerApp.prototype.closeModal = function() {
    this.closeAnnotationForm();
  };

  SpatialViewerApp.prototype.showLoader = function(text) {
    var l = document.getElementById('viewerLoader'), t = document.getElementById('loaderText');
    if (t) t.innerText = text;
    if (l) l.style.display = 'flex';
  };

  SpatialViewerApp.prototype.hideLoader = function() {
    var l = document.getElementById('viewerLoader');
    if (l) l.style.display = 'none';
  };

})();
