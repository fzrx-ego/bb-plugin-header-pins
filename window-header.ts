import { useLayoutEffect, useState, type RefObject } from "react";

// Keep the first pane's pins beside the window controls. Other split panes and
// compact/browser layouts use their own title slots.
export function useWindowHeaderPins(anchor: RefObject<HTMLSpanElement | null>): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const marker = anchor.current;
    if (marker === null) return;
    const host = document.createElement("div");
    host.dataset.headerPinsWindow = "";
    const wide = window.matchMedia("(min-width: 768px)");
    let frame: number | null = null;
    let controls: Element | null = null;
    let row: Element | null = null;
    let actions: Element | null = null;
    const resize = new ResizeObserver(() => schedule());
    const detach = () => {
      marker.removeAttribute("data-window-header-pins");
      host.remove();
      setContainer(null);
    };
    const update = () => {
      const main = marker.closest('main[data-sidebar="inset"]');
      const header = marker.closest('[data-testid="app-page-header-content-row"]');
      const titleBar = document.querySelector('[data-testid="app-layout-root"][data-framed] [data-testid="app-window-title-bar"]');
      if (!wide.matches || !main || !header || !titleBar ||
          main.querySelector('[data-testid="app-page-header-content-row"]') !== header) {
        detach();
        return;
      }
      const headerActions = header.children[1];
      const windowControls = titleBar.firstElementChild;
      if (!headerActions || !windowControls) {
        detach();
        return;
      }
      if (controls !== windowControls || row !== header || actions !== headerActions) {
        resize.disconnect();
        controls = windowControls;
        row = header;
        actions = headerActions;
        resize.observe(controls);
        resize.observe(row);
        resize.observe(actions);
      }
      const barRect = windowControls.getBoundingClientRect();
      const rowRect = header.getBoundingClientRect();
      const left = barRect.right + 8;
      const right = headerActions.getBoundingClientRect().left - 8;
      host.style.left = `${left}px`;
      host.style.top = `${rowRect.top}px`;
      host.style.width = `${Math.max(0, right - left)}px`;
      host.style.height = `${rowRect.height}px`;
      marker.dataset.windowHeaderPins = "";
      if (!host.isConnected) document.body.append(host);
      setContainer(host);
    };
    function schedule() {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    }
    const chromeSelector = '[data-testid="app-window-title-bar"], [data-testid="app-page-header-content-row"]';
    const mutations = new MutationObserver((records) => {
      // Timeline updates do not affect header geometry.
      if (records.some(({ target, addedNodes, removedNodes }) =>
        (target instanceof Element && target.closest(chromeSelector) !== null) ||
        Array.from(addedNodes).concat(Array.from(removedNodes)).some((node) => node instanceof Element &&
          (node.matches(chromeSelector) || node.querySelector(chromeSelector) !== null)),
      )) schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    wide.addEventListener("change", schedule);
    // Sidebar transitions move the action group without changing its width.
    document.addEventListener("transitionend", schedule);
    update();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      wide.removeEventListener("change", schedule);
      document.removeEventListener("transitionend", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      marker.removeAttribute("data-window-header-pins");
      host.remove();
    };
  }, [anchor]);
  return container;
}
