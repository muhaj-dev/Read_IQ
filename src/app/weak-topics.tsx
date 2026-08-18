import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmptyHint } from '@/components/home/empty-hint';
import { RootCauseCard } from '@/components/home/root-cause-card';
import { WeakTopicChips } from '@/components/home/weak-topic-chips';
import { SettingsHeader } from '@/components/settings/settings-header';
import { fonts } from '@/constants/typography';
import { useRootCauses } from '@/hooks/use-root-causes';
import { useTheme } from '@/hooks/use-theme';
import { summarizeWeakTopics } from '@/lib/quiz-stats';
import { useQuizStore } from '@/store/use-quiz-store';

/** All weak topics from recent quizzes — the "View all" target from the dashboard. */
export default function WeakTopicsScreen() {
  const colors = useTheme();
  const router = useRouter();
  const results = useQuizStore((s) => s.results);
  const topics = summarizeWeakTopics(results, Infinity);
  const failing = topics.filter((t) => t.weak).length;
  // Root causes are derived from the failing topics only — the ones the latest
  // quiz actually flagged, not everything ever missed.
  const { causes, loading } = useRootCauses(topics.filter((t) => t.weak).map((t) => t.label));

  return (
    <View className="flex-1" style={{ backgroundColor: colors.surface }}>
      <StatusBar style="dark" />
      <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
        <SettingsHeader title="Weak Topics" />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {topics.length > 0 ? (
            <View className="gap-4">
              <Text style={[styles.subtitle, { color: colors.onSurfaceVariant }]}>
                {failing > 0
                  ? `${failing} ${failing === 1 ? 'topic' : 'topics'} to review from your latest quiz, plus earlier ones worth another look.`
                  : 'Topics from your recent quizzes worth another look.'}
              </Text>
              <WeakTopicChips topics={topics} />

              {loading || causes.length > 0 ? (
                <View className="gap-3 pt-2">
                  <View className="gap-1">
                    <Text style={[styles.sectionTitle, { color: colors.onSurface }]}>
                      What is actually causing this
                    </Text>
                    <Text style={[styles.subtitle, { color: colors.onSurfaceVariant }]}>
                      {loading
                        ? 'Tracing your weak topics back through your notes…'
                        : 'These sit underneath the topics you missed. Study them first.'}
                    </Text>
                  </View>
                  {causes.map((cause) => (
                    <RootCauseCard key={cause.concept} cause={cause} />
                  ))}
                </View>
              ) : null}
            </View>
          ) : (
            <EmptyHint
              icon="quiz"
              title="No weak topics yet"
              subtitle="Take a quiz and we'll surface the topics worth reviewing here."
              cta="Start a quiz"
              onPress={() => router.push('/quiz')}
            />
          )}
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
    paddingTop: 8,
    paddingBottom: 40,
  },
  sectionTitle: {
    fontSize: 16,
    lineHeight: 22,
    fontFamily: fonts.headingSemibold,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 20,
    fontFamily: fonts.bodyRegular,
  },
});
