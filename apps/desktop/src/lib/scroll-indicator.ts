export const SCROLLING_ATTRIBUTE = 'data-scrolling';
const HIDE_DELAY_MS = 800;

export function scrolledElement(target: EventTarget | null, doc: Document): Element | null {
  if (target === doc) {
    return doc.documentElement;
  }
  return target instanceof Element ? target : null;
}

export function installScrollIndicator(doc: Document, hideDelayMs = HIDE_DELAY_MS): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event) => {
    const element = scrolledElement(event.target, doc);
    if (!element) {
      return;
    }
    element.setAttribute(SCROLLING_ATTRIBUTE, '');
    clearTimeout(timers.get(element));
    timers.set(
      element,
      setTimeout(() => {
        element.removeAttribute(SCROLLING_ATTRIBUTE);
        timers.delete(element);
      }, hideDelayMs),
    );
  };

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };
}
