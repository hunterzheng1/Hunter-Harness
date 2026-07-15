export interface ChunkWriteResult {
  receivedRanges: Array<{ start: number; end: number }>;
  complete: boolean;
}

export interface QuarantinedBlob {
  contentSha256: string;
  quarantinedAt: string;
}

export interface ArtifactStorage {
  hasBlob(contentSha256: string): Promise<boolean>;
  getBlob(contentSha256: string): Promise<Uint8Array>;
  putBlob(contentSha256: string, content: Uint8Array): Promise<void>;
  quarantineBlob(contentSha256: string, quarantinedAt: string): Promise<boolean>;
  listQuarantinedBlobs(): Promise<QuarantinedBlob[]>;
  restoreQuarantinedBlob(contentSha256: string): Promise<void>;
  deleteQuarantinedBlob(contentSha256: string): Promise<void>;
  writeSessionChunk(input: {
    sessionId: string;
    contentSha256: string;
    start: number;
    total: number;
    chunk: Uint8Array;
  }): Promise<ChunkWriteResult>;
  deleteSession(sessionId: string): Promise<void>;
}
