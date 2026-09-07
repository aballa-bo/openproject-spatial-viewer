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

  // ---- Cleanup previous viewer instance ----
  function destroyExistingViewer() {
    if (window.spatialViewerApp) {
      try {
        var app = window.spatialViewerApp;
        if (app._animFrameId) cancelAnimationFrame(app._animFrameId);
        if (app._conversionPoll) clearTimeout(app._conversionPoll);
        if (app._gltfWorker) { try { app._gltfWorker.terminate(); } catch (ignore3) {} }
        app._modelBlob = null;
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

  SpatialViewerApp.prototype.initThree = function() {
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

    this.raycaster = new THREE.Raycaster();
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

    var box = new THREE.Box3().setFromObject(object);
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z) || 10;

    // Scale-dependent tuning for the drawing tools.
    this.modelRadius = maxDim;
    this.surfaceOffset = Math.max(maxDim * 0.0006, 0.0015); // tiny lift, stays "on" the surface
    if (this.raycaster) this.raycaster.params.Points.threshold = maxDim * 0.01; // hit splat/point clouds

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
  };

  SpatialViewerApp.prototype.getIntersection = function(e) {
    var rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    var intersects = this.raycaster.intersectObjects(this.modelMeshObjects, true);
    return intersects.length > 0 ? intersects[0] : null;
  };

  // A ray hit projected onto the surface, with a minuscule scale-relative lift
  // along the (world-space) surface normal to avoid z-fighting with the model.
  SpatialViewerApp.prototype._surfacePoint = function(hit) {
    var off = this.surfaceOffset || 0.002;
    var dir;
    if (hit.face && hit.face.normal && hit.object) {
      dir = hit.face.normal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
        .normalize();
    } else {
      // Point clouds / gaussian splats have no faces: lift toward the camera.
      dir = new THREE.Vector3().subVectors(this.camera.position, hit.point).normalize();
    }
    return hit.point.clone().addScaledVector(dir, off);
  };

  SpatialViewerApp.prototype.onPointerDown = function(e) {
    if (this.currentTool === 'orbit' || e.button !== 0) return;
    var hit = this.getIntersection(e);
    if (!hit) return;

    if (this.currentTool === 'pin') {
      var n = new THREE.Vector3(0, 1, 0);
      if (hit.face && hit.object) {
        n = hit.face.normal.clone()
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      }
      this.place3DPin(hit.point, n);
    } else if (this.currentTool === 'draw' || this.currentTool === 'lasso') {
      this.isDrawing = true;
      this.controls.enabled = false;
      this.currentDrawingPoints = [this._surfacePoint(hit)];
      this._lastSampleClient = { x: e.clientX, y: e.clientY };
      this._updateOutline(this.currentDrawingPoints, this.currentTool === 'lasso');
    } else if (this.currentTool === 'measure') {
      if (!this.measureStartPoint) {
        this.measureStartPoint = hit.point.clone();
        this.showTooltip('Point 1 selected. Click second point to measure.');
      } else {
        this.finishMeasurement(this.measureStartPoint, hit.point);
        this.measureStartPoint = null;
      }
    }
  };

  SpatialViewerApp.prototype.onPointerMove = function(e) {
    if (!this.isDrawing) return;

    // Screen-space sampling: consistent visual density regardless of model scale.
    var isLasso = this.currentTool === 'lasso';
    var minPx = isLasso ? 4 : 7;
    var last = this._lastSampleClient || { x: e.clientX, y: e.clientY };
    var dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (Math.sqrt(dx * dx + dy * dy) < minPx) return;
    if (this.currentDrawingPoints.length >= 3000) return;

    var hit = this.getIntersection(e);
    if (!hit) return;

    this._lastSampleClient = { x: e.clientX, y: e.clientY };
    this.currentDrawingPoints.push(this._surfacePoint(hit));
    this._updateOutline(this.currentDrawingPoints, isLasso);

    if (isLasso) {
      var n = this.currentDrawingPoints.length;
      var step = Math.max(4, Math.floor(n / 25)); // bound total triangulation work
      if (n % step === 0) this._updateFillPreview(this.currentDrawingPoints);
    }
  };

  SpatialViewerApp.prototype.onPointerUp = function() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.controls.enabled = true;

    var isLasso = this.currentTool === 'lasso';
    var pts = this.currentDrawingPoints || [];
    if (pts.length < (isLasso ? 3 : 2)) { this.clearTempMarkup(); return; }

    if (isLasso) {
      this._updateOutline(pts, true);      // always a closed loop
      this._updateFillPreview(pts);
    }

    this.openAnnotationModal({
      type: isLasso ? 'lasso_selection' : 'draw_polyline',
      closed: isLasso,
      points: pts.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    });
  };

  // Outline preview: LineLoop when closed (lasso), Line when open (draw).
  SpatialViewerApp.prototype._updateOutline = function(points, closed) {
    if (this.currentDrawingLine) {
      this.tempMarkupGroup.remove(this.currentDrawingLine);
      this.currentDrawingLine.geometry.dispose();
      this.currentDrawingLine = null;
    }
    var geom = new THREE.BufferGeometry().setFromPoints(points);
    var mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(this.activeColor), depthTest: false, transparent: true
    });
    this.currentDrawingLine = closed ? new THREE.LineLoop(geom, mat) : new THREE.Line(geom, mat);
    this.currentDrawingLine.renderOrder = 999;
    this.tempMarkupGroup.add(this.currentDrawingLine);
  };

  SpatialViewerApp.prototype._updateFillPreview = function(points) {
    if (this.currentFillMesh) {
      this.tempMarkupGroup.remove(this.currentFillMesh);
      this.currentFillMesh.geometry.dispose();
      this.currentFillMesh.material.dispose();
      this.currentFillMesh = null;
    }
    var m = this._buildPolygonFill(points, new THREE.Color(this.activeColor));
    if (m) { this.currentFillMesh = m; this.tempMarkupGroup.add(m); }
  };

  // Semi-transparent filled polygon from a 3D ring of points. The ring is
  // projected onto its best-fit plane, triangulated, then lifted back to 3D.
  SpatialViewerApp.prototype._buildPolygonFill = function(points, color) {
    if (!points || points.length < 3) return null;

    var normal = new THREE.Vector3();
    for (var i = 0; i < points.length; i++) {
      var cur = points[i], nxt = points[(i + 1) % points.length];
      normal.x += (cur.y - nxt.y) * (cur.z + nxt.z);
      normal.y += (cur.z - nxt.z) * (cur.x + nxt.x);
      normal.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    if (normal.lengthSq() < 1e-12) return null;
    normal.normalize();

    var centroid = new THREE.Vector3();
    points.forEach(function(p) { centroid.add(p); });
    centroid.multiplyScalar(1 / points.length);

    var u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.dot(u)) > 0.9) u.set(0, 1, 0);
    u.crossVectors(normal, u).normalize();
    var v = new THREE.Vector3().crossVectors(normal, u).normalize();

    var flat2d = points.map(function(p) {
      var d = new THREE.Vector3().subVectors(p, centroid);
      return new THREE.Vector2(d.dot(u), d.dot(v));
    });

    var tris;
    try {
      tris = THREE.ShapeUtils.triangulateShape(flat2d, []);
    } catch (err) {
      return null;
    }
    if (!tris || !tris.length) return null;

    var positions = new Float32Array(points.length * 3);
    points.forEach(function(p, k) {
      positions[k * 3] = p.x; positions[k * 3 + 1] = p.y; positions[k * 3 + 2] = p.z;
    });
    var index = [];
    tris.forEach(function(t) { index.push(t[0], t[1], t[2]); });

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(index);
    geom.computeVertexNormals();

    var mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    }));
    mesh.renderOrder = 998;
    return mesh;
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
        var loop = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(ring),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true })
        );
        loop.renderOrder = 998;
        loop.userData = { annotation: a };
        self.annotationsGroup.add(loop);

        var fill = self._buildPolygonFill(ring, col);
        if (fill) { fill.userData = { annotation: a }; self.annotationsGroup.add(fill); }
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
    if (!a.camera_viewpoint || !a.camera_viewpoint.eye) return;
    var startPos = this.camera.position.clone();
    var endPos = new THREE.Vector3(a.camera_viewpoint.eye[0], a.camera_viewpoint.eye[1], a.camera_viewpoint.eye[2]);
    var startTarget = this.controls.target.clone();
    var endTarget = new THREE.Vector3(a.camera_viewpoint.target[0], a.camera_viewpoint.target[1], a.camera_viewpoint.target[2]);
    var self = this, progress = 0;
    (function fly() {
      progress += 0.04;
      self.camera.position.lerpVectors(startPos, endPos, progress);
      self.controls.target.lerpVectors(startTarget, endTarget, progress);
      self.controls.update();
      if (progress < 1) requestAnimationFrame(fly);
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
    if (clearBtn) clearBtn.addEventListener('click', function() { self.clearTempMarkup(); });

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
    var msgs = { pin: 'Click on the surface to place a 3D pin.', draw: 'Click and drag along the surface to draw a polyline.', lasso: 'Drag around a region — the selection closes and fills automatically.', measure: 'Click first point then second point to measure.' };
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
    this.currentFillMesh = null;
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
