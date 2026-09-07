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
  // Renders the model's own geometry, tinted, discarding fragments outside the
  // lasso polygon (tested in NDC against gl_FragCoord). Because it shares the
  // model geometry and uses depthTest, the tint lands exactly on the visible
  // surface — no offset, no speckle, correctly occluded.
  var LASSO_MAX_PTS = 48;
  var LASSO_VS =
    'void main() {\n' +
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n' +
    '}';
  var LASSO_POINTS_VS =
    'uniform float uSize;\n' +
    'void main() {\n' +
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
    '  gl_PointSize = clamp(uSize * 350.0 / max(-mv.z, 0.001), 2.0, 24.0);\n' +
    '  gl_Position = projectionMatrix * mv;\n' +
    '}';
  // uPoly holds an already-closed polygon (last point == first); unused tail
  // slots repeat the last point (degenerate edges contribute nothing). All
  // array indexing is loop-index based for maximum driver compatibility.
  var LASSO_FS =
    'uniform vec3 uColor;\n' +
    'uniform float uOpacity;\n' +
    'uniform vec2 uRes;\n' +
    'uniform vec2 uPoly[' + LASSO_MAX_PTS + '];\n' +
    'uniform int uPolyLen;\n' +
    'void main() {\n' +
    '  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;\n' +
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

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a);

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

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    var dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight1.position.set(20, 40, 20);
    this.scene.add(dirLight1);

    var dirLight2 = new THREE.DirectionalLight(0x90b0ff, 0.5);
    dirLight2.position.set(-20, -20, -20);
    this.scene.add(dirLight2);

    this.gridHelper = new THREE.GridHelper(50, 50, 0x334155, 0x1e293b);
    this.gridHelper.position.y = -0.01;
    this.scene.add(this.gridHelper);

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

      // model_file replies JSON while a server-side conversion is pending.
      var ct = response.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        return response.json().then(function(j) {
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

  // (7) Parse GLB/GLTF in a Web Worker so the main thread does not freeze.
  // Falls back to a main-thread GLTFLoader.parse() on any failure (e.g. the GLB
  // has textures / KHR extensions the worker path can't handle).
  SpatialViewerApp.prototype._parseGltf = function(buffer) {
    var self = this;

    function mainThreadParse(buf) {
      self.showLoader('Parsing 3D geometry (the page may briefly freeze)...');
      try {
        new THREE.GLTFLoader().parse(buf, '',
          function(gltf) { self.onModelLoaded(gltf.scene); },
          function(err) {
            console.error('[SpatialViewer] GLTF parse error:', err);
            self.showLoader('Error parsing GLTF/GLB: ' + (err && err.message || err));
          });
      } catch (err) {
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
    var heavy = !!this.heavyMode;
    this.renderer.shadowMap.enabled = !heavy;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setPixelRatio(heavy ? 1 : Math.min(window.devicePixelRatio, 2));

    if (heavy) {
      this.showTooltip('Large model — shadows and high-DPI rendering are off for performance.');
      var self = this;
      setTimeout(function() {
        var t = document.getElementById('drawingTooltip');
        if (t && self.currentTool === 'orbit') t.style.display = 'none';
      }, 5000);
    }
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
        child.castShadow = !heavy;
        child.receiveShadow = !heavy;
        self.modelMeshObjects.push(child);

        var g = child.geometry;
        if (g && g.index) triangles += g.index.count / 3;
        else if (g && g.attributes && g.attributes.position) triangles += g.attributes.position.count / 3;
      }
    });

    // (1) Escalate to heavy mode if the mesh is dense even when the file is small.
    if (!heavy && triangles > 4000000) {
      heavy = this.heavyMode = true;
      this.modelMeshObjects.forEach(function(m) { m.castShadow = false; m.receiveShadow = false; });
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

    this.controls.target.copy(center);
    this.camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 1.2, center.z + maxDim * 1.5);
    this.camera.lookAt(center);
    this.controls.update();

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
    this.viewport.addEventListener('lostpointercapture', function(e) { self.onPointerUp(e); });
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
    try { if (e.pointerId != null) this.viewport.setPointerCapture(e.pointerId); } catch (ignore) {}
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
    this.controls.enabled = true;
    try {
      if (this._activePointerId != null) this.viewport.releasePointerCapture(this._activePointerId);
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

  // Highlight the VISIBLE model surface inside the (NDC) lasso polygon by
  // re-rendering the model's OWN geometry with a tint shader that discards
  // fragments outside the polygon. depthTest keeps only the front-most surface,
  // so the tint is pixel-exact on the visible surface — same for glb/ifc/gs.
  SpatialViewerApp.prototype._showLassoPolygon = function(ndcPoly, color) {
    if (!ndcPoly || ndcPoly.length < 3 || !this.modelMeshObjects || !this.modelMeshObjects.length) {
      this._setLassoHighlight(null);
      return;
    }
    var packed = packLassoPoly(ndcPoly);
    var col = new THREE.Color(color);

    // Fast path: just refresh the uniforms of the existing overlay.
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

    var res = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    var radius = this.modelRadius || 10;
    var group = new THREE.Group();

    this.modelMeshObjects.forEach(function(obj) {
      if (!obj.geometry || !obj.geometry.attributes || !obj.geometry.attributes.position) return;
      var isPoints = !!obj.isPoints;
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Vector3(col.r, col.g, col.b) },
          uOpacity: { value: isPoints ? 0.9 : 0.45 },
          uRes: { value: res.clone() },
          uPoly: { value: packed.flat },
          uPolyLen: { value: packed.len },
          uSize: { value: radius * 0.004 }
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
    this._showLassoPolygon(ndc, color);
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

    // Reset mode to "new"
    var newRadio = document.querySelector('input[name="caMode"][value="new"]');
    if (newRadio) { newRadio.checked = true; this.updateCreateMode('new'); }

    if (panel) {
      panel.classList.remove('collapsed');
      panel.classList.add('creating');
    }
    if (subject) subject.focus();
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
    var typeId = document.getElementById('caType') ? document.getElementById('caType').value : '';
    var priorityId = document.getElementById('caPriority') ? document.getElementById('caPriority').value : '';
    var assigneeId = document.getElementById('caAssignee') ? document.getElementById('caAssignee').value : '';
    var existingWpId = document.getElementById('caExistingWp') ? document.getElementById('caExistingWp').value : '';

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
      wp_type_id: typeId,
      wp_priority_id: priorityId,
      wp_assigned_to_id: assigneeId
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

  SpatialViewerApp.prototype.flyToAnnotation = function(a) {
    var self = this;

    var showSelection = function() {
      self._setLassoHighlight(null); // rebuild for this viewpoint
      if (a.annotation_type === 'lasso_selection' && a.geometry_data && a.geometry_data.points &&
          a.geometry_data.points.length >= 3) {
        var ring = a.geometry_data.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
        self._selectSurfaceInLasso(ring, self.camera, a.color || '#3b82f6');
      }
    };

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

    var spBtn = document.getElementById('btnSidePanelToggle'), sp = document.getElementById('spatialSidePanel');
    if (spBtn && sp) spBtn.addEventListener('click', function() { sp.classList.toggle('collapsed'); });

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
