import { useRef } from 'react';
import type { SourceStatus } from '@/types';
import { Button, FileIcon, RetryIcon } from '@/ui';

export interface ErrorPanelProps {
  status: Extract<SourceStatus, 'denied' | 'unavailable' | 'error'>;
  message: string | null;
  onRetry(): void;
  onOpenFile(file: File): void;
  onBack(): void;
}

const TITLE: Record<ErrorPanelProps['status'], string> = {
  denied: 'Camera permission needed',
  unavailable: 'No camera found',
  error: 'Something went wrong',
};

export function ErrorPanel({ status, message, onRetry, onOpenFile, onBack }: ErrorPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="af-error">
      <div className="af-error__card" role="alert" aria-labelledby="af-error-title">
        <h2 id="af-error-title">{TITLE[status]}</h2>
        <p>{message ?? 'The video source could not be started.'}</p>
        <div className="af-error__actions">
          <Button variant="primary" icon={<RetryIcon />} onClick={onRetry} autoFocus>Try again</Button>
          <Button icon={<FileIcon />} onClick={() => fileRef.current?.click()}>Open a video file</Button>
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="af-visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) onOpenFile(f);
              e.currentTarget.value = '';
            }}
          />
        </div>
      </div>
    </div>
  );
}
