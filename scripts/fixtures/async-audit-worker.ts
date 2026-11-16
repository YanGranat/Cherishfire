import { withAuditDeadline } from "./with-audit-deadline";

const mode = process.argv[2];
void withAuditDeadline(
  () => {
    switch (mode) {
      case "resolve":
        return Promise.resolve();
      case "reject":
        return Promise.reject(new Error("Rejected audit task"));
      case "throw":
        throw new Error("Thrown audit task");
      case "pending":
        return new Promise<void>(() => {});
      default:
        throw new Error("Unknown audit task");
    }
  },
  "Worker audit",
  50,
).then(
  () => console.log("Worker audit completed."),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
