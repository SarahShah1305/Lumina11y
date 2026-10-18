export type CommandHandler = (spokenText: string, matchedPhrase: string) => void | Promise<void>;

export type VoiceCommand = {
  id: number;
  phrases: string[];
  description: string;
  handler: CommandHandler;
};

const fillerWords = new Set(['a', 'an', 'can', 'could', 'hey', 'me', 'please', 'the', 'to', 'um', 'uh', 'you']);
const commands = new Map<number, VoiceCommand>();
let nextCommandId = 1;

export function normalizeCommand(text: string): string {
  return text
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !fillerWords.has(word))
    .join(' ');
}

function editDistance(first: string, second: string): number {
  const row = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    let diagonal = row[0];
    row[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const above = row[secondIndex];
      row[secondIndex] = Math.min(
        row[secondIndex] + 1,
        row[secondIndex - 1] + 1,
        diagonal + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[second.length];
}

function phraseScore(spoken: string, phrase: string): number {
  if (spoken === phrase) return 1;
  if (spoken.includes(phrase) || phrase.includes(spoken)) return 0.9;
  const length = Math.max(spoken.length, phrase.length);
  const distance = editDistance(spoken, phrase);
  const allowedDistance = Math.max(1, Math.floor(length * 0.2));
  return distance <= allowedDistance ? 1 - distance / length : 0;
}

export function registerCommand(
  phrases: string | string[],
  handler: CommandHandler,
  description?: string,
): () => void {
  const cleanedPhrases = (Array.isArray(phrases) ? phrases : [phrases])
    .map(normalizeCommand)
    .filter(Boolean);
  if (cleanedPhrases.length === 0) {
    throw new Error('A voice command must have at least one non-empty phrase.');
  }

  const id = nextCommandId++;
  commands.set(id, {
    id,
    phrases: cleanedPhrases,
    description: description?.trim() || cleanedPhrases.join(' or '),
    handler,
  });
  return () => {
    commands.delete(id);
  };
}

export function getVoiceCommands(): VoiceCommand[] {
  return [...commands.values()];
}

export function findVoiceCommand(spokenText: string): { command: VoiceCommand; phrase: string } | null {
  const normalizedSpeech = normalizeCommand(spokenText);
  if (!normalizedSpeech) return null;

  let best: { command: VoiceCommand; phrase: string; score: number } | null = null;
  let tiedForBest = false;
  for (const command of commands.values()) {
    for (const phrase of command.phrases) {
      const score = phraseScore(normalizedSpeech, phrase);
      if (score > (best?.score ?? 0)) {
        best = { command, phrase, score };
        tiedForBest = false;
      } else if (score > 0 && score === best?.score && command.id !== best.command.id) {
        tiedForBest = true;
      }
    }
  }

  return best && !tiedForBest ? { command: best.command, phrase: best.phrase } : null;
}
