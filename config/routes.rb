# frozen_string_literal: true

OpenProject::Application.routes.draw do
  scope 'projects/:project_id', as: 'project' do
    resources :spatial_models, controller: 'spatial_models' do
      member do
        get :api_data
        get :model_file
      end
      resources :spatial_annotations, controller: 'spatial_annotations', only: [:index, :create, :update, :destroy]
    end
  end

  # Global routes
  resources :spatial_models, only: [:index]
end
