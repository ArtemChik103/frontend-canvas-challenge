import { useState, useRef, useCallback, useEffect } from 'react';
import type { GraphData } from '@canvas/contracts';
import { api, type AppError } from '../lib/api-client.js';

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'conflict' | 'error';

export interface UseGraphSyncOptions {
  spaceId: string | null;
  initialETag: string | null;
  onConflict?: () => void;
}

export function useGraphSync({ spaceId, initialETag, onConflict }: UseGraphSyncOptions) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [lastError, setLastError] = useState<AppError | null>(null);

  const etagRef = useRef<string | null>(initialETag);
  const pendingGraphRef = useRef<GraphData | null>(null);
  const inFlightPromiseRef = useRef<Promise<string | null> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Обновление ETag извне (например, при первичном GET или reload)
  const setETag = useCallback((etag: string | null) => {
    etagRef.current = etag;
  }, []);

  /**
   * Выполняет сохранение графа с соблюдением строгой последовательности (B1).
   * Если предыдущий PUT еще выполняется, следующий встает в очередь
   * и использует ETag, полученный из ответа предыдущего.
   */
  const executeSave = useCallback(
    async (graphToSave: GraphData): Promise<string | null> => {
      if (!spaceId) return null;

      if (inFlightPromiseRef.current) {
        await inFlightPromiseRef.current;
      }

      if (isMountedRef.current) {
        setSaveStatus('saving');
        setLastError(null);
      }

      const currentEtag = etagRef.current;

      const saveOperation = (async () => {
        try {
          const res = await api.request<GraphData>(`/api/spaces/${spaceId}/graph`, {
            method: 'PUT',
            ifMatch: currentEtag || undefined,
            body: graphToSave,
          });

          const newETag = res.etag;
          if (newETag) {
            etagRef.current = newETag;
          }

          // Если пока выполнялся этот запрос, появились новые правки
          if (pendingGraphRef.current && pendingGraphRef.current !== graphToSave) {
            const nextGraph = pendingGraphRef.current;
            pendingGraphRef.current = null;
            return executeSave(nextGraph);
          }

          if (isMountedRef.current) {
            setSaveStatus('saved');
          }
          return newETag;
        } catch (err) {
          const appErr = err as AppError;
          if (isMountedRef.current) {
            setLastError(appErr);
            if (appErr.status === 412 || appErr.code === 'GRAPH_VERSION_CONFLICT') {
              setSaveStatus('conflict');
              if (onConflict) onConflict();
            } else {
              setSaveStatus('error');
            }
          }
          throw appErr;
        } finally {
          inFlightPromiseRef.current = null;
        }
      })();

      inFlightPromiseRef.current = saveOperation;
      return saveOperation;
    },
    [spaceId, onConflict],
  );

  /**
   * Добавляет состояние графа в очередь с debounce 500 мс (B1).
   */
  const queueSave = useCallback(
    (graph: GraphData) => {
      pendingGraphRef.current = graph;
      if (isMountedRef.current) {
        setSaveStatus('unsaved');
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (pendingGraphRef.current) {
          const toSave = pendingGraphRef.current;
          pendingGraphRef.current = null;
          executeSave(toSave).catch(() => {});
        }
      }, 500);
    },
    [executeSave],
  );

  /**
   * Немедленно отправляет все отложенные правки без ожидания debounce-таймера (A3).
   * Вызывается перед запуском генерации.
   */
  const flushSave = useCallback(async (): Promise<string | null> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (pendingGraphRef.current) {
      const toSave = pendingGraphRef.current;
      pendingGraphRef.current = null;
      return executeSave(toSave);
    }

    if (inFlightPromiseRef.current) {
      return inFlightPromiseRef.current;
    }

    return etagRef.current;
  }, [executeSave]);

  return {
    saveStatus,
    lastError,
    currentETag: etagRef.current,
    setETag,
    queueSave,
    flushSave,
  };
}
