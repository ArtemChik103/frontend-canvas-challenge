/**
 * Обобщенный механизм опроса асинхронных операций (D5).
 * Переиспользуется для отслеживания генерации изображения с учетом Retry-After и AbortSignal.
 */

export interface PollOptions<T> {
  readonly fn: () => Promise<T>;
  readonly isDone: (value: T) => boolean;
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly getDelay?: (value: T) => number | undefined;
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const { fn, isDone, intervalMs = 1000, maxAttempts = 60, signal, getDelay } = options;

  let attempts = 0;

  while (attempts < maxAttempts) {
    if (signal?.aborted) {
      throw new DOMException('Опрос прерван', 'AbortError');
    }

    attempts++;
    const result = await fn();

    if (isDone(result)) {
      return result;
    }

    if (attempts >= maxAttempts) {
      break;
    }

    const customDelay = getDelay ? getDelay(result) : undefined;
    const delay = customDelay !== undefined && customDelay >= 0 ? customDelay : intervalMs;

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new DOMException('Опрос прерван', 'AbortError'));
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delay);

      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new DOMException('Опрос прерван', 'AbortError'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  throw new Error('Превышено максимальное время ожидания генерации');
}
