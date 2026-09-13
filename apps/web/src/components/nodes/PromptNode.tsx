import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface PromptNodeData {
  text: string;
  onChangeText?: (nodeId: string, newText: string) => void;
  onDeleteNode?: (nodeId: string) => void;
}

export const PromptNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const nodeData = data as unknown as PromptNodeData;
  const text = (nodeData?.text as string) || '';

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (nodeData?.onChangeText) {
      nodeData.onChangeText(id, e.target.value);
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
      <div className="node-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="node-header-tag prompt-tag">Промпт</span>
          <span>Текстовое описание</span>
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

      <div className="node-body">
        <textarea
          className="prompt-textarea nodrag"
          value={text}
          onChange={handleChange}
          placeholder="Опишите желаемое изображение..."
          maxLength={2000}
          rows={4}
        />
        <div
          style={{
            fontSize: '0.6875rem',
            color: 'var(--gray-400)',
            marginTop: '0.25rem',
            textAlign: 'right',
          }}
        >
          {text.length} / 2000
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="prompt-out"
        aria-label="Выход текстового промпта"
      />
    </div>
  );
};
