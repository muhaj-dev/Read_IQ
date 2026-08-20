import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { fonts } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/color';

/** null while the check is still in flight. */
export type ConnectionState = { ok: boolean; message: string } | null;

type Props = {
  icon: AppIconName;
  title: string;
  state: ConnectionState;
  divider: boolean;
};

/** A live service status row: what it powers, and whether it is actually working.
 *
 *  Deliberately not pressable. Nothing here is a setting the student can change
 *  from the phone — the keys come from the build — so a chevron would promise a
 *  screen that cannot exist. It reports, and that is all it does. */
export function ConnectionRow({ icon, title, state, divider }: Props) {
  const colors = useTheme();

  // quizCheck is the app's existing "this is right" green (the quiz's correct
  // mark); reusing it keeps one green in the app rather than inventing a second.
  const tone =
    state === null ? colors.onSurfaceVariant : state.ok ? colors.quizCheck : colors.error;

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`${title}: ${state?.message ?? 'checking'}`}
      className="flex-row items-center justify-between gap-4 p-5"
      style={
        divider && {
          borderBottomWidth: 1,
          borderBottomColor: withAlpha(colors.outlineVariant, 0.5),
        }
      }>
      <View className="flex-1 flex-row items-center gap-4">
        <AppIcon name={icon} size={24} color={colors.outline} />
        <View className="flex-1">
          <Text style={[styles.title, { color: colors.onSurface }]}>{title}</Text>
          <Text style={[styles.message, { color: tone }]}>
            {state?.message ?? 'Checking…'}
          </Text>
        </View>
      </View>

      {state === null ? (
        <ActivityIndicator size="small" color={colors.outlineVariant} />
      ) : (
        <AppIcon name={state.ok ? 'check-circle' : 'warning'} size={20} color={tone} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: fonts.bodyRegular,
  },
  message: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: fonts.bodyMedium,
  },
});
