# frozen_string_literal: true

class CreateSpatialAnnotations < ActiveRecord::Migration[7.0]
  def change
    create_table :spatial_annotations do |t|
      t.references :spatial_model, null: false, foreign_key: true, index: true
      t.references :work_package, foreign_key: true, index: true, null: true
      t.references :author, null: false, foreign_key: { to_table: :users }, index: true
      t.string :title, null: false
      t.text :description
      t.string :annotation_type, default: "pin", null: false
      t.string :color, default: "#3b82f6"
      t.jsonb :camera_viewpoint, default: {}
      t.jsonb :geometry_data, default: {}
      t.text :thumbnail_base64

      t.timestamps
    end
  end
end
