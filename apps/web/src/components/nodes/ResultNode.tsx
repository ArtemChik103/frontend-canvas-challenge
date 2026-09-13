import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface ResultNodeData {
  label: string;
  imageUrl?: string | null;
  isProcessing?: boolean;
  errorMessage?: string | null;
  onRetry?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
}

export const ResultNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const nodeData = data as unknown as ResultNodeData;
  const isProcessing = Boolean(nodeData?.isProcessing);
  const imageUrl = nodeData?.imageUrl;
  const errorMessage = nodeData?.errorMessage;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (nodeData?.onDeleteNode) {
      nodeData.onDeleteNode(id);
    }
  };

  return (
    <div className={`custom-node ${selected ? 'selected' : ''}`}>
      <Handle
        type="target"
        position={Position.Left}
        id="result-in"
        aria-label="Вход результата от генератора"
      />

      <div className="node-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="node-header-tag result-tag">Результат</span>
          <span>{nodeData?.label || 'Результат'}</span>
        </div>
        {nodeData?.onDeleteNode && (
          <button
            type="button"
            className="node-delete-btn"
            onClick={handleDelete}
            title="Удалить ноду"
            aria-label="Удалить ноду"
          >
            ✕
          </button>
        )}
      </div>

      <div className="node-body nodrag">
        <div className="result-box">
          {isProcessing ? (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  border: '3px solid var(--gray-200)',
                  borderTopColor: 'var(--primary)',
                  borderRadius: '50%',
                  margin: '0 auto 0.5rem',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
              <span style={{ fontSize: '0.8125rem', color: 'var(--gray-600)' }}>
                Идет генерация...
              </span>
            </div>
          ) : imageUrl ? (
            <div style={{ textAlign: 'center' }}>
              <img
                src={
                  imageUrl.startsWith('http')
                    ? imageUrl
                    : `${import.meta.env.VITE_API_URL || 'http://127.0.0.1:4001'}${imageUrl}`
                }
                alt="Сгенерированное изображение"
                className="result-image"
              />
              <div style={{ marginTop: '0.5rem' }}>
                <a
                  href={
                    imageUrl.startsWith('http')
                      ? imageUrl
                      : `${import.meta.env.VITE_API_URL || 'http://127.0.0.1:4001'}${imageUrl}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.75rem', color: 'var(--primary)', textDecoration: 'none' }}
                >
                  Открыть оригинал SVG ↗
                </a>
              </div>
            </div>
          ) : errorMessage ? (
            <div style={{ textAlign: 'center', color: 'var(--danger)', padding: '0.5rem' }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}>
                Ошибка генерации
              </div>
              <div
                style={{ fontSize: '0.75rem', color: 'var(--gray-600)', marginBottom: '0.5rem' }}
              >
                {errorMessage}
              </div>
              {nodeData?.onRetry && (
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => nodeData.onRetry!(id)}
                >
                  Попробовать снова
                </button>
              )}
            </div>
          ) : (
            <div className="result-placeholder">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ margin: '0 auto 0.5rem', display: 'block' }}
              >
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
              Ожидание генерации
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
