import React from "react";
import { useIsFocused } from "@react-navigation/native";

import {
  warmRouteModulesSequentially,
  type RouteModuleWarmupEntry,
} from "@/utils/route-module-warmup";

/**
 * Keeps route-module evaluation owned by the scene the user can currently see.
 * Native stacks retain blurred scenes, so a mount-scoped warmup could otherwise
 * continue consuming the single JavaScript thread during an interaction on a
 * different screen. This tiny coordinator rerenders itself on focus changes;
 * it never subscribes the heavy screen body to navigation focus.
 */
export const FocusedRouteModuleWarmup = React.memo(
  function FocusedRouteModuleWarmup({
    entries,
  }: {
    entries: readonly RouteModuleWarmupEntry[];
  }) {
    const isFocused = useIsFocused();

    React.useEffect(() => {
      if (!isFocused) return;
      const task = warmRouteModulesSequentially(entries);
      return () => task.cancel();
    }, [entries, isFocused]);

    return null;
  },
);
