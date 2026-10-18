# frozen_string_literal: true

# A Work Package custom field mirroring SpatialAnnotation#area, so the
# surface area of a lasso selection is visible on the Work Package's own
# page (including the BIM views), not only inside the 3D viewer's own
# annotation panel. Kept in sync by
# SpatialAnnotation#sync_work_package_area_custom_field -- see that method's
# comment for why the sync is skipped (left blank) whenever a Work Package
# has more than one linked lasso selection, since a single field can't
# represent more than one area unambiguously.
#
# It is an ordinary, user-editable custom field (OpenProject has no
# "system-managed, read-only" custom field type) -- a manual edit through
# the native Work Package form will be overwritten the next time the linked
# annotation (or a sibling annotation on the same Work Package) is saved.
class AddAreaCustomFieldForAnnotations < ActiveRecord::Migration[7.1]
  CUSTOM_FIELD_NAME = "Area (m²)"

  def up
    field = WorkPackageCustomField.find_or_initialize_by(name: CUSTOM_FIELD_NAME)
    field.field_format = "float"
    field.is_for_all = true
    field.is_required = false
    field.is_filter = true
    field.searchable = false
    field.editable = true
    field.admin_only = false
    field.position = (WorkPackageCustomField.maximum(:position) || 0) + 1
    field.save!

    # Enabled for every existing type -- a type created later needs it
    # enabled manually via Administration > Custom fields, same as any
    # other plugin-provided custom field.
    (::Type.all.to_a - field.types.to_a).each { |t| field.types << t }
  end

  def down
    WorkPackageCustomField.find_by(name: CUSTOM_FIELD_NAME)&.destroy
  end
end
