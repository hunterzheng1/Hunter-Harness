type NodeBuiltinLoader = { getBuiltinModule?: (id: string) => unknown };
type ProxyDetector = (value: object) => boolean;

function nodeProxyDetector(): ProxyDetector | null {
  try {
    const runtime = globalThis as typeof globalThis & { process?: NodeBuiltinLoader };
    const module = runtime.process?.getBuiltinModule?.("node:util/types");
    if (module === null || typeof module !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(module, "isProxy");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
      ? descriptor.value as ProxyDetector : null;
  } catch {
    return null;
  }
}

/** Node exposes a non-trapping Proxy intrinsic; unavailable runtimes fail closed. */
export function isRuntimeProxy(value: object): boolean {
  const detector = nodeProxyDetector();
  if (detector !== null) {
    try { return detector(value); } catch { return true; }
  }
  return true;
}
