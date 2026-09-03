# frozen_string_literal: true

module OpenProject
  module SpatialViewer
    module Patches
      module AttachmentPatch
        extend ActiveSupport::Concern

        included do
          alias_method :orig_internal_container?, :internal_container?

          def internal_container?
            orig_internal_container? || container.is_a?(SpatialModel)
          end
        end
      end
    end
  end
end
