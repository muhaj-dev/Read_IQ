import { type Href, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionRow, type ConnectionState } from '@/components/settings/connection-row';
import { SettingsHeader } from '@/components/settings/settings-header';
import { SettingsRow } from '@/components/settings/settings-row';
import { SettingsSection } from '@/components/settings/settings-section';
import { modelLabelFor } from '@/data/ai-models';
import { settingsSections } from '@/data/settings';
import { useTheme } from '@/hooks/use-theme';
import { checkGroqConnection } from '@/lib/groq';
import { checkHydraConnection } from '@/lib/hydra';
import { useSettingsStore } from '@/store/use-settings-store';

/** SETTINGS — grouped preference rows; AI Model + Data & Privacy navigate. */
export default function SettingsScreen() {
  const colors = useTheme();
  const router = useRouter();
  const [focusMode, setFocusMode] = useState(true);
  const chatModel = useSettingsStore((s) => s.chatModel);

  const [hydra, setHydra] = useState<ConnectionState>(null);
  const [groq, setGroq] = useState<ConnectionState>(null);

  // Checked on open rather than on a timer: these are network calls, and the
  // only moment the answer matters is when the student is looking at the row.
  // Both run independently so a slow HydraDB query doesn't hold up Groq's.
  useEffect(() => {
    const controller = new AbortController();
    // Both checks map an abort onto their ordinary "cannot reach" result, so the
    // flag — not the signal — is what stops a torn-down screen being told it is
    // offline on the way out.
    let live = true;
    const settle = (set: (state: ConnectionState) => void) => (state: ConnectionState) => {
      if (live) set(state);
    };
    checkHydraConnection(controller.signal).then(settle(setHydra));
    checkGroqConnection(controller.signal).then(settle(setGroq));
    return () => {
      live = false;
      controller.abort();
    };
  }, []);

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      <StatusBar style="dark" />
      <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
        <SettingsHeader title="Settings" />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {settingsSections.map((section) => (
            <SettingsSection key={section.key} label={section.label}>
              {section.rows.map((row, index) => (
                <SettingsRow
                  key={row.key}
                  // The AI Model row shows the live selection, not a static label.
                  item={row.key === 'model' ? { ...row, value: modelLabelFor(chatModel) } : row}
                  divider={index < section.rows.length - 1}
                  toggled={row.key === 'focus' ? focusMode : undefined}
                  onToggle={row.key === 'focus' ? setFocusMode : undefined}
                  onPress={
                    row.key === 'data-privacy'
                      ? () => router.push('/settings/data-privacy')
                      : row.key === 'model'
                        ? () => router.push('/settings/model' as Href)
                        : undefined
                  }
                />
              ))}
            </SettingsSection>
          ))}

          {/* Last, because it is the section a student reads only when something
              has stopped working. Two rows because they fail separately and mean
              different things: Ask degrades without HydraDB, quizzes stop
              without Groq. */}
          <SettingsSection label="Connections">
            <ConnectionRow icon="psychology" title="Notes & Memory" state={hydra} divider />
            <ConnectionRow icon="smart-toy" title="Quizzes & Transcripts" state={groq} divider={false} />
          </SettingsSection>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 40,
    gap: 40,
  },
});
