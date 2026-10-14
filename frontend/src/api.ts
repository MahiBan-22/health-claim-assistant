// Hosted projects set VITE_API_BASE to the separate backend's HTTPS origin.
export const base: string = (
  import.meta.env.VITE_API_BASE?.trim() ||
  (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8000")
).replace(/\/+$/, "");

let reviewer = false;
export const setReviewerMode = (value: boolean) => {
  reviewer = value;
};
const roleHeaders = (): Record<string, string> =>
  reviewer ? { "X-Workspace-Role": "reviewer" } : {};

async function request(path: string, options: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(base + path, {
      ...options,
      headers: { ...roleHeaders(), ...(options.headers || {}) },
    });
  } catch {
    throw new Error(
      "The workspace service is not responding. Check that the app is running, then try again.",
    );
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      typeof result.detail === "string"
        ? result.detail
        : "Something went wrong (" + response.status + "). Please try again.",
    );
  }
  return response;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return (await request(path, options)).json() as Promise<T>;
}
export const send = <T>(path: string, method: string, body?: unknown) =>
  api<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
export const blob = async (path: string) => (await request(path)).blob();

export function saveFile(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Server-sent snapshots over fetch, with bounded reconnects. Returns a stop function. */
export function listen<T>(
  path: string,
  onData: (data: T) => void,
  onState: (live: boolean) => void,
) {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  async function connect() {
    try {
      const response = await fetch(base + path, {
        headers: roleHeaders(),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("unavailable");
      onState(true);
      delay = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("ended");
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (event.startsWith("data: ") && !controller.signal.aborted)
            onData(JSON.parse(event.slice(6)) as T);
        }
      }
    } catch {
      if (controller.signal.aborted) return;
      onState(false);
      retry = setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
  void connect();
  return () => {
    controller.abort();
    if (retry) clearTimeout(retry);
  };
}
