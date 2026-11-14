import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SEPARATOR_RENDER_HEIGHT } from "../animation/constants";

interface CompletedSectionToggleVisualProps {
  expanded: boolean;
  separatorColor: string;
  topSeparatorStyle?: StyleProp<ViewStyle>;
  toggleColor: string;
  showLabel: string;
  hideLabel: string;
  onPress?: () => void;
  backgroundColor?: string;
}

export function CompletedSectionToggleVisual({
  expanded,
  separatorColor,
  topSeparatorStyle,
  toggleColor,
  showLabel,
  hideLabel,
  onPress,
  backgroundColor = "transparent",
}: CompletedSectionToggleVisualProps) {
  const content = (
    <>
      <MaterialIcons
        name={expanded ? "keyboard-arrow-up" : "keyboard-arrow-down"}
        size={24}
        color={toggleColor}
      />
      <Text style={[styles.toggleText, { color: toggleColor }]}>
        {expanded ? hideLabel : showLabel}
      </Text>
    </>
  );

  return (
    <View style={styles.container}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.topSeparatorLine,
          { backgroundColor: separatorColor },
          topSeparatorStyle,
        ]}
      />
      {onPress ? (
        <Pressable
          onPress={onPress}
          style={[styles.toggleRow, { backgroundColor }]}
        >
          {content}
        </Pressable>
      ) : (
        <View style={[styles.toggleRow, { backgroundColor }]}>{content}</View>
      )}
      <View
        pointerEvents="none"
        style={[
          styles.bottomSeparatorLine,
          { backgroundColor: separatorColor },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
  },
  topSeparatorLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: SEPARATOR_RENDER_HEIGHT,
    zIndex: 1,
  },
  bottomSeparatorLine: {
    height: SEPARATOR_RENDER_HEIGHT,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 15 + SEPARATOR_RENDER_HEIGHT,
    paddingBottom: 15,
    paddingLeft: 20,
  },
  toggleText: {
    fontSize: 16,
    marginLeft: 6,
  },
});
