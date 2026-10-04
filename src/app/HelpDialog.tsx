import { Dialog, Kbd } from '@/ui';
import { SHORTCUT_MAP } from './shortcuts';

export interface HelpDialogProps {
  open: boolean;
  onClose(): void;
  /** Esc handler (defaults to onClose). */
  onEscape?: () => void;
}

export function HelpDialog({ open, onClose, onEscape }: HelpDialogProps) {
  return (
    <Dialog open={open} title="Keyboard & gestures" onClose={onClose} {...(onEscape ? { onEscape } : {})}>
      <p className="af-help__gesture">
        <strong>Gesture:</strong> bring both palms together for half a second, then open them into the “L” window to
        advance the persona (Portrait → Masked hero → Web suit). Thumbs up / index inward flips the window — the corners
        simply follow your fingertips.
      </p>
      <p className="af-help__gesture">
        <strong>Hands-free capture:</strong> with “Hold still to capture” on (Settings → Window &amp; gestures), keeping the
        window still for the hold time takes a snapshot or starts a recording. The self-timer and auto-stop apply to
        R, S and T.
      </p>
      <table className="af-help__table">
        <caption className="af-visually-hidden">Keyboard shortcuts</caption>
        <tbody>
          {SHORTCUT_MAP.map((s) => (
            <tr key={s.label}>
              <td>{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</td>
              <td>{s.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
