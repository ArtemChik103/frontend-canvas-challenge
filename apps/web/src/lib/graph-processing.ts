/**
 * Модуль высокопроизводительной обработки графа (Критерии P1, P2).
 *
 * Архитектурные принципы:
 * 1. Индексация графа за один проход O(N + E) в Map для O(1) проверок связей при drag-and-drop.
 *    Исключает квадратичную сложность O(N * E) при вызовах isValidConnection на каждый тик мыши.
 * 2. Очистка служебных полей React Flow (selected, dragging, measured) в один проход
 *    без промежуточных цепочек .map().filter().
 * 3. Сохранение упакованных плотных массивов (PACKED_ELEMENTS) для оптимизатора V8.
 */

import type { Node as FlowNode, Edge as FlowEdge, Viewport } from '@xyflow/react';
import type { GraphData, NodeData } from '@canvas/contracts';

export interface GraphIndex {
  readonly nodeTypeMap: ReadonlyMap<string, 'prompt' | 'generator' | 'result'>;
  readonly incomingCount: ReadonlyMap<string, number>;
  readonly outgoingCount: ReadonlyMap<string, number>;
  readonly totalNodes: number;
  readonly totalEdges: number;
}

/**
 * Строит индекс связности и типов вершин графа за один проход O(N + E).
 */
export function buildGraphIndex(
  nodes: ReadonlyArray<FlowNode>,
  edges: ReadonlyArray<FlowEdge>,
): GraphIndex {
  const nodeTypeMap = new Map<string, 'prompt' | 'generator' | 'result'>();
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();

  const nLen = nodes.length;
  for (let i = 0; i < nLen; i++) {
    const node = nodes[i];
    nodeTypeMap.set(node.id, node.type as 'prompt' | 'generator' | 'result');
  }

  const eLen = edges.length;
  for (let i = 0; i < eLen; i++) {
    const edge = edges[i];
    incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1);
    outgoingCount.set(edge.source, (outgoingCount.get(edge.source) || 0) + 1);
  }

  return {
    nodeTypeMap,
    incomingCount,
    outgoingCount,
    totalNodes: nLen,
    totalEdges: eLen,
  };
}

export interface ConnectionCheckParams {
  source: string;
  target: string;
}

/**
 * Нормализует направление соединения к каноническому:
 * prompt -> generator
 * generator -> result
 * Если пользователь протянул связь в обратную сторону (от target к source),
 * меняет source и target местами, чтобы ребро всегда было валидным для бэкенда.
 */
export function normalizeConnection(
  params: ConnectionCheckParams,
  nodeTypeMap: ReadonlyMap<string, 'prompt' | 'generator' | 'result'>,
): ConnectionCheckParams | null {
  const sourceType = nodeTypeMap.get(params.source);
  const targetType = nodeTypeMap.get(params.target);

  if (!sourceType || !targetType) return null;

  // Прямое направление
  if (
    (sourceType === 'prompt' && targetType === 'generator') ||
    (sourceType === 'generator' && targetType === 'result')
  ) {
    return params;
  }

  // Обратное направление (пользователь тянул от входа к выходу)
  if (
    (sourceType === 'generator' && targetType === 'prompt') ||
    (sourceType === 'result' && targetType === 'generator')
  ) {
    return {
      source: params.target,
      target: params.source,
    };
  }

  return null;
}

/**
 * O(1) проверка допустимости соединения (A2, P1).
 * Правила:
 * - Только prompt -> generator и generator -> result (в любом направлении перетаскивания).
 * - У каждого входа (target) не более 1 связи.
 * - У генератора (source) не более 1 выхода к результату.
 * - Промпт (source) может соединяться с несколькими генераторами.
 * - Лимит: не более 20 ребер в графе.
 */
