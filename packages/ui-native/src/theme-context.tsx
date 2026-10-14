import type { ThemeMode } from '@dhc/tokens';
import { createContext, useContext, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { nativeTheme, type NativeTheme } from './theme';

const ThemeContext = createContext<NativeTheme>(nativeTheme('light'));

/** Follows the device's light or dark setting unless `mode` pins one. */
export function ThemeProvider({ mode, children }: { mode?: ThemeMode; children: ReactNode }) {
  const scheme = useColorScheme();
  const resolved: ThemeMode = mode ?? (scheme === 'dark' ? 'dark' : 'light');
  return <ThemeContext.Provider value={nativeTheme(resolved)}>{children}</ThemeContext.Provider>;
}

export function useTheme(): NativeTheme {
  return useContext(ThemeContext);
}
