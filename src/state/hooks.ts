/** Stable React hooks over the app store (zustand v5 needs `useShallow` for object selectors). */
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, selectSettings, selectSession } from './store';

export const useScene = () => useAppStore((s) => s.scene);
export const useSettings = () => useAppStore(useShallow(selectSettings));
export const useSession = () => useAppStore(useShallow(selectSession));
