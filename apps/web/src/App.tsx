import React, { useState, useEffect, useCallback } from 'react';
import type { SpaceData } from '@canvas/contracts';
import { api, type AppError } from './lib/api-client.js';
import { CanvasEditor } from './components/CanvasEditor.js';
import { SpaceSelector } from './components/SpaceSelector.js';

const STORAGE_SPACE_KEY = 'canvas_active_space_id';

export const App: React.FC = () => {
  const [currentSpace, setCurrentSpace] = useState<SpaceData | null>(null);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initSpace = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const savedSpaceId = localStorage.getItem(STORAGE_SPACE_KEY);
      const spaces = await api.get<SpaceData[]>('/api/spaces');

      if (savedSpaceId) {
        const found = spaces.find((s) => s.id === savedSpaceId);
        if (found) {
          setCurrentSpace(found);
          setIsLoading(false);
          return;
        }
      }

      if (spaces.length > 0) {
        setCurrentSpace(spaces[0]);
        localStorage.setItem(STORAGE_SPACE_KEY, spaces[0].id);
      } else {
        // Создаем начальное пространство, если ни одного нет (A1)
        const newSpace = await api.post<SpaceData>('/api/spaces', {
          title: 'Мое рабочее пространство',
        });
        setCurrentSpace(newSpace);
        localStorage.setItem(STORAGE_SPACE_KEY, newSpace.id);
      }
    } catch (err) {
      setError((err as AppError).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    initSpace();
  }, [initSpace]);

  const handleSelectSpace = (space: SpaceData) => {
    setCurrentSpace(space);
    localStorage.setItem(STORAGE_SPACE_KEY, space.id);
    setIsSelectorOpen(false);
  };

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          width: '100vw',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <div
          style={{
            width: '36px',
            height: '36px',
            border: '3px solid var(--gray-300)',
            borderTopColor: 'var(--primary)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <p style={{ fontWeight: 600, color: 'var(--gray-600)' }}>
          Загрузка рабочего пространства...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          width: '100vw',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            color: 'var(--danger)',
            marginBottom: '0.5rem',
          }}
        >
          Не удалось подключиться к серверу API
        </h1>
        <p style={{ color: 'var(--gray-600)', marginBottom: '1.5rem' }}>{error}</p>
        <button type="button" className="btn primary md" onClick={initSpace}>
          Попробовать снова
        </button>
      </div>
    );
  }

  return (
    <>
      {currentSpace && (
        <CanvasEditor space={currentSpace} onSwitchSpace={() => setIsSelectorOpen(true)} />
      )}

      {isSelectorOpen && (
        <SpaceSelector
          currentSpaceId={currentSpace?.id || null}
          onSelectSpace={handleSelectSpace}
          onClose={() => setIsSelectorOpen(false)}
        />
      )}
    </>
  );
};
