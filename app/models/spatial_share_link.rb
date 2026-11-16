# frozen_string_literal: true

# A secret URL token granting anonymous, read-only access to a single
# SpatialModel (and, when set, a single annotation used as the opening view).
# Revoking a link = destroying the row.
class SpatialShareLink < ApplicationRecord
  MAX_DAYS = 3650
  DEFAULT_DAYS = 365

  belongs_to :spatial_model
  belongs_to :spatial_annotation, optional: true
  belongs_to :created_by, class_name: "User", optional: true

  before_validation :generate_token, on: :create
  validates :token, presence: true, uniqueness: true

  scope :active, -> { where("expires_at IS NULL OR expires_at > ?", Time.current) }

  def self.find_active(token)
    return nil if token.blank?

    active.find_by(token: token.to_s)
  end

  def expired?
    expires_at.present? && expires_at <= Time.current
  end

  private

  def generate_token
    self.token ||= SecureRandom.urlsafe_base64(32)
  end
end
