import type { Request, Response } from "express";

export interface RuntimeProxyAbortLifecycle {
  controller: AbortController;
  cleanup(): void;
}

/**
 * Bind an upstream fetch to the full downstream response lifetime.
 *
 * Express' request `aborted` event only covers an incomplete inbound request.
 * Once a small POST body has been fully received, a browser that disconnects
 * while reading a long response instead closes the ServerResponse. Listen to
 * both sides so a pooled request cannot continue running after its client has
 * gone away.
 */
export function createRuntimeProxyAbortLifecycle(
  req: Request,
  res: Response,
): RuntimeProxyAbortLifecycle {
  const controller = new AbortController();
  const abort = (reason: string) => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(reason));
    }
  };
  const onRequestAborted = () =>
    abort("The downstream request was aborted before completion.");
  const onResponseClosed = () => {
    if (!res.writableEnded) {
      abort("The downstream response closed before completion.");
    }
  };
  const onSocketClosed = () => {
    if (!res.writableEnded) {
      abort("The downstream socket closed before response completion.");
    }
  };

  req.once("aborted", onRequestAborted);
  res.once("close", onResponseClosed);
  req.socket.once("close", onSocketClosed);

  return {
    controller,
    cleanup() {
      req.off("aborted", onRequestAborted);
      res.off("close", onResponseClosed);
      req.socket.off("close", onSocketClosed);
    },
  };
}

/**
 * Pipe an upstream Fetch response into Express while propagating cancellation
 * into the body reader. The caller owns response headers and the abort
 * lifecycle; this function owns the reader and always releases it.
 */
export async function pipeRuntimeResponseBody(
  res: Response,
  response: globalThis.Response,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) {
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();

  try {
    while (!signal?.aborted && !res.destroyed) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted || res.destroyed) break;
      res.write(Buffer.from(value));
    }
  } catch (error) {
    if (!signal?.aborted && !res.destroyed) throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
