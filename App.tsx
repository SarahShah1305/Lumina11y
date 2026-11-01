import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS, SPEECH_RATES, TEXT_SCALES, type ColorTheme, type UserSettings } from './src/types';
import { hasCompletedSetup, loadUserSettings, markSetupComplete, readLocalSettings, saveUserSettings } from './src/lib/preferences';
import { isSupabaseConfigured, supabase } from './src/lib/supabase';
import { PhotoFlow } from './src/photo/PhotoFlow';
import { normalizeCommand } from './src/voice/commands';
import {
  APP_NAME,
  APP_WELCOME_SPEECH,
  findVoiceCommand,
  VoiceButton,
  VoiceProvider,
  useVoice,
} from './src/voice';

type Screen = 'welcome' | 'accessibility' | 'account' | 'email' | 'codeword' | 'confirm' | 'home' | 'photo';
type AuthMode = 'sign-in' | 'sign-up';
type SettingsStep = 'text-size' | 'color-theme' | 'voice-speed';
type PromptHandler = (spokenText: string) => string | null;
type HomeOption = {
  id: string;
  label: string;
  spokenPhrase: string;
  commandPhrases: string[];
  helpSentence: string;
  secondary: boolean;
  compact?: boolean;
  webOnly?: boolean;
  onPress: () => void;
  onVoiceCommand?: (matchedPhrase: string) => void;
};

const settingSteps: SettingsStep[] = ['text-size', 'color-theme', 'voice-speed'];

const registeredSystemPhrases = new Set([
  'next', 'next page', 'back', 'previous page', 'yes', 'no', 'skip',
  'help', 'repeat', 'stop', 'slower', 'faster', 'go back', 'logout',
  'sign out', 'log out', 'sign in', 'create account', 'try again',
]);
function paletteFor(theme: ColorTheme) {
  if (theme === 'high-contrast') {
    return {
      background: '#000000', card: '#000000', text: '#ffffff', muted: '#ffffff',
      accent: '#ffeb00', accentText: '#000000', border: '#ffffff', input: '#000000',
    };
  }
  if (theme === 'dark') {
    return {
      background: '#111820', card: '#1c2833', text: '#f5f8fa', muted: '#c8d4dc',
      accent: '#67d9f4', accentText: '#06131a', border: '#d1dce3', input: '#111820',
    };
  }
  return {
    background: '#eaf2f7', card: '#ffffff', text: '#142d3a', muted: '#405966',
    accent: '#005b75', accentText: '#ffffff', border: '#526e7c', input: '#ffffff',
  };
}

type Palette = ReturnType<typeof paletteFor>;

function AppButton({
  label,
  onPress,
  palette,
  scale,
  secondary = false,
  compact = false,
  selected = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  scale: number;
  secondary?: boolean;
  compact?: boolean;
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        {
          backgroundColor: secondary ? palette.card : palette.accent,
          borderColor: secondary ? palette.border : palette.accent,
          borderWidth: secondary ? 2 : 0,
          opacity: disabled ? 0.55 : pressed ? 0.78 : 1,
        },
        selected && { borderWidth: 4 },
      ]}
    >
      <Text
        style={{
          color: secondary ? palette.text : palette.accentText,
          fontSize: (compact ? 16 : 19) * scale,
          lineHeight: (compact ? 22 : 26) * scale,
          fontWeight: '800',
          textAlign: 'center',
        }}
      >
        {label}{selected ? ', selected' : ''}
      </Text>
    </Pressable>
  );
}

