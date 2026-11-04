export type Theme = 'dark' | 'light';

export const THEME_COOKIE = 'theme';

export function themeFrom(value: string | undefined): Theme {
  return value === 'light' ? 'light' : 'dark';
}
