import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { findVoiceCommand, getVoiceCommands, normalizeCommand, registerCommand, type CommandHandler } from './commands';
import {
  isListening as getListeningState,
  startListening as startPlatformListening,
  stopListening as stopPlatformListening,
  subscribeToListening,
  type ListeningError,
} from './listening';
import { getDefaultSpeechRate, setDefaultSpeechRate, speak as speakText, stopSpeaking as stopSpeech, type SpeakOptions } from './speak';
import {
  findVoiceShortcut,
  getVoiceShortcuts,
  registerShortcut,
  subscribeToShortcuts,
  type VoiceShortcut,
} from './shortcuts';

type VoiceContextValue = {
  speak: (text: string, options?: SpeakOptions) => void;
  stopSpeaking: () => void;
  startListening: (
    onResult?: (text: string) => void,
    onError?: (error: ListeningError, details?: string) => void,
  ) => Promise<void>;
  stopListening: (announce?: boolean) => void;
  repeatLastResponse: () => void;
  setRepeatHandler: (handler: (() => void) | null) => () => void;
  readHelp: () => void;
  setHelpHandler: (handler: (() => void) | null) => () => void;
  registerCommand: (phrases: string | string[], handler: CommandHandler, description?: string) => () => void;
  registerShortcut: (keyCombo: string, label: string, handler: () => void | Promise<void>) => () => void;
  setSpeechRate: (rate: number) => void;
  speechRate: number;
  isListening: boolean;
  lastHeard: string;
  shortcuts: VoiceShortcut[];
};

