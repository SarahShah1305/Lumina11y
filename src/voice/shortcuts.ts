export type ShortcutHandler = () => void | Promise<void>;

export type VoiceShortcut = {
  keyCombo: string;
  label: string;
  handler?: ShortcutHandler;
};

const defaults: VoiceShortcut[] = [
  { keyCombo: 'Alt+H', label: 'Hear voice commands and keyboard shortcuts' },
  { keyCombo: 'Alt+B', label: 'Go back to the previous screen' },
  { keyCombo: 'Alt+E', label: 'Emergency help' },
  { keyCombo: 'Alt+R', label: 'Start or read back guided typing' },
  { keyCombo: 'Alt+N', label: 'Open notes' },
];

const shortcuts = new Map<string, VoiceShortcut>();
const listeners = new Set<() => void>();

function normalizeCombo(keyCombo: string): string {
  const key = keyCombo
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1)
    ?.toLocaleUpperCase();
  if (!key) throw new Error('A keyboard shortcut must include a key.');
  return `Alt+${key}`;
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

export function registerShortcut(keyCombo: string, label: string, handler: ShortcutHandler): () => void {
  const normalizedCombo = normalizeCombo(keyCombo);
  const previous = shortcuts.get(normalizedCombo);
  shortcuts.set(normalizedCombo, { keyCombo: normalizedCombo, label: label.trim(), handler });
  notifyListeners();

  return () => {
    if (previous) shortcuts.set(normalizedCombo, previous);
    else shortcuts.delete(normalizedCombo);
    notifyListeners();
  };
}

export function getVoiceShortcuts(): VoiceShortcut[] {
  return defaults.map((shortcut) => shortcuts.get(shortcut.keyCombo) ?? shortcut)
    .concat(
      [...shortcuts.values()].filter((shortcut) => !defaults.some((item) => item.keyCombo === shortcut.keyCombo)),
    );
}

export function findVoiceShortcut(key: string): VoiceShortcut | undefined {
  const normalizedKey = key.toLocaleUpperCase();
  return getVoiceShortcuts().find((shortcut) => shortcut.keyCombo === `Alt+${normalizedKey}`);
}

export function subscribeToShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function normalizeShortcutCombo(keyCombo: string): string {
  return normalizeCombo(keyCombo);
}
