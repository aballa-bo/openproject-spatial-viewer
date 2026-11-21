# frozen_string_literal: true

# Anonymous, read-only viewer for iframes (Moodle quizzes etc.).
#
# Access is granted ONLY by the secret token of a SpatialShareLink and only to
# that link's model. Nothing here writes, and the annotation data sent to the
# browser is stripped of everything that could give the answer away (title,
# description, work package, author): the viewer just opens on the saved
# viewpoint with the damaged area spot-lit.
#
# Frame-ancestors defaults to any origin; restrict with the environment
# variable SPATIAL_VIEWER_EMBED_ORIGINS="https://moodle.example.edu https://…".
class SpatialEmbedController < ApplicationController
  skip_before_action :check_if_login_required
  # Access is decided by the secret share token (find_share), not by roles.
  no_authorization_required! :show, :api_data, :model_file, :layer_file, :layer_octree
  before_action :find_share
  before_action :allow_framing
  after_action :drop_frame_options

  layout "spatial_embed"

  def show
    @embed = true
    @spatial_model = @share.spatial_model
    @project = @spatial_model.project
    @api_url = spatial_embed_api_data_path(token: params[:token])
    @spatial_model.enqueue_conversion
    render template: "spatial_embed/show"
  end

  def api_data
    model = @share.spatial_model
    model.enqueue_conversion if model.needs_conversion?
    model.spatial_layers.each do |l|
      l.enqueue_conversion if l.needs_conversion?
      l.enqueue_octree if l.octree_applicable?
    end

    file_size = if model.needs_conversion? && model.converted_file_ready?
                  model.converted_file_path.size
                else
                  model.model_attachment&.filesize
                end

    render json: {
      id: model.id,
      title: model.title,
      description: nil,
      model_format: model.viewer_format,
      source_format: model.model_format,
      model_url: (model.model_attachment.present? ? spatial_embed_model_file_path(token: params[:token]) : nil),
      file_size:,
      conversion: conversion_payload(model),
      layers: layers_payload(model),
      settings: settings_payload(model),
      annotations: annotations_payload,
      work_packages: [],
      can_annotate: false,
      embed: true
    }
  end

  def model_file
    model = @share.spatial_model
    attachment = model.model_attachment
    return render_404 if attachment.blank?

    if model.needs_conversion?
      return serve_pending(model) unless model.converted_file_ready?

      send_file model.converted_file_path.to_s, filename: "model.glb", type: "model/gltf-binary", disposition: "inline"
    elsif File.exist?(attachment.diskfile.path)
      zip = File.extname(attachment.filename.to_s).casecmp(".zip").zero?
      type = zip ? "application/zip" : (SpatialModelsController::MODEL_CONTENT_TYPES[model.model_format] || "application/octet-stream")
      send_file attachment.diskfile.path, filename: attachment.filename, type:, disposition: "inline"
    else
      render_404
    end
  end

  def layer_file
    layer = find_layer
    return render_404 unless layer

    types = SpatialLayersController::LAYER_CONTENT_TYPES
    if layer.needs_conversion?
      return serve_pending(layer) unless layer.converted_file_ready?

      send_file layer.converted_file_path.to_s, filename: "layer-#{layer.id}.#{layer.viewer_format}",
                                                  type: types[layer.viewer_format] || "application/octet-stream", disposition: "inline"
    else
      attachment = layer.file_attachment
      return render_404 unless attachment && File.exist?(attachment.diskfile.path)

      zip = File.extname(attachment.filename.to_s).casecmp(".zip").zero?
      send_file attachment.diskfile.path, filename: attachment.filename,
                                          type: (zip ? "application/zip" : (types[layer.source_format] || "application/octet-stream")),
                                          disposition: "inline"
    end
  end

  def layer_octree
    layer = find_layer
    node = params[:node].to_s
    return render_404 unless layer && node.match?(/\A(hierarchy|r[0-7]{0,24})\z/)

    path = layer.octree_dir.join(node == "hierarchy" ? "hierarchy.json" : "#{node}.bin")
    return render_404 unless layer.octree_ready? && path.file?

    expires_in 1.day, public: false
    send_file path.to_s, type: node == "hierarchy" ? "application/json" : "application/octet-stream", disposition: "inline"
  end

  private

  def find_share
    @share = SpatialShareLink.includes(:spatial_model, :spatial_annotation).find_active(params[:token])
    return render_404 unless @share && @share.spatial_model.project&.active?
  end

  def find_layer
    @share.spatial_model.spatial_layers.find_by(id: params[:layer_id])
  end

  # Textured glTF needs blob:/data: connect-src (see SpatialModelsController);
  # embedding needs frame-ancestors opened up for the Moodle origin(s).
  def allow_framing
    origins = ENV["SPATIAL_VIEWER_EMBED_ORIGINS"].to_s.split.presence || %w[*]
    append_content_security_policy_directives(connect_src: %w[blob: data:], frame_ancestors: origins)
  end

  def drop_frame_options
    response.headers.delete("X-Frame-Options")
  end

  def serve_pending(record)
    record.enqueue_conversion
    state = record.conversion_state
    render json: { status: state["status"].presence || "pending", message: state["message"] }
  end

  def conversion_payload(model)
    return nil unless model.needs_conversion?
    return { status: "error", message: "No IFC file is attached to this model." } if model.model_attachment.blank?

    state = model.conversion_state
    { status: model.converted_file_ready? ? "completed" : (state["status"].presence || "pending"), message: state["message"] }
  end

  def layers_payload(model)
    out = []
    if model.model_attachment.present?
      converted = model.needs_conversion? && model.converted_file_ready?
      out << {
        id: "model", title: model.title, kind: SpatialLayer.kind_for(model.model_format),
        source_format: model.model_format, format: model.viewer_format, visible: true,
        url: spatial_embed_model_file_path(token: params[:token]),
        conversion: conversion_payload(model),
        file_size: (converted ? model.converted_file_path.size : model.model_attachment.filesize)
      }
    end

    model.spatial_layers.each do |layer|
      next if layer.file_attachment.blank?

      converted = layer.needs_conversion? && layer.converted_file_ready?
      out << {
        id: layer.id, title: layer.title, kind: layer.kind, source_format: layer.source_format,
        format: layer.viewer_format, visible: layer.visible, selection_layer_id: layer.selection_layer_id, exposure: layer.exposure, scale: layer.scale,
        url: spatial_embed_layer_file_path(token: params[:token], layer_id: layer.id),
        conversion: layer.conversion_payload,
        file_size: (converted ? layer.converted_file_path.size : layer.file_attachment.filesize),
        octree_url: (layer.octree_ready? ? spatial_embed_layer_octree_path(token: params[:token], layer_id: layer.id, v: layer.file_attachment.id) : nil)
      }
    end
    out
  end

  # The model's saved start view, overridden by the annotation's camera when
  # the link points at one.
  def settings_payload(model)
    settings = (model.settings || {}).deep_stringify_keys
    cam = @share.spatial_annotation&.camera_viewpoint
    if cam.is_a?(Hash) && cam["eye"].is_a?(Array) && cam["target"].is_a?(Array)
      settings["start_view"] = {
        "position" => { "x" => cam["eye"][0], "y" => cam["eye"][1], "z" => cam["eye"][2] },
        "target" => { "x" => cam["target"][0], "y" => cam["target"][1], "z" => cam["target"][2] }
      }
    end
    settings
  end

  # Only what is needed to frame and highlight the area. NO title,
  # description, work package, author or snapshot: those would reveal the
  # answer of the question.
  def annotations_payload
    a = @share.spatial_annotation
    return [] unless a

    [{
      id: a.id, title: "", description: "", annotation_type: a.annotation_type, color: a.color,
      camera_viewpoint: a.camera_viewpoint, geometry_data: a.geometry_data
    }]
  end
end
