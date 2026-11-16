#!/usr/bin/env python3
"""Apply a CloudCompare rotation/translation matrix to an IFC file.

Pure Python (standard library only). Run without arguments: a small window
asks for the IFC file and the pasted 4x4 matrix (terminal prompts if tkinter
is not available).

How it works: the IFC is plain STEP text. Every object hangs from a root
IfcLocalPlacement (PlacementRelTo = $, usually the IfcSite). Only those root
placements are rewritten as  new = M * old,  so the whole model moves rigidly
and the geometry itself is untouched. The file is otherwise copied byte for
byte.

Matrix convention: CloudCompare's, column vectors, p' = M p, in metres.
The translation is converted to the file's length unit (mm, m, ...).
A uniform scale cannot be stored in IFC placements, so it is applied by
redefining the project's length unit (1 unit = scale x the old one), which
rescales the whole model; the translation is converted accordingly.

CLI:
  transform_ifc.py model.ifc --matrix "<pasted text>" [-o out.ifc] [--invert]
  transform_ifc.py model.ifc --matrix-file m.txt
"""
import argparse
import math
import os
import re
import sys

_NUM = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
_ENT = re.compile(
    r'^[ \t]*#(\d+)[ \t]*=[ \t]*(IFCLOCALPLACEMENT|IFCAXIS2PLACEMENT3D|'
    r'IFCCARTESIANPOINT|IFCDIRECTION|IFCSIUNIT|IFCCONVERSIONBASEDUNIT)[ \t]*\((.*?)\)[ \t]*;',
    re.I | re.M | re.S)
_PREFIX = {'EXA': 1e18, 'PETA': 1e15, 'TERA': 1e12, 'GIGA': 1e9, 'MEGA': 1e6,
           'KILO': 1e3, 'HECTO': 1e2, 'DECA': 10.0, 'DECI': 0.1,
           'CENTI': 1e-2, 'MILLI': 1e-3, 'MICRO': 1e-6, 'NANO': 1e-9}


# ---------- small 3x3 / vector helpers ----------
def mm(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)]
            for i in range(3)]


def mv(a, v):
    return [sum(a[i][k] * v[k] for k in range(3)) for i in range(3)]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def norm(v):
    n = math.sqrt(dot(v, v))
    return [x / n for x in v]


def det3(a):
    return dot(a[0], cross(a[1], a[2]))


def invert_rigid(m):
    r = [[m[j][i] for j in range(3)] for i in range(3)]
    t = [-sum(r[i][k] * m[k][3] for k in range(3)) for i in range(3)]
    return [r[0] + [t[0]], r[1] + [t[1]], r[2] + [t[2]], [0, 0, 0, 1]]


def parse_matrix(text):
    vals = [float(v) for v in _NUM.findall(text)]
    if len(vals) == 12:
        vals += [0, 0, 0, 1]
    if len(vals) != 16:
        raise ValueError("Expected 16 numbers (a 4x4 matrix), found %d. Paste "
                         "the 4 rows as CloudCompare prints them." % len(vals))
    m = [vals[i * 4:i * 4 + 4] for i in range(4)]
    if any(abs(a - b) > 1e-9 for a, b in zip(m[3], [0, 0, 0, 1])):
        raise ValueError("Last row must be 0 0 0 1 (got %s). Transposed?" % m[3])
    return m


def decompose(m):
    """Split into (R, s, t): rotation, uniform scale, translation (metres)."""
    a = [row[:3] for row in m[:3]]
    det = det3(a)
    if det <= 0:
        raise ValueError("The matrix contains a reflection (det <= 0).")
    s = det ** (1.0 / 3)
    r = [[x / s for x in row] for row in a]
    rt = [[r[j][i] for j in range(3)] for i in range(3)]
    err = max(abs(v - (1.0 if i == j else 0.0))
              for i, row in enumerate(mm(r, rt)) for j, v in enumerate(row))
    if err > 1e-4:
        raise ValueError("The 3x3 part is not a rotation times a uniform "
                         "scale (error %.2g)." % err)
    return r, s, [m[i][3] for i in range(3)]


# ---------- IFC handling ----------
def _nums(s):
    return [float(v) for v in _NUM.findall(s)]


def _ref(s):
    s = s.strip()
    return int(s[1:]) if s.startswith('#') else None


def length_unit_in_metres(text):
    for m in _ENT.finditer(text):
        if m.group(2).upper() != 'IFCSIUNIT':
            continue
        a = m.group(3).upper()
        if '.LENGTHUNIT.' in a and '.METRE.' in a:
            for k, v in _PREFIX.items():
                if '.%s.' % k in a:
                    return v
            return 1.0
    return 1.0


