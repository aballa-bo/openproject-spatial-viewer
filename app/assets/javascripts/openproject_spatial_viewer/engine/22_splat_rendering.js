  // ---- Point-cloud & true Gaussian-splat rendering -----------------------
  // Turns the positions/colors/covariance decoded in
  // 21_point_cloud_formats.js into actual THREE.js objects: a plain colored
  // THREE.Points cloud (_buildPointCloud/_buildSplatPoints, for sources with
  // no Gaussian training data) or, for real 3DGS data, the per-splat
  // covariance-projection renderers (SplatRenderer/SplatRendererTex) behind
  // _buildTrueSplats -- this plugin's namesake feature.

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
      // Selection highlight (see _updateSelectionSpotlight): this material
      // is unlit (PointsMaterial), so it can't be relit by the real
      // THREE.SpotLight at all -- its falloff is approximated here instead,
      // in world space, same technique as the true-splat shaders
      // (SPLAT_VERTEX_SHADER). Stashing `shader` on the material lets
      // _updateSplatSelectionUniforms find and update these uniforms after
      // compile, the standard pattern for onBeforeCompile-injected uniforms.
      shader.uniforms.uSelCenter = { value: new THREE.Vector3() };
      shader.uniforms.uSelRadius = { value: 0 };
      shader.uniforms.uSelFalloff = { value: 1 };
      shader.uniforms.uSelActive = { value: 0 };
      mat.userData.shader = shader;

      shader.vertexShader = shader.vertexShader.replace(
        'void main() {',
        'varying vec3 vSelWorldPos;\n' +
        'void main() {\n' +
        '\tvSelWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;\n'
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'varying vec3 vSelWorldPos;\n' +
        'uniform vec3 uSelCenter;\n' +
        'uniform float uSelRadius;\n' +
        'uniform float uSelFalloff;\n' +
        'uniform float uSelActive;\n' +
        'void main() {\n' +
        '\tvec2 _splatUv = gl_PointCoord * 2.0 - 1.0;\n' +
        '\tfloat _splatD2 = dot(_splatUv, _splatUv);\n' +
        '\tif (_splatD2 > 1.0) discard;\n' +
        '\tfloat _splatFalloff = exp(-_splatD2 * 4.0);\n' +
        '\tfloat _selFactor = 1.0;\n' +
        '\tif (uSelActive > 0.5) {\n' +
        '\t\tfloat _selD = distance(vSelWorldPos, uSelCenter);\n' +
        '\t\tfloat _selT = clamp((_selD - uSelRadius) / max(uSelFalloff, 0.001), 0.0, 1.0);\n' +
        '\t\t_selFactor = mix(1.0, 0.12, _selT);\n' +
        '\t}\n'
      ).replace(
        '#include <dithering_fragment>',
        'gl_FragColor.a *= _splatFalloff;\n\tgl_FragColor.rgb *= _selFactor;\n\t#include <dithering_fragment>'
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

  // Shared by SPLAT_VERTEX_SHADER and SPLAT_VERTEX_SHADER_TEX: once each has
  // its own center/covA/covB/colorOpacity/sh1-8 in scope (as per-instance
  // attributes there, as a texture2D lookup here), the rest -- covariance
  // projection into a 2D screen-space ellipse, the SH view-dependent color
  // evaluation, and the selection-highlight dimming -- is identical, so it
  // lives here once instead of being kept in sync by hand across two
  // 70-line copies.
  var SPLAT_VERTEX_MAIN_BODY = [
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
    // Selection highlight (see _updateSelectionSpotlight): splat color is
    // baked-in SH, never relit by a real THREE.Light, so the spotlight's
    // own falloff is approximated here by hand instead -- same center/
    // radius/margin, computed once per splat in world space.
    '  float selFactor = 1.0;',
    '  if (uSelActive > 0.5) {',
    '    float selD = distance(worldCenter, uSelCenter);',
    '    float selT = clamp((selD - uSelRadius) / max(uSelFalloff, 0.001), 0.0, 1.0);',
    '    selFactor = mix(1.0, 0.12, selT);',
    '  }',
    '  col *= selFactor;',
    '  vColor = vec4(clamp(col, 0.0, 1.0), colorOpacity.a);',
    '  vPos = corner * 3.0;', // corner in {-1..1} along each ellipse axis -> *3 = "how many sigma", since r1/r2 above already encode the 3-sigma extent
    '}'
  ];

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
    'uniform vec3 uSelCenter;',
    'uniform float uSelRadius;',
    'uniform float uSelFalloff;',
    'uniform float uSelActive;',
    'varying vec4 vColor;',
    'varying vec2 vPos;',
    'void main() {'
  ].concat(SPLAT_VERTEX_MAIN_BODY).join('\n');

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
        linearColor: { value: colorSpaceLinear ? 1.0 : 0.0 },
        uSelCenter: { value: new THREE.Vector3() },
        uSelRadius: { value: 0 },
        uSelFalloff: { value: 1 },
        uSelActive: { value: 0 }
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

  // Shares SPLAT_VERTEX_MAIN_BODY with SPLAT_VERTEX_SHADER (see its own
  // comment) -- the only difference between the two is how
  // center/covA/covB/colorOpacity/sh1-8 are obtained: a texture2D lookup
  // per splat here instead of a per-instance attribute there.
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
    // Selection highlight (see _updateSelectionSpotlight) -- same as
    // SPLAT_VERTEX_SHADER's own copy of this block.
    'uniform vec3 uSelCenter;',
    'uniform float uSelRadius;',
    'uniform float uSelFalloff;',
    'uniform float uSelActive;',
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
    '  vec3 sh8 = texture2D(texSH8, suv).xyz;'
  ].concat(SPLAT_VERTEX_MAIN_BODY).join('\n');

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
        uSelCenter: { value: new THREE.Vector3() },
        uSelRadius: { value: 0 },
        uSelFalloff: { value: 1 },
        uSelActive: { value: 0 },
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

