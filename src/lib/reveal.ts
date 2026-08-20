// Typewriter reveal — shared by every streaming-looking answer in Ask.
//
// Nothing here is actually waiting on a network stream. The text is already in
// hand by the time this runs, but an answer that lands whole reads as a canned
// string, and the chat bubble's typing state is driven by deltas. Aborting stops
// the reveal; the caller still holds the finished text either way.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Feed `text` to `onToken` a few words at a time. No-op without a callback. */
export async function reveal(
  text: string,
  onToken?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!onToken) return;
  const parts = text.match(/\S+\s*/g) ?? [];
  for (let i = 0; i < parts.length; i += 4) {
    if (signal?.aborted) return;
    onToken(parts.slice(i, i + 4).join(''));
    await sleep(16);
  }
}
