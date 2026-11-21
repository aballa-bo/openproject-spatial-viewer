# frozen_string_literal: true

class AddExposureToSpatialLayers < ActiveRecord::Migration[7.0]
  def change
    add_column :spatial_layers, :exposure, :float, default: 1.0, null: false
  end
end
