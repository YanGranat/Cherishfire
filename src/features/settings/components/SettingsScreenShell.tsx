import React, { type ComponentProps } from "react";
import { useRouter } from "expo-router";
import { Header } from "@/components/layout/Header";
import { ScreenWrapper } from "@/components/layout/ScreenWrapper";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { settingsScreenBackgrounds } from "@/theme/colors";
interface SettingsScreenShellProps {
  title: string;
  rightActions?: ComponentProps<typeof Header>["rightActions"];
  scrollableBody?: boolean;
  children: React.ReactNode;
}
// Settings keep their navigation and primary header action fixed. Only the
// list below the header scrolls, so long option lists cannot hide Back/Add.
export function SettingsScreenShell({
  title,
  rightActions,
  scrollableBody = true,
  children,
}: SettingsScreenShellProps) {
  const router = useRouter();
  const backgroundColor = settingsScreenBackgrounds[useVisualEffectiveMode()];
  return (
    <ScreenWrapper padBottom={false} backgroundColor={backgroundColor}>
      <Header
        backgroundColor={backgroundColor}
        title={title}
        showBack
        onBack={() => {
          router.back();
        }}
        centerTitle
        rightActions={rightActions}
      />
      {scrollableBody ? (
        <ScreenWrapper scrollable backgroundColor={backgroundColor}>
          {children}
        </ScreenWrapper>
      ) : (
        children
      )}
    </ScreenWrapper>
  );
}
