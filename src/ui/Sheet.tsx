import { Dialog, type DialogProps } from './Dialog';

export type SheetProps = Omit<DialogProps, 'variant'>;

/** Side sheet (desktop) / bottom sheet (mobile) built on Dialog semantics. */
export function Sheet(props: SheetProps) {
  return <Dialog {...props} variant="sheet" />;
}
