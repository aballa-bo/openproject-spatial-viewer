#!/usr/bin/env python3
"""
transform_gaussians.py - apply a CloudCompare rigid transformation matrix to a
Gaussian Splatting file (.ply or .sog), keeping colours and opacity intact.

Why not just "Save as PLY" in CloudCompare?
  CloudCompare treats a Gaussian PLY as a plain point cloud: it moves the
  points but drops the splat properties (f_dc_*, f_rest_*, opacity, scale_*,
  rot_*), which is why the splat comes back grey. Even if it kept them, a
  rotation would also have to rotate every Gaussian's orientation and its
  spherical-harmonics (view-dependent colour). This script does all of it:

    position        p'  = s * R * p + t
    orientation     q'  = q(R) * q                    (rot_0..3, order w x y z)
    size            log(scale)' = log(scale) + log(s) (scale_0..2 are stored in log)
    colour (SH)     DC (f_dc_*) is rotation invariant; the view-dependent
                    bands f_rest_* (degree 1-3) are rotated with the matching
                    real-SH rotation matrices.
    opacity         unchanged

Usage
  GUI (pick the file, paste the matrix):
      python transform_gaussians.py

  Command line:
      python transform_gaussians.py scan.ply --matrix-file matrix.txt -o scan_aligned.ply
      python transform_gaussians.py scan.sog --matrix "0.99 -0.01 0 12.3  0.01 0.99 0 -4.1  0 0 1 0.5  0 0 0 1"

  The matrix is the 4x4 text CloudCompare shows/saves after an alignment
  (Edit > Apply transformation, or the console after ICP / point-pair
  alignment). Paste it as is; 4 lines of 4 numbers.

Requirements
  Python 3.8+, numpy.  Pillow is needed only for .sog files.
      pip install numpy pillow
  The GUI uses tkinter (bundled with the standard Python installers).
"""
import argparse
import io
import json
import math
import os
import re
import struct
import sys
import zipfile

try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.stderr.write("This tool needs numpy:  pip install numpy\n")
    raise SystemExit(1)

# ---------------------------------------------------------------------------
# Matrix parsing / decomposition
# ---------------------------------------------------------------------------

_NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def parse_matrix(text):
    """Extract a 4x4 matrix from pasted text (CloudCompare format or similar).

    Accepts 16 numbers (4x4) or 12 numbers (3x4, last row implied).
    Anything that is not a number (labels, brackets, commas) is ignored.
    """
    vals = [float(v) for v in _NUM.findall(text)]
    if len(vals) == 12:
        vals += [0.0, 0.0, 0.0, 1.0]
    if len(vals) != 16:
        raise ValueError(
            "Expected 16 numbers (a 4x4 matrix), found %d. Paste the 4 rows "
            "exactly as CloudCompare prints them." % len(vals))
    m = np.array(vals, dtype=np.float64).reshape(4, 4)
    if not np.allclose(m[3], [0, 0, 0, 1], atol=1e-9):
        raise ValueError("The last row of the matrix must be 0 0 0 1 "
                         "(got %s). Is the matrix transposed?" % m[3])
    return m


def decompose(m, tol=1e-3):
    """Split the matrix into (R, s, t): rotation, uniform scale, translation."""
    a = m[:3, :3]
    det = np.linalg.det(a)
    if det <= 0:
        raise ValueError("The matrix contains a reflection (determinant %.4f <= 0); "
                         "it cannot be applied to Gaussians." % det)
    s = det ** (1.0 / 3.0)
    r = a / s
    err = np.abs(r.T @ r - np.eye(3)).max()
    if err > tol:
        raise ValueError(
            "The matrix is not a rotation + uniform scale + translation "
            "(non-uniform scale or shear detected, orthogonality error %.4g)." % err)
    # clean numerical noise: project onto the closest rotation
    u, _, vt = np.linalg.svd(r)
    r = u @ vt
    return r, s, m[:3, 3].copy()


def describe(m):
    r, s, t = decompose(m)
    ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2))))
    return ("scale %.6f | rotation %.4f deg | translation (%.4f, %.4f, %.4f)"
            % (s, ang, t[0], t[1], t[2]))


