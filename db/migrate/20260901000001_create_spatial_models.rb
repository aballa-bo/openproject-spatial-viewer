# frozen_string_literal: true

class CreateSpatialModels < ActiveRecord::Migration[7.0]
  def change
    create_table :spatial_models do |t|
      t.references :project, null: false, foreign_key: true, index: true
      t.references :uploader, null: false, foreign_key: { to_table: :users }, index: true
      t.string :title, null: false
      t.text :description
      t.string :model_format, default: "gltf", null: false
      t.boolean :is_default, default: false, null: false
      t.jsonb :settings, default: {}

      t.timestamps
    end
  end
end
