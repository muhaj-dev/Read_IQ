// Scan OCR — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. The camera/scan screens, the preview and
// the confirm flow are all real; reading text out of the photo needs a vision
// model, which this build has none of.
//
// To wire this up later: implement `extractImageText` against a vision provider.

import { BtlError } from './btl';

/** Not implemented — returns nothing; the Scan screen falls back to manual entry. */
export async function extractImageText(_uri: string): Promise<string> {
  throw new BtlError('not-configured');
}
