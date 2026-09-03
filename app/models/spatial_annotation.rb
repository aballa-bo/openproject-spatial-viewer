# frozen_string_literal: true

class SpatialAnnotation < ApplicationRecord
  belongs_to :spatial_model
  belongs_to :work_package, optional: true
  belongs_to :author, class_name: "User"

  validates :title, presence: true
  validates :spatial_model, presence: true
  validates :author, presence: true
  validates :annotation_type, inclusion: { in: %w[pin draw_polyline lasso_selection measurement] }

  def as_json_payload
    {
      id: id,
      title: title,
      description: description,
      annotation_type: annotation_type,
      color: color,
      camera_viewpoint: camera_viewpoint,
      geometry_data: geometry_data,
      thumbnail_base64: thumbnail_base64,
      work_package_id: work_package_id,
      work_package_subject: work_package&.subject,
      work_package_status: work_package&.status&.name,
      author_name: author.name,
      created_at: created_at.strftime('%d/%m/%Y %H:%M')
    }
  end
end