def _scale_unit(text, ents, sc, next_id):
    """Point IFCUNITASSIGNMENT's length unit at a conversion-based unit of
    `sc` times the original SI length unit. Returns (text, new entity lines)."""
    m = re.search(r'(IFCUNITASSIGNMENT\s*\(\()(.*?)(\)\)\s*;)', text, re.I | re.S)
    if not m:
        raise ValueError("No IFCUNITASSIGNMENT found: cannot apply a scale.")
    refs = re.findall(r'#(\d+)', m.group(2))
    si = [int(r) for r in refs if int(r) in ents and ents[int(r)][0] == 'IFCSIUNIT'
          and '.LENGTHUNIT.' in ents[int(r)][1].upper()]
    if not si:
        raise ValueError("The file's length unit is not a plain SI unit "
                         "(e.g. it uses inches): cannot apply a scale.")
    d, mw, cu = next_id, next_id + 1, next_id + 2
    body = re.sub(r'#%d\b' % si[0], '#%d' % cu, m.group(2))
    text = text[:m.start()] + m.group(1) + body + m.group(3) + text[m.end():]
    return text, [
        "#%d=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);" % d,
        "#%d=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(%r),#%d);" % (mw, float(sc), si[0]),
        "#%d=IFCCONVERSIONBASEDUNIT(#%d,.LENGTHUNIT.,'SCALED',#%d);" % (cu, d, mw)]


def transform_ifc(inp, out, matrix, invert=False, log=print, yup=False):
    r, sc, t = decompose(matrix)
    if invert:
        rt = [[r[j][i] for j in range(3)] for i in range(3)]
        t = [-v / sc for v in mv(rt, t)]
        r, sc = rt, 1.0 / sc
    if yup:
        # The matrix was computed on a Y-up export of the model (glTF/GLB,
        # IfcConvert...): (x, y, z)_ifc -> (x, z, -y). Conjugate it back into
        # the IFC's own Z-up frame: R' = C^T R C, t' = C^T t.
        c = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]
        ct = [[c[j][i] for j in range(3)] for i in range(3)]
        r = mm(ct, mm(r, c))
        t = mv(ct, t)
        log("Matrix converted from a Y-up export to the IFC's Z-up frame")
    with open(inp, 'r', encoding='latin-1', newline='') as f:
        text = f.read()
    unit = length_unit_in_metres(text)
    scaled = abs(sc - 1) > 1e-6
    # IFC placements cannot hold a scale. A uniform scale is applied instead by
    # redefining the project's length unit (1 unit = sc * old unit): every
    # length in the file (geometry, radii, extrusions...) is rescaled at once.
    unit_new = unit * sc
    log("File length unit: %g m%s" % (unit, ("; new unit %g m (scale %.6f)" % (unit_new, sc)) if scaled else ""))
    t = [v / unit_new for v in t]

    ents = {}
    for m in _ENT.finditer(text):
        ents[int(m.group(1))] = (m.group(2).upper(), m.group(3), m.span())
    next_id = max([int(x) for x in re.findall(r'^[ \t]*#(\d+)', text, re.M)] or [0]) + 1

    roots = []
    for eid, (typ, args, span) in ents.items():
        if typ != 'IFCLOCALPLACEMENT':
            continue
        parts = args.split(',', 1)
        if parts[0].strip() == '$':
            roots.append(eid)
    ua = re.search(r'IFCUNITASSIGNMENT\s*\(\((.*?)\)\)', text, re.I | re.S)
    if ua and any(int(r) in ents and ents[int(r)][0] == 'IFCCONVERSIONBASEDUNIT'
                  and '.LENGTHUNIT.' in ents[int(r)][1].upper()
                  for r in re.findall(r'#(\d+)', ua.group(1))):
        raise ValueError("The file's length unit is a conversion-based unit "
                         "(inches, or already scaled by this tool): not supported.")
    if not roots:
        raise ValueError("No root IfcLocalPlacement found: is this a valid IFC?")
    log("Root placements to transform: %d" % len(roots))

    new_ents, repl = [], []
    for eid in roots:
        typ, args, span = ents[eid]
        rel = _ref(args.split(',', 1)[1])
        loc, z, x = [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]
        if rel is not None and rel in ents and ents[rel][0] == 'IFCAXIS2PLACEMENT3D':
            ps = [p.strip() for p in ents[rel][1].split(',')]
            lr, ar, rr = [_ref(p) for p in (ps + ['$', '$'])[:3]]
            if lr in ents:
                loc = (_nums(ents[lr][1]) + [0, 0, 0])[:3]
            if ar in ents:
                z = norm((_nums(ents[ar][1]) + [0, 0, 0])[:3])
            if rr in ents:
                x0 = (_nums(ents[rr][1]) + [0, 0, 0])[:3]
                x = norm([a - dot(x0, z) * b for a, b in zip(x0, z)])
        nl = [a + b for a, b in zip(mv(r, loc), t)]
        nz, nx = mv(r, z), mv(r, x)
        pid, zid, xid, aid = next_id, next_id + 1, next_id + 2, next_id + 3
        next_id += 4
        f = lambda v: ','.join(repr(float(c)) for c in v)
        new_ents += [
            "#%d=IFCCARTESIANPOINT((%s));" % (pid, f(nl)),
            "#%d=IFCDIRECTION((%s));" % (zid, f(nz)),
            "#%d=IFCDIRECTION((%s));" % (xid, f(nx)),
            "#%d=IFCAXIS2PLACEMENT3D(#%d,#%d,#%d);" % (aid, pid, zid, xid)]
        repl.append((span, "#%d=IFCLOCALPLACEMENT($,#%d);" % (eid, aid)))

    for (a, b), new in sorted(repl, reverse=True):
        text = text[:a] + new + text[b:]
    if scaled:
        text, extra = _scale_unit(text, ents, sc, next_id)
        new_ents += extra
    end = [m.start() for m in re.finditer(r'^[ \t]*ENDSEC[ \t]*;', text, re.M | re.I)][-1]
    nl_ch = '\r\n' if '\r\n' in text[:2000] else '\n'
    text = text[:end] + nl_ch.join(new_ents) + nl_ch + text[end:]
    with open(out, 'w', encoding='latin-1', newline='') as f:
        f.write(text)
    log("Written: %s" % out)


