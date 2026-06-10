import { PlanChat } from './PlanChat';
import { CompactBoard } from './CompactBoard';

interface PlanViewProps {
  projectId: string;
  onClose: () => void;
}

export function PlanView({ projectId, onClose }: PlanViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header bar — right padding leaves room for the global settings gear */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 72px 10px 24px',
          borderBottom: '1px solid #ddd',
          background: '#fff',
          gap: 12,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600 }}>Planning mode</span>
        <button
          onClick={onClose}
          style={{
            marginLeft: 'auto',
            padding: '4px 12px',
            fontSize: 13,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Close planning mode
        </button>
      </div>

      {/* Chat panel — flex 3 */}
      <div style={{ flex: 3, overflow: 'hidden', borderBottom: '2px solid #e5e7eb' }}>
        <PlanChat projectId={projectId} />
      </div>

      {/* Compact board — flex 2 */}
      <div style={{ flex: 2, overflow: 'hidden', background: '#f9fafb' }}>
        <div style={{ padding: '6px 16px', fontSize: 13, fontWeight: 600, color: '#888', borderBottom: '1px solid #e5e7eb' }}>
          Board (live)
        </div>
        <div style={{ height: 'calc(100% - 29px)', overflow: 'auto' }}>
          <CompactBoard projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
