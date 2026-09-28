/**
 * The viewer's Shiki theme: every color is a CSS variable (--dvr-*, set in diff.css from the app's
 * tokens), so syntax colors follow the app's light/dark switch without re-highlighting. Registered
 * twice only because Pierre takes the color scheme from a single theme's type; a light/dark pair
 * leaves it to `themeType`.
 */
import { createCSSVariablesTheme, registerCustomTheme, type ThemeRegistration } from '@pierre/diffs';

export const THEMES = { light: 'gh-dash-light', dark: 'gh-dash-dark' } as const;

let registered = false;

export function registerThemes() {
  if (registered) return;
  registered = true;
  for (const type of ['light', 'dark'] as const) {
    const base = createCSSVariablesTheme({ name: THEMES[type], variablePrefix: '--dvr-', fontStyle: false });
    const theme: ThemeRegistration = {
      ...base,
      type,
      // Pierre derives its add/delete/modified colors from these.
      colors: {
        ...base.colors,
        'gitDecoration.addedResourceForeground': 'var(--add)',
        'gitDecoration.deletedResourceForeground': 'var(--del)',
        'gitDecoration.modifiedResourceForeground': 'var(--accent)',
      },
    };
    registerCustomTheme(THEMES[type], () => Promise.resolve(theme));
  }
}
