# frozen_string_literal: true

# Read-only, revocable links that let people without an OpenProject account
# (e.g. students in a Moodle quiz) open ONE spatial model -- optionally framed
# on ONE annotation -- inside an iframe. See SpatialEmbedController.
class CreateSpatialShareLinks < ActiveRecord::Migration[7.1]
  def change
    create_table :spatial_share_links do |t|
      t.references :spatial_model, null: false, foreign_key: { on_delete: :cascade }
      t.references :spatial_annotation, null: true, foreign_key: { on_delete: :cascade }
      t.bigint :created_by_id
      t.string :token, null: false
      t.string :label
      t.datetime :expires_at
      t.timestamps
    end
    add_index :spatial_share_links, :token, unique: true
  end
end
