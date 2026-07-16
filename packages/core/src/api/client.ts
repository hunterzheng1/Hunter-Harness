import { sha256Bytes } from "../fs/hash.js";
import { withRetry } from "./retry.js";

export interface ApiClientOptions {
  serverUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  retryAttempts?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    details: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

class RetryableResponseError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super("retryable HTTP response: " + response.status);
    this.response = response;
  }
}

interface RequestOptions {
  requestId: string;
  idempotencyKey?: string;
  body?: unknown;
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
}

export class HunterHarnessApiClient {
  readonly serverUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly token: string;
  readonly sleep: ((milliseconds: number) => Promise<void>) | undefined;
  readonly retryAttempts: number;

  constructor(options: ApiClientOptions) {
    const url = new URL(options.serverUrl);
    if (url.protocol !== "https:") {
      throw new Error("server URL must use HTTPS");
    }
    if (options.token.trim() === "") {
      throw new Error("API token is required");
    }
    this.serverUrl = url.toString().replace(/\/$/, "");
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep;
    this.retryAttempts = options.retryAttempts ?? 3;
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions
  ): Promise<T> {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: "Bearer " + this.token,
      "X-Request-Id": options.requestId,
      ...options.headers
    });
    if (options.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    let body: RequestInit["body"];
    if (options.rawBody !== undefined) {
      body = options.rawBody as unknown as RequestInit["body"];
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await withRetry(async () => {
        const value = await this.fetch(this.serverUrl + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body })
        });
        if (value.status === 429 || value.status >= 500) {
          throw new RetryableResponseError(value);
        }
        return value;
      }, {
        attempts: this.retryAttempts,
        ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
        shouldRetry: () => true
      });
    } catch (error) {
      if (error instanceof RetryableResponseError) {
        response = error.response;
      } else {
        throw error;
      }
    }
    const text = await response.text();
    const payload = text === "" ? {} : JSON.parse(text) as Record<string, unknown>;
    if (!response.ok) {
      const envelope = payload.error as Record<string, unknown> | undefined;
      throw new ApiError(
        response.status,
        typeof envelope?.code === "string" ? envelope.code : "HTTP_ERROR",
        typeof envelope?.message === "string" ? envelope.message : "server request failed",
        typeof envelope?.request_id === "string" ? envelope.request_id : null,
        envelope?.details ?? {}
      );
    }
    return payload as T;
  }

  async resolveProject(
    body: object,
    requestId: string,
    idempotencyKey: string
  ): Promise<{
    schema_version: 1;
    project_id: string;
    binding_status: "created" | "bound";
    project_version: string | null;
    baseline_manifest: unknown;
    request_id: string;
  }> {
    return this.request("POST", "/api/v1/projects:resolve", {
      requestId, idempotencyKey, body
    });
  }

  async getProject(
    projectId: string,
    requestId: string
  ): Promise<{
    schema_version: 1;
    project_id: string;
    latest_project_version: string | null;
    latest_artifact_id: string | null;
    request_id: string;
  }> {
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId),
      { requestId }
    );
  }

  async createProposalSession(
    projectId: string,
    body: object,
    requestId: string,
    idempotencyKey: string
  ): Promise<{
    session_id: string;
    expires_at: string;
    missing_blobs: string[];
    max_chunk_bytes: number;
    request_id: string;
  }> {
    return this.request(
      "POST",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/proposal-sessions",
      { requestId, idempotencyKey, body }
    );
  }

  async queryBlobs(
    sessionId: string,
    hashes: string[],
    requestId: string,
    idempotencyKey: string
  ): Promise<{ present: string[]; missing: string[]; request_id: string }> {
    return this.request(
      "POST",
      "/api/v1/proposal-sessions/" + encodeURIComponent(sessionId) + "/blobs:query",
      { requestId, idempotencyKey, body: { content_sha256: hashes } }
    );
  }

  async uploadBlobChunk(options: {
    sessionId: string;
    contentSha256: string;
    chunk: Uint8Array;
    start: number;
    total: number;
    requestId: string;
    idempotencyKey: string;
  }): Promise<{ verified?: boolean; received_ranges?: unknown[] }> {
    const end = options.start + options.chunk.byteLength - 1;
    return this.request(
      "PUT",
      "/api/v1/proposal-sessions/" + encodeURIComponent(options.sessionId) +
        "/blobs/" + encodeURIComponent(options.contentSha256),
      {
        requestId: options.requestId,
        idempotencyKey: options.idempotencyKey,
        rawBody: options.chunk,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": "bytes " + options.start + "-" + end + "/" + options.total,
          "X-Chunk-SHA256": sha256Bytes(options.chunk)
        }
      }
    );
  }

  async finalizeProposal(
    sessionId: string,
    body: {
      schema_version: 1;
      manifest_sha256: string;
      base_artifact_id: string | null;
      sensitive_scan_skip?: true;
      sensitive_scan_skip_reason?: string;
    },
    requestId: string,
    idempotencyKey: string
  ): Promise<{
    proposal_id: string;
    status: "approved";
    artifact_id: string | null;
    received_files: number;
    request_id: string;
  }> {
    return this.request(
      "POST",
      "/api/v1/proposal-sessions/" + encodeURIComponent(sessionId) + ":finalize",
      { requestId, idempotencyKey, body }
    );
  }

  async getUpdateManifest(
    projectId: string,
    query: {
      base_project_version: string | null;
      base_manifest_hash: string;
      adapter: string;
      profile: string;
    },
    requestId: string
  ): Promise<{
    schema_version: 1;
    project_id: string;
    observed_project_version: string | null;
    artifact_id: string | null;
    artifact_manifest_url: string | null;
    delta_available: boolean;
    request_id: string;
  }> {
    const parameters = new URLSearchParams({
      base_project_version: query.base_project_version ?? "",
      base_manifest_hash: query.base_manifest_hash,
      adapter: query.adapter,
      profile: query.profile
    });
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) +
        "/update-manifest?" + parameters.toString(),
      { requestId }
    );
  }

  async getArtifactManifest<T>(
    artifactId: string,
    requestId: string
  ): Promise<T> {
    return this.request(
      "GET",
      "/api/v1/artifacts/" + encodeURIComponent(artifactId) + "/manifest",
      { requestId }
    );
  }

  async downloadArtifactBlob(
    artifactId: string,
    contentSha256: string,
    requestId: string
  ): Promise<Uint8Array> {
    const response = await withRetry(async () => {
      const value = await this.fetch(
        this.serverUrl + "/api/v1/artifacts/" + encodeURIComponent(artifactId) +
          "/blobs/" + encodeURIComponent(contentSha256),
        {
          headers: {
            Accept: "application/octet-stream",
            Authorization: "Bearer " + this.token,
            "X-Request-Id": requestId
          }
        }
      );
      if (value.status === 429 || value.status >= 500) {
        throw new RetryableResponseError(value);
      }
      return value;
    }, {
      attempts: this.retryAttempts,
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      shouldRetry: () => true
    });
    if (!response.ok) {
      const payload = await response.json() as {
        error?: { code?: string; message?: string; request_id?: string; details?: unknown };
      };
      throw new ApiError(
        response.status,
        payload.error?.code ?? "HTTP_ERROR",
        payload.error?.message ?? "artifact download failed",
        payload.error?.request_id ?? null,
        payload.error?.details ?? {}
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.headers.get("X-Content-SHA256") !== contentSha256 ||
        sha256Bytes(bytes) !== contentSha256) {
      throw new ApiError(
        422,
        "ARTIFACT_HASH_MISMATCH",
        "artifact blob integrity check failed",
        response.headers.get("X-Request-Id"),
        {}
      );
    }
    return bytes;
  }
}
