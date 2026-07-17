/** Keep the window from jumping to the top during in-place UI transitions. */
export function runPreservingWindowScroll(action: () => void): void {
  if (typeof window === "undefined") {
    action();
    return;
  }
  const x = window.scrollX;
  const y = window.scrollY;
  action();
  const restore = (): void => {
    if (window.scrollX !== x || window.scrollY !== y) {
      window.scrollTo(x, y);
    }
  };
  restore();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  }
}

/** Prevent mouse-click focus from scrolling the focused control into view. */
export function suppressMouseFocusScroll(event: { preventDefault: () => void }): void {
  event.preventDefault();
}
