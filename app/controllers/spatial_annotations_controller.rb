# frozen_string_literal: true

class SpatialAnnotationsController < ApplicationController
  before_action :find_project_by_project_id
  before_action :authorize
  before_action :find_model

  protect_from_forgery with: :null_session, if: -> { request.format.json? }

  def index
    @annotations = @spatial_model.spatial_annotations.includes(:work_package, :author)
    render json: @annotations.map(&:as_json_payload)
  end

  def create
    @annotation = @spatial_model.spatial_annotations.build(annotation_params)
    @annotation.author = User.current

    if params[:create_work_package] == "true" && params[:wp_subject].present?
      wp = @project.work_packages.build(
        subject: params[:wp_subject],
        description: params[:wp_description] || @annotation.description,
        author: User.current,
        type: @project.types.first
      )
      wp.save(validate: false) if wp.valid?
      @annotation.work_package = wp if wp.persisted?
    elsif params[:work_package_id].present?
      @annotation.work_package_id = params[:work_package_id]
    end

    if @annotation.save
      render json: { success: true, annotation: @annotation.as_json_payload }, status: :created
    else
      render json: { success: false, errors: @annotation.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    @annotation = @spatial_model.spatial_annotations.find(params[:id])
    @annotation.destroy
    render json: { success: true }
  end

  private

  def find_model
    @spatial_model = SpatialModel.find_by!(id: params[:spatial_model_id], project: @project)
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def annotation_params
    params.require(:spatial_annotation).permit(
      :title,
      :description,
      :annotation_type,
      :color,
      :work_package_id,
      :thumbnail_base64,
      camera_viewpoint: {},
      geometry_data: {}
    )
  end
end
