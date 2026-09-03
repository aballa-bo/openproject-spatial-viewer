# frozen_string_literal: true

# Reshape spatial_annotations along the BCF data model:
# - every annotation is tied to a Work Package (enforced in the model)
# - it carries a BCF-schema viewpoint (json_viewpoint) + a stable viewpoint_uuid
# - it is mirrored to a Bim::Bcf::Issue / Bim::Bcf::Viewpoint (bcf_issue_id / bcf_viewpoint_id)
# - the snapshot moves from an inline base64 column to a real attachment
class RestructureSpatialAnnotationsForBcf < ActiveRecord::Migration[7.1]
  def up
    change_table :spatial_annotations, bulk: true do |t|
      t.string :viewpoint_uuid
      t.string :viewpoint_name
      t.jsonb  :json_viewpoint, default: {}, null: false
      t.bigint :bcf_issue_id
      t.bigint :bcf_viewpoint_id
    end

    # Backfill a uuid for existing rows.
    select_values("SELECT id FROM spatial_annotations WHERE viewpoint_uuid IS NULL").each do |id|
      execute("UPDATE spatial_annotations SET viewpoint_uuid = #{quote(SecureRandom.uuid)} WHERE id = #{Integer(id)}")
    end

    add_index :spatial_annotations, :viewpoint_uuid, unique: true
    add_index :spatial_annotations, :bcf_issue_id

    remove_column :spatial_annotations, :thumbnail_base64 if column_exists?(:spatial_annotations, :thumbnail_base64)

    # An annotation now belongs to a Work Package (like a BCF topic): it should
    # be removed together with the WP instead of blocking its deletion.
    if foreign_key_exists?(:spatial_annotations, :work_packages)
      remove_foreign_key :spatial_annotations, :work_packages
    end
    add_foreign_key :spatial_annotations, :work_packages, column: :work_package_id, on_delete: :cascade
  end

  def down
    if foreign_key_exists?(:spatial_annotations, :work_packages)
      remove_foreign_key :spatial_annotations, :work_packages
    end
    add_foreign_key :spatial_annotations, :work_packages, column: :work_package_id

    add_column :spatial_annotations, :thumbnail_base64, :text unless column_exists?(:spatial_annotations, :thumbnail_base64)

    change_table :spatial_annotations, bulk: true do |t|
      t.remove :viewpoint_uuid
      t.remove :viewpoint_name
      t.remove :json_viewpoint
      t.remove :bcf_issue_id
      t.remove :bcf_viewpoint_id
    end
  end
end
