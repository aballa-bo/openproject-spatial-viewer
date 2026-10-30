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
    // Splat color comes straight out of the per-splat spherical-harmonics
    // evaluation in the vertex shader (baked in at training time) -- this
    // material writes gl_FragColor directly and never goes through
    // three.js's own <tonemapping_fragment> chunk, so the renderer's
    // toneMappingExposure (wired up for every normal lit material in
    // _applyRenderSettingsUnsafe) has no effect on it at all. This uniform
    // is the splat-side equivalent, set from the same Exposure slider value
    // (see _applyRenderSettingsUnsafe) and applied as a simple linear
    // brightness multiply -- there's no real "tone mapping curve" to run
    // splats through, just like there's no relighting them (see
    // `light` below).
    'uniform float exposure;',
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
    '  vec3 outColor = clamp(vColor.rgb * exposure, 0.0, 1.0);',
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
        exposure: { value: 1.0 },
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
        exposure: { value: 1.0 },
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

