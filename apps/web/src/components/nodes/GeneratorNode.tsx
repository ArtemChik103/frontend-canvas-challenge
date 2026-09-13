import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface GeneratorNodeData {
  label: string;
  isGenerating?: boolean;
  statusMessage?: string;
  onGenerate?: (nodeId: string, scenario: 'success' | 'failure') => void;
  onDeleteNode?: (nodeId: string) => void;
}

export const GeneratorNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const nodeData = data as unknown as GeneratorNodeData;
  const isGenerating = Boolean(nodeData?.isGenerating);

  const [scenario, setScenario] = useState<'success' | 'failure'>('success');

  const handleTrigger = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isGenerating && nodeData?.onGenerate) {
      nodeData.onGenerate(id, scenario);
    }
  };

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
        id="gen-in"
        aria-label="Вход для текста от промпта"
      />

      <div className="node-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="node-header-tag generator-tag">Генератор</span>
          <span>{nodeData?.label || 'Генератор'}</span>
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
        <div className="scenario-selector">
          <label htmlFor={`scenario-${id}`} className="scenario-label">
            Сценарий API:
          </label>
          <select
            id={`scenario-${id}`}
            className="scenario-select"
            value={scenario}
            onChange={(e) => setScenario(e.target.value as 'success' | 'failure')}
            disabled={isGenerating}
          >
            <option value="success">Успешная генерация</option>
            <option value="failure">Тестовый сбой (failed)</option>
          </select>
        </div>

        <button
          type="button"
          className="btn primary sm full-width"
          disabled={isGenerating}
          onClick={handleTrigger}
          aria-busy={isGenerating}
        >
          {isGenerating ? <span>Генерация...</span> : <span>Сгенерировать</span>}
        </button>

        {nodeData?.statusMessage && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--gray-500)',
              marginTop: '0.5rem',
              textAlign: 'center',
            }}
          >
            {nodeData.statusMessage}
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="gen-out"
        aria-label="Выход генератора к результату"
      />
    </div>
  );
};
