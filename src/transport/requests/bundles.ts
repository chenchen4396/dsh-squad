import type { BundleImportMode, BundleImportSummary, SquadBundle } from '../../domain/bundle.js'

/** Moving configuration in and out as a file. */
export interface BundlesRequests {
  'bundle.export': {
    payload: { teamIds?: string[] | undefined }
    result: SquadBundle
  }
  'bundle.import': {
    payload: { bundle: SquadBundle; mode: BundleImportMode }
    result: BundleImportSummary
  }
}
