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

echo "[1/7] Cleaning old modules and copying to $DEST_DIR..."
rm -rf "$OP_DIR/modules/openproject-3d_viewer" "$OP_DIR/modules/openproject-spatial_viewer" "$DEST_DIR"

# Clean any previous entries from Gemfile.modules
sed -i "/openproject-3d_viewer/d" "$OP_DIR/Gemfile.modules" 2>/dev/null || true
sed -i "/openproject-spatial_viewer/d" "$OP_DIR/Gemfile.modules" 2>/dev/null || true

cp -r "$PLUGIN_SRC" "$DEST_DIR"
chown -R openproject:openproject "$DEST_DIR"

echo "[2/7] Configuring Gemfile.modules..."
if ! grep -q "openproject-spatial_viewer" "$OP_DIR/Gemfile.modules"; then
  sed -i "/group :opf_plugins do/a\\  gem '$PLUGIN_NAME', path: 'modules/$MODULE_DIR_NAME'" "$OP_DIR/Gemfile.modules"
  echo "[+] $PLUGIN_NAME entry added to group :opf_plugins."
fi

echo "[3/7] Installing Ruby dependencies (bundle install)..."
openproject run bundle config set frozen false
openproject run bundle install

echo "[4/7] Running database migrations..."
openproject run rake db:migrate

echo "[5/7] Deploying static assets for the 3D viewer..."
ASSET_DIR="$OP_DIR/public/assets/openproject_spatial_viewer"
mkdir -p "$ASSET_DIR/vendor"

# Copy JS, CSS, and vendor files
cp -r "$PLUGIN_SRC/app/assets/javascripts/openproject_spatial_viewer/"*.js "$ASSET_DIR/" 2>/dev/null || true
cp -r "$PLUGIN_SRC/app/assets/stylesheets/openproject_spatial_viewer/"* "$ASSET_DIR/" 2>/dev/null || true
cp -r "$PLUGIN_SRC/app/assets/javascripts/openproject_spatial_viewer/vendor/"* "$ASSET_DIR/vendor/" 2>/dev/null || true

chown -R openproject:openproject "$ASSET_DIR"

echo "[6/7] Clearing cache & checking IFC conversion toolchain..."
openproject run rake tmp:cache:clear

if [ -x "$OP_DIR/bin/IfcConvert" ] || command -v IfcConvert >/dev/null 2>&1; then
  echo "[+] IfcConvert found: IFC -> GLB conversion is enabled."
else
  echo "[!] IfcConvert NOT found. IFC models cannot be converted."
  echo "    Install IfcOpenShell or the OpenProject BIM module (which bundles it),"
  echo "    or set the IFCCONVERT_BIN environment variable."
fi

# Cache directory for converted models (IFC -> GLB)
CONV_DIR="$(openproject run bundle exec rails runner 'print OpenProject::Configuration.attachments_storage_path' 2>/dev/null)/spatial_viewer"
mkdir -p "$CONV_DIR" 2>/dev/null && chown -R openproject:openproject "$CONV_DIR" 2>/dev/null || true

echo "[7/7] Restarting OpenProject services..."
systemctl restart openproject-web-1 openproject-worker-1 2>/dev/null || openproject restart

echo "========================================================="
echo " [OK] Installation completed successfully!              "
echo " The '3D & Splatting' module is now active in OpenProject."
echo "========================================================="
