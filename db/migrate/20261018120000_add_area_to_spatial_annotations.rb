# frozen_string_literal: true

# The surface area (m^2) of a lasso selection's saved fill patch, computed
# server-side from geometry_data -- never set directly by the client (see
# SpatialAnnotation#compute_lasso_area and SpatialAnnotationsController's
# annotation_params, which does not permit it).
class AddAreaToSpatialAnnotations < ActiveRecord::Migration[7.1]
  def change
    add_column :spatial_annotations, :area, :float
  end
end
