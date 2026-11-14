import fs from "node:fs";
import path from "node:path";
import { OneShotActionGate } from "../src/application/interaction/one-shot-action-gate";

type CheckResult = {
  name: string;
  ok: boolean;
  details?: string;
};

function fileExists(projectRoot: string, relativePath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

function readFile(projectRoot: string, relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function runAudit(): CheckResult[] {
  const projectRoot = process.cwd();
  const requiredFiles = [
    "app/habit/[id].tsx",
    "src/features/habit-detail/components/InlineDescription.tsx",
    "src/features/habit-detail/components/MonthCalendar.tsx",
    "src/features/habit-detail/components/ProgressStats.tsx",
    "src/features/habit-detail/components/EditRows.tsx",
    "src/features/habit-detail/components/HabitDetailFormOverlayController.tsx",
    "src/features/habit-detail/components/HabitDetailStatusOverlayController.tsx",
    "src/features/habit-form/components/RepeatSheet.tsx",
    "src/features/habit-form/components/ReminderScreen.tsx",
    "src/features/habits/components/FailureReasonDialog.tsx",
  ];

  const checks: CheckResult[] = requiredFiles.map((relativePath) => ({
    name: `file:${relativePath}`,
    ok: fileExists(projectRoot, relativePath),
    details: fileExists(projectRoot, relativePath)
      ? undefined
      : "missing required file",
  }));

  const habitScreenPath = "app/habit/[id].tsx";
  if (fileExists(projectRoot, habitScreenPath)) {
    const content = readFile(projectRoot, habitScreenPath);
    const requiredTokens = [
      "InlineDescription",
      "MonthCalendar",
      "ProgressStats",
      "EditRows",
    ];
    for (const token of requiredTokens) {
      checks.push({
        name: `token:${token}`,
        ok: content.includes(token),
        details: content.includes(token)
          ? undefined
          : `token "${token}" not found in ${habitScreenPath}`,
      });
    }
    checks.push({
      name: "terminal-mutations:one-shot-gate",
      ok:
        /const handleArchive = useCallback\([\s\S]{0,180}if \(!claimTerminalMutation\(\)\)[\s\S]{0,180}archiveHabit\(habitId\)[\s\S]{0,80}router\.back\(\)/.test(
          content,
        ) &&
        /const handleDelete = useCallback\([\s\S]{0,180}if \(!claimTerminalMutation\(\)\)[\s\S]{0,180}deleteHabit\(habitId\)[\s\S]{0,80}router\.back\(\)/.test(
          content,
        ),
      details: "archive/delete must not issue duplicate router.back() calls",
    });
  }

  const formOverlayControllerPath =
    "src/features/habit-detail/components/HabitDetailFormOverlayController.tsx";
  if (fileExists(projectRoot, formOverlayControllerPath)) {
    const content = readFile(projectRoot, formOverlayControllerPath);
    for (const token of ["RepeatSheet", "ReminderScreen"]) {
      checks.push({
        name: `token:${token}`,
        ok: content.includes(token),
        details: content.includes(token)
          ? undefined
          : `token "${token}" not found in ${formOverlayControllerPath}`,
      });
    }
  }

  const statusOverlayControllerPath =
    "src/features/habit-detail/components/HabitDetailStatusOverlayController.tsx";
  if (fileExists(projectRoot, statusOverlayControllerPath)) {
    const content = readFile(projectRoot, statusOverlayControllerPath);
    for (const token of ["CalendarDayMenu", "FailureReasonDialog"]) {
      checks.push({
        name: `token:${token}`,
        ok: content.includes(token),
        details: content.includes(token)
          ? undefined
          : `token "${token}" not found in ${statusOverlayControllerPath}`,
      });
    }
  }

  const gate = new OneShotActionGate();
  checks.push({
    name: "terminal-mutations:one-shot-behavior",
    ok: gate.claim() && !gate.claim() && !gate.claim(),
    details: "only the first rapid terminal action may claim navigation",
  });

  return checks;
}

function main(): void {
  const results = runAudit();
  const failed = results.filter((result) => !result.ok);

  for (const result of results) {
    if (result.ok) {
      console.log(`PASS ${result.name}`);
      continue;
    }
    console.error(
      `FAIL ${result.name}${result.details ? ` - ${result.details}` : ""}`
    );
  }

  if (failed.length > 0) {
    console.error(
      `habit scene structural audit failed: ${failed.length} check(s) failed`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`habit scene structural audit passed: ${results.length} checks`);
}

main();