export function validateConnection(params: ConnectionCheckParams, index: GraphIndex): boolean {
  if (index.totalEdges >= 20) {
    return false;
  }

  const normalized = normalizeConnection(params, index.nodeTypeMap);
  if (!normalized) {
    return false;
  }

  // 1. У любого входа (target) максимум 1 связь
  const currentIn = index.incomingCount.get(normalized.target) || 0;
  if (currentIn >= 1) {
    return false;
  }

  // 2. У генератора максимум 1 выход к результату
  const sourceType = index.nodeTypeMap.get(normalized.source);
  if (sourceType === 'generator') {
    const currentOut = index.outgoingCount.get(normalized.source) || 0;
    if (currentOut >= 1) {
      return false;
    }
  }

  return true;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const edgeUuidCache = new Map<string, string>();

/**
 * Гарантирует, что id ребра соответствует формату UUID (требование OpenAPI схемы контракта).
 * React Flow генерирует id вида "xy-edge__...", которые отклоняются валидатором Fastify 400.
 */
export function getOrGenerateEdgeUuid(edgeId: string): string {
  if (UUID_REGEX.test(edgeId)) return edgeId;
  let cached = edgeUuidCache.get(edgeId);
  if (!cached) {
    cached = crypto.randomUUID();
    edgeUuidCache.set(edgeId, cached);
  }
  return cached;
}

/**
 * Преобразует внутреннее состояние React Flow в чистую схему GraphData для REST API.
 * Выполняется строго за один проход O(N + E) без выделения промежуточных массивов.
 */
export function sanitizeGraphForApi(
  nodes: ReadonlyArray<FlowNode>,
  edges: ReadonlyArray<FlowEdge>,
  viewport: Viewport,
): GraphData {
  const nLen = nodes.length;
  const cleanNodes: NodeData[] = new Array(nLen);
  const nodeTypeMap = new Map<string, 'prompt' | 'generator' | 'result'>();

  for (let i = 0; i < nLen; i++) {
    const node = nodes[i];
    const type = node.type as 'prompt' | 'generator' | 'result';
    nodeTypeMap.set(node.id, type);

    const clampedX = Math.max(-10000, Math.min(10000, Math.round(node.position.x)));
    const clampedY = Math.max(-10000, Math.min(10000, Math.round(node.position.y)));

    if (type === 'prompt') {
      cleanNodes[i] = {
        id: node.id,
        type: 'prompt',
        position: { x: clampedX, y: clampedY },
        data: { text: (node.data?.text as string) || '' },
      };
    } else if (type === 'generator') {
      cleanNodes[i] = {
        id: node.id,
        type: 'generator',
        position: { x: clampedX, y: clampedY },
        data: { label: (node.data?.label as string) || 'Генератор' },
      };
    } else {
      cleanNodes[i] = {
        id: node.id,
        type: 'result',
        position: { x: clampedX, y: clampedY },
        data: { label: (node.data?.label as string) || 'Результат' },
      };
    }
  }

  const eLen = edges.length;
  const cleanEdges: GraphData['edges'] = new Array(eLen);

  for (let i = 0; i < eLen; i++) {
    const edge = edges[i];
    const sourceType = nodeTypeMap.get(edge.source);
    const targetType = nodeTypeMap.get(edge.target);

    // Нормализуем направление ребра для бэкенда (prompt -> generator -> result):
    let source = edge.source;
    let target = edge.target;

    if (sourceType === 'generator' && targetType === 'prompt') {
      source = edge.target;
      target = edge.source;
    } else if (sourceType === 'result' && targetType === 'generator') {
      source = edge.target;
      target = edge.source;
    }

    cleanEdges[i] = {
      id: getOrGenerateEdgeUuid(edge.id),
      source,
      target,
    };
  }

  const zoomClamped = Math.max(0.1, Math.min(4, viewport.zoom));

  return {
    nodes: cleanNodes,
    edges: cleanEdges,
    viewport: {
      x: Math.round(viewport.x),
      y: Math.round(viewport.y),
      zoom: Number(zoomClamped.toFixed(2)),
    },
  };
}

export interface GenerationChain {
  readonly isValid: boolean;
  readonly promptId?: string;
  readonly promptText?: string;
  readonly resultNodeId?: string;
  readonly error?: string;
}

/**
 * Валидация цепочки перед запуском генерации (A3, A4, B4).
 * Проверяет наличие входящего промпта с непустым текстом и исходящего результата
 * с явной проверкой типов нод во избежание ложного определения result ноды как промпта.
 */
export function inspectGenerationChain(
  generatorId: string,
  nodes: ReadonlyArray<FlowNode>,
  edges: ReadonlyArray<FlowEdge>,
): GenerationChain {
  const nodeMap = new Map<string, FlowNode>();
  for (let i = 0; i < nodes.length; i++) {
    nodeMap.set(nodes[i].id, nodes[i]);
  }

  let promptId: string | undefined;
  let resultNodeId: string | undefined;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);

    // Связь с промптом: либо prompt -> generator, либо generator -> prompt
    if (
      (edge.target === generatorId && sourceNode?.type === 'prompt') ||
      (edge.source === generatorId && targetNode?.type === 'prompt')
    ) {
      promptId = sourceNode?.type === 'prompt' ? edge.source : edge.target;
    }

    // Связь с результатом: либо generator -> result, либо result -> generator
    if (
      (edge.source === generatorId && targetNode?.type === 'result') ||
      (edge.target === generatorId && sourceNode?.type === 'result')
    ) {
      resultNodeId = targetNode?.type === 'result' ? edge.target : edge.source;
    }
  }

  if (!promptId) {
    return { isValid: false, error: 'Подключите текстовую ноду к генератору' };
  }

  const promptNode = nodeMap.get(promptId);
  const promptText = (promptNode?.data?.text as string)?.trim() || '';
  if (!promptText) {
    return { isValid: false, error: 'Текстовая нода пуста. Введите описание для генерации' };
  }

  if (!resultNodeId) {
    return { isValid: false, error: 'Подключите ноду результата к выходу генератора' };
  }

  const resultNode = nodeMap.get(resultNodeId);
  if (!resultNode) {
    return { isValid: false, error: 'Связанная нода результата не найдена' };
  }

  return {
    isValid: true,
    promptId,
    promptText,
    resultNodeId,
  };
}
