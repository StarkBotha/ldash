const ENDPOINT = '/api/client-log';

export function logClientError(message: string, extra?: Record<string, unknown>): void {
  const body = JSON.stringify({ level: 'error', message, ...extra });
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => {
      // fire-and-forget: ignore network failures
    });
  } catch {
    // never let logging break the app
  }
}

function installGlobalHandlers(): void {
  window.onerror = (message, source, lineno, colno, error) => {
    const msg = typeof message === 'string' ? message : String(message);
    logClientError(msg, {
      stack: error?.stack,
      url: source ?? window.location.href,
    });
    // Return false so default browser error handling still runs
    return false;
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : String(reason ?? 'Unhandled promise rejection');
    logClientError(message, {
      stack: reason instanceof Error ? reason.stack : undefined,
      url: window.location.href,
    });
  });
}

installGlobalHandlers();
