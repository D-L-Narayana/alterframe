import { Dialog, Kbd } from '@/ui';
import { SHORTCUT_MAP } from './shortcuts';

export function HelpDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} title="Keyboard & gestures" onClose={onClose}>
      <p className="af-help__gesture">
        <strong>Gesture:</strong> bring both palms together for half a second, then open them into the “L” window to
        advance the persona (Portrait → Masked hero → Web suit). Thumbs up / index inward flips the window — the corners
        simply follow your fingertips.
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
