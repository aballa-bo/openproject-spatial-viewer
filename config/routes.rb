# frozen_string_literal: true

OpenProject::Application.routes.draw do
  scope 'projects/:project_id', as: 'project' do
    resources :spatial_models, controller: 'spatial_models' do
      member do
        get :api_data
        get :model_file
        patch :set_start_view
        get :download_exe
      end
      resources :spatial_layers, controller: 'spatial_layers', only: [:create, :update, :destroy] do
        member do
          get :file
        end
      end
      resources :spatial_annotations, controller: 'spatial_annotations', only: [:index, :create, :update, :destroy] do
        member do
          get :snapshot
        end
      end
    end
  end

  # Global routes
  resources :spatial_models, only: [:index]
end
