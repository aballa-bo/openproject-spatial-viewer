# frozen_string_literal: true

# Scale factor of a (LiDAR) layer, applied to measured distances and areas.
class AddScaleToSpatialLayers < ActiveRecord::Migration[7.0]
  def change
    add_column :spatial_layers, :scale, :float, default: 1.0, null: false
  end
end