# ---------------------------------------------------------------------------
# Quaternions (w, x, y, z)
# ---------------------------------------------------------------------------

def mat_to_quat(r):
    t = np.trace(r)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [0.25 * s, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s]
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        q = [(r[2, 1] - r[1, 2]) / s, 0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s]
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        q = [(r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        q = [(r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s]
    q = np.array(q, dtype=np.float64)
    return q / np.linalg.norm(q)


def quat_mul_left(qa, q):
    """qa (4,) times every quaternion in q (N,4); both w,x,y,z."""
    w1, x1, y1, z1 = qa
    w2, x2, y2, z2 = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    out = np.empty_like(q)
    out[:, 0] = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2
    out[:, 1] = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2
    out[:, 2] = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2
    out[:, 3] = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2
    return out


# ---------------------------------------------------------------------------
# Spherical harmonics rotation (3DGS convention, degrees 1..3)
# ---------------------------------------------------------------------------

_C1 = 0.4886025119029199
_C2 = (1.0925484305920792, -1.0925484305920792, 0.31539156525252005,
       -1.0925484305920792, 0.5462742152960396)
_C3 = (-0.5900435899266435, 2.890611442640554, -0.4570457994644658,
       0.3731763325901154, -0.4570457994644658, 1.445305721320277,
       -0.5900435899266435)


def _sh_basis(d, band):
    """Real SH basis of one band (1..3) at unit directions d (n,3), exactly as in
    the reference 3DGS rasteriser (same sign conventions). Returns (n, 2*band+1)."""
    x, y, z = d[:, 0], d[:, 1], d[:, 2]
    xx, yy, zz = x * x, y * y, z * z
    if band == 1:
        return np.stack([-_C1 * y, _C1 * z, -_C1 * x], axis=1)
    if band == 2:
        return np.stack([_C2[0] * x * y, _C2[1] * y * z, _C2[2] * (2 * zz - xx - yy),
                         _C2[3] * x * z, _C2[4] * (xx - yy)], axis=1)
    return np.stack([_C3[0] * y * (3 * xx - yy), _C3[1] * x * y * z,
                     _C3[2] * y * (4 * zz - xx - yy), _C3[3] * z * (2 * zz - 3 * xx - 3 * yy),
                     _C3[4] * x * (4 * zz - xx - yy), _C3[5] * z * (xx - yy),
                     _C3[6] * x * (xx - 3 * yy)], axis=1)


def sh_rotation_matrices(r, bands):
    """For each band l, the matrix D_l such that
         Y_l(R^T d) = Y_l(d) @ D_l^T     (rows: samples)
    and therefore the new coefficients are  c' = c @ D_l .
    Fitted numerically on random directions with the very basis the renderer
    uses, so conventions can't get out of sync."""
    rng = np.random.RandomState(12345)
    d = rng.normal(size=(256, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    d_old = d @ r  # (R^T d) for row vectors
    mats = []
    for band in range(1, bands + 1):
        b = _sh_basis(d, band)
        c = _sh_basis(d_old, band)
        dt, *_ = np.linalg.lstsq(b, c, rcond=None)   # b @ dt = c  ->  dt = D^T
        mats.append(dt.T)
    return mats


def rotate_sh(coefs, r):
    """coefs: (N, K, 3) in 3DGS order (K = 3, 8 or 15; axis 2 = R,G,B).
    Returns rotated copy."""
    k = coefs.shape[1]
    bands = {3: 1, 8: 2, 15: 3}.get(k)
    if bands is None:
        raise ValueError("Unsupported number of SH coefficients per channel: %d" % k)
    mats = sh_rotation_matrices(r, bands)
    out = np.empty_like(coefs)
    off = 0
    for band, dmat in enumerate(mats, start=1):
        n = 2 * band + 1
        blk = coefs[:, off:off + n, :]                 # (N, n, 3)
        out[:, off:off + n, :] = np.einsum('nkc,kj->njc', blk, dmat)
        off += n
    return out


# ---------------------------------------------------------------------------
# PLY (INRIA 3DGS layout)
# ---------------------------------------------------------------------------

_PLY_TYPES = {
    'char': 'i1', 'int8': 'i1', 'uchar': 'u1', 'uint8': 'u1',
    'short': '<i2', 'int16': '<i2', 'ushort': '<u2', 'uint16': '<u2',
    'int': '<i4', 'int32': '<i4', 'uint': '<u4', 'uint32': '<u4',
    'float': '<f4', 'float32': '<f4', 'double': '<f8', 'float64': '<f8',
}


def read_ply(path):
    with open(path, 'rb') as f:
        head = b''
        while True:
            line = f.readline()
            if not line:
                raise ValueError("Not a valid PLY file (no end_header).")
            head += line
            if line.strip() == b'end_header':
                break
        body_start = f.tell()
        text = head.decode('latin1').splitlines()
        if text[0].strip() != 'ply':
            raise ValueError("Not a PLY file.")
        fmt = None
        elements = []   # [name, count, [(propname, dtype)]]
        for ln in text[1:]:
            tok = ln.split()
            if not tok:
                continue
            if tok[0] == 'format':
                fmt = tok[1]
            elif tok[0] == 'element':
                elements.append([tok[1], int(tok[2]), []])
            elif tok[0] == 'property':
                if tok[1] == 'list':
                    raise ValueError("PLY lists are not supported in a Gaussian file.")
                if tok[1] not in _PLY_TYPES:
                    raise ValueError("Unknown PLY type '%s'." % tok[1])
                elements[-1][2].append((tok[2], _PLY_TYPES[tok[1]]))
        if fmt != 'binary_little_endian':
            raise ValueError("Only binary_little_endian PLY files are supported (found '%s')." % fmt)
        if not elements or elements[0][0] != 'vertex':
            raise ValueError("The first PLY element must be 'vertex'.")
        name, count, props = elements[0]
        names = [p[0] for p in props]
        if 'f_dc_0' not in names or 'rot_0' not in names or 'scale_0' not in names:
            if 'x' in names and 'chunk' in [e[0] for e in elements]:
                raise ValueError("This looks like a *compressed* PLY. Decompress it first "
                                 "(e.g. with PlayCanvas 'splat-transform' or SuperSplat).")
            raise ValueError("This PLY is not a Gaussian Splatting file (no f_dc_*, scale_*, "
                             "rot_* properties). It looks like a plain point cloud.")
        dt = np.dtype([(n, t) for n, t in props])
        f.seek(body_start)
        data = np.fromfile(f, dtype=dt, count=count)
        if data.shape[0] != count:
            raise ValueError("PLY file is truncated.")
        tail = f.read()
    return head, data, tail, elements


def write_ply(path, head, data, tail):
    with open(path, 'wb') as f:
        f.write(head)
        data.tofile(f)
        f.write(tail)


def transform_ply(inp, out, r, s, t, log):
    head, data, tail, _ = read_ply(inp)
    n = data.shape[0]
    log("PLY: %d Gaussians" % n)

    pos = np.stack([data['x'], data['y'], data['z']], axis=1).astype(np.float64)
    pos = (pos @ r.T) * s + t
    if np.abs(pos).max() > 2e5:
        log("WARNING: coordinates are now up to %.3g. PLY stores float32, so precision is "
            "only ~%.3g units there. Consider georeferencing with a smaller offset."
            % (np.abs(pos).max(), np.abs(pos).max() * 6e-8))
    for i, ax in enumerate('xyz'):
        data[ax] = pos[:, i]

    q = np.stack([data['rot_%d' % i] for i in range(4)], axis=1).astype(np.float64)
    nrm = np.linalg.norm(q, axis=1, keepdims=True)
    nrm[nrm == 0] = 1
    q = quat_mul_left(mat_to_quat(r), q / nrm)
    for i in range(4):
        data['rot_%d' % i] = q[:, i]

    if abs(s - 1.0) > 1e-9:
        ls = math.log(s)
        for i in range(3):
            data['scale_%d' % i] = data['scale_%d' % i] + ls

    names = data.dtype.names
    if 'nx' in names:  # normals, if present
        nrm_v = np.stack([data['nx'], data['ny'], data['nz']], axis=1).astype(np.float64) @ r.T
        for i, ax in enumerate(('nx', 'ny', 'nz')):
            data[ax] = nrm_v[:, i]

    rest = sorted((n_ for n_ in names if n_.startswith('f_rest_')),
                  key=lambda x: int(x.split('_')[2]))
    if rest:
        if len(rest) % 3:
            raise ValueError("f_rest_* count (%d) is not a multiple of 3." % len(rest))
        k = len(rest) // 3
        # INRIA layout: channel-major -> f_rest[ch*K + c]
        arr = np.empty((n, k, 3), dtype=np.float64)
        for ch in range(3):
            for c in range(k):
                arr[:, c, ch] = data[rest[ch * k + c]]
        arr = rotate_sh(arr, r)
        for ch in range(3):
            for c in range(k):
                data[rest[ch * k + c]] = arr[:, c, ch]
        log("Rotated %d spherical-harmonic coefficients per channel." % k)
    write_ply(out, head, data, tail)
    log("Saved " + out)


# ---------------------------------------------------------------------------
# SOG (PlayCanvas "Spatially Ordered Gaussians", zip of meta.json + WebP)
# ---------------------------------------------------------------------------

def _need_pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        raise RuntimeError(".sog support needs Pillow:  pip install pillow")


def _read_img(Image, blob):
    im = Image.open(io.BytesIO(blob))
    im.load()
    a = np.asarray(im.convert('RGBA'))
    return a.copy()


def _write_img(Image, arr):
    buf = io.BytesIO()
    # exact=True keeps RGB values of fully transparent pixels (SOG relies on that)
    Image.fromarray(arr, 'RGBA').save(buf, format='WEBP', lossless=True, exact=True, quality=100, method=4)
    return buf.getvalue()


def _unlog(v):
    return np.sign(v) * np.expm1(np.abs(v))


def _log(p):
    return np.sign(p) * np.log1p(np.abs(p))


def _nearest_sorted(cb, vals):
    """Index of the nearest entry of the sorted codebook cb for every value."""
    pos = np.searchsorted(cb, vals).clip(1, len(cb) - 1)
    lo, hi = cb[pos - 1], cb[pos]
    return np.where(np.abs(vals - lo) <= np.abs(hi - vals), pos - 1, pos)


def _kmeans_codebook(vals, size, rounds=12):
    """Sorted 1-D codebook of `size` entries minimising the quantisation error."""
    cb = np.quantile(vals, (np.arange(size) + 0.5) / size)
    cb[0], cb[-1] = vals.min(), vals.max()
    for _ in range(rounds):
        cb = np.sort(cb)
        idx = _nearest_sorted(cb, vals)
        sums = np.bincount(idx, weights=vals, minlength=size)
        cnt = np.bincount(idx, minlength=size)
        cb = np.where(cnt > 0, sums / np.maximum(cnt, 1), cb)
    return np.sort(cb)



def transform_sog(inp, out, r, s, t, log):
    Image = _need_pil()
    with zipfile.ZipFile(inp) as zin:
        files = {i.filename: zin.read(i) for i in zin.infolist() if not i.is_dir()}
    meta_name = next((n for n in files if n.split('/')[-1].lower() == 'meta.json'), None)
    if not meta_name:
        raise ValueError(".sog archive has no meta.json")
    meta = json.loads(files[meta_name].decode('utf-8'))
    count = int(meta['count'])
    dirp = meta_name[:meta_name.rfind('/') + 1] if '/' in meta_name else ''

    def key(name):
        for n in files:
            if n == dirp + name or n.split('/')[-1] == name:
                return n
        raise ValueError(".sog archive is missing '%s'" % name)

    def img(name):
        return _read_img(Image, files[key(name)])

    log("SOG: %d Gaussians" % count)

    # ---- positions
    l_img, u_img = img(meta['means']['files'][0]), img(meta['means']['files'][1])
    shape = l_img.shape
    l = l_img.reshape(-1, 4)[:count].astype(np.int64)
    u = u_img.reshape(-1, 4)[:count].astype(np.int64)
    q16 = (u[:, :3] << 8) | l[:, :3]
    mins = np.array(meta['means']['mins'], dtype=np.float64)
    maxs = np.array(meta['means']['maxs'], dtype=np.float64)
    pos = _unlog(mins + (maxs - mins) * (q16 / 65535.0))
    pos = (pos @ r.T) * s + t
    v = _log(pos)
    nmin, nmax = v.min(axis=0), v.max(axis=0)
    span = np.where(nmax - nmin > 0, nmax - nmin, 1.0)
    nq = np.clip(np.rint((v - nmin) / span * 65535.0), 0, 65535).astype(np.int64)
    nl = np.full(l_img.reshape(-1, 4).shape, 255, dtype=np.uint8)
    nu = np.full(u_img.reshape(-1, 4).shape, 255, dtype=np.uint8)
    nl[:count, :3] = nq & 255
    nu[:count, :3] = nq >> 8
    # rows beyond `count` (texture padding) keep their original bytes
    nl[count:] = l_img.reshape(-1, 4)[count:]
    nu[count:] = u_img.reshape(-1, 4)[count:]
    new_files = {
        key(meta['means']['files'][0]): _write_img(Image, nl.reshape(shape)),
        key(meta['means']['files'][1]): _write_img(Image, nu.reshape(shape)),
    }
    meta['means']['mins'] = [float(x) for x in nmin]
    meta['means']['maxs'] = [float(x) for x in nmax]

    # ---- orientation
    qimg = img(meta['quats']['files'][0])
    qshape = qimg.shape
    qt = qimg.reshape(-1, 4)[:count]
    abc = (qt[:, :3].astype(np.float64) / 255.0 - 0.5) * 2.0 / math.sqrt(2.0)
    mode = qt[:, 3].astype(np.int64) - 252
    d = np.sqrt(np.maximum(0.0, 1.0 - (abc ** 2).sum(axis=1)))
    quat = np.empty((count, 4))
    for m_, cols in enumerate(([1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2])):
        sel = mode == m_
        quat[sel, m_] = d[sel]
        for j, c in enumerate(cols):
            quat[sel, c] = abc[sel, j]
    quat = quat_mul_left(mat_to_quat(r), quat)
    quat /= np.linalg.norm(quat, axis=1, keepdims=True)
    big = np.abs(quat).argmax(axis=1)
    sign = np.sign(quat[np.arange(count), big])
    sign[sign == 0] = 1
    quat *= sign[:, None]                      # largest component positive
    nq_img = qimg.reshape(-1, 4).copy()
    for m_, cols in enumerate(([1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2])):
        sel = big == m_
        for j, c in enumerate(cols):
            nq_img[:count][sel, j] = np.clip(
                np.rint((quat[sel, c] * math.sqrt(2.0) * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)
        nq_img[:count][sel, 3] = 252 + m_
    new_files[key(meta['quats']['files'][0])] = _write_img(Image, nq_img.reshape(qshape))

    # ---- size: codebook entries are log(scale)
    if abs(s - 1.0) > 1e-9:
        meta['scales']['codebook'] = [float(c) + math.log(s) for c in meta['scales']['codebook']]

    # ---- view-dependent colour (optional)
    shn = meta.get('shN')
    if shn and shn.get('files') and len(shn['files']) >= 2 and shn.get('bands', 0) >= 1:
        k = {1: 3, 2: 8, 3: 15}[int(shn['bands'])]
        cimg = img(shn['files'][0])
        cshape = cimg.shape
        cb = np.array(shn['codebook'], dtype=np.float64)
        width = cshape[1]
        rows = cshape[0]
        # palette entry p lives at row p//64, columns (p%64)*k .. +k  (see viewer parseSOG)
        npal = rows * (width // k)
        flat = cimg.reshape(rows, width // k, k, 4)           # (row, palette-in-row, coeff, rgba)
        vals = cb[flat[:, :, :, :3]]                          # (row, pal, k, 3)
        pal = vals.reshape(npal, k, 3)
        pal = rotate_sh(pal, r)
        # re-quantise: 256-entry codebook fitted with a few 1-D k-means rounds
        flatv = pal.ravel()
        cb2 = _kmeans_codebook(flatv, len(cb))
        idx = _nearest_sorted(cb2, flatv)
        out_px = np.full(cimg.shape, 255, dtype=np.uint8).reshape(rows, width // k, k, 4)
        out_px[:, :, :, :3] = idx.reshape(rows, width // k, k, 3).astype(np.uint8)
        new_files[key(shn['files'][0])] = _write_img(Image, out_px.reshape(cshape))
        shn['codebook'] = [float(c) for c in cb2]
        log("Rotated %d spherical-harmonic coefficients per channel." % k)

    # ---- write
    new_files[meta_name] = json.dumps(meta).encode('utf-8')
    with zipfile.ZipFile(out, 'w') as zout:
        for name, blob in files.items():
            blob = new_files.get(name, blob)
            comp = zipfile.ZIP_DEFLATED if name.endswith('.json') else zipfile.ZIP_STORED
            zout.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), blob, compress_type=comp)
    log("Saved " + out)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

# The Spatial Viewer flips every splat by diag(1,-1,-1) (180 deg about X) when it
# loads it, because 3DGS training pipelines usually have +Y pointing down. Meshes
# and point clouds are not flipped. A splat whose matrix was computed against a
# mesh/point cloud in the *same raw frame* therefore needs that flip cancelled:
# file' = F * M * file, so that viewer(file') = F * file' = M * file.
VIEWER_FLIP = np.diag([1.0, -1.0, -1.0])


def run(inp, out, matrix, invert=False, log=print, viewer_flip=True):
    r, s, t = decompose(matrix)
    if invert:
        r_i = r.T
        s_i = 1.0 / s
        t = -(s_i * (r_i @ t))
        r, s = r_i, s_i
    if viewer_flip:
        r = VIEWER_FLIP @ r
        t = VIEWER_FLIP @ t
        log("Compensating the Spatial Viewer's Y/Z flip of splats.")
    log("Applying: " + ("(inverse) " if invert else "") +
        "scale %.6f, translation (%.4f, %.4f, %.4f)" % (s, t[0], t[1], t[2]))
    ext = os.path.splitext(inp)[1].lower()
    if ext == '.ply':
        transform_ply(inp, out, r, s, t, log)
    elif ext == '.sog':
        transform_sog(inp, out, r, s, t, log)
    else:
        raise ValueError("Unsupported input '%s' (use .ply or .sog)." % ext)


def default_output(inp):
    base, ext = os.path.splitext(inp)
    return base + '_aligned' + ext


def gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, scrolledtext

    root = tk.Tk()
    root.title("Transform Gaussian Splatting (CloudCompare matrix)")
    root.geometry("720x640")
    st = {'inp': tk.StringVar(), 'out': tk.StringVar(), 'inv': tk.BooleanVar(value=False),
          'flip': tk.BooleanVar(value=True)}

    def row(label, var, cmd):
        f = tk.Frame(root)
        f.pack(fill='x', padx=10, pady=4)
        tk.Label(f, text=label, width=14, anchor='w').pack(side='left')
        tk.Entry(f, textvariable=var).pack(side='left', fill='x', expand=True)
        tk.Button(f, text="Browse...", command=cmd).pack(side='left', padx=4)

    def pick_in():
        p = filedialog.askopenfilename(title="Gaussian splat file",
                                       filetypes=[("Gaussian splats", "*.ply *.sog"), ("All files", "*.*")])
        if p:
            st['inp'].set(p)
            if not st['out'].get():
                st['out'].set(default_output(p))

    def pick_out():
        ext = os.path.splitext(st['inp'].get())[1] or '.ply'
        p = filedialog.asksaveasfilename(title="Save as", defaultextension=ext,
                                         initialfile=os.path.basename(st['out'].get()))
        if p:
            st['out'].set(p)

    row("Input (.ply/.sog)", st['inp'], pick_in)
    row("Output", st['out'], pick_out)

    tk.Label(root, anchor='w', text="Paste the 4x4 matrix from CloudCompare:").pack(fill='x', padx=10)
    mtx = scrolledtext.ScrolledText(root, height=7, font=('Courier', 10))
    mtx.pack(fill='x', padx=10, pady=4)
    info = tk.Label(root, anchor='w', fg='#555', text="", justify='left')
    info.pack(fill='x', padx=10)

    def refresh(*_):
        txt = mtx.get('1.0', 'end').strip()
        if not txt:
            info.config(text="", fg='#555')
            return
        try:
            info.config(text="OK: " + describe(parse_matrix(txt)), fg='#117733')
        except Exception as e:
            info.config(text=str(e), fg='#aa2222')

    mtx.bind('<KeyRelease>', refresh)
    mtx.bind('<<Paste>>', lambda e: root.after(50, refresh))
    tk.Checkbutton(root, text="Apply the inverse matrix", variable=st['inv']).pack(anchor='w', padx=10)
    tk.Checkbutton(root, text="Compensate the Spatial Viewer's Y/Z flip of splats "
                              "(keep ON for files uploaded there)",
                   variable=st['flip']).pack(anchor='w', padx=10)

    logbox = scrolledtext.ScrolledText(root, height=10, state='disabled', font=('Courier', 9))

    def log(msg):
        logbox.config(state='normal')
        logbox.insert('end', msg + '\n')
        logbox.see('end')
        logbox.config(state='disabled')
        root.update_idletasks()

    def go():
        try:
            inp, out = st['inp'].get().strip(), st['out'].get().strip()
            if not inp or not os.path.isfile(inp):
                raise ValueError("Choose an existing input file.")
            if not out:
                out = default_output(inp)
                st['out'].set(out)
            if os.path.abspath(inp) == os.path.abspath(out):
                raise ValueError("Output must be a different file from the input.")
            run(inp, out, parse_matrix(mtx.get('1.0', 'end')), st['inv'].get(), log, st['flip'].get())
            messagebox.showinfo("Done", "Saved:\n" + out)
        except Exception as e:
            log("ERROR: %s" % e)
            messagebox.showerror("Error", str(e))

    tk.Button(root, text="Apply transformation", command=go, height=2).pack(fill='x', padx=10, pady=8)
    logbox.pack(fill='both', expand=True, padx=10, pady=(0, 10))
    root.mainloop()


def interactive_cli():
    """Fallback when tkinter is not available: ask on the terminal."""
    inp = input("Gaussian file (.ply / .sog): ").strip().strip('"')
    print("Paste the 4x4 matrix from CloudCompare, then an empty line:")
    lines = []
    while True:
        ln = sys.stdin.readline()
        if not ln or not ln.strip():
            if lines:
                break
            continue
        lines.append(ln)
    m = parse_matrix(''.join(lines))
    print(describe(m))
    out = input("Output file [%s]: " % default_output(inp)).strip().strip('"') or default_output(inp)
    run(inp, out, m)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Apply a CloudCompare 4x4 transformation to a Gaussian Splatting .ply/.sog file.")
    ap.add_argument('input', nargs='?', help="input .ply or .sog (omit to open the GUI)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--matrix', help="the 4x4 matrix as text (16 numbers)")
    g.add_argument('--matrix-file', help="text file containing the 4x4 matrix")
    ap.add_argument('-o', '--output', help="output file (default: <input>_aligned.<ext>)")
    ap.add_argument('--invert', action='store_true', help="apply the inverse of the matrix")
    ap.add_argument('--no-viewer-flip', action='store_true',
                    help="do not compensate the Spatial Viewer's diag(1,-1,-1) flip of splats "
                         "(use this if the output is for another viewer)")
    a = ap.parse_args(argv)

    if not a.input:
        try:
            import tkinter  # noqa: F401
        except ImportError:
            return interactive_cli()
        return gui()

    if a.matrix_file:
        with open(a.matrix_file, 'r') as f:
            text = f.read()
    elif a.matrix:
        text = a.matrix
    else:
        print("Paste the 4x4 matrix, then Ctrl-D (Ctrl-Z + Enter on Windows):")
        text = sys.stdin.read()
    out = a.output or default_output(a.input)
    if os.path.abspath(out) == os.path.abspath(a.input):
        ap.error("output must differ from input")
    try:
        m = parse_matrix(text)
        print(describe(m))
        run(a.input, out, m, a.invert, viewer_flip=not a.no_viewer_flip)
    except Exception as e:
        sys.stderr.write("ERROR: %s\n" % e)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
