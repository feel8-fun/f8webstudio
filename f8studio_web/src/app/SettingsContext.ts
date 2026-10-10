import { createContext, useContext } from 'react';

export type SettingsCategory = 'ai' | 'cloud';
export const SettingsContext = createContext<(category: SettingsCategory) => void>(() => {});
export function useSettings() { return useContext(SettingsContext); }
