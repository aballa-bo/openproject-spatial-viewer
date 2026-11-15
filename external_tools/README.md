# external_tools

Standalone helper scripts that run on a user's own machine (they are not part of
the OpenProject plugin and are not loaded by the viewer).

## transform_gaussians.py

Applies a CloudCompare 4x4 rototranslation matrix to a Gaussian Splatting file
(`.ply` or `.sog`) so it lines up with a model aligned in CloudCompare (for
example a photogrammetric model registered to a LiDAR cloud).

Saving the splat from CloudCompare does not work: it treats the file as a plain
point cloud and drops the Gaussian properties (colour, opacity, size,
orientation), so the result renders grey. This script transforms them properly:

| Property | Treatment |
|---|---|
| position | `p' = s·R·p + t` |
| orientation (`rot_*`) | composed with the rotation |
| size (`scale_*`, stored as log) | `+ log(s)` |
| colour DC (`f_dc_*`) | unchanged (rotation invariant) |
| view-dependent colour (`f_rest_*`, SOG `shN`) | spherical harmonics rotated |
| opacity | unchanged |

### Install

    pip install numpy            # .ply
    pip install numpy pillow     # also .sog

### Use

GUI: run it with no arguments, pick the file, paste the matrix, click *Apply*.

    python transform_gaussians.py

Command line:

    python transform_gaussians.py scan.ply --matrix-file matrix.txt -o scan_aligned.ply
    python transform_gaussians.py scan.sog --matrix "0.99 -0.01 0 12.3  0.01 0.99 0 -4.1  0 0 1 0.5  0 0 0 1"
    python transform_gaussians.py scan.ply --matrix-file matrix.txt --invert

The matrix is pasted exactly as CloudCompare prints it (4 rows of 4 numbers;
labels and brackets are ignored). Without `-o` the output is `<input>_aligned.<ext>`.

### Things to check

- **Same frame?** The matrix only applies if the splat is in the same coordinate
  frame as the model that was aligned (same camera poses, no re-centring or
  rescaling by the trainer). Overlay the splat centres and the model to verify.
- **Scale.** If *adjust scale* was enabled in CloudCompare the matrix contains a
  uniform scale; it is applied to positions and Gaussian sizes. Non-uniform scale,
  shear or reflection are rejected.
- **Global shift.** CloudCompare matrices refer to the (possibly shifted) local
  coordinates shown in CloudCompare. If it offered a *Global shift* when loading
  the cloud, take it into account.
- **Large coordinates.** `.ply` stores float32 positions: with georeferenced
  coordinates (hundreds of thousands) precision drops to centimetres or worse.
  The script warns about it; align to a local origin instead.
- `.sog`: positions and spherical harmonics are re-quantised (the format is
  already quantised, so the loss is of the same order); colours, opacity and
  sizes are kept.
- Only binary little-endian, uncompressed 3DGS `.ply` files are supported.
