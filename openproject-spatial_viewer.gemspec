# frozen_string_literal: true

Gem::Specification.new do |s|
  s.name        = "openproject-spatial_viewer"
  s.version     = "1.0.0"
  s.authors     = ["OpenProject Customization"]
  s.email       = ["info@openproject.org"]
  s.summary     = "3D, Mesh & Gaussian Splatting Viewer for OpenProject"
  s.description = "3D Viewer supporting OBJ, glTF/GLB, and 3D Gaussian Splatting with interactive mesh markup and WorkPackage linking."
  s.license     = "GPL-3.0"

  s.files = Dir["{app,config,db,lib}/**/*", "README.md"]
end
