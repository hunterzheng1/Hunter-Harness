export interface ServerConfig {
  maxFileBytes: number;
  maxUploadFiles: number;
  maxProposalBytes: number;
  maxChunkBytes: number;
  sessionTtlMs: number;
}

export const defaultServerConfig: ServerConfig = {
  maxFileBytes: 10 * 1024 * 1024,
  maxUploadFiles: 100,
  maxProposalBytes: 50 * 1024 * 1024,
  maxChunkBytes: 4 * 1024 * 1024,
  sessionTtlMs: 24 * 60 * 60 * 1000
};
