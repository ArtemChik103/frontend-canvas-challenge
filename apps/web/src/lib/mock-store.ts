import type { SpaceData, GraphData, GenerationData, GenerationRequest } from '@canvas/contracts';

const STORAGE_SPACES_KEY = 'canvas_mock_spaces_v1';
const STORAGE_GRAPHS_KEY = 'canvas_mock_graphs_v1';
const STORAGE_GENERATIONS_KEY = 'canvas_mock_generations_v1';

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `"${hex}${hex}${hex}${hex}${hex}${hex}${hex}${hex}"`.slice(0, 66);
}

function defaultInitialGraph(): GraphData {
  const promptId = '11111111-1111-4111-8111-111111111111';
  const generatorId = '22222222-2222-4222-8222-222222222222';
  const resultId = '33333333-3333-4333-8333-333333333333';
  const edge1Id = '44444444-4444-4444-8444-444444444444';
  const edge2Id = '55555555-5555-4555-8555-555555555555';

  return {
    nodes: [
      {
        id: promptId,
        type: 'prompt',
        position: { x: 100, y: 160 },
        data: { text: 'Уютный деревянный домик на берегу горного озера на закате' },
      },
      {
        id: generatorId,
        type: 'generator',
        position: { x: 420, y: 160 },
        data: { label: 'Генератор изображений v1' },
      },
      {
        id: resultId,
        type: 'result',
        position: { x: 740, y: 160 },
        data: { label: 'Результат генерации' },
      },
    ],
    edges: [
      { id: edge1Id, source: promptId, target: generatorId },
      { id: edge2Id, source: generatorId, target: resultId },
    ],
    viewport: { x: 50, y: 50, zoom: 1 },
  };
}

export class MockCanvasStore {
  private getSpacesMap(): Record<string, SpaceData> {
    try {
      const raw = localStorage.getItem(STORAGE_SPACES_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}

    const id = '00000000-0000-4000-8000-000000000001';
    const initialSpace: SpaceData = {
      id,
      title: 'Мое рабочее пространство',
      createdAt: new Date().toISOString(),
      links: {
        self: { href: `/api/spaces/${id}`, method: 'GET' },
        graph: { href: `/api/spaces/${id}/graph`, method: 'GET' },
        saveGraph: { href: `/api/spaces/${id}/graph`, method: 'PUT' },
        generations: { href: `/api/spaces/${id}/generations`, method: 'GET' },
        createGeneration: { href: `/api/spaces/${id}/generations`, method: 'POST' },
      },
    };
    const map = { [id]: initialSpace };
    this.saveSpacesMap(map);
    this.saveGraph(id, defaultInitialGraph());
    return map;
  }

  private saveSpacesMap(map: Record<string, SpaceData>): void {
    try {
      localStorage.setItem(STORAGE_SPACES_KEY, JSON.stringify(map));
    } catch {}
  }

  public getSpaces(): SpaceData[] {
    return Object.values(this.getSpacesMap());
  }

  public getSpace(id: string): SpaceData | null {
    return this.getSpacesMap()[id] || null;
  }

  public createSpace(title: string): SpaceData {
    const id = crypto.randomUUID();
    const newSpace: SpaceData = {
      id,
      title: title.trim() || 'Новое пространство',
      createdAt: new Date().toISOString(),
      links: {
        self: { href: `/api/spaces/${id}`, method: 'GET' },
        graph: { href: `/api/spaces/${id}/graph`, method: 'GET' },
        saveGraph: { href: `/api/spaces/${id}/graph`, method: 'PUT' },
        generations: { href: `/api/spaces/${id}/generations`, method: 'GET' },
        createGeneration: { href: `/api/spaces/${id}/generations`, method: 'POST' },
      },
    };
    const map = this.getSpacesMap();
    map[id] = newSpace;
    this.saveSpacesMap(map);
    this.saveGraph(id, defaultInitialGraph());
    return newSpace;
  }

  public getGraph(spaceId: string): { data: GraphData; etag: string } {
    try {
      const raw = localStorage.getItem(`${STORAGE_GRAPHS_KEY}_${spaceId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { data: parsed.data, etag: parsed.etag || simpleHash(JSON.stringify(parsed.data)) };
      }
    } catch {}
    const defaultGraph = defaultInitialGraph();
    const etag = simpleHash(JSON.stringify(defaultGraph));
    this.saveGraph(spaceId, defaultGraph);
    return { data: defaultGraph, etag };
  }

  public saveGraph(spaceId: string, graph: GraphData, _ifMatch?: string): { data: GraphData; etag: string } {
    const rawData = JSON.stringify(graph);
    const etag = simpleHash(rawData);
    try {
      localStorage.setItem(
        `${STORAGE_GRAPHS_KEY}_${spaceId}`,
        JSON.stringify({ data: graph, etag }),
      );
    } catch {}
    return { data: graph, etag };
  }

  public getGenerations(spaceId: string): GenerationData[] {
    try {
      const raw = localStorage.getItem(`${STORAGE_GENERATIONS_KEY}_${spaceId}`);
      if (raw) {
        const list: Array<GenerationData & { settlesAt?: number }> = JSON.parse(raw);
        const now = Date.now();
        return list.map((g) => {
          const settlesAt = g.settlesAt ?? 0;
          const status = now < settlesAt ? 'processing' : g.scenario === 'success' ? 'succeeded' : 'failed';
          return {
            ...g,
            status,
            imageUrl: status === 'succeeded' ? '/assets/demo.svg' : null,
            failureCode: status === 'failed' ? 'SIMULATED_FAILURE' : null,
          };
        });
      }
    } catch {}
    return [];
  }

  public createGeneration(spaceId: string, body: GenerationRequest): GenerationData {
    const id = crypto.randomUUID();
    const graphData = this.getGraph(spaceId).data;

    let resultNodeId = '';
    const edge = graphData.edges.find((e) => e.source === body.nodeId);
    if (edge) {
      resultNodeId = edge.target;
    } else {
      const resNode = graphData.nodes.find((n) => n.type === 'result');
      resultNodeId = resNode ? resNode.id : crypto.randomUUID();
    }

    let promptText = '';
    const promptEdge = graphData.edges.find((e) => e.target === body.nodeId);
    if (promptEdge) {
      const pNode = graphData.nodes.find((n) => n.id === promptEdge.source);
      if (pNode && pNode.type === 'prompt') {
        promptText = pNode.data.text || '';
      }
    }

    const settlesAt = Date.now() + 1500;
    const newGen: GenerationData & { settlesAt: number } = {
      id,
      spaceId,
      nodeId: body.nodeId,
      resultNodeId,
      prompt: promptText,
      graphETag: body.graphETag,
      scenario: body.scenario,
      status: 'processing',
      createdAt: new Date().toISOString(),
      imageUrl: null,
      failureCode: null,
      settlesAt,
      links: {
        self: { href: `/api/spaces/${spaceId}/generations/${id}`, method: 'GET' },
        graph: { href: `/api/spaces/${spaceId}/graph`, method: 'GET' },
        image: { href: '/assets/demo.svg', method: 'GET' },
      },
    };

    const current = this.getGenerations(spaceId) as Array<GenerationData & { settlesAt?: number }>;
    current.unshift(newGen);
    try {
      localStorage.setItem(`${STORAGE_GENERATIONS_KEY}_${spaceId}`, JSON.stringify(current));
    } catch {}

    return newGen;
  }

  public getGeneration(spaceId: string, generationId: string): GenerationData | null {
    const list = this.getGenerations(spaceId);
    return list.find((g) => g.id === generationId) || null;
  }
}

export const mockStore = new MockCanvasStore();
