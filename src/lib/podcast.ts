// "From Your Notes" study podcast — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. The episode player, transcript view,
// host turns, voice picker and playback controls are all real UI; writing the
// two-host script from a note needs an AI provider, which this build has none of.
//
// To wire this up later: implement `generateEpisodeScript` to return a grounded
// script. The store already stamps noteId + content hash + createdAt around it.

import type { PodcastCoverage, PodcastTurn } from '@/types/podcast';

import { BtlError } from './btl';
import { hashContent } from './hash';

// Re-exported so existing importers keep working now that hashContent moved to lib/hash.
export { hashContent };

/** What the scriptwriter returns (before we stamp noteId + hash + createdAt). */
export type EpisodeScript = {
  title: string;
  coverage: PodcastCoverage;
  turns: PodcastTurn[];
};

/** Not implemented — episode generation needs an AI provider. */
export async function generateEpisodeScript(_note: {
  title: string;
  subject: string | null;
  content: string;
}): Promise<EpisodeScript> {
  throw new BtlError('not-configured');
}
