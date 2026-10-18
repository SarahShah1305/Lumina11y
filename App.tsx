import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { APP_NAME, APP_WELCOME_SPEECH, useVoice, VoiceButton, VoiceDemoScreen, VoiceProvider } from './src/voice';

type Screen = 'welcome' | 'auth' | 'home' | 'settings';
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
      accessibilityLabel={label}
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

function VoiceOptions({
  scale,
  palette,
  onSettings,
  onSignIn,
  includeSignIn = false,
}: {
  scale: number;
  palette: ReturnType<typeof paletteFor>;
  onSettings: () => void;
  onSignIn?: () => void;
  includeSignIn?: boolean;
}) {
  const { readHelp, repeatLastResponse, speak, stopSpeaking } = useVoice();

  return (
    <View style={sForVoiceOptions.section}>
      <AppText accessibilityRole="header" scale={scale} color={palette.text} style={sForVoiceOptions.heading}>Voice options</AppText>
      <ActionButton label="Voice help" onPress={readHelp} scale={scale} palette={palette} secondary />
      <ActionButton label="Accessibility settings" onPress={onSettings} scale={scale} palette={palette} secondary />
      <ActionButton label="Repeat" onPress={repeatLastResponse} scale={scale} palette={palette} secondary />
      <ActionButton label="Stop" onPress={() => { stopSpeaking(); speak('Stopped.'); }} scale={scale} palette={palette} secondary />
      {Platform.OS === 'web' && <VoiceButton />}
      {includeSignIn && onSignIn && (
        <ActionButton label="Sign in" onPress={onSignIn} scale={scale} palette={palette} />
      )}
    </View>
  );
}

const sForVoiceOptions = StyleSheet.create({
  section: { gap: 8, marginTop: 12 },
  heading: { fontSize: 23, lineHeight: 31, fontWeight: '800', marginBottom: 4 },
});

