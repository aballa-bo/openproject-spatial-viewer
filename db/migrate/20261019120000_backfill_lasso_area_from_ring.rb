# frozen_string_literal: true

# Backfills SpatialAnnotation#area for lasso_selection annotations saved
# before fill_grid existed. compute_lasso_area now falls back to a
# ring-based approximation (SpatialAnnotation#calculate_ring_area) when
# fill_grid is absent, but that only runs on save -- without this, any
# annotation nobody happens to re-save would be stuck showing a blank Area
# forever. Re-saving also re-runs sync_work_package_area_custom_field, so
# the linked Work Package's "Area (m²)" custom field (see
# AddAreaCustomFieldForAnnotations) gets backfilled too, wherever a Work
# Package has exactly one lasso selection.
class BackfillLassoAreaFromRing < ActiveRecord::Migration[7.1]
  def up
    SpatialAnnotation.where(annotation_type: "lasso_selection", area: nil).find_each do |annotation|
      annotation.save(validate: false)
    rescue StandardError => e
      Rails.logger.warn("[SpatialViewer] Could not backfill area for annotation ##{annotation.id}: #{e.message}")
    end
  end

  def down
    # Irreversible by design -- there is no record of which rows this filled
    # in versus already had a value from the grid path.
  end
end
