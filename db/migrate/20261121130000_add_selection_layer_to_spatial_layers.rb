# frozen_string_literal: true

# A Gaussian-splat layer can point at the photogrammetry/IFC layer the lasso
# selects on while only the splat is shown.
class AddSelectionLayerToSpatialLayers < ActiveRecord::Migration[7.0]
  def change
    add_column :spatial_layers, :selection_layer_id, :integer
  end
end
