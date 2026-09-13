# Решение тестового задания: Канвас на React Flow

Фронтенд-приложение на React 19, TypeScript, Vite и React Flow (`@xyflow/react`), расположенное в `apps/web` (`@canvas/web`), реализующее визуальный редактор цепочки нод «текст → генератор → результат», сериализованную очередь сохранения с ETag и симуляцию генерации изображений.

Репозиторий решения: [https://github.com/ArtemChik103/frontend-canvas-challenge](https://github.com/ArtemChik103/frontend-canvas-challenge)

---

## Быстрый запуск

### 1. Установка зависимостей

Требуются Node.js >= 24.x и pnpm (или npm >= 11.x).

```sh
pnpm install
```

_(или `npm ci` / `npm install`)_

### 2. Запуск в режиме разработки

Для запуска бэкенда (порт 4001) и фронтенда (порт 5174):

```sh
# Терминал 1: запуск API сервера
pnpm run dev

# Терминал 2: запуск веб-приложения канваса
pnpm run dev:web
```

Канвас доступен по адресу: [http://localhost:5174](http://localhost:5174).
Swagger API: [http://localhost:4001/docs/](http://localhost:4001/docs/).

### 3. Сборка и проверки

```sh
# Проверка типов и сборка фронтенда
pnpm run build:web

# Полная проверка проекта (линтер, OpenAPI спецификация, тесты бэкенда)
pnpm run check

# Запуск smoke-тестов API (при работающем бэкенде)
pnpm run smoke
```

---

## Устройство работы с API, Debounce и Очередь сохранений (DRY & Обобщение — D1–D8, B1–B2)

Сетевое взаимодействие и синхронизация графа построены на основе строгой абстракции, гарантирующей согласованность данных при частых интерактивных действиях пользователя.

### 1. Единый сетевой транспорт (`apps/web/src/lib/api-client.ts`) (D1–D4, D8)

- Все запросы проходят через единый класс `ApiClient`. В компонентах **нет** собственных вызовов `fetch`, дублирующихся проверок статуса `response.ok` или ручного вызова `.json()`.
- Ответы `204 No Content` и `304 Not Modified` обрабатываются без чтения тела ответа.
- Автоматически считываются и пробрасываются ключевые заголовки: `ETag` (включая кавычки), `Location`, `Retry-After`, `X-Request-Id`.
- Сетевые ошибки, невалидный JSON, HTTP-коды (4xx, 5xx) и прерывания `AbortError` приводятся к единому виду `AppError`:
  ```ts
  export interface AppError {
    readonly kind: 'http' | 'network' | 'parse' | 'abort';
    readonly status?: number;
    readonly code?: string;
    readonly message: string;
    readonly requestId?: string;
    readonly headers?: Headers;
  }
  ```

### 2. Очередь сохранений и Debounce 500 мс (`apps/web/src/hooks/useGraphSync.ts`) (B1, B2)

При перемещении нод или быстром наборе текста в поле промпта частота событий достигает 60 раз в секунду. Отправлять сетевой запрос на каждое микродействие недопустимо:

- **Debounce 500 мс**: Таймер сбрасывается при каждом изменении. Запрос отправляется только после паузы в 500 мс.
- **Последовательная очередь (Serial Queue)**:
  - Бэкенд требует передачу `If-Match: <ETag>`. Параллельные `PUT`-запросы к одному графу привели бы к гонке версий и ошибкам `412 GRAPH_VERSION_CONFLICT`.
  - Хук `useGraphSync` гарантирует, что одновременно выполняется строго один `PUT`. Если пользователь вносит новые правки во время активного запроса, новое состояние графа сохраняется в `pendingGraph`.
  - По завершении активного запроса хук извлекает свежий `ETag` из ответа сервера и немедленно отправляет накопившиеся правки с этим новым `ETag`.
- **Гарантированное сохранение перед генерацией (Flush)**:
  - При клике на кнопку «Сгенерировать» метод `flushSave()` отменяет таймер debounce, немедленно дожидается завершения текущего `PUT` (или отправляет ожидающие правки) и возвращает подтвержденный сервером `ETag`. Только после этого вызывается `POST /api/spaces/{id}/generations`.
- **Устойчивость к конфликтам (412)**:
  - Если сервер возвращает `412 GRAPH_VERSION_CONFLICT`, локальный черновик пользователя **не стирается**. Отображается статус-баннер с предупреждением и возможностью принудительно перечитать граф с сервера.

### 3. Обобщенный механизм опроса (`apps/web/src/lib/poll.ts`) (D5, B3, B4)

- Утилита `pollUntil<T>` выполняет опрос статуса генерации (`GET /api/spaces/{id}/generations/{id}`) с задержкой 1500 мс (`Retry-After`).
- Связана с `AbortController`: опрос немедленно останавливается при уходе со страницы, переключении пространства или размонтировании компонента, предотвращая утечки памяти и наложение результатов старых генераций на новые ноды.

---

## Разбор обработки графа и производительность (P1, P2)

### Исследуемый участок: `buildGraphIndex` и `validateConnection` (`apps/web/src/lib/graph-processing.ts`)

```ts
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

  return { nodeTypeMap, incomingCount, outgoingCount, totalNodes: nLen, totalEdges: eLen };
}

export function validateConnection(params: ConnectionCheckParams, index: GraphIndex): boolean {
  if (index.totalEdges >= 20) return false;

  const sourceType = index.nodeTypeMap.get(params.source);
  const targetType = index.nodeTypeMap.get(params.target);
  if (!sourceType || !targetType) return false;

  const isPromptToGen = sourceType === 'prompt' && targetType === 'generator';
  const isGenToResult = sourceType === 'generator' && targetType === 'result';
  if (!isPromptToGen && !isGenToResult) return false;

  // Не более 1 входящей связи на любой вход
  if ((index.incomingCount.get(params.target) || 0) >= 1) return false;

  // Не более 1 исходящей связи от генератора к результату
  if (sourceType === 'generator' && (index.outgoingCount.get(params.source) || 0) >= 1)
    return false;

  return true;
}
```

### Анализ эффективности:

1. **Частота вызова**:
   Функция `isValidConnection` вызывается библиотекой React Flow **на каждый кадр движения курсора** при перетаскивании связи между портами нод (сотни раз в секунду).
2. **Число проходов и сложность алгоритма**:
   - В наивной реализации разработчики выполняют линейный поиск внутри проверки соединения:
     ```ts
     // ПЛОХО: O(N + E) на КАЖДОЕ движение курсора мыши
     const sourceNode = nodes.find((n) => n.id === connection.source);
     const targetNode = nodes.find((n) => n.id === connection.target);
     const inDegree = edges.filter((e) => e.target === connection.target).length;
     const outDegree = edges.filter((e) => e.source === connection.source).length;
     ```
     При таком подходе каждое движение мыши создавало 4 прохода по массивам с аллокацией промежуточных массивов через `.filter()`.
   - В нашем решении:
     - Индекс `GraphIndex` строится **за один проход $O(N + E)$** и мемоизируется через `useMemo([nodes, edges])`. Он пересчитывается только при физическом изменении топологии графа.
     - Сама валидация соединения `validateConnection` выполняется **за строго $O(1)$** по предвычисленным хэш-таблицам `Map`.
3. **Выделение памяти и сборщик мусора (GC)**:
   - В процессе перетаскивания связи (hover по портам) создается **0 объектов и 0 промежуточных массивов**.
   - Нет квадратичного разрастания объектов от спреда `{ ...acc }`.
4. **Очистка данных графа перед отправкой (`sanitizeGraphForApi`)**:
   - Сервер отклоняет служебные свойства React Flow (`selected`, `dragging`, `measured`).
   - Функция `sanitizeGraphForApi` выполняет преобразование нод и ребер за **ровно 1 проход** с созданием результирующего массива с фиксированной длиной `new Array(len)`, сохраняя мономорфность структуры объектов для оптимизатора скрытых классов V8 (hidden classes).

---

## Проверенные сценарии

- [x] **A1. Пространства и ноды**: Создание пространства через `POST /api/spaces`; открытие по ID; добавление нод трех типов (`prompt`, `generator`, `result`) с уникальными UUID; перемещение нод и ввод текста отображаются плавно без лагов.
- [x] **A2. Валидация связей**: Разрешены только соединения `prompt -> generator` и `generator -> result`; запрещено подключение второго входа к ноде; запрещено более 1 выхода у генератора; удаление ноды каскадно удаляет связанные ребра; сервер принимает валидный очищенный граф.
- [x] **A3. Сохранение и синхронизация**: Debounce 500 мс объединяет серии быстрых правок в один `PUT /api/spaces/{id}/graph` с заголовком `If-Match`; клик генерации мгновенно сохраняет черновик и запускает генерацию с актуальным `graphETag`.
- [x] **A4. Симуляция генерации и результат**: Отправка `POST /api/spaces/{id}/generations` с `Idempotency-Key`; корректная обработка ответа `202 Accepted` с заголовком `Retry-After`; отображение SVG-картинки с API в связанной ноде результата по окончании.
- [x] **B1. Очередь сохранений (Serial Queue)**: Последовательное выполнение `PUT`-запросов графа при задержках сети; новые правки встают в очередь и используют ETag предыдущего ответа без конфликтов.
- [x] **B2. Обработка конфликта 412**: При несовпадении `If-Match` локальные изменения сохраняются в черновике, выводится предупреждение и кнопка перечитывания серверного графа.
- [x] **B3. Восстановление после перезагрузки**: Граф, ETag и история генераций восстанавливаются при перезагрузке страницы; незавершенная генерация (`processing`) автоматически подхватывается опросом.
- [x] **B4. Изоляция генерации и остановка опроса**: Прекращение опроса при уходе со страницы или закрытии пространства (`AbortSignal`); результат удаленной/переподключенной цепочки не подставляется в чужие ноды.
- [x] **C1. Интерфейс**: Четкая индикация статусов («Сохранено», «Сохранение...», «Конфликт»); ввод текста в промпте не инициирует перетаскивание ноды (`nodrag`); интерфейс полностью доступен на экранах шириной от 1280px.
- [x] **E1. Сборка и тесты**: Успешная сборка `@canvas/web` через `pnpm run build:web`, прохождение всех 10 тестов бэкенда (`pnpm run check`).

---

## Известные ограничения

- Максимальный размер одного графа ограничен серверной спецификацией: не более 20 нод и не более 20 ребер.
- Мобильная версия для канваса не оценивается и не требуется по ТЗ.
