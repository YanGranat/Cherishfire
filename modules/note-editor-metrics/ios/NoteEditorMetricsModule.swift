import ExpoModulesCore
import UIKit

public final class NoteEditorMetricsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NoteEditorMetrics")

    AsyncFunction("getCaretMetrics") { (viewTag: Int, _: Int?, expectedText: String?) -> [String: Any]? in
      self.readCaretMetrics(viewTag: viewTag, expectedText: expectedText)
    }.runOnQueue(.main)
  }

  private func readCaretMetrics(viewTag: Int, expectedText: String?) -> [String: Any]? {
    guard viewTag > 0,
          let host = appContext?.findView(withTag: viewTag, ofType: UIView.self),
          host.window != nil,
          !host.layer.needsLayout(),
          host.bounds.width.isFinite,
          host.bounds.height.isFinite,
          host.bounds.width > 0,
          host.bounds.height > 0,
          let textView = focusedTextView(in: host),
          !textView.layer.needsLayout(),
          let range = textView.selectedTextRange,
          range.isEmpty
    else { return nil }

    let text = textView.text ?? ""
    if let expectedText, !text.utf16.elementsEqual(expectedText.utf16) {
      return nil
    }
    let textLength = text.utf16.count
    let selectionStart = textView.offset(from: textView.beginningOfDocument, to: range.start)
    let selectionEnd = textView.offset(from: textView.beginningOfDocument, to: range.end)
    guard selectionStart >= 0,
          selectionStart == selectionEnd,
          selectionEnd <= textLength
    else { return nil }

    let input: UITextInput = textView
    let coordinateView = input.textInputView ?? textView
    let caret = coordinateView.convert(textView.caretRect(for: range.end), to: host)
      .offsetBy(dx: -host.bounds.minX, dy: -host.bounds.minY)
    guard !caret.isNull,
          !caret.isInfinite,
          caret.minY.isFinite,
          caret.maxY.isFinite,
          caret.minY >= 0,
          caret.height > 0,
          caret.maxY <= host.bounds.height
    else { return nil }

    return [
      "top": caret.minY,
      "bottom": caret.maxY,
      "hostWidth": host.bounds.width,
      "hostHeight": host.bounds.height,
      "textLength": textLength,
      "selectionStart": selectionStart,
      "selectionEnd": selectionEnd,
    ]
  }

  private func focusedTextView(in view: UIView) -> UITextView? {
    if let textView = view as? UITextView, textView.isFirstResponder {
      return textView
    }
    for child in view.subviews {
      if let textView = focusedTextView(in: child) {
        return textView
      }
    }
    return nil
  }
}
