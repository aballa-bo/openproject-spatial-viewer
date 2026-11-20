# frozen_string_literal: true

class AddLocationToSpatialModels < ActiveRecord::Migration[7.0]
  def change
    add_column :spatial_models, :latitude, :decimal, precision: 10, scale: 7
    add_column :spatial_models, :longitude, :decimal, precision: 10, scale: 7
  end
end