function AppContent() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [authMode, setAuthMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(!isSupabaseConfigured);
  const [settingsReady, setSettingsReady] = useState(!isSupabaseConfigured);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [webWelcomeStarted, setWebWelcomeStarted] = useState(false);
  const [pendingSignInMessage, setPendingSignInMessage] = useState(false);
  const { readHelp, registerCommand, setSpeechRate: setVoiceSpeechRate, speak } = useVoice();
  const welcomeSpoken = useRef(false);
  const palette = paletteFor(settings.colorTheme);
  const scale = settings.textScale;
  const s = makeStyles(palette, scale);
  const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);
  const signOut = useCallback(async () => {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.signOut();
    setBusy(false);
    if (error) {
      setAuthMessage(`Could not sign out: ${error.message}`);
      return;
    }
    setScreen('welcome');
    speak(`Signed out of ${APP_NAME}.`);
  }, [speak]);

  useEffect(() => {
    setVoiceSpeechRate(settings.speechRate);
  }, [settings.speechRate, setVoiceSpeechRate]);

  useEffect(() => {
    if (Platform.OS === 'web' || !sessionReady || !settingsReady || welcomeSpoken.current) return;
    welcomeSpoken.current = true;
    speak(APP_WELCOME_SPEECH);
  }, [sessionReady, settingsReady, speak]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !webWelcomeStarted || !settingsReady || welcomeSpoken.current) return;
    welcomeSpoken.current = true;
    speak(APP_WELCOME_SPEECH);
  }, [settingsReady, speak, webWelcomeStarted]);

  useEffect(() => {
    if (!pendingSignInMessage || !session || !settingsReady) return;
    setPendingSignInMessage(false);
    speak('Signed in. You are on the home screen.');
  }, [pendingSignInMessage, session, settingsReady, speak]);

  useEffect(() => {
    const unregister = [
      registerCommand('voice help', readHelp, 'Hear voice commands and keyboard shortcuts'),
      registerCommand(['accessibility settings', 'open settings'], () => {
        speak('Accessibility settings. Choose text size, colour theme, or voice speed.');
        setScreen('settings');
      }, 'Open accessibility settings'),
      registerCommand('sign out', signOut, 'Sign out of your account'),
      registerCommand('sign in', () => {
        speak('Opening sign in.');
        setAuthMessage('');
        setScreen('auth');
      }, 'Open the sign-in screen'),
    ];
    return () => unregister.forEach((remove) => remove());
  }, [readHelp, registerCommand, signOut, speak]);

  useEffect(() => {
    if (!supabase) return;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, nextSession) => {
      setSession(nextSession);
      setSessionReady(true);
      if (nextSession) {
        setScreen('home');
        setSettingsReady(false);
        setSettingsMessage('Loading your saved settings…');
        // Defer database work until Supabase has finished its auth event callback.
        setTimeout(() => { void syncSettings(nextSession); }, 0);
      } else {
        setSettings(DEFAULT_SETTINGS);
        setVoiceSpeechRate(DEFAULT_SETTINGS.speechRate);
        setSettingsReady(true);
        setSettingsMessage('');
        setScreen('auth');
      }
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        setAuthMessage(`Could not restore your sign-in: ${error.message}`);
        setSessionReady(true);
        setSettingsReady(true);
        return;
      }
      setSession(data.session);
      if (data.session) {
        setScreen('home');
        setSettingsReady(false);
        void syncSettings(data.session).finally(() => setSessionReady(true));
      } else {
        setScreen('auth');
        setSettingsReady(true);
        setSessionReady(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function syncSettings(activeSession: Session) {
    const userId = activeSession.user.id;
    const cached = await readLocalSettings(userId);
    setSettings(cached);
    setVoiceSpeechRate(cached.speechRate);
    setSettingsReady(true);
    try {
      const saved = await loadUserSettings(activeSession.user);
      setSettings(saved);
      setVoiceSpeechRate(saved.speechRate);
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
          speak('Account created. Check your email to confirm the account.');
        } else {
          speak(`Account created. Loading your ${APP_NAME} settings.`);
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        setPendingSignInMessage(true);
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

  function startWebWelcome() {
    if (webWelcomeStarted) return;
    setWebWelcomeStarted(true);
  }

  const frame = (children: React.ReactNode, footer?: string) => (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <StatusBar style={settings.colorTheme === 'light' ? 'dark' : 'light'} />
        {Platform.OS === 'web' && !webWelcomeStarted ? (
          <Pressable
            accessibilityLabel={`Welcome to ${APP_NAME}. Press Enter or tap anywhere to start.`}
            accessibilityRole="button"
            focusable
            onPress={startWebWelcome}
            style={s.webWelcomeGate}
          >
            <Text style={s.webWelcomeText}>
              Welcome to {APP_NAME}. Press Enter or tap anywhere to start.
            </Text>
          </Pressable>
        ) : (
          <ScrollView contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
            <View style={s.header}>
              <Text style={s.brand}>{APP_NAME}</Text>
              <AppText scale={scale} color={palette.muted}>A more accessible way to get things done</AppText>
            </View>
            <View style={s.card}>{children}</View>
            {!!footer && <AppText scale={scale} color={palette.muted} style={s.footer}>{footer}</AppText>}
          </ScrollView>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );

  if (!sessionReady) {
    return frame(<AppText scale={scale} color={palette.text} accessibilityRole="text">Restoring your account…</AppText>);
  }

  if (screen === 'welcome') {
    return frame(
      <>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>Welcome to {APP_NAME}</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>
          Designed for blind and low-vision people, with clear steps and controls that work with assistive technology.
        </AppText>
        <VoiceOptions
          scale={scale}
          palette={palette}
          onSettings={() => {
            speak('Accessibility settings. Choose text size, colour theme, or voice speed.');
            setScreen('settings');
          }}
          onSignIn={() => { setAuthMessage(''); setScreen('auth'); }}
          includeSignIn
        />
      </>,
      'Accessible welcome, accounts, and personal settings',
    );
  }

  if (screen === 'auth') {
    return frame(
      <>
        <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>{authMode === 'sign-in' ? 'Sign in' : 'Create your account'}</AppText>
        <AppText scale={scale} color={palette.text} style={s.body}>
          Your account is managed by Supabase. {APP_NAME} never reads your password aloud.
        </AppText>
        <VoiceOptions
          scale={scale}
          palette={palette}
          onSettings={() => {
            speak('Accessibility settings. Choose text size, colour theme, or voice speed.');
            setScreen('settings');
          }}
        />
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
        <AppText scale={scale} color={palette.text} style={s.body}>These preferences are saved to your {APP_NAME} account and restored when you sign in.</AppText>
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
          {settings.speechRate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}× preferred speed. Spoken messages use this speed.
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
      <AppText accessibilityRole="header" scale={scale} color={palette.text} style={s.title}>Welcome to {APP_NAME}</AppText>
      <AppText scale={scale} color={palette.text} style={s.body}>Your account settings are ready. Voice tools, notes and reminders, photo descriptions, and emergency contacts can connect here in later project work.</AppText>
      <VoiceOptions
        scale={scale}
        palette={palette}
        onSettings={() => {
          speak('Accessibility settings. Choose text size, colour theme, or voice speed.');
          setScreen('settings');
        }}
      />
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
    webWelcomeGate: {
      alignItems: 'center',
      backgroundColor: '#000000',
      borderColor: '#ffeb00',
      borderWidth: 5,
      flex: 1,
      justifyContent: 'center',
      padding: 32,
    },
    webWelcomeText: {
      color: '#ffeb00',
      fontSize: 30 * scale,
      fontWeight: '800',
      lineHeight: 42 * scale,
      textAlign: 'center',
    },
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
