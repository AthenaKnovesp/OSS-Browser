export interface TrailingDebounce {
  schedule: () => void;
  cancel: () => void;
}

export function createTrailingDebounce(callback: () => void, delayMs: number): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    schedule: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        callback();
      }, delayMs);
    },
    cancel: () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
