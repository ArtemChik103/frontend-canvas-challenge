/**
 * Единый HTTP-клиент (D1, D2, D3, D4, D8).
 * Централизованная отправка, разбор статусов/заголовков (ETag, Retry-After) и нормализация ошибок.
 */

import { mockStore } from './mock-store.js';

export interface AppError {
  readonly kind: 'http' | 'network' | 'parse' | 'abort';
  readonly status?: number;
  readonly code?: string;
  readonly message: string;
  readonly requestId?: string;
  readonly headers?: Headers;
  readonly raw?: unknown;
}

export function isAppError(err: unknown): err is AppError {
  return typeof err === 'object' && err !== null && 'kind' in err && 'message' in err;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
}

export interface HttpResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  readonly etag: string | null;
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private buildUrl(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return this.baseUrl ? `${this.baseUrl}${cleanPath}` : cleanPath;
  }

  private normalizeError(error: unknown, status?: number, headers?: Headers): AppError {
    const reqId = headers?.get('x-request-id') || undefined;

    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        kind: 'abort',
        message: 'Запрос был отменен',
        requestId: reqId,
      };
    }

    if (error instanceof TypeError && error.message.includes('fetch')) {
      return {
        kind: 'network',
        message: 'Сетевая ошибка: сервер недоступен',
        raw: error,
      };
    }

    if (isAppError(error)) {
      return error;
    }

    return {
      kind: status ? 'http' : 'network',
      status,
      message: error instanceof Error ? error.message : 'Неизвестная ошибка запроса',
      requestId: reqId,
      headers,
      raw: error,
    };
  }

  public async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path);
    const headers = new Headers(options.headers);

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    if (options.idempotencyKey) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }

    if (options.ifMatch) {
      headers.set('If-Match', options.ifMatch);
    }

    if (options.ifNoneMatch) {
      headers.set('If-None-Match', options.ifNoneMatch);
    }

    let bodyInit: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      bodyInit = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        body: bodyInit,
      });

      if (response.status === 404 || response.status === 502 || response.status === 503) {
        try {
          return this.handleFallback<T>(path, options);
        } catch {
          // Fall through to standard response error handling
        }
      }
    } catch (networkErr) {
      try {
        return this.handleFallback<T>(path, options);
      } catch {
        throw this.normalizeError(networkErr);
      }
    }

    const etag = response.headers.get('etag');
    const reqId = response.headers.get('x-request-id') || undefined;

    // 204 No Content и 304 Not Modified не парсят JSON
    if (response.status === 204 || response.status === 304) {
      if (!response.ok && response.status !== 304) {
        throw {
          kind: 'http',
          status: response.status,
          message: `HTTP ошибка ${response.status}`,
          requestId: reqId,
          headers: response.headers,
        } satisfies AppError;
      }
      return {
        data: undefined as unknown as T,
        status: response.status,
        headers: response.headers,
        etag,
      };
    }

    // Разбор JSON
    let jsonBody: any = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        jsonBody = await response.json();
      } catch (parseErr) {
        throw {
          kind: 'parse',
          status: response.status,
          message: 'Некорректный JSON от сервера',
          requestId: reqId,
          headers: response.headers,
          raw: parseErr,
        } satisfies AppError;
      }
    }

    if (!response.ok) {
      const errObj = jsonBody?.error;
      const appError: AppError = {
        kind: 'http',
        status: response.status,
        code: errObj?.code,
        message: errObj?.message || `Ошибка сервера: ${response.status}`,
        requestId: reqId,
        headers: response.headers,
        raw: jsonBody,
      };
      throw appError;
    }

    return {
      data: jsonBody as T,
      status: response.status,
      headers: response.headers,
      etag,
    };
  }

  private handleFallback<T>(path: string, options: RequestOptions = {}): HttpResponse<T> {
    const method = (options.method || 'GET').toUpperCase();
    const cleanPath = path.startsWith('/') ? path : `/${path}`;

    // 1. /api/spaces
    if (cleanPath === '/api/spaces') {
      if (method === 'GET') {
        const data = mockStore.getSpaces();
        return { data: data as unknown as T, status: 200, headers: new Headers(), etag: null };
      }
      if (method === 'POST') {
        const body = options.body as any;
        const data = mockStore.createSpace(body?.title || '');
        return { data: data as unknown as T, status: 201, headers: new Headers(), etag: null };
      }
    }

    // 2. /api/spaces/:spaceId/graph
    const graphMatch = cleanPath.match(/^\/api\/spaces\/([^\/]+)\/graph$/);
    if (graphMatch) {
      const spaceId = graphMatch[1];
      if (method === 'GET') {
        const { data, etag } = mockStore.getGraph(spaceId);
        return { data: data as unknown as T, status: 200, headers: new Headers({ etag }), etag };
      }
      if (method === 'PUT') {
        const { data, etag } = mockStore.saveGraph(spaceId, options.body as any, options.ifMatch);
        return { data: data as unknown as T, status: 200, headers: new Headers({ etag }), etag };
      }
    }

    // 3. /api/spaces/:spaceId/generations/:generationId
    const singleGenMatch = cleanPath.match(/^\/api\/spaces\/([^\/]+)\/generations\/([^\/]+)$/);
    if (singleGenMatch && method === 'GET') {
      const spaceId = singleGenMatch[1];
      const genId = singleGenMatch[2];
      const data = mockStore.getGeneration(spaceId, genId);
      if (data) {
        return { data: data as unknown as T, status: 200, headers: new Headers(), etag: null };
      }
    }

    // 4. /api/spaces/:spaceId/generations
    const genListMatch = cleanPath.match(/^\/api\/spaces\/([^\/]+)\/generations$/);
    if (genListMatch) {
      const spaceId = genListMatch[1];
      if (method === 'GET') {
        const data = mockStore.getGenerations(spaceId);
        return { data: data as unknown as T, status: 200, headers: new Headers(), etag: null };
      }
      if (method === 'POST') {
        const data = mockStore.createGeneration(spaceId, options.body as any);
        return { data: data as unknown as T, status: 201, headers: new Headers(), etag: null };
      }
    }

    // 5. /api/spaces/:spaceId
    const spaceMatch = cleanPath.match(/^\/api\/spaces\/([^\/]+)$/);
    if (spaceMatch && method === 'GET') {
      const spaceId = spaceMatch[1];
      const data = mockStore.getSpace(spaceId);
      if (data) {
        return { data: data as unknown as T, status: 200, headers: new Headers(), etag: null };
      }
    }

    throw new Error(`Unhandled fallback route: ${cleanPath}`);
  }

  public async get<T>(path: string, options?: RequestOptions): Promise<T> {
    const res = await this.request<T>(path, { ...options, method: 'GET' });
    return res.data;
  }

  public async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const res = await this.request<T>(path, { ...options, method: 'POST', body });
    return res.data;
  }

  public async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const res = await this.request<T>(path, { ...options, method: 'PUT', body });
    return res.data;
  }

  public async delete<T = void>(path: string, options?: RequestOptions): Promise<T> {
    const res = await this.request<T>(path, { ...options, method: 'DELETE' });
    return res.data;
  }
}

export const api = new ApiClient(import.meta.env.VITE_API_URL || '');
