import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextProps,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS, SPEECH_RATES, TEXT_SCALES, type ColorTheme, type UserSettings } from './src/types';
import { loadUserSettings, readLocalSettings, saveUserSettings } from './src/lib/preferences';
import { isSupabaseConfigured, supabase } from './src/lib/supabase';
import { useVoice, VoiceDemoScreen, VoiceProvider } from './src/voice';

type Screen = 'welcome' | 'tutorial' | 'auth' | 'home' | 'settings';
type AuthMode = 'sign-in' | 'sign-up';

const paletteFor = (theme: ColorTheme) => {
  if (theme === 'high-contrast') {
    return { background: '#000000', card: '#000000', text: '#ffffff', muted: '#ffffff', accent: '#ffeb00', accentText: '#000000', border: '#ffffff', input: '#000000', error: '#ff8a80' };
  }
  if (theme === 'dark') {
    return { background: '#111820', card: '#1c2833', text: '#f5f8fa', muted: '#c8d4dc', accent: '#67d9f4', accentText: '#06131a', border: '#d1dce3', input: '#111820', error: '#ff9a91' };
  }
  return { background: '#eaf2f7', card: '#ffffff', text: '#142d3a', muted: '#405966', accent: '#005b75', accentText: '#ffffff', border: '#526e7c', input: '#ffffff', error: '#a1261d' };
};

const tutorialPages = [
  {
    title: 'Use your screen reader',
    body: 'Lumina11y labels its buttons and fields for assistive technology. On iPhone, turn on VoiceOver in Settings, then swipe right to move through controls and double-tap to activate one. On Android, use TalkBack in Accessibility settings.',
  },
  {
    title: 'Make the display comfortable',
    body: 'After you create an account, open Settings to choose larger text and a light, dark, or high-contrast colour theme. Your choices are saved to your account and restored when you sign in again.',
  },
  {
    title: 'Set your preferred voice speed',
    body: 'Choose a speech speed in Settings. The preference is saved now so the voice features can use it when they are added. Voice playback is not connected yet.',
  },
];

function AppText({ scale, color, style, ...props }: TextProps & { scale: number; color: string }) {
  return <Text {...props} style={[{ color, fontSize: 18 * scale, lineHeight: 27 * scale }, style]} />;
}

function ActionButton({
  label,
  onPress,
  scale,
  palette,
  secondary = false,
  disabled = false,
  selected,
}: {
  label: string;
  onPress: () => void;
  scale: number;
  palette: ReturnType<typeof paletteFor>;
  secondary?: boolean;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { checked: selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        buttonStyles.button,
        { backgroundColor: secondary ? palette.card : palette.accent, borderColor: palette.accent, borderWidth: secondary ? 2 : 0, opacity: disabled ? 0.55 : pressed ? 0.78 : 1 },
        selected && { borderWidth: 4 },
      ]}
    >
      <Text style={{ color: secondary ? palette.text : palette.accentText, fontSize: 18 * scale, lineHeight: 25 * scale, fontWeight: '700', textAlign: 'center' }}>
        {label}{selected ? ', selected' : ''}
      </Text>
    </Pressable>
  );
}

