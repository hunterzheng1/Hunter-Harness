/**
 * Compatibility facade. Runtime discovery is owned by core so command
 * packages cannot become a second source of truth.
 */
export {
  probePythonRuntime,
  resolvePythonRuntime
} from "@hunter-harness/core";
export type {
  PythonProbeResult,
  PythonRuntimeResolution,
  PythonRuntimeSource,
  ResolvePythonRuntimeOptions
} from "@hunter-harness/core";
