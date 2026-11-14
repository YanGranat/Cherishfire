export const privacyPolicy = {
  title: "Cherishfire Privacy Policy",
  contact: "yangranat@gmail.com",
  sections: [
    {
      title: "Your data stays on your device",
      text: "Cherishfire stores your habits, descriptions, schedules, day marks, notes, reminder times, and preferences locally on your device. You do not need an account. The app does not automatically send this information to the developer and does not include advertising, analytics, or a remote crash-reporting service.",
    },
    {
      title: "Reminders",
      text: "If you enable reminders, Cherishfire asks for notification permission where required and schedules notifications through your device's operating system. Notifications may display habit names, including on the lock screen according to your device settings. You can disable reminders or notification permission at any time. Other app features do not require notification permission.",
    },
    {
      title: "Importing and exporting",
      text: "Import reads a backup file you select. Export creates a JSON file containing your habits, day marks, notes, and app settings. Cherishfire does not encrypt export files. A file leaves the app only when you choose to save or share it; the selected destination or app then handles that copy under its own policies. Share backups only with destinations you trust.",
    },
    {
      title: "Retention and deletion",
      text: "Your data remains on the device until you delete it. You can delete notes and habits in the app; archiving a habit preserves its history. Clearing the app's storage or uninstalling removes its local data. Copies you exported are separate and must be deleted from their saved destinations. Your operating system may retain or restore device backups according to its settings; Android automatic app backup is disabled for Cherishfire.",
    },
    {
      title: "Security",
      text: "Local app data is protected by the operating system's app storage controls. Keep your device secure and protect any exported files. Cherishfire does not operate a server holding your habit data, so the developer cannot recover a lost local database or a backup you no longer have.",
    },
    {
      title: "Contact",
      text: "For privacy questions or support, email yangranat@gmail.com. If you contact support, we use the information you send to respond to your request. Do not include private habit data unless it is needed for your request.",
    },
  ],
} as const;