def default_out(inp):
    b, e = os.path.splitext(inp)
    return b + '_transformed' + (e or '.ifc')


# ---------- front ends ----------
def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox
    root = tk.Tk()
    root.title("Transform IFC with a CloudCompare matrix")
    path = tk.StringVar()
    inv = tk.BooleanVar(value=False)
    yup = tk.BooleanVar(value=False)
    tk.Label(root, text="IFC file:").grid(row=0, column=0, sticky='w', padx=6, pady=4)
    tk.Entry(root, textvariable=path, width=60).grid(row=0, column=1, padx=6)
    tk.Button(root, text="Browse…", command=lambda: path.set(filedialog.askopenfilename(
        filetypes=[("IFC", "*.ifc *.IFC"), ("All", "*.*")]) or path.get())
    ).grid(row=0, column=2, padx=6)
    tk.Label(root, text="Paste the 4x4 matrix from CloudCompare:").grid(
        row=1, column=0, columnspan=3, sticky='w', padx=6)
    box = tk.Text(root, width=70, height=7)
    box.grid(row=2, column=0, columnspan=3, padx=6, pady=4)
    tk.Checkbutton(root, text="Apply the inverse matrix", variable=inv).grid(
        row=3, column=0, columnspan=2, sticky='w', padx=6)
    tk.Checkbutton(root, text="Matrix computed on a Y-up export (GLB/glTF, IfcConvert): "
                   "convert to the IFC's Z-up", variable=yup).grid(
        row=6, column=0, columnspan=3, sticky='w', padx=6)
    logbox = tk.Text(root, width=70, height=5, state='disabled')
    logbox.grid(row=5, column=0, columnspan=3, padx=6, pady=4)

    def log(msg):
        logbox.configure(state='normal')
        logbox.insert('end', msg + '\n')
        logbox.configure(state='disabled')
        root.update_idletasks()

    def go():
        try:
            if not path.get():
                raise ValueError("Choose an IFC file.")
            transform_ifc(path.get(), default_out(path.get()),
                          parse_matrix(box.get('1.0', 'end')), inv.get(), log, yup.get())
        except Exception as e:
            messagebox.showerror("Error", str(e))
    tk.Button(root, text="Transform", command=go).grid(row=4, column=0, padx=6, pady=4, sticky='w')
    root.mainloop()


def run_terminal():
    p = input("IFC file to rotate: ").strip().strip('"\'')
    print("Paste the 4x4 matrix from CloudCompare, then an empty line:")
    lines = []
    while True:
        ln = sys.stdin.readline()
        if not ln or (not ln.strip() and lines):
            break
        lines.append(ln)
    transform_ifc(p, default_out(p), parse_matrix(''.join(lines)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('input', nargs='?')
    ap.add_argument('--matrix')
    ap.add_argument('--matrix-file')
    ap.add_argument('-o', '--output')
    ap.add_argument('--invert', action='store_true')
    ap.add_argument('--yup', action='store_true',
                    help='the matrix was computed on a Y-up export of the model')
    a = ap.parse_args()
    try:
        if a.input and (a.matrix or a.matrix_file):
            txt = a.matrix if a.matrix else open(a.matrix_file).read()
            transform_ifc(a.input, a.output or default_out(a.input),
                          parse_matrix(txt), a.invert, yup=a.yup)
            return
        try:
            import tkinter  # noqa: F401
            tkinter.Tk().destroy()
        except Exception:
            return run_terminal()
        run_gui()
    except Exception as e:
        sys.exit("Error: %s" % e)


if __name__ == '__main__':
    main()
