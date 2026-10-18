import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { VoiceButton } from './VoiceButton';
import { useVoice } from './VoiceContext';

export function VoiceDemoScreen() {
  const { lastHeard, registerCommand, registerShortcut, speak } = useVoice();

  useEffect(() => {
    const unregisterCommand = registerCommand(
      ['demo greeting', 'say hello'],
      () => speak('Hello. Voice commands are working.'),
      'Test command matching',
    );
    const unregisterShortcut = registerShortcut('Alt+G', 'Speak the voice demo greeting', () => {
      speak('Hello from the keyboard shortcut.');
    });
    return () => {
      unregisterCommand();
      unregisterShortcut();
    };
  }, [registerCommand, registerShortcut, speak]);

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>Voice demo (development)</Text>
      <Text style={styles.instruction}>
        Use the button and say “demo greeting”. Say “help” to hear registered commands and keyboard shortcuts.
      </Text>
      <VoiceButton />
      <Pressable
        accessibilityLabel="Test speech output"
        accessibilityRole="button"
        onPress={() => speak('Speech output is working.')}
        style={styles.action}
      >
        <Text style={styles.actionText}>Test speech output</Text>
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={styles.result}>
        {lastHeard ? `Last heard: ${lastHeard}` : 'No speech recognized yet.'}
      </Text>
      <Text style={styles.hint}>Web shortcut test: press Alt+G outside a text field.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'stretch', backgroundColor: '#ffffff', borderColor: '#003747', borderWidth: 2, gap: 16, padding: 24 },
  title: { color: '#142d3a', fontSize: 24, fontWeight: '800' },
  instruction: { color: '#142d3a', fontSize: 18, lineHeight: 26 },
  action: { alignItems: 'center', backgroundColor: '#ffeb00', borderColor: '#000000', borderWidth: 2, minHeight: 60, justifyContent: 'center', padding: 12 },
  actionText: { color: '#000000', fontSize: 18, fontWeight: '800' },
  result: { color: '#142d3a', fontSize: 18, lineHeight: 26 },
  hint: { color: '#405966', fontSize: 16, lineHeight: 24 },
});
