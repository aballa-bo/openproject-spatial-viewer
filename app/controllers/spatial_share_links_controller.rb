# frozen_string_literal: true

# Management of the anonymous embed links (project members with
# :manage_spatial_models only). The public side is SpatialEmbedController.
class SpatialShareLinksController < ApplicationController
  before_action :find_project_by_project_id
  before_action :authorize
  before_action :find_model

  def index
    links = @spatial_model.spatial_share_links.order(created_at: :desc)
    links = links.where(spatial_annotation_id: params[:annotation_id]) if params[:annotation_id].present?
    render json: links.map { |l| payload(l) }
  end

  def create
    annotation = nil
    if params[:annotation_id].present?
      annotation = @spatial_model.spatial_annotations.find_by(id: params[:annotation_id])
      return render json: { success: false, errors: ["Annotation not found"] }, status: :not_found unless annotation
    end

    days = params[:days].to_i
    days = SpatialShareLink::DEFAULT_DAYS if days <= 0
    days = [days, SpatialShareLink::MAX_DAYS].min

    link = @spatial_model.spatial_share_links.create!(
      spatial_annotation: annotation,
      created_by: User.current,
      label: params[:label].to_s.strip.first(120).presence,
      expires_at: days.days.from_now
    )
    render json: { success: true, link: payload(link) }, status: :created
  end

  def destroy
    @spatial_model.spatial_share_links.find(params[:id]).destroy
    render json: { success: true }
  rescue ActiveRecord::RecordNotFound
    render json: { success: false, errors: ["Link not found"] }, status: :not_found
  end

  private

  def find_model
    @spatial_model = SpatialModel.find_by!(id: params[:spatial_model_id], project: @project)
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def payload(link)
    url = spatial_embed_url(token: link.token)
    {
      id: link.id,
      annotation_id: link.spatial_annotation_id,
      label: link.label,
      url:,
      iframe: %(<iframe src="#{url}" width="100%" height="480" style="border:0" allow="fullscreen" loading="lazy"></iframe>),
      expires_at: link.expires_at&.iso8601,
      created_at: link.created_at&.iso8601
    }
  end
end
