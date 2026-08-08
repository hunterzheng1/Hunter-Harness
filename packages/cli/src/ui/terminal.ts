const terminalEscape = String.fromCharCode(27);
const terminalBell = String.fromCharCode(7);
const ansiOscPattern = new RegExp(
  `${terminalEscape}\\][\\s\\S]*?(?:${terminalBell}|${terminalEscape}\\\\)`,
  "g"
);
const ansiCsiPattern = new RegExp(`${terminalEscape}\\[[0-?]*[ -/]*[@-~]`, "g");
const ansiOtherPattern = new RegExp(`${terminalEscape}.`, "g");
const terminalControlPattern = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  "g"
);

/** Remove terminal control sequences and collapse remote/user text to one safe line. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(ansiOscPattern, "")
    .replace(ansiCsiPattern, "")
    .replace(ansiOtherPattern, "")
    .replace(terminalControlPattern, " ")
    .replace(/\s+/g, " ")
    .trim();
}
