export async function withAuditDeadline(
  audit: () => Promise<void>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`${label} did not reach completion`)),
          timeoutMs,
        );
      }),
      Promise.resolve().then(audit),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
