# frozen_string_literal: true

OpenProject::Application.routes.draw do
  scope 'projects/:project_id', as: 'project' do
    resources :spatial_models, controller: 'spatial_models' do
      member do
        get :api_data
        get :model_file
        patch :set_start_view
        patch :set_saved_view
        get :download_exe
      end
      resources :spatial_layers, controller: 'spatial_layers', only: [:create, :update, :destroy] do
        member do
          get :file
          get :octree
          get :hierarchy
        end
      end
      resources :spatial_share_links, controller: 'spatial_share_links', only: [:index, :create, :destroy]
      resources :spatial_annotations, controller: 'spatial_annotations', only: [:index, :create, :update, :destroy] do
        member do
          get :snapshot
        end
      end
    end
  end

  # Anonymous, token-protected, read-only viewer for iframes (e.g. Moodle).
  scope 'spatial_embed/:token', constraints: { token: /[A-Za-z0-9_-]+/ }, controller: 'spatial_embed' do
    get '/', action: :show, as: :spatial_embed
    get 'api_data', action: :api_data, as: :spatial_embed_api_data
    get 'model_file', action: :model_file, as: :spatial_embed_model_file
    get 'layers/:layer_id/file', action: :layer_file, as: :spatial_embed_layer_file
    get 'layers/:layer_id/octree', action: :layer_octree, as: :spatial_embed_layer_octree
  end

  # Global routes
  resources :spatial_models, only: [:index]
end