type VoiceProviderProps = {
  children: React.ReactNode;
  onGoBack?: () => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function VoiceProvider({ children, onGoBack, onLogout }: VoiceProviderProps) {
  const [listening, setListening] = useState(getListeningState);
  const [lastHeard, setLastHeard] = useState('');
  const [speechRate, setSpeechRateState] = useState(getDefaultSpeechRate);
  const [shortcuts, setShortcuts] = useState(getVoiceShortcuts);
  const lastResponse = useRef('');
  const repeatHandler = useRef<(() => void) | null>(null);
  const helpHandler = useRef<(() => void) | null>(null);
  const actionHandlers = useRef({ onGoBack, onLogout });
  actionHandlers.current = { onGoBack, onLogout };

  const speak = useCallback((text: string, options?: SpeakOptions) => {
    if (text.trim() && options?.rememberLastResponse !== false) lastResponse.current = text;
    stopPlatformListening(false);
    speakText(text, options);
  }, []);

  const stopSpeaking = useCallback(() => {
    stopSpeech();
  }, []);

  const repeatLastResponse = useCallback(() => {
    if (repeatHandler.current) {
      repeatHandler.current();
      return;
    }
    if (lastResponse.current) speak(lastResponse.current);
    else speak('There is no response to repeat yet.');
  }, [speak]);

  const setRepeatHandler = useCallback((handler: (() => void) | null) => {
    repeatHandler.current = handler;
    return () => {
      if (repeatHandler.current === handler) repeatHandler.current = null;
    };
  }, []);

  const setSpeechRate = useCallback((rate: number) => {
    setDefaultSpeechRate(rate);
    setSpeechRateState(rate);
  }, []);

  const readHelp = useCallback(() => {
    if (helpHandler.current) {
      helpHandler.current();
      return;
    }
    const commands = getVoiceCommands();
    const currentShortcuts = getVoiceShortcuts();
    const lines = [
      'Voice commands.',
      ...commands.map((command) => `${command.phrases.join(' or ')}. ${command.description}.`),
      'Keyboard shortcuts.',
      ...currentShortcuts.map((shortcut) => `${shortcut.keyCombo}. ${shortcut.label}.`),
      'Arrow Right. Go to the next screen.',
      'Arrow Left. Go back to the previous screen.',
    ];
    stopSpeech();
    const helpRate = Math.min(getDefaultSpeechRate(), 0.85);
    lines.forEach((line, index) => speak(line, { queue: index > 0, rate: helpRate }));
  }, [speak]);

  const setHelpHandler = useCallback((handler: (() => void) | null) => {
    helpHandler.current = handler;
    return () => {
      if (helpHandler.current === handler) helpHandler.current = null;
    };
  }, []);

  const startListening = useCallback(async (
    onResult?: (text: string) => void,
    onError?: (error: ListeningError, details?: string) => void,
  ) => {
    await startPlatformListening(
      async (text) => {
        stopPlatformListening(false);
        console.log('[voice] Transcript received by voice context:', text || '[empty]');
        setLastHeard(text);
        if (onResult) {
          onResult(text);
          return;
        }
        const normalizedText = normalizeCommand(text);
        const match = findVoiceCommand(normalizedText);
        console.log(`[voice ${new Date().toISOString()}] Command mapped:`, match?.phrase ?? '[no match]');
        if (!match) {
          speak("I didn't hear anything. Say it again.");
          return;
        }
        console.log(`[voice ${new Date().toISOString()}] Command executed:`, match.phrase);
        void Promise.resolve(match.command.handler(normalizedText, match.phrase)).catch((error: unknown) => {
          console.error(`Voice command "${match.phrase}" failed.`, error);
          speak("I couldn't complete that command. Please try again.");
        });
      },
      onError,
    );
  }, [speak]);

  const stopListening = useCallback((announce = true) => {
    stopPlatformListening(announce);
  }, []);

  useEffect(() => subscribeToListening(setListening), []);
  useEffect(() => subscribeToShortcuts(() => setShortcuts(getVoiceShortcuts())), []);
  useEffect(() => () => stopPlatformListening(false), []);
  useEffect(() => {
    setDefaultSpeechRate(speechRate);
  }, [speechRate]);

  useEffect(() => {
    const unregister = [
      registerCommand('go back', async () => {
        if (actionHandlers.current.onGoBack) await actionHandlers.current.onGoBack();
        else {
          const backCommand = findVoiceCommand('previous page');
          if (backCommand) await backCommand.command.handler('back', backCommand.phrase);
          else speak('Go back is not connected on this screen.');
        }
      }, 'Go back to the previous page'),
      registerCommand('repeat', () => {
        repeatLastResponse();
      }, 'Repeat the last response'),
      registerCommand('help', readHelp, 'Hear the available voice commands and shortcuts'),
      registerCommand('stop', () => {
        stopSpeech();
        stopPlatformListening(false);
      }, 'Stop speaking and listening'),
      registerCommand('slower', () => {
        const nextRate = Math.max(0.75, Math.round((getDefaultSpeechRate() - 0.1) * 100) / 100);
        setSpeechRate(nextRate);
        speak(nextRate === 0.75 ? 'Speech is at its slowest setting.' : 'Speech slowed down.');
      }, 'Slow down the voice'),
      registerCommand('faster', () => {
        const nextRate = Math.min(1.5, Math.round((getDefaultSpeechRate() + 0.1) * 100) / 100);
        setSpeechRate(nextRate);
        speak(nextRate === 1.5 ? 'Speech is at its fastest setting.' : 'Speech sped up.');
      }, 'Speed up the voice'),
      registerCommand('logout', async () => {
        if (actionHandlers.current.onLogout) await actionHandlers.current.onLogout();
        else {
          const signOutCommand = findVoiceCommand('sign out');
          if (signOutCommand) await signOutCommand.command.handler('sign out', signOutCommand.phrase);
          else speak('Logout is ready to connect to your account handler.');
        }
      }, 'Sign out of your account'),
    ];
    return () => unregister.forEach((remove) => remove());
  }, [readHelp, repeatLastResponse, setSpeechRate, speak]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) return;

      const shortcut = findVoiceShortcut(event.key);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.keyCombo === 'Alt+H') {
        readHelp();
        return;
      }
      if (shortcut.handler) {
        void Promise.resolve().then(() => shortcut.handler?.()).catch((error: unknown) => {
          console.error(`Keyboard shortcut "${shortcut.keyCombo}" failed.`, error);
          speak('I could not complete that shortcut. Please try again.');
        });
      } else {
        speak(`${shortcut.label} is not connected yet.`);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readHelp, speak]);

  const value: VoiceContextValue = {
    speak,
    stopSpeaking,
    startListening,
    stopListening,
    repeatLastResponse,
    setRepeatHandler,
    readHelp,
    setHelpHandler,
    registerCommand,
    registerShortcut,
    setSpeechRate,
    speechRate,
    isListening: listening,
    lastHeard,
    shortcuts,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceContextValue {
  const context = useContext(VoiceContext);
  if (!context) throw new Error('useVoice must be used inside a VoiceProvider.');
  return context;
}
