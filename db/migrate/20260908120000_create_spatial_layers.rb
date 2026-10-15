# frozen_string_literal: true

class CreateSpatialLayers < ActiveRecord::Migration[7.0]
  def change
    create_table :spatial_layers do |t|
      t.references :spatial_model, null: false, foreign_key: true, index: true
      t.references :uploader, foreign_key: { to_table: :users }, index: true
      t.string :title, null: false
      # ifc | mesh | pointcloud | splat
      t.string :kind, null: false
      # ifc obj glb gltf zip ply splat las laz e57
      t.string :source_format, null: false
      t.integer :position, default: 0, null: false
      t.boolean :visible, default: true, null: false
      t.jsonb :settings, default: {}

      t.timestamps
    end
  end
end
