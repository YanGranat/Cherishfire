/** @jsxImportSource nativewind */
import React from "react";
import {
  View,
  ScrollView,
  type ScrollViewProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface ScreenWrapperProps {
  children: React.ReactNode;
  scrollable?: boolean;
  scrollEnabled?: boolean;
  style?: ViewStyle;
  padBottom?: boolean;
  backgroundColor?: string;
  scrollViewRef?: React.Ref<ScrollView>;
  onScroll?: ScrollViewProps["onScroll"];
  onContentSizeChange?: ScrollViewProps["onContentSizeChange"];
  scrollEventThrottle?: ScrollViewProps["scrollEventThrottle"];
}

// Shared safe-area padding and screen background.
export function ScreenWrapper({
  children,
  scrollable = false,
  scrollEnabled = true,
  style,
  padBottom = true,
  backgroundColor,
  scrollViewRef,
  onScroll,
  onContentSizeChange,
  scrollEventThrottle,
}: ScreenWrapperProps) {
  const insets = useSafeAreaInsets();
  const bgOverride = backgroundColor ? { backgroundColor } : null;

  if (scrollable) {
    return (
      <ScrollView
        ref={scrollViewRef}
        className="flex-1 bg-background"
        style={bgOverride ?? undefined}
        scrollEnabled={scrollEnabled}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={[
          { paddingBottom: padBottom ? insets.bottom + 16 : 0 },
          style,
        ]}
        keyboardShouldPersistTaps="always"
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View
      className="flex-1 bg-background"
      style={[
        { paddingBottom: padBottom ? insets.bottom : 0 },
        bgOverride,
        style,
      ]}
    >
      {children}
    </View>
  );
}
