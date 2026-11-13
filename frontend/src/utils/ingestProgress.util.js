const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  `http://${window.location.hostname || 'localhost'}:2020`;

export const STAGE_LABELS = {
  uploaded: 'File received…',
  extracting: 'Extracting content…',
  ocr_processing: 'Running OCR…',
  chunking: 'Chunking document…',
  indexing: 'Indexing in knowledge base…',
  completed: 'File processed successfully.',
  failed: 'File processing failed.',
};

export const INGEST_STEPS = [
  { id: 'uploaded', label: 'Received' },
  { id: 'extracting', label: 'Extract' },
  { id: 'ocr_processing', label: 'OCR' },
  { id: 'chunking', label: 'Chunk' },
  { id: 'indexing', label: 'Index' },
];

export const INITIAL_INGEST_STATE = {
  status: 'idle',
  fileName: null,
  stage: null,
  message: '',
  percent: 0,
  meta: {},
};

export function formatProgressMessage(event) {
  if (!event) return '';

  const { stage, message, meta } = event;

  if (stage === 'ocr_processing' && meta?.page && meta?.total_pages) {
    return `Running OCR (page ${meta.page}/${meta.total_pages})…`;
  }

  if (message) return message;

  return STAGE_LABELS[stage] || 'Processing…';
}

export function getStageIndex(stage) {
  const idx = INGEST_STEPS.findIndex((step) => step.id === stage);
  return idx >= 0 ? idx : -1;
}

export function computeProgressPercent(event) {
  if (!event) return 0;

  const { stage, meta } = event;
  if (stage === 'completed') return 100;
  if (stage === 'failed') return 0;

  const stageBase = {
    uploaded: 10,
    extracting: 25,
    ocr_processing: 30,
    chunking: 80,
    indexing: 95,
  };

  let percent = stageBase[stage] ?? 5;

  if (stage === 'ocr_processing' && meta?.page && meta?.total_pages) {
    const ocrStart = 30;
    const ocrEnd = 70;
    const ratio = meta.page / meta.total_pages;
    percent = ocrStart + (ocrEnd - ocrStart) * ratio;
  }

  return Math.min(Math.round(percent), stage === 'indexing' ? 99 : 99);
}

export function buildIngestStatePatch(event, fileName) {
  return {
    fileName: event?.meta?.file_name || fileName,
    stage: event?.stage ?? null,
    message: formatProgressMessage(event),
    percent: computeProgressPercent(event),
    meta: event?.meta || {},
  };
}

export function subscribeIngestProgress(jobId, { onEvent, onError, onComplete } = {}) {
  const url = `${apiBaseUrl}/job-progress/${encodeURIComponent(jobId)}`;
  const source = new EventSource(url);

  source.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      onEvent?.(event);

      if (event.stage === 'completed') {
        source.close();
        onComplete?.('completed', event);
      } else if (event.stage === 'failed') {
        source.close();
        onComplete?.('failed', event);
      }
    } catch (err) {
      onError?.(err);
    }
  };

  source.onerror = () => {
    source.close();
    onError?.(new Error('SSE connection failed'));
  };

  return () => source.close();
}

export function waitForIngestProgress(jobId, { onEvent } = {}) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const cleanup = subscribeIngestProgress(jobId, {
      onEvent,
      onError: () => {
        cleanup();
        finish({ ok: false, fallback: true });
      },
      onComplete: (status, event) => {
        cleanup();
        finish({
          ok: status === 'completed',
          fallback: false,
          event,
        });
      },
    });
  });
}
