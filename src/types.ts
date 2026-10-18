export type ColorTheme = 'light' | 'high-contrast' | 'dark';

export type UserSettings = {
  textScale: number;
  colorTheme: ColorTheme;
  speechRate: number;
};

export const DEFAULT_SETTINGS: UserSettings = {
  textScale: 1,
  colorTheme: 'light',
  speechRate: 1,
};

export const TEXT_SCALES = [1, 1.15, 1.3, 1.45] as const;
export const SPEECH_RATES = [0.75, 1, 1.25, 1.5] as const;
