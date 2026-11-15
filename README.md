# Cherishfire

![Cherishfire](Screenshots/cherishfire-hero.png)

An offline habit tracker built with Expo and React Native.

## Features

- Schedule habits daily, on selected days of the week or dates of the month,
  or at fixed or completion-based intervals.
- Record Done, Minimum, Maximum, Failure, or Skipped outcomes, with optional
  reasons for failures and skips.
- Browse each habit's calendar, current and best streaks, and dated notes.
- Set multiple local reminder times for each habit.
- Review weekly, monthly, and yearly statistics, with a separate block order
  for each period.
- Archive and restore habits without deleting their history.
- Export and restore habits, history, notes, and preferences as JSON.

## Preview

![Habit calendar, monthly repeat settings, and notes](Screenshots/cherishfire-overview.png)

## Development

Requires Node.js 22.13.0 or later. Use a supported LTS release.

```sh
npm ci
npm start
```

For a local native build, install the Android or iOS toolchain and run
`npm run android` or `npm run ios`. iOS builds require macOS and Xcode.

## Checks

```sh
npm run check
```

## Privacy

See [Privacy Policy](PRIVACY.md).

## License

The application source code is available under [MIT](LICENSE). Third-party
components and icon fonts retain their respective licenses; see
[third-party notices](assets/third_party_notices.json).