function AppContent() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [authMode, setAuthMode] = useState<AuthMode>('sign-in');
  const [tutorialIndex, setTutorialIndex] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(!isSupabaseConfigured);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [settingsMessage, setSettingsMessage] = useState('');
  const { setSpeechRate: setVoiceSpeechRate } = useVoice();
  const palette = paletteFor(settings.colorTheme);
  const scale = settings.textScale;
  const s = makeStyles(palette, scale);
  const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

  useEffect(() => {
    setVoiceSpeechRate(settings.speechRate);
  }, [settings.speechRate, setVoiceSpeechRate]);

  useEffect(() => {
    if (!supabase) return;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, nextSession) => {
      setSession(nextSession);
      setSessionReady(true);
      if (nextSession) {
        setScreen('home');
        setSettingsMessage('Loading your saved settings…');
        // Defer database work until Supabase has finished its auth event callback.
        setTimeout(() => { void syncSettings(nextSession); }, 0);
      } else {
        setSettings(DEFAULT_SETTINGS);
        setSettingsMessage('');
        setScreen('welcome');
      }
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      setSessionReady(true);
      if (error) {
        setAuthMessage(`Could not restore your sign-in: ${error.message}`);
        return;
      }
      setSession(data.session);
      if (data.session) {
        setScreen('home');
        void syncSettings(data.session);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function syncSettings(activeSession: Session) {
    const userId = activeSession.user.id;
    const cached = await readLocalSettings(userId);
    setSettings(cached);
    try {
      const saved = await loadUserSettings(activeSession.user);
      setSettings(saved);
      setSettingsMessage('Your settings are loaded from your account.');
    } catch {
      setSettingsMessage('Could not reach the settings table. Local settings are shown; check the Supabase setup steps.');
    }
  }

  async function submitAuth() {
    if (!email.trim() || !password) {
      const nextMessage = 'Enter both your email address and password.';
      setAuthMessage(nextMessage);
      announce(nextMessage);
      return;
    }
    if (!supabase) {
      setAuthMessage('Supabase is not configured. Add the project URL and publishable key to your .env file, then restart Expo.');
      return;
    }

    setBusy(true);
    setAuthMessage('');
    try {
      if (authMode === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) {
          setAuthMessage('Account created. Check your email to confirm the account, then come back and sign in.');
          announce('Account created. Check your email to confirm the account.');
        } else {
          announce('Account created. Loading your Lumina11y settings.');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        announce('Signed in. Loading your Lumina11y settings.');
      }
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'We could not complete that request. Try again.';
      setAuthMessage(nextMessage);
      announce(nextMessage);
    } finally {
      setBusy(false);
    }
  }

  async function updateSettings(nextSettings: UserSettings) {
    setSettings(nextSettings);
    if (!session) return;
    setSettingsMessage('Saving your settings…');
    try {
      await saveUserSettings(session.user, nextSettings);
      setSettingsMessage('Saved to your account.');
      announce('Settings saved to your account.');
    } catch {
      setSettingsMessage('Saved on this phone, but not synced. Check your connection and Supabase setup.');
      announce('Settings saved on this phone, but could not sync to your account.');
    }
  }

  async function signOut() {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.signOut();
    setBusy(false);
    if (error) {
      setAuthMessage(`Could not sign out: ${error.message}`);
      return;
    }
    setScreen('welcome');
    announce('Signed out of Lumina11y.');
  }

  function startTutorial() {
    setTutorialIndex(0);
    setScreen('tutorial');
    announce(`Tutorial. ${tutorialPages[0].title}. ${tutorialPages[0].body}`);
  }

  const frame = (children: React.ReactNode, footer?: string) => (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <StatusBar style={settings.colorTheme === 'light' ? 'dark' : 'light'} />
        <ScrollView contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={s.header}>
            <Text style={s.brand}>Lumina11y</Text>
            <AppText scale={scale} color={palette.muted}>A more accessible way to get things done</AppText>
          </View>
          <View style={s.card}>{children}</View>
          {!!footer && <AppText scale={scale} color={palette.muted} style={s.footer}>{footer}</AppText>}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );

  if (!sessionReady) {
    return frame(<AppText scale={scale} color={palette.text} accessibilityRole="text">Restoring your account…</AppText>);
  }

  if (screen === 'welcome') {
    return frame(
      <>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>Welcome to Lumina11y</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>
          Designed for blind and low-vision people, with clear steps and controls that work with assistive technology.
        </AppText>
        <ActionButton label="Start the tutorial" onPress={startTutorial} scale={scale} palette={palette} />
        <ActionButton label="Sign in or create an account" onPress={() => { setAuthMessage(''); setScreen('auth'); }} scale={scale} palette={palette} secondary />
      </>,
      'Person 1 · accessible welcome, tutorial, accounts, and personal settings',
    );
  }

  if (screen === 'tutorial') {
    const page = tutorialPages[tutorialIndex];
    const finish = () => {
      if (session) setScreen('home');
      else setScreen('auth');
      announce(session ? 'Tutorial complete. Welcome to Lumina11y.' : 'Tutorial complete. Sign in or create an account to continue.');
    };
    return frame(
      <>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>Lumina11y tutorial</AppText>
        <AppText scale={scale} color={palette.muted} style={s.hint}>Step {tutorialIndex + 1} of {tutorialPages.length}</AppText>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.sectionTitle}>{page.title}</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>{page.body}</AppText>
        {tutorialIndex > 0 && <ActionButton label="Previous step" onPress={() => { setTutorialIndex(tutorialIndex - 1); announce(`Step ${tutorialIndex}. ${tutorialPages[tutorialIndex - 1].title}`); }} scale={scale} palette={palette} secondary />}
        {tutorialIndex < tutorialPages.length - 1
          ? <ActionButton label="Next step" onPress={() => { setTutorialIndex(tutorialIndex + 1); announce(`Step ${tutorialIndex + 2}. ${tutorialPages[tutorialIndex + 1].title}. ${tutorialPages[tutorialIndex + 1].body}`); }} scale={scale} palette={palette} />
          : <ActionButton label={session ? 'Finish tutorial' : 'Finish and continue'} onPress={finish} scale={scale} palette={palette} />}
        <ActionButton label="Skip tutorial" onPress={finish} scale={scale} palette={palette} secondary />
      </>,
      'You can review this tutorial any time from the home screen.',
    );
  }

  if (screen === 'auth') {
    return frame(
      <>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>{authMode === 'sign-in' ? 'Sign in' : 'Create your account'}</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>
          Your account is managed by Supabase. Lumina11y never reads your password aloud.
        </AppText>
        <AppText scale={scale} color={palette.text} style={s.label}>Email address</AppText>
        <TextInput
          accessibilityLabel="Email address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={setEmail}
          returnKeyType="next"
          style={s.input}
          textContentType="emailAddress"
          value={email}
        />
        <AppText scale={scale} color={palette.text} style={s.label}>Password</AppText>
        <TextInput
          accessibilityLabel="Password. Password content is hidden."
          autoCapitalize="none"
          autoComplete={authMode === 'sign-up' ? 'new-password' : 'password'}
          onChangeText={setPassword}
          onSubmitEditing={() => { void submitAuth(); }}
          returnKeyType="done"
          secureTextEntry
          style={s.input}
          textContentType={authMode === 'sign-up' ? 'newPassword' : 'password'}
          value={password}
        />
        {!!password.length && <AppText scale={scale} color={palette.muted} style={s.hint}>{password.length} characters entered. Password content stays hidden.</AppText>}
        {!!authMessage && <AppText accessibilityRole="alert" scale={scale} color={palette.error} style={s.hint}>{authMessage}</AppText>}
        {!isSupabaseConfigured && <AppText accessibilityRole="alert" scale={scale} color={palette.error} style={s.hint}>Backend setup is incomplete. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY to .env.</AppText>}
        <ActionButton label={busy ? 'Please wait…' : authMode === 'sign-in' ? 'Sign in' : 'Create account'} onPress={() => { void submitAuth(); }} scale={scale} palette={palette} disabled={busy || !isSupabaseConfigured} />
        <ActionButton label={authMode === 'sign-in' ? 'New here? Create an account' : 'Already registered? Sign in'} onPress={() => { setAuthMode(authMode === 'sign-in' ? 'sign-up' : 'sign-in'); setAuthMessage(''); }} scale={scale} palette={palette} secondary />
        <ActionButton label="Back to welcome" onPress={() => setScreen('welcome')} scale={scale} palette={palette} secondary />
      </>,
      'Email confirmation may be required before you can sign in.',
    );
  }

  if (screen === 'settings') {
    const chooseTheme = (colorTheme: ColorTheme) => { void updateSettings({ ...settings, colorTheme }); };
    return frame(
      <>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>Accessibility settings</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>These preferences are saved to your Lumina11y account and restored when you sign in.</AppText>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.sectionTitle}>Text size</AppText>
        <View accessibilityRole="radiogroup" style={s.optionGroup}>
          {TEXT_SCALES.map((value) => (
            <ActionButton key={value} label={`${Math.round(value * 100)}% text`} onPress={() => { void updateSettings({ ...settings, textScale: value }); }} scale={scale} palette={palette} secondary selected={settings.textScale === value} />
          ))}
        </View>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.sectionTitle}>Colour theme</AppText>
        <View accessibilityRole="radiogroup" style={s.optionGroup}>
          {([
            ['light', 'Light'],
            ['high-contrast', 'High contrast'],
            ['dark', 'Dark'],
          ] as const).map(([value, label]) => (
            <ActionButton key={value} label={label} onPress={() => chooseTheme(value)} scale={scale} palette={palette} secondary selected={settings.colorTheme === value} />
          ))}
        </View>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.sectionTitle}>Voice speed</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>
          {settings.speechRate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}× preferred speed. Voice playback will use this when that feature is connected.
        </AppText>
        <View accessibilityRole="radiogroup" style={s.optionGroup}>
          {SPEECH_RATES.map((value) => (
            <ActionButton key={value} label={`${value}×`} onPress={() => { void updateSettings({ ...settings, speechRate: value }); }} scale={scale} palette={palette} secondary selected={settings.speechRate === value} />
          ))}
        </View>
        {!!settingsMessage && <AppText accessibilityLiveRegion="polite" scale={scale} color={palette.muted} style={s.hint}>{settingsMessage}</AppText>}
        <ActionButton label="Back to home" onPress={() => setScreen('home')} scale={scale} palette={palette} />
      </>,
    );
  }

  return frame(
    <>
      <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>Welcome to Lumina11y</AppText>
      <AppText scale={scale} color={palette.text} style={s.body}>Your account settings are ready. Voice tools, notes and reminders, photo descriptions, and emergency contacts can connect here in later project work.</AppText>
      <ActionButton label="Accessibility settings" onPress={() => setScreen('settings')} scale={scale} palette={palette} />
      <ActionButton label="Review tutorial" onPress={startTutorial} scale={scale} palette={palette} secondary />
      {!!settingsMessage && <AppText accessibilityLiveRegion="polite" scale={scale} color={palette.muted} style={s.hint}>{settingsMessage}</AppText>}
      <ActionButton label={busy ? 'Signing out…' : 'Sign out'} onPress={() => { void signOut(); }} scale={scale} palette={palette} secondary disabled={busy} />
    </>,
    `Signed in as ${session?.user.email ?? 'your account'}`,
  );
}

