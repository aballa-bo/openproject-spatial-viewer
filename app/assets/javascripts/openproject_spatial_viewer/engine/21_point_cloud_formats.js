  // ---- Generic download + point-cloud/splat SOURCE format parsing -------
  // load3DModel/_downloadModel: the format-agnostic entry point (HEAD size
  // check, streamed download with progress) shared by every format --
  // dispatch to the right parser happens in _parseModel (23_parsers.js).
  // Below that: raw binary readers for the point-cloud/Gaussian-splat
  // source formats (zip/PLY/LAS/.sog) -- building the actual THREE.js
  // renderers from their output lives in 22_splat_rendering.js.

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

