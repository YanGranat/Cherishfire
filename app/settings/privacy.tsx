/** @jsxImportSource nativewind */
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsScreenShell } from "@/features/settings/components/SettingsScreenShell";
import { privacyPolicy } from "@/features/settings/privacy-policy";

export default function PrivacyScreen() {
  const { t } = useTranslation();
  return (
    <SettingsScreenShell title={t("settings.privacyPolicy")}>
      <View className="px-base py-base">
        <Text className="text-primary text-lg font-semibold mb-base">
          {privacyPolicy.title}
        </Text>
        {privacyPolicy.sections.map((section) => (
          <View key={section.title} className="mb-base">
            <Text
              className="text-primary text-base font-semibold mb-sm"
              accessibilityRole="header"
            >
              {section.title}
            </Text>
            <Text selectable className="text-primary text-base leading-6">
              {section.text}
            </Text>
          </View>
        ))}
      </View>
    </SettingsScreenShell>
  );
}
