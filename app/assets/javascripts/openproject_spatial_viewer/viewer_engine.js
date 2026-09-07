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

  // ---- Lasso surface-highlight shader --------------------------------------
  // A projective decal. The lasso polygon lives in the NDC of the camera that
  // made the selection; every fragment of the model is re-projected through
  // that camera (uSelViewProj) and tested against it, so the tint is glued to
  // the SURFACE and rotates with the model. Visibility is frozen at selection
  // time with a depth map rendered from the same camera (uSelDepth), so only
  // the surface that was actually in front stays highlighted.
  var LASSO_MAX_PTS = 48;
  var LASSO_VS =
    'uniform mat4 uSelViewProj;\n' +
    'varying vec4 vSelClip;\n' +
    'void main() {\n' +
    '  vSelClip = uSelViewProj * modelMatrix * vec4(position, 1.0);\n' +
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n' +
    '}';
  var LASSO_POINTS_VS =
    'uniform mat4 uSelViewProj;\n' +
    'uniform float uSize;\n' +
    'varying vec4 vSelClip;\n' +
    'void main() {\n' +
    '  vSelClip = uSelViewProj * modelMatrix * vec4(position, 1.0);\n' +
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
    '  gl_PointSize = clamp(uSize * 350.0 / max(-mv.z, 0.001), 2.0, 24.0);\n' +
    '  gl_Position = projectionMatrix * mv;\n' +
    '}';
  // uPoly holds an already-closed polygon (last point == first); unused tail
  // slots repeat the last point (degenerate edges contribute nothing). All
  // array indexing is loop-index based for maximum driver compatibility.
  var LASSO_FS =
    '#include <packing>\n' +
    'uniform vec3 uColor;\n' +
    'uniform float uOpacity;\n' +
    'uniform vec2 uPoly[' + LASSO_MAX_PTS + '];\n' +
    'uniform int uPolyLen;\n' +
    'uniform sampler2D uSelDepth;\n' +
    'uniform bool uUseDepth;\n' +
    'uniform float uDepthBias;\n' +
    'varying vec4 vSelClip;\n' +
    'void main() {\n' +
    '  if (vSelClip.w <= 0.0) discard;\n' +
    '  vec2 ndc = vSelClip.xy / vSelClip.w;\n' +
    '  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) discard;\n' +
    '  bool inside = false;\n' +
    '  for (int i = 0; i < ' + (LASSO_MAX_PTS - 1) + '; i++) {\n' +
    '    if (i + 1 >= uPolyLen) break;\n' +
    '    vec2 a = uPoly[i];\n' +
    '    vec2 b = uPoly[i + 1];\n' +
    '    if (((a.y > ndc.y) != (b.y > ndc.y)) &&\n' +
    '        (ndc.x < (b.x - a.x) * (ndc.y - a.y) / (b.y - a.y) + a.x)) {\n' +
    '      inside = !inside;\n' +
    '    }\n' +
    '  }\n' +
    '  if (!inside) discard;\n' +
    '  if (uUseDepth) {\n' +
    '    float myDepth = 0.5 * (vSelClip.z / vSelClip.w) + 0.5;\n' +
    '    float mapDepth = unpackRGBAToDepth(texture2D(uSelDepth, ndc * 0.5 + 0.5));\n' +
    '    if (myDepth > mapDepth + uDepthBias) discard;\n' +
    '  }\n' +
    '  gl_FragColor = vec4(uColor, uOpacity);\n' +
    '}';

  // ---- Cleanup previous viewer instance ----
  function destroyExistingViewer() {
    if (window.spatialViewerApp) {
      try {
        var app = window.spatialViewerApp;
        if (app._animFrameId) cancelAnimationFrame(app._animFrameId);
        if (app._conversionPoll) clearTimeout(app._conversionPoll);
        if (app._gltfWorker) { try { app._gltfWorker.terminate(); } catch (ignore3) {} }
        app._modelBlob = null;
        if (app._selDepthRT) { try { app._selDepthRT.dispose(); } catch (e) {} app._selDepthRT = null; }
        if (app._depthMat) { try { app._depthMat.dispose(); } catch (e) {} app._depthMat = null; }
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
      console.error('[SpatialViewer] init failed, will retry on next event:', err);
      container.dataset.spatialInit = ''; // release so a later Turbo event can retry
      var lt = document.getElementById('loaderText');
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

    this.initThree();
    this.initEvents();
    this.initUI();
    this.loadProjectData();
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

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
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

    this._buildEnvironment();

    this.annotationsGroup = new THREE.Group();
    this.scene.add(this.annotationsGroup);

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

    this._applyRenderSettings();

    var self = this;
    // setAnimationLoop (not requestAnimationFrame) is required for WebXR:
    // during an immersive session the browser drives the frame timing.
    this.renderer.setAnimationLoop(function() {
      var presenting = self.renderer.xr && self.renderer.xr.isPresenting;
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

  // A cheap, asset-free image-based light: a vertical sky/horizon/ground
  // gradient turned into a pre-filtered environment map. Gives glTF PBR
  // materials soft ambient light and subtle reflections.
  SpatialViewerApp.prototype._buildEnvironment = function() {
    if (!THREE.PMREMGenerator || !THREE.DataTexture) return;
    try {
      var w = 16, h = 64, data = new Uint8Array(w * h * 4);
      var sky = [232, 238, 247], horizon = [206, 210, 216], ground = [120, 120, 126];
      var lerp = function(a, b, t) { return a + (b - a) * t; };
      for (var y = 0; y < h; y++) {
        var t = y / (h - 1);            // 0 = bottom row, 1 = top row
        var up = 1 - t;                 // 1 = top of the sphere
        var c = (up > 0.5)
          ? [lerp(horizon[0], sky[0], (up - 0.5) * 2), lerp(horizon[1], sky[1], (up - 0.5) * 2), lerp(horizon[2], sky[2], (up - 0.5) * 2)]
          : [lerp(ground[0], horizon[0], up * 2), lerp(ground[1], horizon[1], up * 2), lerp(ground[2], horizon[2], up * 2)];
        for (var x = 0; x < w; x++) {
          var i = (y * w + x) * 4;
          data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
      }
      var tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.needsUpdate = true;

      var pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      this._envMap = pmrem.fromEquirectangular(tex).texture;
      tex.dispose();
      pmrem.dispose();
    } catch (e) {
      console.warn('[SpatialViewer] environment map build failed:', e);
      this._envMap = null;
    }
  };

  var TONE_MAP = {
    aces: 'ACESFilmicToneMapping',
    reinhard: 'ReinhardToneMapping',
    linear: 'LinearToneMapping',
    none: 'NoToneMapping'
  };

  // Push the current renderSettings onto the renderer / scene / lights / model.
  SpatialViewerApp.prototype._applyRenderSettings = function() {
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

    // Environment light + reflections
    this.scene.environment = (s.env && this._envMap) ? this._envMap : null;

    // Light intensity multiplier
    var k = s.light;
    if (this.ambientLight) this.ambientLight.intensity = 0.45 * k;
    if (this.keyLight) this.keyLight.intensity = 0.85 * k;
    if (this.fillLight) this.fillLight.intensity = 0.35 * k;

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

        // Formats converted server-side (e.g. IFC -> GLB): wait for the job.
        var conv = data.conversion;
        if (conv && conv.status && conv.status !== 'completed') {
          if (conv.status === 'error') {
            self.showLoader('IFC conversion failed: ' + (conv.message || 'unknown error'));
            return;
          }
          self.showLoader('Converting IFC on the server (this may take a few minutes)...');
          clearTimeout(self._conversionPoll);
          self._conversionPoll = setTimeout(function() { self.loadProjectData(); }, 8000);
          return;
        }

        // Authoritative uncompressed size from the server — model_file is gzip'd
        // so its Content-Length can't be trusted for the heavy-model decision.
        var heavyMb = parseInt(self.container.dataset.heavyModelMb, 10) || 40;
        if (data.file_size) {
          self._modelBytes = data.file_size;
          self.heavyMode = data.file_size >= heavyMb * 1048576;
        }

        self.load3DModel(data.model_url, data.model_format);
      })
      .catch(function(err) {
        console.error('[SpatialViewer] API Error:', err);
        self.showLoader('Error loading model configuration: ' + err.message);
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
        if (!res || res.aborted || res.pending) return;
        self._parseModel(res.buffer, format);
      })
      .catch(function(err) {
        console.error('[SpatialViewer] Model loading failed:', err);
        self.showLoader('Error loading model: ' + (err && err.message || err));
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
          } else {
            self.showLoader('Converting the model on the server...');
            clearTimeout(self._conversionPoll);
            self._conversionPoll = setTimeout(function() { self.load3DModel(url, format); }, 8000);
          }
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

  SpatialViewerApp.prototype._parseModel = function(buffer, format) {
    var self = this;
    self.showLoader('Parsing 3D geometry...');

    if (format === 'glb' || format === 'gltf') {
      self._parseGltf(buffer);
    } else if (format === 'obj') {
      self.onModelLoaded(new THREE.OBJLoader().parse(new TextDecoder('utf-8').decode(buffer)));
    } else if (format === 'ply' || format === 'gaussian_splat' || format === 'splat' || format === 'ksplat') {
      var geom = new THREE.PLYLoader().parse(buffer);
      geom.computeVertexNormals();
      var mat = geom.hasAttribute('color')
        ? new THREE.PointsMaterial({ size: 0.05, vertexColors: true })
        : new THREE.PointsMaterial({ size: 0.05, color: 0x38bdf8 });
      self.onModelLoaded(new THREE.Points(geom, mat));
    } else if (format === 'ifc') {
      self.parseIfcBuffer(buffer);
    } else {
      self.hideLoader();
      self.createDemoModel();
    }
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

  // (7) Parse GLB/GLTF in a Web Worker so the main thread does not freeze.
  // Falls back to a main-thread GLTFLoader.parse() on any failure (e.g. the GLB
  // has textures / KHR extensions the worker path can't handle).
  SpatialViewerApp.prototype._parseGltf = function(buffer) {
    var self = this;

    var refs = this._gltfExternalRefs(buffer);
    if (refs.length) {
      var shown = refs.slice(0, 3).join(', ') + (refs.length > 3 ? ', …' : '');
      this.showLoader(
        'This .gltf file references ' + refs.length + ' external file(s) that were ' +
        'not uploaded (' + shown + '). Upload a single self-contained .glb instead, ' +
        'or a .gltf with embedded (data-URI) buffers and textures.');
      console.warn('[SpatialViewer] glTF references external resources:', refs);
      return;
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
            self.showLoader('Error parsing GLTF/GLB: ' + (err && err.message || err) +
              '. If this is a large or highly detailed model, the browser tab may ' +
              'have run out of memory — try a decimated / Draco-compressed export.');
          });
      } catch (err) {
        console.error('[SpatialViewer] GLTFLoader.parse threw:', err);
        self.showLoader('Error parsing GLTF/GLB: ' + (err && err.message || err));
      }
    }

    function recoverAndFallback() {
      if (self._modelBlob) {
        self._modelBlob.arrayBuffer()
          .then(mainThreadParse)
          .catch(function(err) { self.showLoader('Error loading model: ' + (err && err.message || err)); });
      } else {
        self.showLoader('Could not load the 3D model (background parse failed).');
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

  SpatialViewerApp.prototype.onModelLoaded = function(object) {
    this.modelObject = object;
    this.scene.add(object);

    this._bvhReady = false; // rebuild BVH for the new model on next tool use
    this._setLassoHighlight(null); // any old highlight references the old geometry
    this.modelMeshObjects = [];
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
        self.modelMeshObjects.push(child);

        var g = child.geometry;
        if (g && g.index) triangles += g.index.count / 3;
        else if (g && g.attributes && g.attributes.position) triangles += g.attributes.position.count / 3;
      }
    });

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
    var maxDim = Math.max(size.x, size.y, size.z) || 10;

    // Drawing tools: markup points sit exactly on the surface (outlines render
    // with depthTest:false, so no lift is needed). Point clouds / gaussian
    // splats need a scale-relative ray threshold to be pickable.
    this.modelRadius = maxDim;
    this.surfaceOffset = 0;
    if (this.raycaster) this.raycaster.params.Points.threshold = maxDim * 0.01;

    // Fit the depth range to the model: the default 0.1..2000 wastes almost all
    // depth precision up close, which the selection depth map depends on.
    this.camera.near = Math.max(maxDim / 2000, 1e-4);
    this.camera.far = Math.max(maxDim * 200, 100);
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 1.2, center.z + maxDim * 1.5);
    this.camera.lookAt(center);
    this.controls.update();

    // Size shadows to the model and remember this framing for the Home button.
    this._fitShadowsToModel(box, center, maxDim);
    this._homeView = { position: this.camera.position.clone(), target: this.controls.target.clone() };

    // Re-apply render settings now that the model (and its materials) exist, so
    // shadows / wireframe / env map land on the new meshes.
    this._applyRenderSettings();

    this.hideLoader();
    this.renderExisting3DAnnotations();
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
    // NOTE: deliberately no 'lostpointercapture' listener. It bubbles, and
    // OrbitControls captures the pointer on the canvas first; re-capturing
    // would fire it and abort the stroke after a couple of points.
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

  SpatialViewerApp.prototype._raycastAt = function(clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    var intersects = this.raycaster.intersectObjects(this.modelMeshObjects, true);
    return intersects.length > 0 ? intersects[0] : null;
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
    // Live surface highlight, refreshed every few samples.
    if ((++this._lassoHlFrame % 4) === 0) {
      this._showLassoPolygon(this._screenPathToNdc(path), this.activeColor);
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

  SpatialViewerApp.prototype.onPointerUp = function() {
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
    this._showLassoPolygon(this._screenPathToNdc(path), this.activeColor);

    // Now (once) turn a down-sampled screen ring into 3D points for storage.
    // The 2D overlay stays on screen as the outline until the form is closed.
    var ring = this._screenPathToWorldRing(path, 64);
    if (ring.length < 3) { this._clearLassoOverlay(); this.clearTempMarkup(); return; }

    this.currentDrawingPoints = ring;
    console.log('[SpatialViewer] lasso: ' + path.length + ' screen points -> ' + ring.length + ' 3D points');

    this.openAnnotationModal({
      type: 'lasso_selection',
      closed: true,
      points: ring.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    });
  };

  SpatialViewerApp.prototype._screenPathToNdc = function(path) {
    var w = this.viewport.clientWidth || 1, h = this.viewport.clientHeight || 1;
    return path.map(function(p) { return [(p.x / w) * 2 - 1, -(p.y / h) * 2 + 1]; });
  };

  // Down-sample the screen ring and project it onto the model; points that miss
  // the mesh fall back to the focal plane so the stored ring always has the
  // shape that was drawn.
  SpatialViewerApp.prototype._screenPathToWorldRing = function(path, maxPoints) {
    this._ensureBVH();
    var rect = this.canvas.getBoundingClientRect();
    var n = path.length;
    var stride = Math.max(1, Math.floor(n / maxPoints));

    var planeNormal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      planeNormal, (this.controls ? this.controls.target : new THREE.Vector3()).clone()
    );

    var out = [];
    for (var i = 0; i < n && out.length < maxPoints; i += stride) {
      var p = path[i];
      var hit = this._raycastAt(rect.left + p.x, rect.top + p.y);
      if (hit) { out.push(this._surfacePoint(hit)); continue; }
      var fallback = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (fallback) out.push(fallback);
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

  // Pack an NDC polygon into the shader uniform: down-sample to LASSO_MAX_PTS-1
  // points, close it, pad the tail with the last point (degenerate edges).
  function packLassoPoly(ndc) {
    var maxRing = LASSO_MAX_PTS - 1;
    var poly;
    if (ndc.length <= maxRing) {
      poly = ndc.slice();
    } else {
      poly = [];
      var stride = ndc.length / maxRing;
      for (var i = 0; i < maxRing; i++) poly.push(ndc[Math.floor(i * stride)]);
    }
    poly.push(poly[0]); // close

    var flat = new Float32Array(LASSO_MAX_PTS * 2);
    var lastPt = poly[poly.length - 1];
    for (var k = 0; k < LASSO_MAX_PTS; k++) {
      var pt = k < poly.length ? poly[k] : lastPt;
      flat[k * 2] = pt[0]; flat[k * 2 + 1] = pt[1];
    }
    return { flat: flat, len: poly.length };
  }

  // Render the model's depth from `camera` into a reusable target, packed as
  // RGBA (same encoding three uses for shadow maps). This freezes "what was
  // visible at selection time" so the highlight stays correct after orbiting.
  SpatialViewerApp.prototype._renderSelectionDepth = function(camera) {
    if (!this.renderer || !this.scene) return null;
    try {
      var size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      var w = Math.max(512, Math.min(2048, Math.round(size.x) || 1024));
      var h = Math.max(512, Math.min(2048, Math.round(size.y) || 1024));

      if (!this._selDepthRT || this._selDepthRT.width !== w || this._selDepthRT.height !== h) {
        if (this._selDepthRT) this._selDepthRT.dispose();
        this._selDepthRT = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthBuffer: true,
          stencilBuffer: false
        });
      }
      if (!this._depthMat) {
        this._depthMat = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          side: THREE.DoubleSide
        });
      }

      // Only the model belongs in the depth map.
      var hidden = [];
      [this.annotationsGroup, this.tempMarkupGroup, this.lassoHighlightGroup, this.gridHelper]
        .forEach(function(o) { if (o && o.visible) { o.visible = false; hidden.push(o); } });

      var prevOverride = this.scene.overrideMaterial;
      var prevTarget = this.renderer.getRenderTarget();
      var prevClear = this.renderer.getClearColor(new THREE.Color());
      var prevAlpha = this.renderer.getClearAlpha();

      this.scene.overrideMaterial = this._depthMat;
      this.renderer.setRenderTarget(this._selDepthRT);
      this.renderer.setClearColor(0xffffff, 1); // unwritten = far
      this.renderer.clear(true, true, false);
      this.renderer.render(this.scene, camera);

      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(prevClear, prevAlpha);
      this.scene.overrideMaterial = prevOverride;
      hidden.forEach(function(o) { o.visible = true; });

      return {
        texture: this._selDepthRT.texture,
        viewProj: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      };
    } catch (e) {
      console.warn('[SpatialViewer] selection depth pass failed:', e);
      return null;
    }
  };

  // Highlight the model surface inside the (NDC) lasso polygon by re-rendering
  // the model's OWN geometry with the projective tint shader. `camera` is the
  // camera the polygon was measured in; the tint then stays glued to the
  // surface when the view is orbited.
  SpatialViewerApp.prototype._showLassoPolygon = function(ndcPoly, color, camera) {
    if (!ndcPoly || ndcPoly.length < 3 || !this.modelMeshObjects || !this.modelMeshObjects.length) {
      this._setLassoHighlight(null);
      return;
    }
    var packed = packLassoPoly(ndcPoly);
    var col = new THREE.Color(color);

    // Fast path: same selection viewpoint, only the polygon changed (live drag).
    if (this._lassoHl) {
      this._lassoHl.traverse(function(n) {
        if (n.material && n.material.uniforms) {
          n.material.uniforms.uPoly.value = packed.flat;
          n.material.uniforms.uPolyLen.value = packed.len;
          n.material.uniforms.uColor.value.set(col.r, col.g, col.b);
          n.material.uniformsNeedUpdate = true;
        }
      });
      return;
    }

    camera = camera || this.camera;
    camera.updateMatrixWorld();
    this.scene.updateMatrixWorld(true);

    var sel = this._renderSelectionDepth(camera);
    var selViewProj = sel ? sel.viewProj
      : new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    var radius = this.modelRadius || 10;
    var group = new THREE.Group();

    this.modelMeshObjects.forEach(function(obj) {
      if (!obj.geometry || !obj.geometry.attributes || !obj.geometry.attributes.position) return;
      var isPoints = !!obj.isPoints;
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Vector3(col.r, col.g, col.b) },
          uOpacity: { value: isPoints ? 0.9 : 0.45 },
          uPoly: { value: packed.flat },
          uPolyLen: { value: packed.len },
          uSize: { value: radius * 0.004 },
          uSelViewProj: { value: selViewProj },
          uSelDepth: { value: sel ? sel.texture : null },
          // MeshDepthMaterial cannot rasterise Points, so skip the occlusion
          // test for point clouds / gaussian splats.
          uUseDepth: { value: !!sel && !isPoints },
          uDepthBias: { value: 0.0006 }
        },
        vertexShader: isPoints ? LASSO_POINTS_VS : LASSO_VS,
        fragmentShader: LASSO_FS,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: !isPoints,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      var node = isPoints ? new THREE.Points(obj.geometry, mat) : new THREE.Mesh(obj.geometry, mat);
      node.applyMatrix4(obj.matrixWorld);
      node.matrixAutoUpdate = false;
      node.frustumCulled = false;
      node.userData._sharedGeometry = true;
      group.add(node);
    });

    if (!group.children.length) return;
    group.renderOrder = 997;
    this._setLassoHighlight(group);
  };

  // Same highlight, driven by a stored 3D ring projected through `camera`.
  SpatialViewerApp.prototype._selectSurfaceInLasso = function(ring3d, camera, color) {
    if (!ring3d || ring3d.length < 3) return;
    camera = camera || this.camera;
    camera.updateMatrixWorld();
    this.scene.updateMatrixWorld(true);

    var vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    var _p = new THREE.Vector3();
    var ndc = ring3d.map(function(v) { _p.copy(v).applyMatrix4(vp); return [_p.x, _p.y]; });
    this._showLassoPolygon(ndc, color, camera);
  };

  SpatialViewerApp.prototype.place3DPin = function(point, normal) {
    var g = new THREE.ConeGeometry(0.2, 0.6, 16);
    g.translate(0, 0.3, 0); g.rotateX(Math.PI);
    var mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(this.activeColor), roughness: 0.2 }));
    mesh.position.copy(point);
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
    return this.renderer.domElement.toDataURL('image/png');
  };

  // Opens the inline "New Work Package" panel beside the viewer (BCF-style
  // split view) instead of a modal overlay.
  SpatialViewerApp.prototype.openAnnotationModal = function(gd) {
    this.pendingGeometry = gd;
    this.pendingThumbnail = this.captureSnapshot();

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

    this.openSidePanel();
    if (panel) panel.classList.add('creating');
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
      // A stale "creating" class would bring the panel back showing an empty
      // New Work Package form instead of the tabs.
      if (!app || !app.pendingGeometry) sp.classList.remove('creating');
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

  SpatialViewerApp.prototype.closeAnnotationForm = function() {
    var panel = document.getElementById('spatialSidePanel');
    if (panel) panel.classList.remove('creating');
    this.clearTempMarkup();
    this._clearLassoOverlay();
    this._setLassoHighlight(null);
    this.lassoScreenPath = null;
    this.pendingGeometry = null;
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

    var payload = {
      spatial_annotation: {
        title: (mode === 'new' ? subject : (subject || 'Annotation')),
        description: desc,
        annotation_type: gd.type,
        color: this.activeColor,
        work_package_id: (mode === 'existing') ? existingWpId : null,
        thumbnail_base64: this.pendingThumbnail,
        camera_viewpoint: {
          eye: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
          target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
          up: [this.camera.up.x, this.camera.up.y, this.camera.up.z]
        },
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
      wp_estimated_hours: val('caEstimatedHours')
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
        self.closeAnnotationForm();
        self.projectData.annotations.unshift(result.annotation);
        self.renderAnnotationsList(self.projectData.annotations);
        self.renderExisting3DAnnotations();
        // Keep the filled surface highlight on the annotation that was just
        // created, rebuilt from its stored ring (the camera has not moved, so
        // it matches exactly what was drawn).
        self.showAnnotationSurface(result.annotation);
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

  SpatialViewerApp.prototype.renderExisting3DAnnotations = function() {
    while (this.annotationsGroup.children.length > 0) this.annotationsGroup.remove(this.annotationsGroup.children[0]);
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

  // Re-project a saved lasso annotation's 3D ring through the current camera
  // and tint the model surface inside it (the same filled highlight shown while
  // drawing). Rebuilt each time so it matches the current viewpoint.
  SpatialViewerApp.prototype.showAnnotationSurface = function(a) {
    this._setLassoHighlight(null);
    if (!a || a.annotation_type !== 'lasso_selection') return;
    var gd = a.geometry_data;
    if (!gd || !gd.points || gd.points.length < 3) return;
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
        (a.work_package_id
          ? '<a class="annotation-wp-link" href="' + esc(a.work_package_url || ('/work_packages/' + a.work_package_id)) +
              '" target="_blank" rel="noopener" title="' + esc(a.work_package_subject || '') + '">' +
              '<i class="icon-relations"></i> ' + esc(wpLabel) + '</a>'
          : '') +
        '<div class="annotation-meta"><span>' + esc(a.author_name || '') + '</span><span>' + esc(a.created_at || '') + '</span></div>' +
      '</div>';

      card.innerHTML = html;

      // Clicking the card (but not the WP link) restores the viewpoint.
      card.addEventListener('click', function(e) {
        if (e.target.closest && e.target.closest('.annotation-wp-link')) return;
        self.flyToAnnotation(a);
      });
      list.appendChild(card);
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

    navigator.xr.isSessionSupported('immersive-vr').then(function(supported) {
      if (!supported) { btn.style.display = 'none'; return; }
      btn.style.display = '';
      btn.disabled = false;
      btn.title = 'Enter VR';
    }).catch(function() { btn.style.display = 'none'; });

    function endVR() {
      if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
    }

    function onSessionEnded() {
      if (self._xrSession) self._xrSession.removeEventListener('end', onSessionEnded);
      self._xrSession = null;
      self.xrDolly.position.set(0, 0, 0);
      btn.disabled = false;
      btn.classList.remove('active');
      btn.title = 'Enter VR';
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
        btn.disabled = false;
        btn.classList.remove('active');
        btn.title = 'Enter VR';
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
