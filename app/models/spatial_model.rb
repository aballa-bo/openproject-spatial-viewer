# frozen_string_literal: true

class SpatialModel < ApplicationRecord
  acts_as_attachable view_permission: :view_spatial_models,
                     add_permission: :manage_spatial_models,
                     delete_permission: :manage_spatial_models

  belongs_to :project
  belongs_to :uploader, class_name: "User"
  has_many :spatial_annotations, dependent: :destroy

  validates :title, presence: true
  validates :project, presence: true
  validates :uploader, presence: true
  validates :model_format, inclusion: { in: %w[gltf glb obj gaussian_splat ply splat ksplat ifc] }

  scope :defaults, -> { where(is_default: true) }

  def model_attachment
    attachments.first
  end

  def model_attachment_url
    if model_attachment.present?
      "/api/v3/attachments/#{model_attachment.id}/content"
    end
  end

  def formatted_size
    if model_attachment.present?
      "#{(model_attachment.filesize.to_f / 1024 / 1024).round(2)} MB"
    else
      "N/A"
    end
  end
end
