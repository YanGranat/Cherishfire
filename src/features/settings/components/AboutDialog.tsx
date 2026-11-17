/** @jsxImportSource nativewind */
import { View, Text } from "react-native";
import Constants from "expo-constants";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/Dialog";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { lightTheme, darkTheme } from "@/theme/colors";
interface AboutDialogProps {
  visible: boolean;
  onClose: () => void;
}
// Compact product dialog with title, description, and version.
// No app icon or large logo - text only.
export function AboutDialog({ visible, onClose }: AboutDialogProps) {
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const appVersion = Constants.expoConfig?.version ?? "1.5.122";
  return (
    <Dialog
      visible={visible}
      title={t("about.title")}
      variant="about"
      titleStyle={{
        fontSize: 20,
        lineHeight: 26,
        fontWeight: "400",
        marginBottom: 16,
      }}
      contentBackgroundColor={palette.menuSurface}
      contentStyle={{ paddingBottom: 12 }}
      actionsContainerStyle={{
        width: "100%",
        justifyContent: "flex-end",
        columnGap: 0,
      }}
      actionButtonStyle={{
        paddingHorizontal: 0,
      }}
      actions={[
        {
          label: t("about.close"),
          onPress: onClose,
          role: "cancel",
          tone: "muted",
          textStyle: {
            color: palette.muted,
            fontSize: 13.5,
            lineHeight: 19,
            fontWeight: "600",
          },
        },
      ]}
    >
      <View>
        <Text className="text-base mb-sm" style={{ color: palette.muted }}>
          {t("about.description")}
        </Text>
        <Text className="text-sm" style={{ color: palette.muted }}>
          {t("about.version", { version: appVersion })}
        </Text>
      </View>
    </Dialog>
  );
}
