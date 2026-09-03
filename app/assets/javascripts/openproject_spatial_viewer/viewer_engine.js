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

  // ---- Cleanup previous viewer instance ----
  function destroyExistingViewer() {
    if (window.spatialViewerApp) {
      try {
        var app = window.spatialViewerApp;
        if (app._animFrameId) cancelAnimationFrame(app._animFrameId);
        if (app._conversionPoll) clearTimeout(app._conversionPoll);
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
    this.showLoader('Downloading 3D model (' + format.toUpperCase() + ')...');

    if (typeof THREE === 'undefined') {
      this.showLoader('Error: Three.js engine failed to initialize.');
      return;
    }

    var self = this;
    fetch(url, { credentials: 'same-origin' })
      .then(function(response) {
        if (!response.ok) throw new Error('HTTP error ' + response.status);

        // model_file returns JSON (not binary) while a server-side conversion
        // is still pending/processing/failed. Poll until the .glb is ready.
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
            return null; // stop this load attempt
          });
        }

        var contentLength = response.headers.get('content-length');
        if (!response.body || !window.ReadableStream || !contentLength) {
          return response.arrayBuffer();
        }
        var total = parseInt(contentLength, 10);
        var loaded = 0;
        var reader = response.body.getReader();
        var chunks = [];

        function read() {
          return reader.read().then(function(result) {
            if (result.done) {
              var buf = new Uint8Array(loaded);
              var offset = 0;
              for (var i = 0; i < chunks.length; i++) {
                buf.set(chunks[i], offset);
                offset += chunks[i].length;
              }
              return buf.buffer;
            }
            chunks.push(result.value);
            loaded += result.value.length;
            var pct = total > 0 ? Math.round((loaded / total) * 100) + '% ' : '';
            self.showLoader('Downloading model: ' + pct + '(' + (loaded / 1048576).toFixed(1) + ' MB)');
            return read();
          });
        }
        return read();
      })
      .then(function(buffer) {
        if (!buffer) return; // conversion still pending: a poll was scheduled
        self.showLoader('Parsing 3D geometry...');

        if (format === 'glb' || format === 'gltf') {
          var gltfLoader = new THREE.GLTFLoader();
          gltfLoader.parse(buffer, '',
            function(gltf) { self.onModelLoaded(gltf.scene); },
            function(err) {
              console.error('[SpatialViewer] GLTF parse error:', err);
              self.showLoader('Error parsing GLTF/GLB: ' + (err.message || err));
            }
          );
        } else if (format === 'obj') {
          var text = new TextDecoder('utf-8').decode(buffer);
          var objLoader = new THREE.OBJLoader();
          self.onModelLoaded(objLoader.parse(text));
        } else if (format === 'ply' || format === 'gaussian_splat' || format === 'splat' || format === 'ksplat') {
          var plyLoader = new THREE.PLYLoader();
          var geom = plyLoader.parse(buffer);
          geom.computeVertexNormals();
          var mat = geom.hasAttribute('color')
            ? new THREE.PointsMaterial({ size: 0.05, vertexColors: true })
            : new THREE.PointsMaterial({ size: 0.05, color: 0x38bdf8 });
          self.onModelLoaded(new THREE.Points(geom, mat));
        } else if (format === 'ifc') {
          // IFC: attempt simple GLB-like parse; if the server converted it, it works.
          // Otherwise, parse as text and build simple geometry.
          self.parseIfcBuffer(buffer);
        } else {
          self.hideLoader();
          self.createDemoModel();
        }
      })
      .catch(function(err) {
        console.error('[SpatialViewer] Model loading failed:', err);
        self.showLoader('Error downloading model: ' + err.message);
      });
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
    object.traverse(function(child) {
      if (child.isMesh || child.isPoints) {
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(function(m) { m.clippingPlanes = self.clipPlanes; });
          } else {
            child.material.clippingPlanes = self.clipPlanes;
          }
        }
        child.castShadow = true;
        child.receiveShadow = true;
        self.modelMeshObjects.push(child);
      }
    });

    var box = new THREE.Box3().setFromObject(object);
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z) || 10;

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

  SpatialViewerApp.prototype.onPointerDown = function(e) {
    if (this.currentTool === 'orbit' || e.button !== 0) return;
    var hit = this.getIntersection(e);
    if (!hit) return;

    if (this.currentTool === 'pin') {
      this.place3DPin(hit.point, hit.face ? hit.face.normal : new THREE.Vector3(0,1,0));
    } else if (this.currentTool === 'draw' || this.currentTool === 'lasso') {
      this.isDrawing = true;
      this.controls.enabled = false;
      var norm = hit.face ? hit.face.normal : new THREE.Vector3(0,1,0);
      this.currentDrawingPoints = [hit.point.clone().add(norm.clone().multiplyScalar(0.02))];
      this.startPolyline(this.currentDrawingPoints);
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
    var hit = this.getIntersection(e);
    if (hit) {
      var norm = hit.face ? hit.face.normal : new THREE.Vector3(0,1,0);
      var pt = hit.point.clone().add(norm.clone().multiplyScalar(0.02));
      var last = this.currentDrawingPoints[this.currentDrawingPoints.length - 1];
      if (!last || last.distanceTo(pt) > 0.05) {
        this.currentDrawingPoints.push(pt);
        this.updatePolyline(this.currentDrawingPoints);
      }
    }
  };

  SpatialViewerApp.prototype.onPointerUp = function() {
    if (this.isDrawing) {
      this.isDrawing = false;
      this.controls.enabled = true;
      if (this.currentDrawingPoints.length > 2) {
        this.openAnnotationModal({
          type: this.currentTool === 'lasso' ? 'lasso_selection' : 'draw_polyline',
          points: this.currentDrawingPoints.map(function(p) { return {x:p.x,y:p.y,z:p.z}; })
        });
      }
    }
  };

  SpatialViewerApp.prototype.startPolyline = function(points) {
    var geom = new THREE.BufferGeometry().setFromPoints(points);
    var mat = new THREE.LineBasicMaterial({ color: new THREE.Color(this.activeColor), linewidth: 4, depthTest: false });
    this.currentDrawingLine = new THREE.Line(geom, mat);
    this.tempMarkupGroup.add(this.currentDrawingLine);
  };

  SpatialViewerApp.prototype.updatePolyline = function(points) {
    if (this.currentDrawingLine) {
      this.currentDrawingLine.geometry.dispose();
      this.currentDrawingLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    }
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

  SpatialViewerApp.prototype.openAnnotationModal = function(gd) {
    this.pendingGeometry = gd;
    var modal = document.getElementById('annotationModal');
    var preview = document.getElementById('modalThumbnailPreview');
    var titleInput = document.getElementById('modalAnnotTitle');
    var descInput = document.getElementById('modalAnnotDesc');
    var wpSubject = document.getElementById('modalWpSubject');

    this.pendingThumbnail = this.captureSnapshot();
    if (preview) preview.src = this.pendingThumbnail;

    if (titleInput) {
      var titles = { pin: '3D Pin Marker', draw_polyline: 'Mesh Inspection Drawing', lasso_selection: 'Mesh Region Selection' };
      titleInput.value = titles[gd.type] || (gd.type === 'measurement' ? '3D Measurement: ' + gd.dist + ' m' : 'Annotation');
    }
    if (wpSubject && titleInput) wpSubject.value = titleInput.value;
    if (descInput) descInput.value = '';
    if (modal) modal.style.display = 'flex';
  };

  SpatialViewerApp.prototype.saveAnnotation = function() {
    var title = document.getElementById('modalAnnotTitle').value;
    var desc = document.getElementById('modalAnnotDesc').value;
    var cwpEl = document.getElementById('modalCreateWpCheck');
    var createWp = cwpEl ? cwpEl.checked : false;
    var wpSubject = document.getElementById('modalWpSubject').value;
    var ewpEl = document.getElementById('modalSelectExistingWp');
    var existingWpId = ewpEl ? ewpEl.value : '';
    var self = this;

    var payload = {
      spatial_annotation: {
        title: title, description: desc,
        annotation_type: this.pendingGeometry.type,
        color: this.activeColor,
        work_package_id: existingWpId || null,
        thumbnail_base64: this.pendingThumbnail,
        camera_viewpoint: {
          eye: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
          target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
          up: [this.camera.up.x, this.camera.up.y, this.camera.up.z]
        },
        geometry_data: this.pendingGeometry
      },
      create_work_package: createWp ? 'true' : 'false',
      wp_subject: wpSubject
    };

    fetch(this.apiUrl.replace('/api_data', '/spatial_annotations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.success) {
        self.closeModal(); self.clearTempMarkup();
        self.projectData.annotations.unshift(result.annotation);
        self.renderAnnotationsList(self.projectData.annotations);
        self.renderExisting3DAnnotations();
        var c = document.getElementById('annotationCountHeader');
        if (c) c.innerText = self.projectData.annotations.length;
      } else {
        alert('Save error: ' + (result.errors || []).join(', '));
      }
    })
    .catch(function(err) { alert('Network error: ' + err); });
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
      } else if ((a.annotation_type === 'draw_polyline' || a.annotation_type === 'lasso_selection') && gd.points) {
        var pts = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
        var geom = new THREE.BufferGeometry().setFromPoints(pts);
        var line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: col, linewidth: 3, depthTest: false }));
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
      card.innerHTML = '<div class="annotation-card-header"><span class="annotation-title">' + a.title + '</span><span class="annotation-type-badge" style="background:' + a.color + ';color:#fff;">' + a.annotation_type.toUpperCase() + '</span></div>' +
        (a.description ? '<div class="annotation-desc">' + a.description + '</div>' : '') +
        (a.work_package_id ? '<div class="badge -success mt-1">Ticket #' + a.work_package_id + '</div>' : '') +
        '<div class="annotation-meta"><span>' + (a.author_name||'') + '</span><span>' + (a.created_at||'') + '</span></div>';
      card.addEventListener('click', function() { self.flyToAnnotation(a); });
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
      var card = document.createElement('div');
      card.className = 'annotation-card';
      card.innerHTML = '<div class="annotation-card-header"><span class="annotation-title">#' + wp.id + ' - ' + wp.subject + '</span><span class="badge -info">' + (wp.type||'Task') + '</span></div><div class="annotation-meta"><span>Status: ' + (wp.status||'New') + '</span><span>Assigned: ' + (wp.assigned_to||'-') + '</span></div>';
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

    var cancelBtn = document.getElementById('modalCancelBtn'), closeMBtn = document.getElementById('closeModalBtn'), saveBtn = document.getElementById('modalSaveBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', function() { self.closeModal(); });
    if (closeMBtn) closeMBtn.addEventListener('click', function() { self.closeModal(); });
    if (saveBtn) saveBtn.addEventListener('click', function() { self.saveAnnotation(); });

    document.querySelectorAll('.color-dot').forEach(function(dot) {
      dot.addEventListener('click', function() {
        document.querySelectorAll('.color-dot').forEach(function(d) { d.classList.remove('active'); });
        dot.classList.add('active');
        self.activeColor = dot.dataset.color;
      });
    });

    var cwp = document.getElementById('modalCreateWpCheck'), wpf = document.getElementById('wpFieldsGroup'), lwp = document.getElementById('linkExistingWpGroup');
    if (cwp) cwp.addEventListener('change', function(e) {
      if (wpf) wpf.style.display = e.target.checked ? 'block' : 'none';
      if (lwp) lwp.style.display = e.target.checked ? 'none' : 'block';
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
    var msgs = { pin: 'Click on the mesh surface to place a 3D Pin.', draw: 'Click and drag on the mesh to draw a 3D polyline.', lasso: 'Drag to select a mesh region with the lasso.', measure: 'Click first point then second point to measure.' };
    if (msgs[this.currentTool]) { tip.innerText = msgs[this.currentTool]; tip.style.display = 'block'; }
    else { tip.style.display = 'none'; }
  };

  SpatialViewerApp.prototype.showTooltip = function(text) {
    var tip = document.getElementById('drawingTooltip');
    if (tip) { tip.innerHTML = text; tip.style.display = 'block'; }
  };

  SpatialViewerApp.prototype.clearTempMarkup = function() {
    while (this.tempMarkupGroup.children.length > 0) this.tempMarkupGroup.remove(this.tempMarkupGroup.children[0]);
  };

  SpatialViewerApp.prototype.closeModal = function() {
    var m = document.getElementById('annotationModal');
    if (m) m.style.display = 'none';
    this.clearTempMarkup();
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
