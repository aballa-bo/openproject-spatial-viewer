// Back-to-front depth sort for true Gaussian-splat rendering (SplatRenderer in
// viewer_engine.js), run in a Worker so it never blocks the main thread. Ported
// from PlayCanvas's own GSplatSorter/SortWorker (the actual production
// implementation used by their "SuperSplat Explore" viewer, verified by reading
// its bundled source directly rather than guessing), adapted to this file's
// data model: we always alpha-blend every splat in one pass, so the
// opaque/transparent split and the "mapping" indirection PlayCanvas's version
// carries (for their resource-sharing/LOD system) are dropped -- our `order`
// indices already correspond 1:1 to the splat data array.
//
// Protocol (postMessage):
//   -> {type:'init', centers: ArrayBuffer (Float32, xyz per splat)}
//        One-time setup. Builds 256-splat "chunks" (bounding sphere per chunk)
//        used to adaptively size depth buckets later.
//   -> {type:'camera', position:{x,y,z}, direction:{x,y,z}}
//        Sent whenever the camera moves meaningfully. Triggers a resort.
//   <- {type:'order', order: ArrayBuffer (Uint32, transferred)}
//        Posted back after every resort actually performed (camera deltas
//        under ~0.001 in position/direction are treated as "unchanged" and
//        skipped, same epsilon PlayCanvas uses).
//   -> {type:'release', buffer: ArrayBuffer (the same buffer sent back in an
//       'order' message, transferred back once the main thread is done
//       reading it)}
//        Returns an order buffer to the pool below so it can be reused by a
//        later resort instead of allocating a fresh one. During continuous
//        navigation (camera moving every frame) resorts can fire many times
//        per second; without this, every single one allocates a brand-new
//        multi-megabyte Uint32Array (e.g. ~16MB for 4M splats) that
//        immediately becomes garbage -- a real, measured source of
//        sustained-navigation memory churn (see viewer_engine.js's
//        SplatRendererTex/SplatRenderer onmessage handlers, which send this
//        back right after copying the order out). The pool bounds steady-
//        state allocation to the handful of buffers actually in flight.
(function() {
  'use strict';

  var CHUNK_SIZE = 256;
  var NUM_COARSE_BINS = 32;

  var centers = null;
  var numVertices = 0;
  var order = null;
  var freeOrderBuffers = []; // pool of Uint32Array(numVertices), returned via 'release'

  // Per-chunk precomputed bounding sphere (center.xyz, radius), used only to
  // build the coarse histogram below -- never touched after init.
  var chunkCenters = null; // Float32Array, 3 per chunk
  var chunkRadii = null;   // Float32Array, 1 per chunk

  var lastPos = { x: NaN, y: NaN, z: NaN };
  var lastDir = { x: NaN, y: NaN, z: NaN };
  var pendingPos = null, pendingDir = null;

  var distances = null;     // Uint32Array(numVertices) -- bucket index per splat
  var countBuffer = null;   // Uint32Array(bucketCount+1) -- counting-sort histogram
  var binCount = new Array(NUM_COARSE_BINS);
  var binBase = new Array(NUM_COARSE_BINS);
  var binDivider = new Array(NUM_COARSE_BINS);

  function buildChunks() {
    var numChunks = Math.ceil(numVertices / CHUNK_SIZE);
    chunkCenters = new Float32Array(numChunks * 3);
    chunkRadii = new Float32Array(numChunks);
    for (var c = 0; c < numChunks; c++) {
      var start = c * CHUNK_SIZE, end = Math.min(numVertices, start + CHUNK_SIZE);
      var mx = Infinity, my = Infinity, mz = Infinity;
      var Mx = -Infinity, My = -Infinity, Mz = -Infinity;
      for (var i = start; i < end; i++) {
        var x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        if (x < mx) mx = x; if (x > Mx) Mx = x;
        if (y < my) my = y; if (y > My) My = y;
        if (z < mz) mz = z; if (z > Mz) Mz = z;
      }
      if (!isFinite(mx)) { mx = Mx = my = My = mz = Mz = 0; } // chunk was entirely non-finite
      chunkCenters[c * 3] = (mx + Mx) * 0.5;
      chunkCenters[c * 3 + 1] = (my + My) * 0.5;
      chunkCenters[c * 3 + 2] = (mz + Mz) * 0.5;
      chunkRadii[c] = Math.sqrt((Mx - mx) * (Mx - mx) + (My - my) * (My - my) + (Mz - mz) * (Mz - mz)) * 0.5;
    }
  }

  function resort(px, py, pz, dx, dy, dz) {
    var numChunks = chunkCenters.length / 3;

    // Exact min/max signed distance along the view direction, from the whole
    // point cloud's per-chunk bounding spheres (center dot dir +/- radius).
    var minDist = Infinity, maxDist = -Infinity;
    for (var c = 0; c < numChunks; c++) {
      var d = chunkCenters[c * 3] * dx + chunkCenters[c * 3 + 1] * dy + chunkCenters[c * 3 + 2] * dz;
      var r = chunkRadii[c];
      if (d - r < minDist) minDist = d - r;
      if (d + r > maxDist) maxDist = d + r;
    }
    if (!isFinite(minDist) || !isFinite(maxDist)) { minDist = 0; maxDist = 1; }

    var compareBits = Math.max(10, Math.min(20, Math.round(Math.log2(Math.max(1, numVertices / 4)))));
    var bucketCount = Math.pow(2, compareBits) + 1;
    if (!distances || distances.length !== numVertices) distances = new Uint32Array(numVertices);
    if (!countBuffer || countBuffer.length !== bucketCount) countBuffer = new Uint32Array(bucketCount);
    else countBuffer.fill(0);

    var range = maxDist - minDist;
    if (range < 1e-6) {
      for (var z0 = 0; z0 < numVertices; z0++) { distances[z0] = 0; }
      countBuffer[0] = numVertices;
    } else {
      // Coarse pass: how many chunks' bounding spheres overlap each of 32
      // equal-width bins across the full depth range -- a cheap proxy for
      // where splats actually cluster, so the real (per-splat) buckets below
      // can be allocated proportionally instead of uniformly. Verified
      // against PlayCanvas's own SortWorker, same technique.
      for (var bi = 0; bi < NUM_COARSE_BINS; bi++) binCount[bi] = 0;
      for (var c2 = 0; c2 < numChunks; c2++) {
        var dc = chunkCenters[c2 * 3] * dx + chunkCenters[c2 * 3 + 1] * dy + chunkCenters[c2 * 3 + 2] * dz - minDist;
        var rc = chunkRadii[c2];
        var binMin = Math.max(0, Math.floor((dc - rc) * NUM_COARSE_BINS / range));
        var binMax = Math.min(NUM_COARSE_BINS, Math.ceil((dc + rc) * NUM_COARSE_BINS / range));
        for (var bj = binMin; bj < binMax; bj++) binCount[bj]++;
      }
      var binTotal = 0;
      for (var bi2 = 0; bi2 < NUM_COARSE_BINS; bi2++) binTotal += binCount[bi2];
      if (binTotal <= 0) binTotal = 1;
      for (var bi3 = 0; bi3 < NUM_COARSE_BINS; bi3++) {
        binDivider[bi3] = (binCount[bi3] / binTotal * bucketCount) >>> 0;
      }
      for (var bi4 = 0; bi4 < NUM_COARSE_BINS; bi4++) {
        binBase[bi4] = bi4 === 0 ? 0 : binBase[bi4 - 1] + binDivider[bi4 - 1];
      }

      var binRange = range / NUM_COARSE_BINS;
      var ii = 0;
      for (var i2 = 0; i2 < numVertices; i2++) {
        var x = centers[ii++], y = centers[ii++], z = centers[ii++];
        var dd = (x * dx + y * dy + z * dz - minDist) / binRange;
        var bin = dd >>> 0;
        if (bin >= NUM_COARSE_BINS) bin = NUM_COARSE_BINS - 1;
        var divider = binDivider[bin] || 1;
        var sortKey = (binBase[bin] + divider * (dd - bin)) >>> 0;
        if (sortKey >= bucketCount) sortKey = bucketCount - 1;
        distances[i2] = sortKey;
        countBuffer[sortKey]++;
      }
    }

    // Counting sort: prefix-sum the histogram, then place each splat's index
    // into its bucket's slot. Ascending bucket = farthest-first = correct
    // back-to-front order for standard "over" alpha blending (same convention
    // as the main-thread version this replaces).
    for (var k = 1; k < countBuffer.length; k++) countBuffer[k] += countBuffer[k - 1];
    if (!order || order.length !== numVertices) {
      // Reuse a buffer returned via 'release' if one is available (same
      // size -- a pool entry is only ever sized for the current
      // numVertices, cleared on 'init') instead of allocating a new one.
      order = freeOrderBuffers.length ? freeOrderBuffers.pop() : new Uint32Array(numVertices);
    }
    for (var j = numVertices - 1; j >= 0; j--) {
      var bucket = distances[j];
      order[--countBuffer[bucket]] = j;
    }
  }

  function maybeResort() {
    if (!pendingPos || !pendingDir || !centers) return;
    var px = pendingPos.x, py = pendingPos.y, pz = pendingPos.z;
    var dx = pendingDir.x, dy = pendingDir.y, dz = pendingDir.z;
    var eps = 0.001;
    if (isFinite(lastPos.x) &&
        Math.abs(px - lastPos.x) < eps && Math.abs(py - lastPos.y) < eps && Math.abs(pz - lastPos.z) < eps &&
        Math.abs(dx - lastDir.x) < eps && Math.abs(dy - lastDir.y) < eps && Math.abs(dz - lastDir.z) < eps) {
      return;
    }
    lastPos.x = px; lastPos.y = py; lastPos.z = pz;
    lastDir.x = dx; lastDir.y = dy; lastDir.z = dz;

    resort(px, py, pz, dx, dy, dz);

    self.postMessage({ type: 'order', order: order.buffer }, [order.buffer]);
    order = null; // buffer was transferred away; recovered from the pool (or
                   // reallocated) next resort -- see the 'release' handler below
  }

  self.addEventListener('message', function(ev) {
    var d = ev.data || {};
    if (d.type === 'init') {
      centers = new Float32Array(d.centers);
      numVertices = centers.length / 3;
      buildChunks();
      lastPos.x = NaN; // force the next camera update to actually sort
      freeOrderBuffers.length = 0; // old pool entries (if any) are the wrong size now
    } else if (d.type === 'camera') {
      pendingPos = d.position;
      pendingDir = d.direction;
      maybeResort();
    } else if (d.type === 'release') {
      var buf = new Uint32Array(d.buffer);
      if (buf.length === numVertices) freeOrderBuffers.push(buf);
    }
  });
})();