export default function App() {
  const showVoiceDemo =
    __DEV__ &&
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('voiceDemo') === '1';

  return (
    <VoiceProvider>
      {showVoiceDemo ? <VoiceDemoScreen /> : <AppContent />}
    </VoiceProvider>
  );
}

function makeStyles(palette: ReturnType<typeof paletteFor>, scale: number) {
  return StyleSheet.create({
    scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    header: { marginBottom: 24, gap: 8 },
    brand: { color: palette.text, fontSize: 34 * scale, lineHeight: 42 * scale, fontWeight: '800', letterSpacing: 0.3 },
    card: { backgroundColor: palette.card, borderColor: palette.border, borderWidth: 2, borderRadius: 20, padding: 24, gap: 10 },
    title: { fontSize: 28 * scale, lineHeight: 36 * scale, fontWeight: '800', marginBottom: 4 },
    sectionTitle: { fontSize: 21 * scale, lineHeight: 29 * scale, fontWeight: '800', marginTop: 12 },
    body: { marginBottom: 8 },
    label: { fontWeight: '700', marginTop: 8 },
    input: { backgroundColor: palette.input, color: palette.text, borderColor: palette.border, borderWidth: 2, borderRadius: 10, minHeight: 56, paddingHorizontal: 14, fontSize: 18 * scale, marginBottom: 8 },
    button: { borderRadius: 12, minHeight: 58, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, marginTop: 4 },
    hint: { marginTop: 6 },
    footer: { textAlign: 'center', marginTop: 20 },
    optionGroup: { gap: 6 },
  });
}

const buttonStyles = StyleSheet.create({
  button: {
    borderRadius: 12,
    minHeight: 58,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 4,
  },
});
