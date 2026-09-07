/**
 * OpenProject Spatial Viewer — GLTF/GLB parse worker.
 *
 * Parses a GLB/GLTF ArrayBuffer off the main thread and posts back a flat list
 * of meshes: de-interleaved geometry attributes (transferable ArrayBuffers) +
 * a plain material descriptor + the mesh world matrix.
 *
 * Textures are NOT transferred — the main thread rebuilds MeshStandardMaterials
 * from per-material colours. Heavily textured models will usually fail here and
 * the caller falls back to a main-thread GLTFLoader.parse().
 */

/* global THREE, importScripts */

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== 'parse') return;

  try {
    importScripts(msg.bundleUrl);
  } catch (err) {
    return post({ type: 'error', error: 'importScripts failed: ' + (err && err.message || err) });
  }

  if (typeof THREE === 'undefined' || !THREE.GLTFLoader) {
    return post({ type: 'error', error: 'THREE.GLTFLoader not available in worker' });
  }

  // Textured models are handed back to the main thread so GLTFLoader can build
  // the full materials (this worker only carries geometry + flat colours).
  if (hasTextures(msg.buffer)) {
    return post({ type: 'error', error: 'textured model — defer to main thread' });
  }

  var loader = new THREE.GLTFLoader();

  try {
    loader.parse(
      msg.buffer,
      '',
      function (gltf) {
        try {
          var out = flatten(gltf.scene);
          post({ type: 'done', meshes: out.meshes }, out.transfer);
        } catch (err) {
          post({ type: 'error', error: 'flatten failed: ' + (err && err.message || err) });
        }
      },
      function (err) {
        post({ type: 'error', error: 'GLTF parse error: ' + (err && err.message || err) });
      }
    );
  } catch (err) {
    post({ type: 'error', error: 'parse threw: ' + (err && err.message || err) });
  }
};

// Cheap peek at the glTF JSON to see whether it declares images/textures,
// without a full parse. Handles both .gltf (JSON) and .glb (binary container).
function hasTextures(buffer) {
  try {
    var bytes = new Uint8Array(buffer);
    var json;
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
      // glb: 12-byte header, then JSON chunk (length @ 12, type @ 16, data @ 20)
      var view = new DataView(buffer);
      var jsonLen = view.getUint32(12, true);
      json = new TextDecoder('utf-8').decode(bytes.subarray(20, 20 + jsonLen));
    } else {
      json = new TextDecoder('utf-8').decode(bytes);
    }
    var doc = JSON.parse(json);
    return (doc.images && doc.images.length > 0) || (doc.textures && doc.textures.length > 0);
  } catch (e) {
    return false; // if in doubt, let the worker try
  }
}

function post(payload, transfer) {
  try {
    self.postMessage(payload, transfer || []);
  } catch (err) {
    self.postMessage({ type: 'error', error: 'postMessage failed: ' + (err && err.message || err) });
  }
}

function flatten(root) {
  root.updateMatrixWorld(true);

  var meshes = [];
  var transfer = [];

  root.traverse(function (o) {
    if (!o.isMesh && !o.isPoints) return;
    var g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;

    var attributes = {};
    ['position', 'normal', 'uv', 'color'].forEach(function (name) {
      var a = g.attributes[name];
      if (!a) return;
      var arr = deinterleave(a, name === 'color');
      attributes[name] = { buffer: arr.buffer, itemSize: a.itemSize };
      transfer.push(arr.buffer);
    });

    var index = null;
    if (g.index) {
      var src = g.index.array;
      var copy = src.slice(); // own buffer, offset 0
      index = { buffer: copy.buffer, ctor: copy.constructor.name };
      transfer.push(copy.buffer);
    }

    var mat = Array.isArray(o.material) ? o.material[0] : o.material;

    meshes.push({
      name: o.name || '',
      isPoints: !!o.isPoints,
      matrixWorld: o.matrixWorld.elements.slice(),
      attributes: attributes,
      index: index,
      material: {
        color: (mat && mat.color && mat.color.getHex) ? mat.color.getHex() : 0xb8c0cc,
        opacity: (mat && mat.opacity != null) ? mat.opacity : 1,
        transparent: !!(mat && mat.transparent),
        metalness: (mat && mat.metalness != null) ? mat.metalness : 0.1,
        roughness: (mat && mat.roughness != null) ? mat.roughness : 0.85,
        doubleSided: !!(mat && mat.side === THREE.DoubleSide),
        vertexColors: !!attributes.color
      }
    });
  });

  return { meshes: meshes, transfer: transfer };
}

// Always returns a fresh, non-interleaved Float32Array we own.
function deinterleave(a, isColor) {
  var n = a.count;
  var s = a.itemSize;
  var out = new Float32Array(n * s);
  var norm = isColor && a.normalized ? 255 : 1;
  for (var i = 0; i < n; i++) {
    out[i * s] = a.getX(i) / norm;
    if (s > 1) out[i * s + 1] = a.getY(i) / norm;
    if (s > 2) out[i * s + 2] = a.getZ(i) / norm;
    if (s > 3) out[i * s + 3] = a.getW(i) / norm;
  }
  return out;
}
