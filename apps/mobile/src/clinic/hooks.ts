import { useSyncExternalStore } from 'react';
import { outbox, today } from './runtime';

export const useToday = () => useSyncExternalStore(today.subscribe, today.getState);
export const useOutbox = () => useSyncExternalStore(outbox.subscribe, outbox.getItems);
