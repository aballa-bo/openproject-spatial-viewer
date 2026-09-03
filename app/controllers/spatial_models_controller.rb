# frozen_string_literal: true

class SpatialModelsController < ApplicationController
  before_action :find_project_by_project_id
  before_action :authorize
  before_action :find_model, only: %i[show edit update destroy api_data model_file]

  menu_item :spatial_models
  layout 'base'

  def index
    @models = SpatialModel.where(project: @project).includes(:uploader).order(is_default: :desc, created_at: :desc)
  end

  def show
    @annotations = @spatial_model.spatial_annotations.includes(:work_package, :author).order(created_at: :desc)
    @work_packages = @project.work_packages.visible.order(updated_at: :desc).limit(50)
  end

  def new
    @spatial_model = SpatialModel.new(project: @project, uploader: User.current)
  end

  def create
    @spatial_model = SpatialModel.new(model_params)
    @spatial_model.project = @project
    @spatial_model.uploader = User.current

    if @spatial_model.save
      if params[:file].present?
        attachment = Attachment.new(
          container: @spatial_model,
          author: User.current,
          file: params[:file],
          description: @spatial_model.title
        )
        unless attachment.save
          flash[:error] = "Model created, but file attachment failed: #{attachment.errors.full_messages.join(', ')}"
          redirect_to edit_project_spatial_model_path(@project, @spatial_model)
          return
        end
      end
      flash[:notice] = I18n.t('notice_successful_create')
      redirect_to project_spatial_model_path(@project, @spatial_model)
    else
      render :new
    end
  end

  def edit
  end

  def update
    if @spatial_model.update(model_params)
      if params[:file].present?
        attachment = Attachment.new(
          container: @spatial_model,
          author: User.current,
          file: params[:file],
          description: @spatial_model.title
        )
        if attachment.save
          @spatial_model.attachments.where.not(id: attachment.id).destroy_all
        else
          flash[:error] = "Model details saved, but file replacement failed: #{attachment.errors.full_messages.join(', ')}"
          redirect_to edit_project_spatial_model_path(@project, @spatial_model)
          return
        end
      end
      flash[:notice] = I18n.t('notice_successful_update')
      redirect_to project_spatial_model_path(@project, @spatial_model)
    else
      render :edit
    end
  end

  def destroy
    @spatial_model.destroy
    flash[:notice] = I18n.t('notice_successful_delete')
    redirect_to project_spatial_models_path(@project)
  end

  def model_file
    attachment = @spatial_model.model_attachment
    if attachment.present? && File.exist?(attachment.file.path)
      send_file attachment.file.path,
                filename: attachment.filename,
                type: attachment.content_type || 'application/octet-stream',
                disposition: 'inline'
    else
      render_404
    end
  end

  def api_data
    annotations_json = @spatial_model.spatial_annotations.includes(:work_package, :author).map(&:as_json_payload)
    work_packages_json = @project.work_packages.visible.order(updated_at: :desc).limit(100).map do |wp|
      {
        id: wp.id,
        subject: wp.subject,
        status: wp.status&.name,
        type: wp.type&.name,
        priority: wp.priority&.name,
        assigned_to: wp.assigned_to&.name
      }
    end

    file_url = if @spatial_model.model_attachment.present?
                 model_file_project_spatial_model_path(@project, @spatial_model)
               end

    render json: {
      id: @spatial_model.id,
      title: @spatial_model.title,
      description: @spatial_model.description,
      model_format: @spatial_model.model_format,
      model_url: file_url,
      settings: @spatial_model.settings,
      annotations: annotations_json,
      work_packages: work_packages_json,
      can_annotate: User.current.allowed_in_project?(:create_spatial_annotations, @project)
    }
  end

  private

  def find_model
    @spatial_model = SpatialModel.find_by!(id: params[:id], project: @project)
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def model_params
    params.require(:spatial_model).permit(:title, :description, :model_format, :is_default)
  end
end
