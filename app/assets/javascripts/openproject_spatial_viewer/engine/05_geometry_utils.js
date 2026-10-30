
  // ---- Small, pure helpers shared across the rest of the engine ----
  // No DOM/THREE-scene dependency beyond plain math (pinQuaternionFromNormal
  // builds a THREE.Quaternion, but only from its own argument -- it doesn't
  // touch the scene/camera/etc.), so these have no reason to live next to
  // any one subsystem in particular.

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Lasso surface-highlight: raycast grid --------------------------------
  // The fill is built by casting a grid of rays (one per sample point inside
  // the lasso's screen polygon) at the model and meshing the hits together.
  // Every vertex of the resulting patch IS a point where a ray actually met a
  // surface, so it can never drift off of it — it literally *is* the nearest
  // surface along each ray, across all visible layers. (An earlier version
  // projected the model's own geometry through a frozen camera matrix and
  // depth-tested it against a cached depth map; that approach kept drifting
  // out of alignment whenever the aspect ratio, camera, or scene changed
  // between selection and render, so it has been replaced outright.)

  // Even-odd point-in-polygon test, polygon implicitly closed (last point
  // pairs with the first via the `j = i++` wrap).
  function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // The pin cone is modeled base-at-origin, tip hanging down along local -Y
  // (see place3DPin/renderExisting3DAnnotations) -- i.e. local +Y is its
  // "away from the surface" direction. Previously the mesh was just left at
  // the identity rotation, which only looks right when the surface normal
  // happens to be world +Y (a floor); on a wall or ceiling the tip pointed
  // straight down instead of into the surface, giving no visual cue of
  // exactly where the pin actually sits. Rotating local +Y onto the real hit
  // normal makes the tip touch the surface (pointing into it, opposite the
  // normal) and the body stick out along the normal, on any surface.
  function pinQuaternionFromNormal(normal) {
    var n = (normal && isFinite(normal.x) && isFinite(normal.y) && isFinite(normal.z))
      ? new THREE.Vector3(normal.x, normal.y, normal.z) : new THREE.Vector3(0, 1, 0);
    if (n.lengthSq() < 1e-10) n.set(0, 1, 0);
    n.normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  }

  // Cap the polygon used for hit-testing so a long freehand stroke (up to
  // 4000 points) never makes the per-sample inside-test expensive.
  function downsamplePolyPx(path, maxPts) {
    if (path.length <= maxPts) return path;
    var out = [], stride = path.length / maxPts;
    for (var i = 0; i < maxPts; i++) out.push(path[Math.floor(i * stride)]);
    return out;
  }

  // Keeps a stored lasso fill grid's JSON compact -- 1e-5 units of precision
  // is far finer than visually meaningful for this viewer's models.
  function round5(n) { return Math.round(n * 1e5) / 1e5; }

  // Two independent triangles per grid cell (a-b-c, b-d-c) rather than
  // requiring all 4 corners: a lasso edge or a small gap in the surface then
  // only loses a sliver instead of the whole cell. `grid` is a flat
  // rows*cols array of {x,y,z}-like points, with a falsy entry wherever
  // there was no hit at that cell. Used by the live fill shown while
  // actively drawing a lasso (built from fresh raycasts every time it's
  // called) -- a saved selection's highlight is the 3D spotlight instead
  // (see _updateSelectionSpotlight), built from the stored ring directly,
  // not this grid.
  function triangulateLassoGrid(grid, rows, cols) {
    var positions = [];
    for (var j = 0; j < rows - 1; j++) {
      for (var k = 0; k < cols - 1; k++) {
        var a = grid[j * cols + k], b = grid[j * cols + k + 1];
        var c = grid[(j + 1) * cols + k], d = grid[(j + 1) * cols + k + 1];
        if (a && b && c) { positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
        if (b && d && c) { positions.push(b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z); }
      }
    }
    return positions;
  }

