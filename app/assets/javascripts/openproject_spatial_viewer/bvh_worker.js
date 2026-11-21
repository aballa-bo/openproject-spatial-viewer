/**
 * Spatial Viewer - BVH build worker.
 *
 * Builds a three-mesh-bvh tree for a mesh geometry off the main thread and
 * posts back the serialized tree (+ the re-ordered index) as transferables.
 */
/* global THREE, MeshBVHLib, importScripts */
var ready = false;

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type !== 'build') return;
  var id = m.id;
  try {
    if (!ready) {
      importScripts(m.threeUrl);
      importScripts(m.bvhUrl);
      ready = true;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.position, m.itemSize || 3, !!m.normalized));
    if (m.index) geo.setIndex(new THREE.BufferAttribute(m.index, 1, false));
    (m.groups || []).forEach(function (g) { geo.addGroup(g.start, g.count, g.materialIndex); });
    var bvh = new MeshBVHLib.MeshBVH(geo, { maxLeafTris: 12, verbose: false });
    var data = MeshBVHLib.MeshBVH.serialize(bvh, { cloneBuffers: false });
    var transfer = data.roots.map(function (r) { return r; });
    transfer.push(data.index.buffer);
    self.postMessage({ type: 'done', id: id, roots: data.roots, index: data.index }, transfer);
  } catch (err) {
    self.postMessage({ type: 'fail', id: id, error: String(err && err.message || err) });
  }
};
