declare module "libnpmpublish" {
  export function publish(
    manifest: Record<string, unknown>,
    tarballData: Buffer | Uint8Array,
    options?: {
      token?: string;
      forceAuth?: { token?: string };
      [key: string]: unknown;
    }
  ): Promise<unknown>;
}
