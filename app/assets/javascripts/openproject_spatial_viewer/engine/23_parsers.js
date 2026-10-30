  // ---- Mesh-format parsing: dispatch, bundles, glTF, IFC -----------------
  // _parseModel is the single dispatcher load3DModel's download eventually
  // reaches (see 21_point_cloud_formats.js) -- routes to the point-cloud/
  // splat builders (22_splat_rendering.js) for those formats, and to the
  // mesh-format parsing below for everything else (zipped OBJ/glTF bundles,
  // plain glTF/GLB, IFC).

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
