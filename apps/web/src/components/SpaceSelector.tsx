import React, { useState, useEffect } from 'react';
import type { SpaceData } from '@canvas/contracts';
import { api, type AppError } from '../lib/api-client.js';

export interface SpaceSelectorProps {
  currentSpaceId: string | null;
  onSelectSpace: (space: SpaceData) => void;
  onClose?: () => void;
}

export const SpaceSelector: React.FC<SpaceSelectorProps> = ({
  currentSpaceId,
  onSelectSpace,
  onClose,
}) => {
  const [spaces, setSpaces] = useState<SpaceData[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSpaces = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<SpaceData[]>('/api/spaces');
      setSpaces(res);
    } catch (err) {
      setError((err as AppError).message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSpaces();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;

    setIsCreating(true);
    setError(null);

    try {
      const newSpace = await api.post<SpaceData>('/api/spaces', { title });
      setNewTitle('');
      onSelectSpace(newSpace);
    } catch (err) {
      setError((err as AppError).message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'white',
          borderRadius: '10px',
          maxWidth: '480px',
          width: '100%',
          padding: '1.5rem',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.25rem',
          }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Рабочие пространства</h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '1.5rem',
                cursor: 'pointer',
                color: 'var(--gray-400)',
              }}
            >
              ×
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              background: 'var(--danger-light)',
              color: 'var(--danger)',
              padding: '0.75rem',
              borderRadius: '6px',
              marginBottom: '1rem',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </div>
        )}

        <form
          onSubmit={handleCreate}
          style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}
        >
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Название нового пространства"
            maxLength={80}
            required
            style={{
              flex: 1,
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--gray-300)',
              borderRadius: '6px',
              fontSize: '0.875rem',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            className="btn primary sm"
            disabled={isCreating || !newTitle.trim()}
          >
            {isCreating ? 'Создание...' : 'Создать'}
          </button>
        </form>

        <div>
          <h3
            style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              color: 'var(--gray-600)',
              marginBottom: '0.75rem',
            }}
          >
            Существующие пространства:
          </h3>
          {isLoading ? (
            <p style={{ color: 'var(--gray-400)', fontSize: '0.875rem' }}>Загрузка...</p>
          ) : spaces.length === 0 ? (
            <p style={{ color: 'var(--gray-400)', fontSize: '0.875rem' }}>
              Нет созданных пространств
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                maxHeight: '250px',
                overflowY: 'auto',
              }}
            >
              {spaces.map((sp) => (
                <div
                  key={sp.id}
                  onClick={() => onSelectSpace(sp)}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '6px',
                    border: `2px solid ${sp.id === currentSpaceId ? 'var(--primary)' : 'var(--gray-200)'}`,
                    background: sp.id === currentSpaceId ? 'var(--primary-light)' : 'white',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <strong style={{ fontSize: '0.9375rem' }}>{sp.title}</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>
                    {new Date(sp.createdAt).toLocaleDateString('ru-RU')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
