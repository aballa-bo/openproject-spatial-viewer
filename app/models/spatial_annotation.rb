# frozen_string_literal: true

# A 3D annotation on a SpatialModel.
#
# Structurally this mirrors a BCF viewpoint (BCF 2.1):
#   SpatialAnnotation  ~  Bim::Bcf::Viewpoint   (camera, lines, clipping planes, snapshot)
#   work_package       ~  Bim::Bcf::Issue.work_package
#
# Every annotation is tied to a Work Package. When the BIM module is present the
# annotation is also mirrored into a real Bim::Bcf::Issue / Bim::Bcf::Viewpoint
# (see SpatialViewer::AnnotationBcfSync), so it shows up in the "BCF" section of
# the Work Package page.
class SpatialAnnotation < ApplicationRecord
  acts_as_attachable view_permission: :view_spatial_models,
                     add_on_new_permission: :create_spatial_annotations,
                     add_on_persisted_permission: :create_spatial_annotations,
                     delete_permission: :create_spatial_annotations

  SNAPSHOT_DESCRIPTION = "snapshot"
  # Must match the migration that creates this field
  # (AddAreaCustomFieldForAnnotations::CUSTOM_FIELD_NAME).
  AREA_CUSTOM_FIELD_NAME = "Area (m²)"

  belongs_to :spatial_model
  belongs_to :work_package
  belongs_to :author, class_name: "User"
  belongs_to :bcf_issue, class_name: "Bim::Bcf::Issue", optional: true

  attr_accessor :pending_snapshot

  before_validation :assign_viewpoint_uuid, on: :create
  before_save :assign_json_viewpoint
  before_save :compute_lasso_area
  after_save :persist_pending_snapshot
  after_commit :sync_to_bcf, on: %i[create update]
  after_commit :remove_bcf_viewpoint, on: :destroy
  after_commit :sync_work_package_area_custom_field, on: %i[create update destroy]

  validates :title, presence: true
  validates :spatial_model, :author, :work_package, presence: true
  validates :annotation_type,
            inclusion: { in: %w[pin draw_polyline lasso_selection measurement] }

  def snapshot
    if attachments.loaded?
      attachments.detect { |a| a.description == SNAPSHOT_DESCRIPTION } || attachments.first
    else
      attachments.find_by(description: SNAPSHOT_DESCRIPTION) || attachments.first
    end
  end

  # Accepts a data: URI (as sent by the viewer) or an uploaded file. The actual
  # attachment is built in an after_save hook, once the record has an id.
  def snapshot=(source)
    self.pending_snapshot = source
  end

  def self.snapshot_file_from(source)
    return source if source.respond_to?(:original_filename)
    return nil unless source.is_a?(String) && source.start_with?("data:")

    meta, b64 = source.split(",", 2)
    return nil if b64.blank?

    ext = meta[%r{data:image/(\w+)}, 1] || "png"
    tempfile = Tempfile.new(["spatial_annotation_snapshot", ".#{ext}"])
    tempfile.binmode
    tempfile.write(Base64.decode64(b64))
    tempfile.rewind
    tempfile.define_singleton_method(:original_filename) { "snapshot.#{ext}" }
    tempfile.define_singleton_method(:content_type) { "image/#{ext}" }
    tempfile
  end

  # ---- BCF projection ------------------------------------------------------

  # BCF 2.1 viewpoint JSON built from this annotation. Coordinates are converted
  # from the viewer's Y-up space to the BCF/IFC Z-up convention.
  def to_bcf_viewpoint_json
    cam = (camera_viewpoint || {}).with_indifferent_access
    eye = xyz(cam[:eye])
    target = xyz(cam[:target])
    up = xyz(cam[:up]) || [0, 0, 1]

    json = { "guid" => viewpoint_uuid }

    if eye
      json["perspective_camera"] = {
        "camera_view_point" => hash_point(to_zup(eye)),
        "camera_direction" => hash_point(to_zup(direction(eye, target))),
        "camera_up_vector" => hash_point(to_zup(up)),
        "field_of_view" => 60
      }
    end

    lines = bcf_lines
    json["lines"] = lines if lines.present?

    planes = bcf_clipping_planes
    json["clipping_planes"] = planes if planes.present?

    json["components"] = {
      "selection" => [],
      "coloring" => [],
      "visibility" => { "default_visibility" => true, "exceptions" => [] }
    }
    json
  end

  def work_package_url
    "/work_packages/#{work_package_id}"
  end

  # The snapshot route is nested under project + spatial model, so it must be
  # built with the route helper rather than hand-assembled.
  def snapshot_url
    return nil if snapshot.blank? || spatial_model.blank?

    Rails.application.routes.url_helpers
         .snapshot_project_spatial_model_spatial_annotation_path(spatial_model.project, spatial_model, self)
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] Could not build snapshot URL for annotation ##{id}: #{e.message}")
    nil
  end

  def as_json_payload
    {
      id:,
      viewpoint_uuid:,
      title:,
      description:,
      annotation_type:,
      color:,
      area:,
      camera_viewpoint:,
      geometry_data:,
      json_viewpoint:,
      snapshot_url:,
      work_package_id:,
      work_package_url:,
      work_package_subject: work_package&.subject,
      work_package_status: work_package&.status&.name,
      work_package_type: work_package&.type&.name,
      work_package: work_package_detail_payload,
      bcf_issue_uuid: bcf_issue&.uuid,
      author_name: author&.name,
      created_at: created_at&.strftime("%d/%m/%Y %H:%M")
    }
  end

  # Editable fields of the linked Work Package, for the annotation detail panel.
  def work_package_detail_payload
    wp = work_package
    return nil unless wp

    {
      id: wp.id,
      subject: wp.subject,
      description: wp.description,
      type_id: wp.type_id,
      status_id: wp.status_id,
      status: wp.status&.name,
      assigned_to_id: wp.assigned_to_id,
      responsible_id: wp.responsible_id,
      priority_id: wp.priority_id,
      category_id: wp.category_id,
      version_id: wp.version_id,
      parent_id: wp.parent_id,
      start_date: wp.start_date,
      due_date: wp.due_date,
      estimated_hours: wp.estimated_hours,
      # { custom_field_id => [raw value string, ...] } -- always an array
      # (even for a single-value field) so the client doesn't need to know
      # the field's multi-value-ness just to read this back; see
      # _renderCustomFieldsForType's `values` parameter.
      custom_field_values: wp.custom_field_values.group_by(&:custom_field_id)
                             .transform_values { |cvs| cvs.map(&:value) }
    }
  end

  private

  def assign_viewpoint_uuid
    self.viewpoint_uuid ||= SecureRandom.uuid
    self.viewpoint_name = title if viewpoint_name.blank?
  end

  def assign_json_viewpoint
    self.json_viewpoint = to_bcf_viewpoint_json
  end

  def persist_pending_snapshot
    source = pending_snapshot
    return if source.blank?

    self.pending_snapshot = nil
    file = self.class.snapshot_file_from(source)
    return if file.nil?

    snapshot&.destroy
    ::Attachments::BuildService
      .bypass_allowlist(user: author || User.current)
      .call(file:, container: self, filename: file.try(:original_filename) || "snapshot.png",
            description: SNAPSHOT_DESCRIPTION)
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] Could not store annotation snapshot for ##{id}: #{e.message}")
  ensure
    file.close if file.respond_to?(:close)
  end

  def sync_to_bcf
    ::SpatialViewer::SyncAnnotationBcfJob.perform_later(id)
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] Could not enqueue BCF sync for annotation ##{id}: #{e.message}")
  end

  def remove_bcf_viewpoint
    ::SpatialViewer::AnnotationBcfSync.new(self).destroy_viewpoint
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] BCF viewpoint cleanup failed for annotation ##{id}: #{e.message}")
  end

  # Mirrors this annotation's area onto the linked Work Package's "Area (m²)"
  # custom field (see the AddAreaCustomFieldForAnnotations migration) -- but
  # ONLY when that Work Package has exactly one linked lasso_selection
  # annotation. A Work Package can have several annotations/viewpoints
  # (same as a BCF issue can have several viewpoints), so with 0 or 2+ lasso
  # selections there is no single unambiguous area to show; the field is
  # left blank in that case rather than guessing (e.g. picking "the last one
  # saved").
  #
  # Runs after_commit (not after_save) so the count query below sees this
  # annotation's own just-committed row (or, on destroy, its absence).
  def sync_work_package_area_custom_field
    wp_id = work_package_id
    return unless wp_id

    field = WorkPackageCustomField.find_by(name: AREA_CUSTOM_FIELD_NAME)
    return unless field

    wp = WorkPackage.find_by(id: wp_id)
    return unless wp

    lassos = self.class.where(work_package_id: wp_id, annotation_type: "lasso_selection").to_a
    value = lassos.first.area if lassos.size == 1

    wp.custom_field_values = { field.id => value }
    wp.save(validate: false)
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] Could not sync area custom field for WP ##{wp_id}: #{e.message}")
  end

  # The area column is always derived, never client-supplied (not permitted
  # in SpatialAnnotationsController#annotation_params) -- recomputed on every
  # save, so any future change to geometry_data (e.g. redrawing the lasso)
  # automatically keeps it current without the client needing to send it.
  def compute_lasso_area
    self.area = annotation_type == "lasso_selection" ? calculate_fill_area : nil
  end

  # Mirrors the client's triangulateLassoGrid (viewer_engine.js) exactly --
  # same quad-to-2-triangles split, same "skip the triangle if any of its 3
  # grid points is a null (no-surface-hit) cell" rule -- so the computed area
  # matches what the user actually sees filled in on the model.
  def calculate_fill_area
    gd = (geometry_data || {}).with_indifferent_access
    grid = gd[:fill_grid]
    rows = gd[:fill_rows].to_i
    cols = gd[:fill_cols].to_i
    return nil unless grid.is_a?(Array) && rows > 1 && cols > 1 && grid.length >= rows * cols

    total = 0.0
    (0...(rows - 1)).each do |j|
      (0...(cols - 1)).each do |k|
        a = grid[(j * cols) + k]
        b = grid[(j * cols) + k + 1]
        c = grid[((j + 1) * cols) + k]
        d = grid[((j + 1) * cols) + k + 1]
        total += triangle_area(a, b, c) if a && b && c
        total += triangle_area(b, d, c) if b && d && c
      end
    end
    total.round(4)
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] Could not compute fill area for annotation ##{id}: #{e.message}")
    nil
  end

  def triangle_area(a, b, c)
    ax, ay, az = a[0].to_f, a[1].to_f, a[2].to_f
    bx, by, bz = b[0].to_f, b[1].to_f, b[2].to_f
    cx, cy, cz = c[0].to_f, c[1].to_f, c[2].to_f
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx = (uy * vz) - (uz * vy)
    ny = (uz * vx) - (ux * vz)
    nz = (ux * vy) - (uy * vx)
    0.5 * Math.sqrt((nx**2) + (ny**2) + (nz**2))
  end

  # ---- geometry helpers --------------------------------------------------

  def geometry_points
    pts = (geometry_data || {}).with_indifferent_access[:points]
    Array(pts).filter_map { |p| xyz([p[:x], p[:y], p[:z]]) }
  end

  def closed_geometry?
    annotation_type == "lasso_selection" ||
      (geometry_data || {}).with_indifferent_access[:closed].present?
  end

  def bcf_lines
    pts = geometry_points
    return [] if pts.length < 2

    ring = closed_geometry? && pts.length >= 3 ? pts + [pts.first] : pts
    ring.each_cons(2).map do |a, b|
      { "start_point" => hash_point(to_zup(a)), "end_point" => hash_point(to_zup(b)) }
    end
  end

  def bcf_clipping_planes
    planes = (geometry_data || {}).with_indifferent_access[:clipping_planes]
    Array(planes).filter_map do |pl|
      pl = pl.with_indifferent_access
      loc = xyz([pl.dig(:location, :x), pl.dig(:location, :y), pl.dig(:location, :z)])
      dir = xyz([pl.dig(:direction, :x), pl.dig(:direction, :y), pl.dig(:direction, :z)])
      next unless loc && dir

      { "location" => hash_point(to_zup(loc)), "direction" => hash_point(to_zup(dir)) }
    end
  end

  def xyz(arr)
    return nil if arr.blank?

    a = Array(arr).map { |v| Float(v) rescue nil }
    a.length == 3 && a.none?(&:nil?) ? a : nil
  end

  def direction(eye, target)
    return [0, 0, -1] unless eye && target

    d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]
    n = Math.sqrt(d.sum { |c| c * c })
    n.zero? ? [0, 0, -1] : d.map { |c| c / n }
  end

  # Viewer (Three.js, Y-up) -> BCF/IFC (Z-up): (x, y, z) -> (x, -z, y)
  def to_zup(v)
    [v[0], -v[2], v[1]]
  end

  def hash_point(v)
    { "x" => v[0], "y" => v[1], "z" => v[2] }
  end
end
