export interface Debouncer {
  trigger: () => void;
  cancel: () => void;
}

export function debounce(callback: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    trigger: () => {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        callback();
      }, delayMs);
    },
    cancel,
  };
}
