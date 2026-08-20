import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { buildPdfExtractDocument } from '@/lib/pdf-extract-doc';
import { PDFJS_MAX_CHARS, PDFJS_MAX_PAGES, PDFJS_URL, PDFJS_WORKER_URL } from '@/lib/pdfjs';
import { usePdfExtractStore } from '@/store/use-pdf-extract-store';

/** Runs the headless pdf.js extractor for whatever job is queued.
 *
 *  Mounted once at the app root and never visible: the WebView is 0×0 inside a
 *  `none`-pointer-events wrapper, because a PDF being read is not a screen the
 *  student is on — Upload shows its own status while this works underneath.
 *  Rendering nothing at all when idle is deliberate too, so an app that never
 *  opens a PDF never pays for a WebView. */
export function PdfExtractHost() {
  const active = usePdfExtractStore((s) => s.active);
  const resolve = usePdfExtractStore((s) => s.resolve);
  const fail = usePdfExtractStore((s) => s.fail);

  if (!active) return null;

  const onMessage = (event: WebViewMessageEvent) => {
    let msg: {
      type?: string;
      text?: string;
      pages?: number;
      totalPages?: number;
      truncated?: boolean;
      message?: string;
    };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (msg.type === 'text') {
      resolve(active.id, {
        text: typeof msg.text === 'string' ? msg.text : '',
        pages: msg.pages ?? 0,
        totalPages: msg.totalPages ?? 0,
        truncated: msg.truncated === true,
      });
    } else if (msg.type === 'error') {
      fail(active.id, msg.message ?? 'extraction failed');
    }
  };

  return (
    <View pointerEvents="none" style={styles.host}>
      <WebView
        // Keyed by job so each PDF gets a clean page rather than a reused one
        // still holding the last document's memory.
        key={active.id}
        originWhitelist={['*']}
        source={{
          html: buildPdfExtractDocument({
            pdfBase64: active.base64,
            pdfjsUrl: PDFJS_URL,
            pdfjsWorkerUrl: PDFJS_WORKER_URL,
            maxPages: PDFJS_MAX_PAGES,
            maxChars: PDFJS_MAX_CHARS,
          }),
        }}
        onMessage={onMessage}
        // The page can't report a load failure it never loaded for.
        onError={() => fail(active.id, 'webview-failed')}
        javaScriptEnabled
        // No user-visible surface, so none of the scroll/inset behaviour applies.
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    width: 0,
    height: 0,
    opacity: 0,
  },
  web: {
    width: 0,
    height: 0,
  },
});
