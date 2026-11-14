export interface Note {
  id: number;
  habitId: number;
  date: string; // ISO YYYY-MM-DD
  text: string;
  isFailureReason: boolean;
  reasonType: "failure" | "skipped" | null;
  createdAt: number; // timestamp ms
  updatedAt: number; // timestamp ms
}
