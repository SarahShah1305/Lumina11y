import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS, type ColorTheme, type UserSettings } from '../types';
import { supabase } from './supabase';

const settingsStorageKey = (userId: string) => `lumina11y.settings.${userId}`;
const setupCompleteStorageKey = (userId: string) => `lumina11y.setupComplete.${userId}`;

export async function hasCompletedSetup(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(setupCompleteStorageKey(userId))) === 'true';
  } catch {
    return false;
  }
}

export async function markSetupComplete(userId: string): Promise<void> {
  await AsyncStorage.setItem(setupCompleteStorageKey(userId), 'true');
}

function isColorTheme(value: unknown): value is ColorTheme {
  return value === 'light' || value === 'high-contrast' || value === 'dark';
}

function validSettings(value: unknown): UserSettings | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<UserSettings>;
  if (
    typeof candidate.textScale !== 'number' || candidate.textScale < 1 || candidate.textScale > 1.45 ||
    !isColorTheme(candidate.colorTheme) ||
    typeof candidate.speechRate !== 'number' || candidate.speechRate < 0.75 || candidate.speechRate > 1.5
  ) return null;

  return {
    textScale: candidate.textScale,
    colorTheme: candidate.colorTheme,
    speechRate: candidate.speechRate,
  };
}

export async function readLocalSettings(userId: string): Promise<UserSettings> {
  try {
    const stored = await AsyncStorage.getItem(settingsStorageKey(userId));
    return stored ? validSettings(JSON.parse(stored)) ?? DEFAULT_SETTINGS : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function storeLocalSettings(userId: string, settings: UserSettings): Promise<void> {
  await AsyncStorage.setItem(settingsStorageKey(userId), JSON.stringify(settings));
}

export async function loadUserSettings(user: User): Promise<UserSettings> {
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase
    .from('user_settings')
    .select('text_scale, color_theme, speech_rate')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    const defaults = { ...DEFAULT_SETTINGS };
    const { error: insertError } = await supabase.from('user_settings').upsert({
      user_id: user.id,
      text_scale: defaults.textScale,
      color_theme: defaults.colorTheme,
      speech_rate: defaults.speechRate,
    });
    if (insertError) throw insertError;
    await storeLocalSettings(user.id, defaults);
    return defaults;
  }

  const remoteSettings = validSettings({
    textScale: Number(data.text_scale),
    colorTheme: data.color_theme,
    speechRate: Number(data.speech_rate),
  });
  if (!remoteSettings) throw new Error('Saved settings contain an unsupported value.');
  await storeLocalSettings(user.id, remoteSettings);
  return remoteSettings;
}

export async function saveUserSettings(user: User, settings: UserSettings): Promise<void> {
  await storeLocalSettings(user.id, settings);
  if (!supabase) throw new Error('Supabase is not configured.');

  const { error } = await supabase.from('user_settings').upsert({
    user_id: user.id,
    text_scale: settings.textScale,
    color_theme: settings.colorTheme,
    speech_rate: settings.speechRate,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}
