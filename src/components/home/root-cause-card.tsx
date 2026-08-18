import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { fonts } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/color';
import type { RootCause } from '@/lib/root-cause';

type Props = {
  cause: RootCause;
  /** How many weak topics were analysed — the denominator, so the card can say
   *  "2 of your 3" instead of overclaiming. */
  total: number;
};

/** One upstream concept, what it explains, and the sentence from the student's
 *  own notes that justifies it — so the claim is checkable, not asserted. */
export function RootCauseCard({ cause, total }: Props) {
  const colors = useTheme();
  const count = cause.explains.length;
  // Only claim "all" when it genuinely covers every topic analysed.
  const scope =
    total === 1
      ? 'your weak topic'
      : count >= total
        ? `all ${total} of your weak topics`
        : `${count} of your ${total} weak topics`;

  return (
    <View
      className="gap-2 rounded-2xl p-4"
      style={{
        backgroundColor: colors.surfaceContainer,
        borderWidth: 1,
        borderColor: withAlpha(colors.outlineVariant, 0.3),
      }}>
      <View className="flex-row items-center gap-2">
        <AppIcon name="psychology" size={16} color={colors.primary} />
        <Text style={[styles.concept, { color: colors.onSurface }]} numberOfLines={1}>
          {cause.concept}
        </Text>
      </View>

      <Text style={[styles.explains, { color: colors.onSurfaceVariant }]}>
        Sits underneath {scope} — {cause.explains.join(', ')}
      </Text>

      {cause.evidence ? (
        <Text style={[styles.evidence, { color: colors.onSurfaceVariant }]} numberOfLines={3}>
          “{cause.evidence.trim()}”
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  concept: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontFamily: fonts.headingSemibold,
    textTransform: 'capitalize',
  },
  explains: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.bodyMedium,
  },
  evidence: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: fonts.bodyItalic,
    opacity: 0.85,
  },
});
