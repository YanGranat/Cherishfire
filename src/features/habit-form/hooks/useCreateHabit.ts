import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useHabitStore } from "@/stores/habit-store";
import type { CreateHabitInput } from "@/types/habit";
// Hook for habit creation: validates, creates, navigates back.
export function useCreateHabit() {
  const router = useRouter();
  const createHabit = useHabitStore((s) => s.createHabit);
  const createInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const clearError = useCallback(() => setError(null), []);
  const create = useCallback(
    async (input: CreateHabitInput) => {
      if (!input.name.trim()) return false;
      if (createInFlightRef.current) {
        return false;
      }
      createInFlightRef.current = true;
      setError(null);
      try {
        // Keep the form and its draft until the write succeeds. A failed write
        // must remain retryable without making the user enter the habit again.
        await createHabit(input);
        if (isMountedRef.current) router.back();
        return true;
      } catch (createError) {
        console.error("Failed to create habit", createError);
        if (isMountedRef.current) setError("create-failed");
        return false;
      } finally {
        createInFlightRef.current = false;
      }
    },
    [createHabit, router],
  );
  return {
    create,
    error,
    clearError,
  };
}