function AppContent() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [authMode, setAuthMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [typedCodeword, setTypedCodeword] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(!isSupabaseConfigured);
  const [settingsReady, setSettingsReady] = useState(!isSupabaseConfigured);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [settingsStep, setSettingsStep] = useState<SettingsStep>('text-size');
  const [settingsComplete, setSettingsComplete] = useState(false);
  const [emailConfirming, setEmailConfirming] = useState(false);
  const [codewordConfirming, setCodewordConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const [heard, setHeard] = useState('');
  const [welcomeText, setWelcomeText] = useState('');
  const [webWelcomeStarted, setWebWelcomeStarted] = useState(Platform.OS !== 'web');
  const { lastHeard, readHelp, registerCommand, registerShortcut, repeatLastResponse, setHelpHandler, setRepeatHandler, setSpeechRate, speak, startListening, stopListening, stopSpeaking } = useVoice();

  const palette = paletteFor(settings.colorTheme);
  const scale = settings.textScale;
  const screenRef = useRef(screen);
  const screenToken = useRef(0);
  const enteredScreen = useRef<Screen | null>(null);
  const webWelcomeStartedRef = useRef(webWelcomeStarted);
  const sessionRef = useRef(session);
  const settingsRef = useRef(settings);
  const emailRef = useRef(email);
  const typedCodewordRef = useRef(typedCodeword);
  const codewordRef = useRef('');
  const authModeRef = useRef(authMode);
  const busyRef = useRef(false);
  const sessionReadyRef = useRef(sessionReady);
  const settingsReadyRef = useRef(settingsReady);
  const settingsCompleteRef = useRef(settingsComplete);
  const settingActionPending = useRef(false);
  const settingsStepRef = useRef(settingsStep);
  const authFeedback = useRef('');
  const transitionUserId = useRef('');
  const emailInputRef = useRef<TextInputInstance>(null);
  const codewordInputRef = useRef<TextInputInstance>(null);
  const answerYesRef = useRef<() => void>(() => undefined);
  const answerNoRef = useRef<() => void>(() => undefined);
  const retryAuthRef = useRef<() => void>(() => undefined);
  const navigationRef = useRef<{ next: () => void; back: () => void; skip: () => void }>({
    next: () => undefined,
    back: () => undefined,
    skip: () => undefined,
  });

  screenRef.current = screen;
  sessionRef.current = session;
  settingsRef.current = settings;
  emailRef.current = email;
  typedCodewordRef.current = typedCodeword;
  authModeRef.current = authMode;
  busyRef.current = busy;
  sessionReadyRef.current = sessionReady;
  settingsReadyRef.current = settingsReady;
  settingsCompleteRef.current = settingsComplete;
  settingsStepRef.current = settingsStep;
  webWelcomeStartedRef.current = webWelcomeStarted;

  const homeOptions = useMemo<HomeOption[]>(() => [
    {
      id: 'email', label: 'Read my email address', spokenPhrase: 'read my email address',
      commandPhrases: ['read my email address', 'read email', 'email address'], helpSentence: 'Read my email address: read the email address for your account.', secondary: true,
      onPress: () => {
        const accountEmail = emailRef.current || sessionRef.current?.user.email || '';
        speak(accountEmail ? `Your email address is ${spellEmail(accountEmail)}.` : 'No email address is available.');
      },
      onVoiceCommand: () => {
        const accountEmail = emailRef.current || sessionRef.current?.user.email || '';
        speak(accountEmail ? `Your email address is ${spellEmail(accountEmail)}.` : 'No email address is available.');
      },
    },
    {
      id: 'help', label: 'Help', spokenPhrase: 'help', commandPhrases: ['help'],
      helpSentence: 'Help: hear what each home option does.', secondary: true, onPress: readHelp,
      onVoiceCommand: () => readHelp(),
    },
    {
      id: 'repeat', label: 'Repeat', spokenPhrase: 'repeat', commandPhrases: ['repeat'],
      helpSentence: 'Repeat: hear the whole home menu again.', secondary: true, onPress: repeatLastResponse,
      onVoiceCommand: () => repeatLastResponse(),
    },
    {
      id: 'stop', label: 'Stop', spokenPhrase: 'stop', commandPhrases: ['stop'],
      helpSentence: 'Stop: stop speaking and listening.', secondary: true,
      onPress: () => { stopListening(false); stopSpeaking(); },
      onVoiceCommand: () => { stopListening(false); stopSpeaking(); },
    },
    {
      id: 'voice', label: 'Tap to speak', spokenPhrase: 'tap to speak or stop listening',
      commandPhrases: ['tap to speak', 'stop listening'], helpSentence: 'Tap to speak: start listening for a voice command; say stop listening to stop.',
      secondary: true, onPress: () => { void startListening(); },
      onVoiceCommand: (phrase) => phrase === 'stop listening' ? stopListening(false) : void startListening(),
    },
    {
      id: 'sign-out', label: 'Sign out', spokenPhrase: 'sign out', commandPhrases: ['sign out', 'log out'],
      helpSentence: 'Sign out: sign out of your account.', secondary: true, compact: true,
      onPress: () => {
        const command = findVoiceCommand('sign out');
        if (command) void command.command.handler('sign out', command.phrase);
      },
      onVoiceCommand: () => {
        const command = findVoiceCommand('sign out');
        if (command) void command.command.handler('sign out', command.phrase);
      },
    },
    {
      id: 'camera', label: 'Read with camera', spokenPhrase: 'read with camera',
      commandPhrases: ['read with camera', 'open camera', 'camera', 'take a photo', 'read text', 'describe picture', 'read medicine', 'check money'],
      helpSentence: 'Read with camera: take a photo and I will read the text, describe the picture, read a medicine label, or identify a banknote.',
      secondary: false, onPress: () => setScreen('photo'), onVoiceCommand: () => setScreen('photo'),
    },
  ], [readHelp, repeatLastResponse, setScreen, speak, startListening, stopListening, stopSpeaking]);

  const visibleHomeOptions = useCallback((): HomeOption[] => {
    return homeOptions.filter((option) => (sessionRef.current || option.id !== 'camera') &&
      (Platform.OS === 'web' || !option.webOnly));
  }, [homeOptions]);

  const homeMenuChunks = useCallback((): string[] => {
    const options = visibleHomeOptions();
    return [
      'You are on the home screen. You can say:',
      ...options.map((option) => `${option.spokenPhrase}.`),
      'Say help to hear what each option does.',
    ];
  }, [visibleHomeOptions]);

  const homeHelpChunks = useCallback((): string[] => {
    return visibleHomeOptions().map((option) => option.helpSentence);
  }, [visibleHomeOptions]);

  const speakQueuedChunks = useCallback((chunks: string[], onDone?: () => void): void => {
    const spokenChunks = chunks.filter((chunk) => chunk.trim());
    spokenChunks.forEach((chunk, index) => {
      speak(chunk, {
        queue: index > 0,
        onDone: index === spokenChunks.length - 1 ? onDone : undefined,
      });
    });
  }, [speak]);

  function setActiveSettings(nextSettings: UserSettings) {
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    setSpeechRate(nextSettings.speechRate);
  }

  async function syncSettings(activeSession: Session) {
    const setupComplete = await hasCompletedSetup(activeSession.user.id);
    if (activeSession.user.email) {
      emailRef.current = activeSession.user.email;
      setEmail(activeSession.user.email);
    }
    const cached = await readLocalSettings(activeSession.user.id);
    setActiveSettings(cached);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const saved = await Promise.race([
        loadUserSettings(activeSession.user),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Loading saved settings timed out.')), 5000);
        }),
      ]);
      setActiveSettings(saved);
    } catch (error) {
      console.error('Could not load saved accessibility settings.', error);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    return setupComplete;
  }

  function enterAuthenticatedSession(activeSession: Session) {
    const userId = activeSession.user.id;
    if (transitionUserId.current === userId) return;
    transitionUserId.current = userId;
    sessionRef.current = activeSession;
    setSession(activeSession);
    settingsReadyRef.current = false;
    setSettingsReady(false);
    setTimeout(() => {
      void syncSettings(activeSession).then((setupComplete) => {
        if (sessionRef.current?.user.id !== userId) return;
        settingsReadyRef.current = true;
        setSettingsReady(true);
        setScreen(setupComplete ? 'home' : 'accessibility');
      }).catch((error: unknown) => {
        console.error('Could not prepare accessibility settings after sign-in.', error);
        settingsReadyRef.current = true;
        setSettingsReady(true);
        setScreen('accessibility');
      });
    }, 0);
  }

  function resetSignedOutState() {
    transitionUserId.current = '';
    sessionRef.current = null;
    setSession(null);
    setActiveSettings(DEFAULT_SETTINGS);
    settingsReadyRef.current = true;
    setSettingsReady(true);
    setTypedCodeword('');
    typedCodewordRef.current = '';
    codewordRef.current = '';
    setScreen('welcome');
  }

  function errorSpeech(error: string, details?: string): string {
    if (error === 'permission-denied') return 'Microphone permission was denied. Allow microphone access to use voice commands.';
    let message: string;
    if (error === 'network') message = 'The transcription service could not be reached. Check your internet connection and Supabase URL, or use the keyboard buttons.';
    else if (error === 'timeout') message = 'Voice transcription timed out after 15 seconds. Check your internet connection and try again.';
    else if (error === 'microphone-unavailable') message = 'Microphone is unavailable. Check browser permission and try again.';
    else if (error === 'service-error') message = 'Speech transcription failed. Please try again or use the on-screen buttons.';
    else if (error === 'configuration-error') message = 'Speech transcription is not configured. Please contact the app administrator.';
    else if (error === 'unsupported') message = 'Voice listening is not supported in this browser. Use the on-screen buttons instead.';
    else message = 'Something went wrong while listening. Please try again or use the on-screen buttons.';
    return details ? `${message} Details: ${details}` : message;
  }

  function retryPrompt(prompt: string | string[], token: number, handler: PromptHandler, attempt: number, errorMessage: string) {
    setMessage(errorMessage);
    if (attempt < 2) {
      speak(errorMessage, { onDone: () => promptAndListen(prompt, token, handler, attempt + 1) });
    } else {
      speak(errorMessage);
    }
  }

  function promptAndListen(
    prompt: string | string[],
    token: number,
    handler: PromptHandler,
    attempt = 0,
    sensitive = false,
    displayPrompt?: string,
  ) {
    if (token !== screenToken.current) return;
    const promptText = Array.isArray(prompt) ? prompt.join(' ') : prompt;
    setMessage(displayPrompt ?? promptText);
    const onPromptDone = () => {
        if (token !== screenToken.current) return;
        void startListening((spokenText) => {
          if (token !== screenToken.current) return;
          stopListening(false);
          const normalizedSpokenText = spokenText
            .toLocaleLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ');
          if (sensitive) {
            setHeard('Code word received (hidden)');
            console.log('Voice heard: [code word redacted]');
          } else {
            setHeard(spokenText);
            console.log('Voice heard:', spokenText);
            setMessage(`I heard: ${spokenText}`);
          }
          const match = findVoiceCommand(normalizedSpokenText);
          console.log(`[voice ${new Date().toISOString()}] Command mapped:`, match?.phrase ?? '[no match]');
          if (token !== screenToken.current) return;
          const homeOption = screenRef.current === 'home'
            ? homeOptions.find((option) => option.commandPhrases.some((phrase) => normalizeCommand(phrase) === match?.phrase))
            : undefined;
          if (match && homeOption && homeOption.onVoiceCommand) {
            console.log(`[voice ${new Date().toISOString()}] Home option executed:`, match.phrase);
            homeOption.onVoiceCommand(match.phrase);
            return;
          }
          if (match && registeredSystemPhrases.has(match.phrase)) {
            console.log(`[voice ${new Date().toISOString()}] Command executed:`, match.phrase);
            void Promise.resolve(match.command.handler(normalizedSpokenText, match.phrase)).catch((error: unknown) => {
              console.error('Voice command could not be completed.', error);
              speak('I could not complete that command. Please try again.');
            });
            return;
          }
          console.log(`[voice ${new Date().toISOString()}] Prompt response handler executed.`);
          const retryMessage = handler(normalizedSpokenText);
          if (retryMessage) retryPrompt(prompt, token, handler, attempt, retryMessage);
        }, (error, details) => {
          if (token !== screenToken.current) return;
          if (error === 'no-speech') {
            setHeard('nothing');
            retryPrompt(prompt, token, handler, attempt, "I didn't hear anything. Say it again.");
          } else {
            const message = errorSpeech(error, details);
            setMessage(message);
            speak(message);
          }
        });
      };
    if (Array.isArray(prompt)) speakQueuedChunks(prompt, onPromptDone);
    else speak(prompt, { rememberLastResponse: !sensitive, onDone: onPromptDone });
  }

  function startWelcomeEntry(token: number) {
    setMessage(`Welcome to ${APP_NAME}.`);
    speak(APP_WELCOME_SPEECH, {
      onDone: () => {
        if (token !== screenToken.current) return;
        promptAndListen('Say next to sign in or create an account. Say help to hear the voice options.', token, (spokenText) =>
          /(?:^|\s)(?:next|continue)(?:\s|$)/i.test(spokenText)
            ? (navigationRef.current.next(), null)
            : 'I did not hear you. Say it again.',
        );
      },
    });
  }

  function settingQuestion(step: SettingsStep): string {
    if (step === 'text-size') return 'Accessibility options. Choose text size. Say small, medium, or large.';
    if (step === 'color-theme') return 'Choose colour theme. Say light, dark, or high contrast.';
    return 'Choose voice speed. Say slow, normal, or fast.';
  }

  function currentSettingLabel(step: SettingsStep, current: UserSettings): string {
    if (step === 'text-size') {
      if (current.textScale <= TEXT_SCALES[0]) return 'small';
      if (current.textScale <= TEXT_SCALES[1]) return 'medium';
      return 'large';
    }
    if (step === 'color-theme') return current.colorTheme === 'high-contrast' ? 'high contrast' : current.colorTheme;
    if (current.speechRate <= SPEECH_RATES[0]) return 'slow';
    if (current.speechRate <= SPEECH_RATES[1]) return 'normal';
    return 'fast';
  }

  function continueSettings(stepIndex: number, token: number) {
    if (token !== screenToken.current) return;
    if (stepIndex >= settingSteps.length) {
      settingsCompleteRef.current = true;
      setSettingsComplete(true);
      promptAndListen('Settings saved. Say next to continue.', token, (spokenText) =>
        /(?:^|\s)(?:next|continue)(?:\s|$)/i.test(spokenText)
          ? (navigationRef.current.next(), null)
          : 'I did not hear you. Say it again.',
      );
      return;
    }
    const step = settingSteps[stepIndex];
    settingsStepRef.current = step;
    setSettingsStep(step);
    askSetting(step, token, 0);
  }

  function askSetting(step: SettingsStep, token: number, attempt: number) {
    const prompt = settingQuestion(step);
    promptAndListen(prompt, token, (spokenText) => {
      const normalized = spokenText.toLocaleLowerCase();
      if (/\bskip\b/.test(normalized)) {
        continueSettings(settingSteps.indexOf(step) + 1, token);
        return null;
      }
      let choice: string | null = null;
      if (step === 'text-size') {
        if (/\b(small|smaller)\b/.test(normalized)) choice = 'small';
        else if (/\b(medium|normal)\b/.test(normalized)) choice = 'medium';
        else if (/\b(large|larger|big)\b/.test(normalized)) choice = 'large';
      } else if (step === 'color-theme') {
        if (/\b(high contrast|contrast)\b/.test(normalized)) choice = 'high-contrast';
        else if (/\blight\b/.test(normalized)) choice = 'light';
        else if (/\bdark\b/.test(normalized)) choice = 'dark';
      } else if (/\b(slow|slower)\b/.test(normalized)) choice = 'slow';
      else if (/\b(normal|medium)\b/.test(normalized)) choice = 'normal';
      else if (/\b(fast|faster|quick)\b/.test(normalized)) choice = 'fast';

      if (!choice) return 'I did not hear a valid choice. Say it again.';
      void applySetting(step, choice, token);
      return null;
    }, attempt);
  }

  async function applySetting(step: SettingsStep, choice: string, token: number) {
    if (settingActionPending.current) return;
    settingActionPending.current = true;
    const nextSettings: UserSettings = { ...settingsRef.current };
    let confirmation: string;
    if (step === 'text-size') {
      nextSettings.textScale = choice === 'small' ? TEXT_SCALES[0] : choice === 'medium' ? TEXT_SCALES[1] : TEXT_SCALES[2];
      confirmation = `Text size set to ${choice}.`;
    } else if (step === 'color-theme') {
      nextSettings.colorTheme = choice === 'high-contrast' ? 'high-contrast' : choice === 'dark' ? 'dark' : 'light';
      confirmation = `Colour theme set to ${choice === 'high-contrast' ? 'high contrast' : choice}.`;
    } else {
      nextSettings.speechRate = choice === 'slow' ? SPEECH_RATES[0] : choice === 'normal' ? SPEECH_RATES[1] : SPEECH_RATES[2];
      confirmation = `Voice speed set to ${choice}.`;
    }
    setActiveSettings(nextSettings);
    let saveFailure = false;
    if (sessionRef.current) {
      try {
        await saveUserSettings(sessionRef.current.user, nextSettings);
      } catch (error) {
        saveFailure = true;
        console.error('Could not sync accessibility settings.', error);
      }
    }
    if (token !== screenToken.current) {
      settingActionPending.current = false;
      return;
    }
    if (saveFailure) {
      setMessage('Settings are saved on this device. Cloud sync is unavailable.');
    }
    speak(confirmation, {
      onDone: () => {
        settingActionPending.current = false;
        if (token === screenToken.current) continueSettings(settingSteps.indexOf(step) + 1, token);
      },
      onStopped: () => {
        settingActionPending.current = false;
      },
    });
  }

  function normalizeEmail(value: string): string {
    return value.toLocaleLowerCase().trim()
      .replace(/\bat\b/g, '@')
      .replace(/\bdot\b/g, '.')
      .replace(/\s+/g, '');
  }

  function normalizeCodeword(value: string): string {
    return value.toLocaleLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
  }

  function validEmail(value: string): boolean {
    const separator = value.indexOf('@');
    return separator > 0 && value.indexOf('.', separator + 1) > separator + 1;
  }

  function spellEmail(value: string): string {
    return value.replace(/@/g, ' at ').replace(/\./g, ' dot ').trim().split(/\s+/)
      .map((part) => part === 'at' || part === 'dot' ? part : part.split('').join(' '))
      .join(' ');
  }

  function spellCodeword(value: string): string {
    return value.split(' ').map((word) => word.split('').join(' ')).join(', ');
  }

  function askEmailConfirmation(token: number, candidate: string) {
    setEmailConfirming(true);
    const yes = () => {
      setEmailConfirming(false);
      setScreen('codeword');
    };
    const no = () => {
      setEmailConfirming(false);
      askForEmail(token, 0);
    };
    answerYesRef.current = yes;
    answerNoRef.current = no;
    promptAndListen(`I heard ${spellEmail(candidate)}. Is this correct? Say yes or no.`, token, (spokenText) => {
      if (/\b(yes|correct|right)\b/i.test(spokenText)) {
        yes();
        return null;
      }
      if (/\b(no|incorrect|wrong)\b/i.test(spokenText)) {
        no();
        return null;
      }
      return 'Please say yes or no.';
    });
  }

  function askForEmail(token: number, attempt: number) {
    setEmailConfirming(false);
    promptAndListen('Email. Please say your email.', token, (spokenText) => {
      const candidate = normalizeEmail(spokenText);
      if (!validEmail(candidate)) return 'That email does not look right. Say it again.';
      emailRef.current = candidate;
      setEmail(candidate);
      askEmailConfirmation(token, candidate);
      return null;
    }, attempt);
  }

  function askCodewordConfirmation(token: number, candidate: string) {
    setCodewordConfirming(true);
    const yes = () => {
      codewordRef.current = candidate;
      setTypedCodeword('');
      typedCodewordRef.current = '';
      setCodewordConfirming(false);
      setScreen('confirm');
    };
    const no = () => {
      setCodewordConfirming(false);
      askForCodeword(token, 0);
    };
    answerYesRef.current = yes;
    answerNoRef.current = no;
    promptAndListen(`I heard ${spellCodeword(candidate)}. Is this correct? Say yes or no.`, token, (spokenText) => {
      if (/\b(yes|correct|right)\b/i.test(spokenText)) {
        yes();
        return null;
      }
      if (/\b(no|incorrect|wrong)\b/i.test(spokenText)) {
        no();
        return null;
      }
      return 'Please say yes or no.';
    }, 0, true, 'Code word received (hidden). Is this correct? Say yes or no.');
  }

  function askForCodeword(token: number, attempt: number) {
    setCodewordConfirming(false);
    const error = authFeedback.current;
    authFeedback.current = '';
    const instruction = 'Code word. Say your code word. Use two easy words, like blue tiger.';
    if (error) {
      promptAndListen(
        `${error} ${instruction}`,
        token,
        (spokenText) => handleCodeword(spokenText, token),
        attempt,
        true,
      );
      return;
    }
    promptAndListen(instruction, token, (spokenText) => handleCodeword(spokenText, token), attempt, true);
  }

  function handleCodeword(spokenText: string, token: number): string | null {
    if (/\btry again\b/i.test(spokenText)) {
      askForCodeword(token, 0);
      return null;
    }
    const candidate = normalizeCodeword(spokenText);
    if (candidate.replace(/\s/g, '').length < 6) return 'Please use a longer code word.';
    askCodewordConfirmation(token, candidate);
    return null;
  }

  function speakConfirmPrompt(token: number) {
    const mode = authModeRef.current;
    const action = mode === 'sign-up' ? 'Create this account' : 'Sign in';
    const prompt = `Confirm ${mode === 'sign-up' ? 'account creation' : 'sign in'}. Email: ${spellEmail(emailRef.current)}. ${action}? Say yes or no.`;
    const yes = () => { void submitAuth(); };
    const no = () => {
      codewordRef.current = '';
      setTypedCodeword('');
      setScreen('codeword');
    };
    answerYesRef.current = yes;
    answerNoRef.current = no;
    promptAndListen(prompt, token, (spokenText) => {
      if (/\b(yes|correct|right)\b/i.test(spokenText)) {
        yes();
        return null;
      }
      if (/\b(no|incorrect|wrong)\b/i.test(spokenText)) {
        no();
        return null;
      }
      return 'Please say yes or no.';
    });
  }

  async function submitAuth() {
    if (busyRef.current) return;
    const normalizedEmail = normalizeEmail(emailRef.current);
    const typedCandidate = normalizeCodeword(typedCodewordRef.current).replace(/\s/g, '');
    const password = codewordRef.current || typedCandidate;
    if (!validEmail(normalizedEmail)) {
      setMessage('Enter a valid email address.');
      speak('That email does not look right. Say it again.');
      setScreen('email');
      return;
    }
    if (password.length < 6) {
      codewordRef.current = '';
      setMessage('Please use a longer code word.');
      speak('Please use a longer code word.');
      setScreen('codeword');
      return;
    }
    if (!supabase) {
      setMessage('Sign in is unavailable because Supabase is not configured.');
      speak('Sign in is unavailable right now. Please check the app configuration.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(authModeRef.current === 'sign-up' ? 'Creating account.' : 'Signing in.');
    speak(authModeRef.current === 'sign-up' ? 'Creating your account.' : 'Signing in.');
    try {
      if (authModeRef.current === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({ email: normalizedEmail, password });
        if (error) throw error;
        if (data.session) {
          enterAuthenticatedSession(data.session);
        } else {
        authFeedback.current = 'Account created. Please confirm your email, then sign in. Your accessibility setup will follow.';
          codewordRef.current = '';
          setTypedCodeword('');
          setAuthMode('sign-in');
          authModeRef.current = 'sign-in';
          setScreen('account');
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
        if (error) throw error;
        if (data.session) enterAuthenticatedSession(data.session);
      }
    } catch (error) {
      console.error('Authentication request failed.', error);
      authFeedback.current = 'Wrong email or code word. Say try again.';
      codewordRef.current = '';
      setTypedCodeword('');
      typedCodewordRef.current = '';
      setScreen('codeword');
      setMessage(authFeedback.current);
    } finally {
      codewordRef.current = '';
      busyRef.current = false;
      setBusy(false);
    }
  }

  function selectAccount(mode: AuthMode) {
    setAuthMode(mode);
    authModeRef.current = mode;
    authFeedback.current = '';
    setScreen('email');
  }

  function completeSettingsAndNavigate() {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      setScreen('account');
      return;
    }
    void markSetupComplete(activeSession.user.id).then(() => {
      if (sessionRef.current?.user.id === activeSession.user.id) setScreen('home');
    }).catch((error: unknown) => {
      console.error('Could not save accessibility setup completion.', error);
      if (sessionRef.current?.user.id === activeSession.user.id) setScreen('home');
    });
  }

  function skipCurrentSetting() {
    if (screenRef.current !== 'accessibility') return;
    if (settingActionPending.current) return;
    if (settingsCompleteRef.current) {
      completeSettingsAndNavigate();
      return;
    }
    continueSettings(settingSteps.indexOf(settingsStepRef.current) + 1, screenToken.current);
  }

  function goNext() {
    const current = screenRef.current;
    if (current === 'welcome') {
      if (Platform.OS === 'web' && !webWelcomeStartedRef.current) {
        webWelcomeStartedRef.current = true;
        setWebWelcomeStarted(true);
        startScreenEntry('welcome');
      } else {
        setScreen(sessionRef.current ? 'accessibility' : 'account');
      }
    } else if (current === 'accessibility') {
      if (!settingsCompleteRef.current) skipCurrentSetting();
      else completeSettingsAndNavigate();
    } else if (current === 'account') {
      setScreen('email');
    } else if (current === 'email') {
      const candidate = normalizeEmail(emailRef.current);
      if (!validEmail(candidate)) {
        speak('That email does not look right. Enter or say your email.');
        return;
      }
      if (emailConfirming) answerYesRef.current();
      else setScreen('codeword');
    } else if (current === 'codeword') {
      if (codewordConfirming) {
        answerYesRef.current();
        return;
      }
      const candidate = normalizeCodeword(typedCodewordRef.current);
      if (candidate.replace(/\s/g, '').length < 6) {
        speak('Please use a longer code word.');
        return;
      }
      codewordRef.current = candidate.replace(/\s/g, '');
      setTypedCodeword('');
      typedCodewordRef.current = '';
      setScreen('confirm');
    } else if (current === 'confirm') {
      answerYesRef.current();
    } else {
      speak('You are on the home screen. Say back to return to accessibility options.');
    }
  }

  function goBack() {
    const current = screenRef.current;
    if (current === 'welcome') {
      speak('You are on the welcome screen.');
    } else if (current === 'accessibility') {
      setScreen('welcome');
    } else if (current === 'account') {
      setScreen('welcome');
    } else if (current === 'email') {
      setScreen('account');
    } else if (current === 'codeword') {
      codewordRef.current = '';
      setTypedCodeword('');
      setScreen('email');
    } else if (current === 'confirm') {
      codewordRef.current = '';
      setTypedCodeword('');
      setScreen('codeword');
    } else if (current === 'photo') {
      setScreen('home');
    } else {
      setScreen('accessibility');
    }
  }

  function startScreenEntry(nextScreen: Screen) {
    if (!sessionReadyRef.current || !settingsReadyRef.current) return;
    if (nextScreen === 'welcome' && Platform.OS === 'web' && !webWelcomeStartedRef.current) return;
    if (enteredScreen.current === nextScreen) return;
    enteredScreen.current = nextScreen;
    const token = ++screenToken.current;
    setHeard('');
    setMessage('');
    answerYesRef.current = () => undefined;
    answerNoRef.current = () => undefined;
    stopSpeaking();

    if (nextScreen === 'welcome') {
      startWelcomeEntry(token);
    } else if (nextScreen === 'accessibility') {
      settingActionPending.current = false;
      settingsCompleteRef.current = false;
      setSettingsComplete(false);
      settingsStepRef.current = 'text-size';
      setSettingsStep('text-size');
      continueSettings(0, token);
    } else if (nextScreen === 'account') {
      const feedback = authFeedback.current;
      authFeedback.current = '';
      const prompt = feedback || 'Choose account. Say sign in or create account.';
      promptAndListen(prompt, token, (spokenText) => {
        if (/\b(create|new)\b.*\baccount\b/i.test(spokenText)) {
          selectAccount('sign-up');
          return null;
        }
        if (/\b(sign|log)\s*in\b/i.test(spokenText)) {
          selectAccount('sign-in');
          return null;
        }
        return 'Say sign in or create account.';
      });
    } else if (nextScreen === 'email') {
      askForEmail(token, 0);
    } else if (nextScreen === 'codeword') {
      retryAuthRef.current = () => askForCodeword(token, 0);
      askForCodeword(token, 0);
    } else if (nextScreen === 'confirm') {
      speakConfirmPrompt(token);
    } else if (nextScreen === 'home') {
      promptAndListen(homeMenuChunks(), token, (spokenText) => {
        if (/\b(sign out|log out|logout)\b/i.test(spokenText)) return null;
        return 'I did not hear you. Say it again.';
      });
    }
  }

  useEffect(() => {
    const unregister = [
      registerCommand(['next', 'next page'], () => navigationRef.current.next(), 'Go to the next screen'),
      registerCommand('previous page', () => navigationRef.current.back(), 'Go back to the previous screen'),
      registerCommand('yes', () => answerYesRef.current(), 'Confirm the current choice'),
      registerCommand('no', () => answerNoRef.current(), 'Reject the current choice'),
      registerCommand('skip', () => navigationRef.current.skip(), 'Keep the current setting and continue'),
      registerCommand(['sign in', 'log in'], () => selectAccount('sign-in'), 'Choose sign in'),
      registerCommand(['create account', 'sign up'], () => selectAccount('sign-up'), 'Choose create account'),
      registerCommand(['sign out', 'log out'], async () => {
        if (!supabase) {
          speak('Sign out is unavailable right now.');
          return;
        }
        const { error } = await supabase.auth.signOut();
        if (error) {
          console.error('Could not sign out.', error);
          speak('Could not sign out. Please try again.');
        } else {
          speak('Signed out.');
        }
      }, 'Sign out of your account'),
      registerCommand('try again', () => {
        if (screenRef.current === 'photo') {
          const retryPhotoCommand = findVoiceCommand('retry photo');
          if (retryPhotoCommand) return retryPhotoCommand.command.handler('retry photo', retryPhotoCommand.phrase);
        }
        retryAuthRef.current();
      }, 'Try again'),
    ];
    const removeBackShortcut = registerShortcut('Alt+B', 'Go back to the previous screen', () => navigationRef.current.back());
    return () => {
      unregister.forEach((remove) => remove());
      removeBackShortcut();
    };
  }, [registerCommand, registerShortcut, speak]);

  useEffect(() => {
    if (screen !== 'home' || !session) return;
    const removeHelpHandler = setHelpHandler(() => speakQueuedChunks(homeHelpChunks()));
    const removeRepeatHandler = setRepeatHandler(() => speakQueuedChunks(homeMenuChunks()));
    const unregister: Array<() => void> = [];
    homeOptions.forEach((option) => {
      if (!option.onVoiceCommand || (option.webOnly && Platform.OS !== 'web')) return;
      const phrases = option.commandPhrases.filter((phrase) => !registeredSystemPhrases.has(normalizeCommand(phrase)));
      if (phrases.length) {
        unregister.push(registerCommand(
          phrases,
          (_spokenText, matchedPhrase) => option.onVoiceCommand?.(matchedPhrase),
          option.helpSentence,
        ));
      }
    });
    return () => {
      unregister.forEach((remove) => remove());
      removeHelpHandler();
      removeRepeatHandler();
    };
  }, [homeHelpChunks, homeMenuChunks, homeOptions, registerCommand, screen, session, setHelpHandler, setRepeatHandler, speakQueuedChunks]);

  useEffect(() => {
    const current = screen;
    startScreenEntry(current);
    return () => {
      screenToken.current += 1;
      enteredScreen.current = null;
      stopListening(false);
      stopSpeaking();
    };
    // Screen entry speech is intentionally keyed only to the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    let mounted = true;
    if (!supabase) {
      sessionReadyRef.current = true;
      settingsReadyRef.current = true;
      setSessionReady(true);
      setSettingsReady(true);
      return () => { mounted = false; };
    }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      if (event === 'SIGNED_IN' && nextSession) {
        enterAuthenticatedSession(nextSession);
      } else if (event === 'SIGNED_OUT') {
        resetSignedOutState();
      } else if (nextSession) {
        sessionRef.current = nextSession;
        setSession(nextSession);
      }
    });
    void supabase.auth.getSession().then(async ({ data, error }) => {
      if (!mounted) return;
      if (error) {
        console.error('Could not restore the saved sign-in.', error);
      }
      const restoredSession = data.session;
      sessionRef.current = restoredSession;
      setSession(restoredSession);
      let initialScreen: Screen = 'welcome';
      if (restoredSession) {
        settingsReadyRef.current = false;
        setSettingsReady(false);
        try {
          const setupComplete = await syncSettings(restoredSession);
          initialScreen = setupComplete ? 'home' : 'accessibility';
        } catch (settingsError) {
          console.error('Could not load accessibility settings.', settingsError);
          initialScreen = 'accessibility';
        }
      }
      screenRef.current = initialScreen;
      setScreen(initialScreen);
      settingsReadyRef.current = true;
      setSettingsReady(true);
      sessionReadyRef.current = true;
      setSessionReady(true);
      startScreenEntry(initialScreen);
    }).catch((error: unknown) => {
      if (!mounted) return;
      console.error('Could not initialize the account session.', error);
      sessionReadyRef.current = true;
      settingsReadyRef.current = true;
      screenRef.current = 'welcome';
      setScreen('welcome');
      setSessionReady(true);
      setSettingsReady(true);
      startScreenEntry('welcome');
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
    // Session restoration is performed once at app startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const focusStyle = document.createElement('style');
    focusStyle.dataset.accessibilityFocus = 'true';
    focusStyle.textContent = [
      '[role="button"]:focus-visible, button:focus-visible, input:focus-visible,',
      'textarea:focus-visible, select:focus-visible {',
      'outline: 4px solid #ffbf00 !important;',
      'outline-offset: 3px !important;',
      '}',
    ].join(' ');
    document.head.appendChild(focusStyle);
    const handleNavigationKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )) return;
      if (screenRef.current === 'welcome' && !webWelcomeStartedRef.current) {
        event.preventDefault();
        webWelcomeStartedRef.current = true;
        setWebWelcomeStarted(true);
        startScreenEntry('welcome');
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigationRef.current.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigationRef.current.back();
      }
    };
    window.addEventListener('keydown', handleNavigationKey);
    return () => {
      window.removeEventListener('keydown', handleNavigationKey);
      focusStyle.remove();
    };
  }, []);

  useEffect(() => {
    if (screen !== 'welcome') return;
    setWelcomeText('');
    const fullText = `Welcome to ${APP_NAME}`;
    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      setWelcomeText(fullText.slice(0, index));
      if (index >= fullText.length) clearInterval(timer);
    }, 65);
    return () => clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (screen === 'email') setTimeout(() => emailInputRef.current?.focus(), 100);
    if (screen === 'codeword') setTimeout(() => codewordInputRef.current?.focus(), 100);
  }, [screen]);

  const goNextRef = useRef(goNext);
  const goBackRef = useRef(goBack);
  const skipSettingRef = useRef(skipCurrentSetting);
  goNextRef.current = goNext;
  goBackRef.current = goBack;
  skipSettingRef.current = skipCurrentSetting;
  navigationRef.current = {
    next: () => goNextRef.current(),
    back: () => goBackRef.current(),
    skip: () => skipSettingRef.current(),
  };

  const panResponderRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (!panResponderRef.current) {
    panResponderRef.current = PanResponder.create({
      onMoveShouldSetPanResponder: (event, gesture) => {
        if (
          Platform.OS === 'web' &&
          typeof HTMLElement !== 'undefined' &&
          event.target instanceof HTMLElement &&
          event.target.closest('input, textarea, select, [contenteditable="true"]')
        ) return false;
        return Math.abs(gesture.dx) > 55 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > 55) navigationRef.current.next();
        else if (gesture.dx < -55) navigationRef.current.back();
      },
    });
  }

  const currentStepChoices = settingsStep === 'text-size'
    ? [
        { label: 'Small text', value: 'small' },
        { label: 'Medium text', value: 'medium' },
        { label: 'Large text', value: 'large' },
      ]
    : settingsStep === 'color-theme'
      ? [
          { label: 'Light theme', value: 'light' },
          { label: 'Dark theme', value: 'dark' },
          { label: 'High contrast', value: 'high-contrast' },
        ]
      : [
          { label: 'Slow voice', value: 'slow' },
          { label: 'Normal voice', value: 'normal' },
          { label: 'Fast voice', value: 'fast' },
        ];

  useEffect(() => {
    if (screen !== 'accessibility') return;
    const removeShortcuts = currentStepChoices.map((choice, index) =>
      registerShortcut(`Alt+${index + 1}`, choice.label, () => chooseSettingButton(choice.value)),
    );
    return () => removeShortcuts.forEach((remove) => remove());
  }, [screen, settingsStep, registerShortcut]);

  const chooseSettingButton = (value: string) => {
    const token = screenToken.current;
    void applySetting(settingsStepRef.current, value, token);
  };

  const startWelcomeFromWeb = () => {
    if (webWelcomeStartedRef.current) return;
    webWelcomeStartedRef.current = true;
    setWebWelcomeStarted(true);
    startScreenEntry('welcome');
  };

  const contentStyles = makeScreenStyles(palette, scale);

  if (!sessionReady || (session && !settingsReady)) {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: 'center', backgroundColor: palette.background, justifyContent: 'center', padding: 24 }}>
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 24 * scale, fontWeight: '800', textAlign: 'center' }}>
          Loading your saved settings…
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
      <StatusBar style={settings.colorTheme === 'light' ? 'dark' : 'light'} />
      <View style={contentStyles.frame} {...panResponderRef.current.panHandlers}>
        {screen === 'photo' && session ? (
          <PhotoFlow palette={palette} scale={scale} onBack={() => setScreen('home')} />
        ) : (
          <>
        <View style={contentStyles.navigation}>
          <AppButton label="Back" onPress={() => navigationRef.current.back()} palette={palette} scale={scale} secondary compact />
          <AppButton label="Next" onPress={() => navigationRef.current.next()} palette={palette} scale={scale} compact disabled={busy} />
        </View>
        <ScrollView contentContainerStyle={contentStyles.body} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={contentStyles.title}>
            {screen === 'welcome' ? welcomeText || 'Welcome' :
              screen === 'accessibility' ? 'Accessibility options' :
              screen === 'account' ? 'Choose account' :
              screen === 'email' ? 'Email' :
              screen === 'codeword' ? 'Code word' :
              screen === 'confirm' ? 'Confirm' : 'Home'}
          </Text>
          <Text accessibilityLiveRegion="polite" style={contentStyles.message}>
            {message || (screen === 'welcome' ? `Welcome to ${APP_NAME}.` :
              screen === 'accessibility' ? 'Choose one setting at a time.' :
              screen === 'account' ? 'Choose sign in or create account.' :
              screen === 'email' ? 'Say or type your email address.' :
              screen === 'codeword' ? 'Say or type your code word.' :
              screen === 'confirm' ? 'Confirm to continue.' : 'Voice options')}
          </Text>
          <Text accessibilityLiveRegion="polite" style={contentStyles.heard}>
            {`I heard: ${heard || lastHeard || 'nothing yet'}`}
          </Text>

          {screen === 'welcome' && Platform.OS === 'web' && !webWelcomeStarted && (
            <Pressable
              accessibilityLabel={`Welcome to ${APP_NAME}. Press Enter or tap anywhere to start.`}
              accessibilityRole="button"
              onPress={startWelcomeFromWeb}
              style={contentStyles.startBanner}
            >
              <Text style={contentStyles.startBannerText}>
                Welcome to {APP_NAME}. Press Enter or tap anywhere to start.
              </Text>
            </Pressable>
          )}

          {screen === 'accessibility' && (
            <View style={contentStyles.choices}>
              {currentStepChoices.map(({ label, value }) => (
                <AppButton
                  key={value}
                  label={label}
                  onPress={() => chooseSettingButton(value)}
                  palette={palette}
                  scale={scale}
                  secondary
                  selected={currentSettingLabel(settingsStep, settings) === value}
                />
              ))}
            </View>
          )}

          {screen === 'account' && (
            <View style={contentStyles.choices}>
              <AppButton label="Sign in" onPress={() => selectAccount('sign-in')} palette={palette} scale={scale} />
              <AppButton label="Create account" onPress={() => selectAccount('sign-up')} palette={palette} scale={scale} secondary />
            </View>
          )}

          {screen === 'email' && (
            <View style={contentStyles.form}>
              <TextInput
                ref={emailInputRef}
                accessibilityLabel="Email address"
                accessibilityHint="Type your email address, or say it when prompted."
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                keyboardType="email-address"
                onChangeText={(value) => {
                  emailRef.current = value;
                  setEmail(value);
                }}
                placeholder="Email address"
                placeholderTextColor={palette.muted}
                returnKeyType="next"
                value={email}
                style={contentStyles.input}
              />
              {emailConfirming && (
                <View style={contentStyles.inlineChoices}>
                  <AppButton label="Yes, correct" onPress={() => answerYesRef.current()} palette={palette} scale={scale} />
                  <AppButton label="No, try again" onPress={() => answerNoRef.current()} palette={palette} scale={scale} secondary />
                </View>
              )}
            </View>
          )}

          {screen === 'codeword' && (
            <View style={contentStyles.form}>
              <TextInput
                ref={codewordInputRef}
                accessibilityLabel="Code word"
                accessibilityHint="Type your code word. It is hidden while typing."
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                onChangeText={(value) => {
                  typedCodewordRef.current = value;
                  setTypedCodeword(value);
                }}
                placeholder="Code word"
                placeholderTextColor={palette.muted}
                secureTextEntry
                value={typedCodeword}
                style={contentStyles.input}
              />
              {codewordConfirming && (
                <View style={contentStyles.inlineChoices}>
                  <AppButton label="Yes, correct" onPress={() => answerYesRef.current()} palette={palette} scale={scale} />
                  <AppButton label="No, try again" onPress={() => answerNoRef.current()} palette={palette} scale={scale} secondary />
                </View>
              )}
            </View>
          )}

          {screen === 'confirm' && (
            <View style={contentStyles.choices}>
              <AppButton label={authMode === 'sign-up' ? 'Create account' : 'Sign in'} onPress={() => answerYesRef.current()} palette={palette} scale={scale} disabled={busy} />
              <AppButton label="No, go back" onPress={() => answerNoRef.current()} palette={palette} scale={scale} secondary disabled={busy} />
            </View>
          )}

          {screen === 'home' && (
            <View style={contentStyles.choices}>
              <Text accessibilityRole="header" style={contentStyles.sectionTitle}>Voice options</Text>
              <Text accessibilityLabel="Account email address" style={contentStyles.message}>
                Email: {email || session?.user.email || 'No email address available'}
              </Text>
              {visibleHomeOptions().map((option) => option.id === 'voice'
                ? <VoiceButton key={option.id} />
                : <AppButton
                    key={option.id}
                    label={option.label}
                    onPress={option.onPress}
                    palette={palette}
                    scale={scale}
                    secondary={option.secondary}
                    compact={'compact' in option && option.compact}
                  />)}
            </View>
          )}
        </ScrollView>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function makeScreenStyles(palette: Palette, scale: number) {
  return StyleSheet.create({
    frame: { flex: 1, paddingHorizontal: 16 * scale },
    navigation: {
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      paddingVertical: 8,
    },
    body: { flexGrow: 1, gap: 14, paddingBottom: 24, paddingTop: 8 },
    title: { color: palette.text, fontSize: 30 * scale, fontWeight: '900', lineHeight: 38 * scale },
    message: { color: palette.text, fontSize: 19 * scale, lineHeight: 27 * scale },
    heard: {
      color: palette.muted,
      fontSize: 17 * scale,
      fontWeight: '700',
      lineHeight: 24 * scale,
      minHeight: 26 * scale,
    },
    choices: { gap: 12, marginTop: 8 },
    form: { gap: 12, marginTop: 4 },
    inlineChoices: { gap: 12 },
    input: {
      backgroundColor: palette.input,
      borderColor: palette.border,
      borderRadius: 14,
      borderWidth: 3,
      color: palette.text,
      fontSize: 20 * scale,
      minHeight: 64,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    startBanner: {
      alignItems: 'center',
      backgroundColor: '#000000',
      borderColor: '#ffeb00',
      borderRadius: 18,
      borderWidth: 4,
      justifyContent: 'center',
      minHeight: 112,
      padding: 20,
    },
    startBannerText: { color: '#ffffff', fontSize: 24 * scale, fontWeight: '900', textAlign: 'center' },
    sectionTitle: { color: palette.text, fontSize: 24 * scale, fontWeight: '900', lineHeight: 32 * scale },
  });
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 68,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  compactButton: { minHeight: 48, minWidth: 96, paddingHorizontal: 12, paddingVertical: 8 },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <VoiceProvider>
        <AppContent />
      </VoiceProvider>
    </SafeAreaProvider>
  );
}
