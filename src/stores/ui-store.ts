import { create } from "zustand";
import { format } from "date-fns/format";
interface NotificationPresentationRequest {
  requestId: number;
  date: string;
}
let notificationRequestSequence = 0;
interface UIStore {
  selectedDate: string; // ISO YYYY-MM-DD, default: today
  isCalendarVisible: boolean;
  notificationPresentationRequest: NotificationPresentationRequest | null;
  selectDate(date: string): void;
  toggleCalendar(): void;
  requestNotificationPresentation(date: string): void;
  completeNotificationPresentation(requestId: number): void;
}
export const useUIStore = create<UIStore>((set) => ({
  selectedDate: format(new Date(), "yyyy-MM-dd"),
  isCalendarVisible: true,
  notificationPresentationRequest: null,
  selectDate(date) {
    if (useUIStore.getState().selectedDate === date) return;
    set({ selectedDate: date });
  },
  toggleCalendar() {
    set((state) => {
      const nextVisible = !state.isCalendarVisible;
      return { isCalendarVisible: nextVisible };
    });
  },
  requestNotificationPresentation(date) {
    notificationRequestSequence += 1;
    set({
      notificationPresentationRequest: {
        requestId: notificationRequestSequence,
        date,
      },
    });
  },
  completeNotificationPresentation(requestId) {
    set((state) =>
      state.notificationPresentationRequest?.requestId === requestId
        ? { notificationPresentationRequest: null }
        : state,
    );
  },
}));
