
  // ---- Parallel layer download + per-layer progress ------------------------
  // All layer files are downloaded at once (up to PREFETCH_PARALLEL at a time,
  // in load order) while the layers themselves are still parsed and added to
  // the scene one by one, in the same order as before (the first layer
  // defines the camera and framing). A layer whose file has already arrived
  // is picked up from memory by _downloadModel instead of being fetched again.
  var PREFETCH_PARALLEL = 3;

  // ---- Persistent layer cache (browser Cache Storage) ----------------------
  // Layer URLs carry ?v=<version of the served file> (SpatialViewer::FileVersion).
  // A layer whose URL (= version) is already in the cache is read from disk
  // instead of being downloaded again; a changed layer has a new URL, misses,
  // is downloaded and replaces its older versions. Cache Storage is used rather
  // than the HTTP cache because browsers do not keep files of hundreds of MB
  // there (Firefox: 50 MB per entry). Needs a secure context (HTTPS).
  var LAYER_CACHE = 'spatial-viewer-layers-v1';
  var LAYER_CACHE_MAX_AGE_MS = 60 * 24 * 3600 * 1000; // drop entries not refreshed for 60 days

  function layerCacheUsable(url) {
    return !!url && typeof caches !== 'undefined' && window.isSecureContext && /[?&]v=[0-9a-f]+/.test(url);
  }
  function layerCacheKey(url) { return new URL(url, window.location.href).href; }

  // Resolves to { blob, total, cached: true } or null.
  SpatialViewerApp.prototype._layerCacheGet = function(url) {
    if (!layerCacheUsable(url)) return Promise.resolve(null);
    return caches.open(LAYER_CACHE).then(function(c) {
      return c.match(layerCacheKey(url));
    }).then(function(resp) {
      if (!resp) return null;
      return resp.blob().then(function(b) { return b.size ? { blob: b, total: b.size, cached: true } : null; });
    }).catch(function(err) {
      console.warn('[SpatialViewer] layer cache read failed:', err && err.message || err);
      return null;
    });
  };

  // Stores a downloaded layer and removes the older versions of the same file.
  SpatialViewerApp.prototype._layerCachePut = function(url, blob, contentType) {
    if (!layerCacheUsable(url) || !blob || !blob.size) return;
    var key = layerCacheKey(url), path = new URL(key).pathname;
    caches.open(LAYER_CACHE).then(function(c) {
      return c.keys().then(function(reqs) {
        return Promise.all(reqs.filter(function(r) {
          return r.url !== key && new URL(r.url).pathname === path;
        }).map(function(r) { return c.delete(r); }));
      }).then(function() {
        return c.put(key, new Response(blob, { headers: {
          'Content-Type': contentType || 'application/octet-stream',
          'X-SV-Cached-At': String(Date.now())
        } }));
      });
    }).catch(function(err) {
      // Quota exceeded or private mode: the viewer just keeps downloading.
      console.warn('[SpatialViewer] layer cache write failed:', err && err.message || err);
    });
  };

  // Once per page: drop entries that were not refreshed for a long time.
  SpatialViewerApp.prototype._layerCachePrune = function() {
    if (this._layerCachePruned || typeof caches === 'undefined' || !window.isSecureContext) return;
    this._layerCachePruned = true;
    var now = Date.now();
    caches.open(LAYER_CACHE).then(function(c) {
      return c.keys().then(function(reqs) {
        return Promise.all(reqs.map(function(r) {
          return c.match(r).then(function(resp) {
            var at = resp && parseInt(resp.headers.get('X-SV-Cached-At'), 10);
            if (!at || now - at > LAYER_CACHE_MAX_AGE_MS) return c.delete(r);
          });
        }));
      });
    }).catch(function() {});
  };

  // load3DModel's first step: a cached layer is handed to _downloadModel as if
  // prefetched (no HEAD request, no size confirmation); otherwise HEAD as before.
  SpatialViewerApp.prototype._probeLayer = function(url, preDone) {
    var self = this;
    if (preDone) return Promise.reject(new Error('prefetched'));
    return this._layerCacheGet(url).then(function(hit) {
      if (hit) {
        self._prefetched = self._prefetched || {};
        self._prefetched[url] = { promise: Promise.resolve(hit) };
        throw new Error('prefetched');
      }
      return fetch(url, { method: 'HEAD', credentials: 'same-origin' });
    });
  };

  SpatialViewerApp.prototype._layerProg = function(id, patch) {
    if (id == null) return;
    this._layerProgress = this._layerProgress || {};
    var p = this._layerProgress[id] = this._layerProgress[id] || { state: 'queued', loaded: 0, total: 0 };
    for (var k in patch) p[k] = patch[k];
    this._scheduleProgressRender();
  };

  SpatialViewerApp.prototype._scheduleProgressRender = function() {
    var self = this;
    if (this._progRaf) return;
    this._progRaf = requestAnimationFrame(function() {
      self._progRaf = 0;
      self._renderLayerProgress();
    });
  };

  SpatialViewerApp.prototype._renderLayerProgress = function() {
    var host = document.getElementById('viewerLoader');
    if (!host) return;
    var box = document.getElementById('layerProgress');
    if (!box) {
      box = document.createElement('div');
      box.id = 'layerProgress';
      box.className = 'layer-progress';
      host.appendChild(box);
    }
    var self = this, prog = this._layerProgress || {};
    var ids = (this._layerOrder || []).filter(function(i) { return prog[i]; });
    box.innerHTML = '';
    box.style.display = ids.length > 1 || (ids.length === 1 && prog[ids[0]].state !== 'done') ? '' : 'none';
    var labels = { queued: 'queued', ready: 'downloaded', processing: 'processing…', streaming: 'streaming…', done: 'done', error: 'failed' };
    ids.forEach(function(id) {
      var p = prog[id], m = (self.layerMeta && self.layerMeta[id]) || {};
      var row = document.createElement('div');
      row.className = 'layer-progress-row -' + p.state;
      var name = document.createElement('span');
      name.className = 'layer-progress-name';
      name.textContent = m.title || id;
      var bar = document.createElement('div');
      bar.className = 'layer-progress-bar';
      var fill = document.createElement('i');
      var frac = p.state === 'done' || p.state === 'ready' || p.state === 'processing' ? 1
        : (p.state === 'download' && p.total ? Math.min(1, p.loaded / p.total) : 0);
      fill.style.width = Math.round(frac * 100) + '%';
      if ((p.state === 'download' && !p.total) || p.state === 'processing' || p.state === 'streaming') bar.classList.add('-busy');
      bar.appendChild(fill);
      var st = document.createElement('span');
      st.className = 'layer-progress-state';
      st.textContent = p.state === 'download'
        ? (p.total ? Math.round(frac * 100) + '%' : (p.loaded / 1048576).toFixed(1) + ' MB')
        : (labels[p.state] || p.state);
      row.appendChild(name); row.appendChild(bar); row.appendChild(st);
      box.appendChild(row);
    });
  };

  // Start downloading every layer file that can be fetched up front.
  SpatialViewerApp.prototype._prefetchLayers = function(queue) {
    var self = this;
    this._installLongTaskLog();
    this._layerCachePrune();
    var warnBytes = (parseInt(this.container.dataset.maxModelMb, 10) || 250) * 1048576;
    this._prefetched = {};
    var todo = [];
    queue.forEach(function(l) {
      var conv = l.conversion;
      var octree = l.kind === 'pointcloud' && l.octree_url;
      // Octree clouds stream their own nodes; pending conversions return a JSON
      // envelope; very large files keep the "continue?" confirmation.
      if (octree) { self._layerProg(l.id, { state: 'queued' }); return; }
      if (conv && conv.status && conv.status !== 'completed') { self._layerProg(l.id, { state: 'queued' }); return; }
      if (l.file_size && l.file_size > warnBytes) { self._layerProg(l.id, { state: 'queued' }); return; }
      var entry = {};
      entry.promise = new Promise(function(resolve) { entry.resolve = resolve; });
      self._prefetched[l.url] = entry;
      self._layerProg(l.id, { state: 'queued', total: l.file_size || 0 });
      todo.push({ l: l, entry: entry });
    });

    var next = 0, gen = this._loadGen = (this._loadGen || 0) + 1;
    var run = function() {
      if (next >= todo.length || gen !== self._loadGen) return;
      var t = todo[next++];
      self._prefetchOne(t.l, t.entry, gen).then(run);
    };
    for (var i = 0; i < PREFETCH_PARALLEL; i++) run();
  };

  // Downloads run in a Web Worker so they are not stalled while the main thread
  // is busy parsing another layer; falls back to the page thread if no Worker.
  SpatialViewerApp.prototype._prefetchWorker = function() {
    if (this._pfWorker) return this._pfWorker;
    var self = this;
    try {
      // bump ?v= when the worker changes: static assets are cached for a year
      var w = new Worker('/assets/openproject_spatial_viewer/prefetch_worker.js?v=2');
      this._pfJobs = {};
      w.onmessage = function(e) {
        var m = e.data || {}, job = self._pfJobs[m.id];
        if (!job) return;
        if (m.type === 'start') { self._layerProg(job.l.id, { total: m.total }); }
        else if (m.type === 'progress') { if (job.gen === self._loadGen) self._layerProg(job.l.id, { state: 'download', loaded: m.loaded }); }
        else if (m.type === 'done') {
          delete self._pfJobs[m.id];
          if (job.gen !== self._loadGen) { job.entry.resolve(null); job.finish(); return; }
          self._layerProg(job.l.id, { state: 'ready', loaded: m.blob.size, total: m.blob.size });
          self._layerCachePut(job.l.url, m.blob, m.contentType);
          job.entry.resolve({ blob: m.blob, total: m.total });
          job.finish();
        } else if (m.type === 'fail') {
          delete self._pfJobs[m.id];
          console.warn('[SpatialViewer] prefetch failed for layer', job.l.id, '-', m.reason);
          self._layerProg(job.l.id, { state: 'queued' });
          if (self._prefetched) delete self._prefetched[job.l.url];
          job.entry.resolve(null);
          job.finish();
        }
      };
      w.onerror = function() { self._pfWorker = null; };
      this._pfWorker = w;
    } catch (err) { this._pfWorker = null; }
    return this._pfWorker;
  };

  SpatialViewerApp.prototype._prefetchOne = function(l, entry, gen) {
    var self = this;
    return this._layerCacheGet(l.url).then(function(hit) {
      if (!hit) return self._prefetchOneNetwork(l, entry, gen);
      if (gen === self._loadGen) self._layerProg(l.id, { state: 'ready', loaded: hit.total, total: hit.total });
      entry.resolve(hit);
    });
  };

  SpatialViewerApp.prototype._prefetchOneNetwork = function(l, entry, gen) {
    var self = this, w = this._prefetchWorker();
    if (!w) return this._prefetchOneMain(l, entry, gen);
    return new Promise(function(finish) {
      var id = (self._pfSeq = (self._pfSeq || 0) + 1);
      self._pfJobs[id] = { l: l, entry: entry, gen: gen, finish: finish };
      self._layerProg(l.id, { state: 'download', loaded: 0 });
      w.postMessage({ type: 'fetch', id: id, url: l.url, size: l.file_size || 0 });
    });
  };

  SpatialViewerApp.prototype._prefetchOneMain = function(l, entry, gen) {
    var self = this;
    var fail = function() {
      if (self._prefetched) delete self._prefetched[l.url];
      entry.resolve(null); // the normal path downloads it itself
    };
    this._layerProg(l.id, { state: 'download', loaded: 0 });
    return fetch(l.url, { credentials: 'same-origin' }).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var ct = (resp.headers.get('content-type') || '').toLowerCase();
      var total = parseInt(resp.headers.get('content-length'), 10) || l.file_size || 0;
      if (ct.indexOf('/json') !== -1 || !resp.body || !window.ReadableStream) {
        throw new Error('not prefetchable'); // envelope / glTF-json / no streaming: normal path
      }
      self._layerProg(l.id, { total: total });
      var chunks = [], loaded = 0, reader = resp.body.getReader();
      var pump = function() {
        return reader.read().then(function(r) {
          if (r.done) return;
          chunks.push(r.value); loaded += r.value.length;
          if (gen === self._loadGen) self._layerProg(l.id, { state: 'download', loaded: loaded });
          return pump();
        });
      };
      return pump().then(function() {
        var blob = new Blob(chunks); chunks.length = 0;
        if (gen !== self._loadGen) { entry.resolve(null); return; }
        self._layerProg(l.id, { state: 'ready', loaded: blob.size, total: blob.size });
        self._layerCachePut(l.url, blob, ct);
        entry.resolve({ blob: blob, total: total });
      });
    }).catch(function(err) {
      console.warn('[SpatialViewer] prefetch failed for layer', l.id, '-', err && err.message || err);
      self._layerProg(l.id, { state: 'queued' });
      fail();
    });
  };

  // ---- First-show warm-up of mesh / IFC layers + stall tracing -------------
  // Cause of the "a few seconds before the mouse responds" after switching from
  // the LiDAR to a heavy photogrammetry layer: the layer's BVH (picking /
  // raycast tree, one synchronous build per big mesh) is only built on first
  // use -- the first mouse press -- and its textures/geometry are uploaded to
  // the GPU on the first frame it is drawn. Both block the main thread.
  var TEX_KEYS = ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap'];

  SpatialViewerApp.prototype._layerNeedsBVH = function(id) {
    var g = this.layerGroups && this.layerGroups[id];
    if (!g) return false;
    return (this.modelMeshObjects || []).some(function(m) {
      if (m.userData.layerVisibilityGroup !== g || !m.isMesh || !m.geometry || m.geometry.boundsTree || m.userData._bvhPending) return false;
      var pos = m.geometry.attributes && m.geometry.attributes.position;
      return pos && pos.count > 30 && pos.count <= 9000000;
    });
  };

  SpatialViewerApp.prototype._layerNeedsWarmup = function(id) {
    var m = this.layerMeta && this.layerMeta[id];
    if (!m || !this.layerGroups[id] || (m.kind !== 'mesh' && m.kind !== 'ifc')) return false;
    return this._layerNeedsBVH(id) || !(this._layerTexWarm && this._layerTexWarm[id]);
  };

  SpatialViewerApp.prototype._warmLayer = function(id, done) {
    var self = this, g = this.layerGroups[id], m = this.layerMeta[id];
    this._toast('Preparing “' + (m.title || id) + '”… the view may stay unresponsive for a few seconds.', 0);
    // two frames so the toast is on screen before the page blocks
    requestAnimationFrame(function() { requestAnimationFrame(function() { setTimeout(function() {
      var t0 = performance.now(), tBvh = 0, tTex = 0;
      try {
        if (self._layerNeedsBVH(id)) {
          // in a worker when possible (picking on this layer is off until it is ready)
          if (!self._buildBVHAsync(g)) self._ensureBVH(g);
          tBvh = performance.now() - t0;
        }
        var t1 = performance.now();
        if (self.renderer && self.renderer.initTexture) {
          g.traverse(function(o) {
            if (!o.material) return;
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat) {
              TEX_KEYS.forEach(function(k) { if (mat && mat[k] && mat[k].isTexture) { try { self.renderer.initTexture(mat[k]); } catch (e) {} } });
            });
          });
        }
        tTex = performance.now() - t1;
      } catch (err) { console.warn('[SpatialViewer] layer warm-up failed:', err); }
      self._layerTexWarm = self._layerTexWarm || {};
      self._layerTexWarm[id] = true;
      console.log('[SpatialViewer] layer "' + (m.title || id) + '" prepared: BVH ' + Math.round(tBvh) + ' ms, textures ' + Math.round(tTex) + ' ms');
      self._toast(null);
      done();
    }, 0); }); });
  };

  // Small message at the bottom of the viewport. ms = 0: stays until _toast(null).
  SpatialViewerApp.prototype._toast = function(text, ms) {
    var host = this.viewport || document.getElementById('spatialViewport');
    if (!host) return;
    var el = this._toastEl;
    if (!el) {
      el = this._toastEl = document.createElement('div');
      el.className = 'sv-toast';
      el.setAttribute('role', 'status');
      host.appendChild(el);
    }
    clearTimeout(this._toastTimer);
    if (!text) { el.style.display = 'none'; return; }
    el.textContent = text;
    el.style.display = '';
    if (ms) { var self = this; this._toastTimer = setTimeout(function() { el.style.display = 'none'; }, ms); }
  };

  // Console trace of any task that blocks the page for > 200 ms (Chromium).
  SpatialViewerApp.prototype._installLongTaskLog = function() {
    if (this._longTaskLog || !window.PerformanceObserver) return;
    this._longTaskLog = true;
    try {
      new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(e) {
          if (e.duration > 200) console.log('[SpatialViewer] main thread blocked for ' + Math.round(e.duration) + ' ms');
        });
      }).observe({ entryTypes: ['longtask'] });
    } catch (err) {}
  };

  // ---- BVH built in Web Workers --------------------------------------------
  // The picking tree of each mesh is built off the main thread right after its
  // layer is loaded, so nothing is left to build (and block the page) when the
  // layer is first shown or clicked. A mesh still being built is skipped by
  // the raycast target list (m.userData._bvhPending) instead of falling back
  // to a brute-force raycast. If workers are unavailable the old synchronous
  // build (_ensureBVH) is used.
  var BVH_WORKERS = 2;

  SpatialViewerApp.prototype._bvhPool = function() {
    if (this._bvhWorkers) return this._bvhWorkers;
    if (!window.Worker || !window.MeshBVHLib) return null;
    var self = this, list = [];
    try {
      for (var i = 0; i < BVH_WORKERS; i++) {
        var w = new Worker('/assets/openproject_spatial_viewer/bvh_worker.js');
        w.onmessage = function(e) { self._onBvhResult(e.data || {}); };
        w.onerror = function() { self._bvhWorkersFailed(); };
        list.push(w);
      }
    } catch (err) { return null; }
    this._bvhWorkers = list;
    this._bvhJobs = {};
    this._bvhSeq = 0;
    return list;
  };

  SpatialViewerApp.prototype._bvhWorkersFailed = function() {
    var self = this;
    console.warn('[SpatialViewer] BVH worker failed; falling back to the main thread');
    (this._bvhWorkers || []).forEach(function(w) { try { w.terminate(); } catch (e) {} });
    this._bvhWorkers = null;
    this._bvhNoWorker = true;
    var jobs = this._bvhJobs || {};
    this._bvhJobs = {};
    Object.keys(jobs).forEach(function(k) { jobs[k].mesh.userData._bvhPending = false; });
    this._bvhReady = false; // let _ensureBVH build the rest synchronously
  };

  SpatialViewerApp.prototype._onBvhResult = function(m) {
    var job = this._bvhJobs && this._bvhJobs[m.id];
    if (!job) return;
    delete this._bvhJobs[m.id];
    var mesh = job.mesh, geo = mesh.geometry;
    mesh.userData._bvhPending = false;
    if (job.gen !== this._bvhGen) return; // layers were reloaded meanwhile
    if (m.type === 'done') {
      try {
        geo.boundsTree = window.MeshBVHLib.MeshBVH.deserialize({ roots: m.roots, index: m.index }, geo, { setIndex: true });
      } catch (err) {
        console.warn('[SpatialViewer] BVH deserialize failed:', err);
        this._bvhReady = false;
      }
    } else {
      console.warn('[SpatialViewer] BVH worker error:', m.error);
      this._bvhReady = false; // sync fallback for this mesh
    }
    this._bvhPendingCount = Math.max(0, (this._bvhPendingCount || 1) - 1);
    if (!this._bvhPendingCount) {
      console.log('[SpatialViewer] BVH ready for all meshes (' + Math.round(performance.now() - this._bvhT0) + ' ms since start)');
      if (this._bvhWaiters) { var w = this._bvhWaiters; this._bvhWaiters = []; w.forEach(function(f) { f(); }); }
    }
  };

  // Start building the BVH of every pending mesh of a layer group (or of all
  // layers). Returns true if work was queued.
  SpatialViewerApp.prototype._buildBVHAsync = function(group) {
    var pool = this._bvhPool();
    if (!pool || this._bvhNoWorker || !window.MeshBVHLib) return false;
    var self = this, queued = 0;
    this._bvhGen = this._bvhGen || 0;
    (this.modelMeshObjects || []).forEach(function(m) {
      if (group && m.userData.layerVisibilityGroup !== group) return;
      if (!m.isMesh || !m.geometry || m.geometry.boundsTree || m.userData._bvhPending) return;
      var pos = m.geometry.attributes && m.geometry.attributes.position;
      if (!pos || pos.isInterleavedBufferAttribute || !pos.array || !(pos.count > 30 && pos.count <= 9000000)) return;
      var idx = m.geometry.index;
      if (idx && idx.isInterleavedBufferAttribute) return;
      var id = ++self._bvhSeq;
      self._bvhJobs[id] = { mesh: m, gen: self._bvhGen };
      m.userData._bvhPending = true;
      if (!self._bvhPendingCount) self._bvhT0 = performance.now();
      self._bvhPendingCount = (self._bvhPendingCount || 0) + 1;
      queued++;
      var pc = pos.array.slice();
      var ic = idx && idx.array ? idx.array.slice() : null;
      var transfer = [pc.buffer]; if (ic) transfer.push(ic.buffer);
      pool[id % pool.length].postMessage({
        type: 'build', id: id,
        threeUrl: '/assets/openproject_spatial_viewer/vendor.bundle.js',
        bvhUrl: '/assets/openproject_spatial_viewer/vendor/mesh-bvh.js',
        position: pc, itemSize: pos.itemSize, normalized: !!pos.normalized, index: ic,
        groups: (m.geometry.groups || []).map(function(g) { return { start: g.start, count: g.count, materialIndex: g.materialIndex }; })
      }, transfer);
    });
    return queued > 0;
  };

  SpatialViewerApp.prototype._bvhIdle = function(fn) {
    if (!this._bvhPendingCount) return fn();
    (this._bvhWaiters = this._bvhWaiters || []).push(fn);
  };
