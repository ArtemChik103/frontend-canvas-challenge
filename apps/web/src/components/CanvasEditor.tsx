import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type Viewport,
} from '@xyflow/react';
import type { SpaceData, GraphData, GenerationData } from '@canvas/contracts';
import { api, type AppError } from '../lib/api-client.js';
import { pollUntil } from '../lib/poll.js';
import {
  buildGraphIndex,
  validateConnection,
  normalizeConnection,
  sanitizeGraphForApi,
  inspectGenerationChain,
} from '../lib/graph-processing.js';
import { useGraphSync } from '../hooks/useGraphSync.js';
import { PromptNode } from './nodes/PromptNode.js';
import { GeneratorNode } from './nodes/GeneratorNode.js';
import { ResultNode } from './nodes/ResultNode.js';

const nodeTypes = {
  prompt: PromptNode,
  generator: GeneratorNode,
  result: ResultNode,
};

export interface CanvasEditorProps {
  space: SpaceData;
  onSwitchSpace?: () => void;
}

export const CanvasEditor: React.FC<CanvasEditorProps> = ({ space, onSwitchSpace }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });

  const nodesRef = useRef<FlowNode[]>(nodes);
  nodesRef.current = nodes;

  const edgesRef = useRef<FlowEdge[]>(edges);
  edgesRef.current = edges;

  const viewportRef = useRef<Viewport>(viewport);
  viewportRef.current = viewport;

  const [bannerError, setBannerError] = useState<string | null>(null);

  const activePollingControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Синхронизация графа с debounce 500 мс и очередью
  const {
    saveStatus,
    lastError: saveError,
    currentETag,
    setETag,
    queueSave,
    flushSave,
  } = useGraphSync({
    spaceId: space.id,
    initialETag: null,
    onConflict: () => {
      setBannerError(
        'Конфликт версии графа (412): данные на сервере изменились. Нажмите «Перечитать граф».',
      );
    },
  });

  // Загрузка графа и истории генераций
  const loadGraph = useCallback(async () => {
    setBannerError(null);

    try {
      const graphRes = await api.request<GraphData>(`/api/spaces/${space.id}/graph`);
      const graph = graphRes.data;
      setETag(graphRes.etag);

      // Загружаем существующие генерации, чтобы восстановить картинки в result нодах (B3)
      let generations: GenerationData[] = [];
      try {
        generations = await api.get<GenerationData[]>(`/api/spaces/${space.id}/generations`);
      } catch {
        // Если генераций нет — продолжаем
      }

      // Индексируем генерации по resultNodeId (берем самую свежую попытку)
      const genByResult = new Map<string, GenerationData>();
      for (let i = 0; i < generations.length; i++) {
        const g = generations[i];
        if (!genByResult.has(g.resultNodeId)) {
          genByResult.set(g.resultNodeId, g);
        }
      }

      // Формируем ноды для React Flow
      const flowNodes = graph.nodes.map((n) => {
        const gen = genByResult.get(n.id);
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          data: {
            ...n.data,
            imageUrl: gen?.status === 'succeeded' ? gen.imageUrl : null,
            errorMessage: gen?.status === 'failed' ? gen.failureCode || 'Ошибка генерации' : null,
            isProcessing: gen?.status === 'processing',
            onChangeText: handlePromptTextChange,
            onGenerate: handleTriggerGenerate,
            onDeleteNode: handleDeleteNode,
            onRetry: handleRetryGenerate,
          },
        };
      });

      setNodes(flowNodes);
      setEdges(graph.edges);
      if (graph.viewport) {
        setViewport(graph.viewport);
      }

      // Возобновляем опрос незавершенных генераций (B3)
      generations.forEach((gen) => {
        if (gen.status === 'processing') {
          monitorGeneration(gen.id, gen.nodeId, gen.resultNodeId);
        }
      });
    } catch (err) {
      const appErr = err as AppError;
      setBannerError(`Ошибка загрузки графа: ${appErr.message}`);
    }
  }, [space.id, setETag]);

  useEffect(() => {
    loadGraph();
    return () => {
      // Прерываем все активные опросы при размонтировании (B4)
      activePollingControllersRef.current.forEach((ctrl) => ctrl.abort());
      activePollingControllersRef.current.clear();
    };
  }, [loadGraph]);

  // Триггер автосохранения при изменении нод/ребер/viewport
  const triggerSave = useCallback(() => {
    const clean = sanitizeGraphForApi(nodesRef.current, edgesRef.current, viewportRef.current);
    queueSave(clean);
  }, [queueSave]);

  // Обработчики нод
  function handlePromptTextChange(nodeId: string, newText: string) {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === nodeId) {
          return { ...node, data: { ...node.data, text: newText } };
        }
        return node;
      }),
    );
    nodesRef.current = nodesRef.current.map((node) => {
      if (node.id === nodeId) {
        return { ...node, data: { ...node.data, text: newText } };
      }
      return node;
    });
    const clean = sanitizeGraphForApi(nodesRef.current, edgesRef.current, viewportRef.current);
    queueSave(clean);
  }

  function handleDeleteNode(nodeId: string) {
    // При удалении ноды каскадно удаляем связанные ребра (A2)
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));

    nodesRef.current = nodesRef.current.filter((n) => n.id !== nodeId);
    edgesRef.current = edgesRef.current.filter((e) => e.source !== nodeId && e.target !== nodeId);

    const clean = sanitizeGraphForApi(nodesRef.current, edgesRef.current, viewportRef.current);
    queueSave(clean);
  }

  // Валидация соединений на лету (A2, P1) с поддержкой любого направления перетаскивания
  const checkIsValidConnection = useCallback((connection: Connection | FlowEdge) => {
    if (!connection.source || !connection.target) return false;
    const currentIndex = buildGraphIndex(nodesRef.current, edgesRef.current);
    return validateConnection(
      { source: connection.source, target: connection.target },
      currentIndex,
    );
  }, []);

  const handleConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      const currentIndex = buildGraphIndex(nodesRef.current, edgesRef.current);
      const normalized = normalizeConnection(
        { source: params.source, target: params.target },
        currentIndex.nodeTypeMap,
      );
      if (normalized && validateConnection(normalized, currentIndex)) {
        const sourceType = currentIndex.nodeTypeMap.get(normalized.source);
        const targetType = currentIndex.nodeTypeMap.get(normalized.target);
        const sourceHandle = sourceType === 'prompt' ? 'prompt-out' : 'gen-out';
        const targetHandle = targetType === 'result' ? 'result-in' : 'gen-in';
        const edgeId = crypto.randomUUID();

        const edgeWithUuid: FlowEdge = {
          ...params,
          id: edgeId,
          source: normalized.source,
          target: normalized.target,
          sourceHandle,
          targetHandle,
        };

        setEdges((eds) => addEdge(edgeWithUuid, eds));
        edgesRef.current = addEdge(edgeWithUuid, edgesRef.current);

        const clean = sanitizeGraphForApi(nodesRef.current, edgesRef.current, viewportRef.current);
        queueSave(clean);
      }
    },
    [queueSave, setEdges],
  );

  // Добавление новых нод
  const handleAddNode = (type: 'prompt' | 'generator' | 'result') => {
    if (nodesRef.current.length >= 20) {
      setBannerError('Достигнут максимум нод в одном графе (20)');
      return;
    }

    const id = crypto.randomUUID();
    const offset = nodesRef.current.length * 20;

    const basePositions = {
      prompt: { x: 50 + offset, y: 100 + offset },
      generator: { x: 380 + offset, y: 100 + offset },
      result: { x: 720 + offset, y: 100 + offset },
    };

    const initialData = {
      prompt: { text: 'Горы на рассвете' },
      generator: { label: 'Генератор' },
      result: { label: 'Результат', imageUrl: null, errorMessage: null },
    }[type];

    const newNode: FlowNode = {
      id,
      type,
      position: basePositions[type],
      data: {
        ...initialData,
        onChangeText: handlePromptTextChange,
        onGenerate: handleTriggerGenerate,
        onDeleteNode: handleDeleteNode,
        onRetry: handleRetryGenerate,
      },
    };

    setNodes((nds) => [...nds, newNode]);
    nodesRef.current = [...nodesRef.current, newNode];
    const clean = sanitizeGraphForApi(nodesRef.current, edgesRef.current, viewportRef.current);
    queueSave(clean);
  };

  // Мониторинг асинхронной генерации
  const monitorGeneration = useCallback(
    async (generationId: string, generatorId: string, resultNodeId: string) => {
      const abortCtrl = new AbortController();
      activePollingControllersRef.current.set(generationId, abortCtrl);

      try {
        const finalGen = await pollUntil<GenerationData>({
          fn: () =>
            api.get<GenerationData>(`/api/spaces/${space.id}/generations/${generationId}`, {
              signal: abortCtrl.signal,
            }),
          isDone: (g) => g.status === 'succeeded' || g.status === 'failed',
          intervalMs: 1500,
          signal: abortCtrl.signal,
        });

        // Проверяем, существует ли еще нода результата и привязана ли она к этому результату (B4)
        setNodes((nds) =>
          nds.map((node) => {
            if (node.id === resultNodeId) {
              return {
                ...node,
                data: {
                  ...node.data,
                  isProcessing: false,
                  imageUrl: finalGen.status === 'succeeded' ? finalGen.imageUrl : null,
                  errorMessage:
                    finalGen.status === 'failed' ? finalGen.failureCode || 'Сбой симуляции' : null,
                },
              };
            }
            if (node.id === generatorId) {
              return {
                ...node,
                data: {
                  ...node.data,
                  isGenerating: false,
                  statusMessage: finalGen.status === 'succeeded' ? 'Готово!' : 'Сбой',
                },
              };
            }
            return node;
          }),
        );
      } catch (err) {
        const appErr = err as AppError;
        if (appErr.kind !== 'abort') {
          setNodes((nds) =>
            nds.map((node) => {
              if (node.id === resultNodeId) {
                return {
                  ...node,
                  data: { ...node.data, isProcessing: false, errorMessage: appErr.message },
                };
              }
              if (node.id === generatorId) {
                return { ...node, data: { ...node.data, isGenerating: false } };
              }
              return node;
            }),
          );
        }
      } finally {
        activePollingControllersRef.current.delete(generationId);
      }
    },
    [space.id, setNodes],
  );

  // Запуск генерации (A3, A4, B1, B2)
  async function handleTriggerGenerate(generatorId: string, scenario: 'success' | 'failure') {
    setBannerError(null);

    // 1. Проверяем валидность цепочки
    const chain = inspectGenerationChain(generatorId, nodesRef.current, edgesRef.current);
    if (!chain.isValid) {
      setBannerError(chain.error || 'Неполная цепочка нод');
      return;
    }

    const { resultNodeId } = chain;

    // 2. Гарантированно сохраняем все неотправленные правки графа (A3, B1)
    let latestETag: string | null = null;
    try {
      latestETag = await flushSave();
    } catch (saveErr) {
      setBannerError('Не удалось сохранить последние изменения графа перед генерацией');
      return;
    }

    if (!latestETag) {
      latestETag = currentETag;
    }

    // 3. Индикация в нодах генератора и результата
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === generatorId) {
          return {
            ...node,
            data: { ...node.data, isGenerating: true, statusMessage: 'Отправка...' },
          };
        }
        if (node.id === resultNodeId) {
          return { ...node, data: { ...node.data, isProcessing: true, errorMessage: null } };
        }
        return node;
      }),
    );

    // 4. Отправляем запрос создания генерации с Idempotency-Key
    const idempotencyKey = crypto.randomUUID();

    try {
      const genRes = await api.request<GenerationData>(`/api/spaces/${space.id}/generations`, {
        method: 'POST',
        idempotencyKey,
        body: {
          nodeId: generatorId,
          graphETag: latestETag,
          scenario,
        },
      });

      const generation = genRes.data;

      // 5. Запускаем опрос статуса
      monitorGeneration(generation.id, generatorId, resultNodeId!);
    } catch (err) {
      const appErr = err as AppError;
      setBannerError(`Ошибка запуска генерации: ${appErr.message}`);
      setNodes((nds) =>
        nds.map((node) => {
          if (node.id === generatorId) {
            return { ...node, data: { ...node.data, isGenerating: false, statusMessage: null } };
          }
          if (node.id === resultNodeId) {
            return {
              ...node,
              data: { ...node.data, isProcessing: false, errorMessage: appErr.message },
            };
          }
          return node;
        }),
      );
    }
  }

  function handleRetryGenerate(resultNodeId: string) {
    // Находим генератор, подключенный к этой ноде результата
    const edge = edgesRef.current.find((e) => e.target === resultNodeId);
    if (edge) {
      handleTriggerGenerate(edge.source, 'success');
    }
  }

  return (
    <div className="canvas-layout">
      <header className="canvas-header">
        <div className="header-brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect width="7" height="7" x="3" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="14" rx="1" />
            <rect width="7" height="7" x="3" y="14" rx="1" />
          </svg>
          <span>{space.title}</span>
        </div>

        <div className="header-center">
          <span
            className={`save-badge ${saveStatus}`}
            title={saveError ? saveError.message : undefined}
          >
            <span className="badge-dot" />
            {saveStatus === 'saved' && 'Сохранено'}
            {saveStatus === 'saving' && 'Сохранение...'}
            {saveStatus === 'unsaved' && 'Есть несохраненные правки'}
            {saveStatus === 'conflict' && 'Конфликт (412)'}
            {saveStatus === 'error' && 'Ошибка сохранения'}
          </span>
        </div>

        <div className="header-actions">
          {onSwitchSpace && (
            <button type="button" className="btn secondary sm" onClick={onSwitchSpace}>
              Пространства
            </button>
          )}
          <button
            type="button"
            className="btn outline sm"
            onClick={loadGraph}
            title="Заново прочитать состояние графа с сервера"
          >
            Перечитать граф
          </button>
        </div>
      </header>

      {bannerError && (
        <div className="conflict-banner" role="alert">
          <span>{bannerError}</span>
          <button type="button" className="conflict-banner-btn" onClick={loadGraph}>
            Обновить граф
          </button>
        </div>
      )}

      <div className="flow-container">
        <div className="canvas-toolbar" role="toolbar" aria-label="Инструменты канваса">
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => handleAddNode('prompt')}
            disabled={nodes.length >= 20}
          >
            + Текст
          </button>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => handleAddNode('generator')}
            disabled={nodes.length >= 20}
          >
            + Генератор
          </button>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => handleAddNode('result')}
            disabled={nodes.length >= 20}
          >
            + Результат
          </button>
        </div>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={(changes) => {
            onNodesChange(changes);
            triggerSave();
          }}
          onEdgesChange={(changes) => {
            onEdgesChange(changes);
            triggerSave();
          }}
          onConnect={handleConnect}
          isValidConnection={checkIsValidConnection}
          nodeTypes={nodeTypes}
          onMoveEnd={(_, newViewport) => {
            setViewport(newViewport);
            triggerSave();
          }}
          fitView
          aria-label="Редактор нод генерации изображений"
        >
          <Background color="#cbd5e1" gap={16} />
          <Controls />
          <MiniMap nodeStrokeWidth={3} />
        </ReactFlow>
      </div>
    </div>
  );
};
