#!/bin/bash
set -e

PLUGIN_NAME="openproject-spatial_viewer"
MODULE_DIR_NAME="spatial_viewer"
PLUGIN_SRC="/home/administrator/openproject-spatial_viewer"
OP_DIR="/opt/openproject"
DEST_DIR="$OP_DIR/modules/$MODULE_DIR_NAME"

echo "========================================================="
echo " Installing OpenProject Spatial 3D & Splatting Plugin   "
echo "========================================================="

if [ "$EUID" -ne 0 ]; then
  echo "[-] ERROR: Run this script with root privileges:"
  echo "    sudo bash install.sh"
  exit 1
fi

echo "[1/8] Cleaning old modules and copying to $DEST_DIR..."
rm -rf "$OP_DIR/modules/openproject-3d_viewer" "$OP_DIR/modules/openproject-spatial_viewer" "$DEST_DIR"

# Clean any previous entries from Gemfile.modules
sed -i "/openproject-3d_viewer/d" "$OP_DIR/Gemfile.modules" 2>/dev/null || true
sed -i "/openproject-spatial_viewer/d" "$OP_DIR/Gemfile.modules" 2>/dev/null || true

cp -r "$PLUGIN_SRC" "$DEST_DIR"
chown -R openproject:openproject "$DEST_DIR"

echo "[2/8] Configuring Gemfile.modules..."
if ! grep -q "openproject-spatial_viewer" "$OP_DIR/Gemfile.modules"; then
  sed -i "/group :opf_plugins do/a\\  gem '$PLUGIN_NAME', path: 'modules/$MODULE_DIR_NAME'" "$OP_DIR/Gemfile.modules"
  echo "[+] $PLUGIN_NAME entry added to group :opf_plugins."
fi

echo "[3/8] Installing Ruby dependencies (bundle install)..."
openproject run bundle config set frozen false
openproject run bundle install

echo "[4/8] Running database migrations..."
openproject run rake db:migrate

echo "[5/8] Deploying static assets for the 3D viewer..."
ASSET_DIR="$OP_DIR/public/assets/openproject_spatial_viewer"
mkdir -p "$ASSET_DIR/vendor"

# Copy JS, CSS, and vendor files
cp -r "$PLUGIN_SRC/app/assets/javascripts/openproject_spatial_viewer/"*.js "$ASSET_DIR/" 2>/dev/null || true
cp -r "$PLUGIN_SRC/app/assets/stylesheets/openproject_spatial_viewer/"* "$ASSET_DIR/" 2>/dev/null || true
cp -r "$PLUGIN_SRC/app/assets/javascripts/openproject_spatial_viewer/vendor/"* "$ASSET_DIR/vendor/" 2>/dev/null || true

# Minify this plugin's own JS (not vendor/ or vendor.bundle.js, which ship
# pre-built) in place in $ASSET_DIR, using the Node + uglify-js OpenProject
# already vendors for its own asset build -- no new dependency, and only
# the DEPLOYED copy is minified; $PLUGIN_SRC (this repo's source, used for
# every future edit) is never touched and stays fully readable.
NODE_BIN="$OP_DIR/.heroku/node/bin/node"
UGLIFYJS="$OP_DIR/node_modules/.bin/uglifyjs"
OWN_JS_FILES="viewer_engine.js layer_manager.js gltf_worker.js splat_sort_worker.js"
if [ -x "$NODE_BIN" ] && [ -f "$UGLIFYJS" ]; then
  echo "    Minifying plugin JS with uglify-js..."
  for name in $OWN_JS_FILES; do
    f="$ASSET_DIR/$name"
    [ -f "$f" ] || continue
    before=$(wc -c < "$f")
    tmp="$f.min.tmp"
    if "$NODE_BIN" "$UGLIFYJS" "$f" -c -m -o "$tmp" 2>"$tmp.err"; then
      mv "$tmp" "$f"
      after=$(wc -c < "$f")
      echo "      $name: $before -> $after bytes"
    else
      echo "    [!] Minification failed for $name, deploying it unminified:"
      cat "$tmp.err"
      rm -f "$tmp"
    fi
    rm -f "$tmp.err"
  done
else
  echo "    [!] node/uglify-js not found under $OP_DIR -- deploying plugin JS unminified."
fi

chown -R openproject:openproject "$ASSET_DIR"

echo "[6/8] Clearing cache & checking IFC conversion toolchain..."
openproject run rake tmp:cache:clear

if [ -x "$OP_DIR/bin/IfcConvert" ] || command -v IfcConvert >/dev/null 2>&1; then
  echo "[+] IfcConvert found: IFC -> GLB conversion is enabled."
else
  echo "[!] IfcConvert NOT found. IFC models cannot be converted."
  echo "    Install IfcOpenShell or the OpenProject BIM module (which bundles it),"
  echo "    or set the IFCCONVERT_BIN environment variable."
fi

# Cache directory for converted models (IFC -> GLB)
STORAGE_ROOT="$(openproject run bundle exec rails runner 'print OpenProject::Configuration.attachments_storage_path' 2>/dev/null)"
CONV_DIR="$STORAGE_ROOT/spatial_viewer"
mkdir -p "$CONV_DIR" 2>/dev/null && chown -R openproject:openproject "$CONV_DIR" 2>/dev/null || true

echo "[7/8] Deploying the Unity standalone player (for \"Download as .exe\")..."
# The player itself is never built here -- this server has no Unity Editor,
# no Windows build tools, no GPU. It is built once, out of band, by a
# developer with Unity Editor from the project under unity/SpatialViewerPlayer/
# (see README.md), then its build output is dropped at
# $PLUGIN_SRC/unity/SpatialViewerPlayer/dist/ before running this script.
UNITY_PLAYER_SRC="$PLUGIN_SRC/unity/SpatialViewerPlayer/dist"
UNITY_PLAYER_DEST="${SPATIAL_VIEWER_UNITY_PLAYER_DIR:-$STORAGE_ROOT/unity_player}"
if [ -d "$UNITY_PLAYER_SRC" ] && [ -n "$(ls -A "$UNITY_PLAYER_SRC" 2>/dev/null)" ]; then
  mkdir -p "$UNITY_PLAYER_DEST"
  rsync -a --delete "$UNITY_PLAYER_SRC/" "$UNITY_PLAYER_DEST/"
  chown -R openproject:openproject "$UNITY_PLAYER_DEST"
  echo "[+] Unity player deployed to $UNITY_PLAYER_DEST -- \"Download as .exe\" is enabled."
else
  echo "[!] No Unity player build found at $UNITY_PLAYER_SRC."
  echo "    \"Download as .exe\" stays hidden in the viewer until it's deployed."
  echo "    See README.md for the one-time Unity Editor build + deploy step."
fi

echo "[8/8] Restarting OpenProject services..."
systemctl restart openproject-web-1 openproject-worker-1 2>/dev/null || openproject restart

echo "========================================================="
echo " [OK] Installation completed successfully!              "
echo " The '3D & Splatting' module is now active in OpenProject."
echo "========================================================="
