package expo.modules.noteeditormetrics

import android.view.View
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.views.textinput.ReactEditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NoteEditorMetricsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NoteEditorMetrics")
    Constants("supportsViewport" to true)

    View(NoteEditorViewportView::class) {
      OnViewDestroys { view: NoteEditorViewportView -> view.disposeController() }
    }

    AsyncFunction("getCaretMetrics") { viewTag: Int, expectedEventCount: Int?, expectedText: String? ->
      readCaretMetrics(viewTag, expectedEventCount, expectedText)
    }.runOnQueue(Queues.MAIN)
  }

  private fun readCaretMetrics(
    viewTag: Int,
    expectedEventCount: Int?,
    expectedText: String?,
  ): Map<String, Any>? {
    if (viewTag <= 0 || expectedEventCount == null || expectedEventCount < 0) return null

    val host = try {
      appContext.findView<View>(viewTag) as? ReactEditText
    } catch (_: Exception) {
      null
    } ?: return null

    if (!host.isAttachedToWindow || !host.hasFocus() || host.isLayoutRequested ||
      host.width <= 0 || host.height <= 0 || !host.canUpdateWithEventCount(expectedEventCount)
    ) return null

    val text = host.text ?: return null
    if (expectedText != null && text.toString() != expectedText) return null
    val layout = host.layout ?: return null
    val selectionStart = host.selectionStart
    val selectionEnd = host.selectionEnd
    val contentWidth = host.width - host.compoundPaddingLeft - host.compoundPaddingRight

    if (selectionStart < 0 || selectionStart != selectionEnd || selectionEnd > text.length ||
      contentWidth <= 0 || layout.width != contentWidth || layout.text.length != text.length ||
      layout.lineCount <= 0
    ) return null

    val line = layout.getLineForOffset(selectionEnd)
    if (line !in 0 until layout.lineCount) return null

    val verticalOffset = host.totalPaddingTop - host.scrollY
    val top = verticalOffset + layout.getLineTop(line)
    val bottom = verticalOffset + layout.getLineBottom(line)
    if (top < 0 || bottom <= top || bottom > host.height) return null

    return mapOf(
      "top" to PixelUtil.toDIPFromPixel(top.toFloat()).toDouble(),
      "bottom" to PixelUtil.toDIPFromPixel(bottom.toFloat()).toDouble(),
      "hostWidth" to PixelUtil.toDIPFromPixel(host.width.toFloat()).toDouble(),
      "hostHeight" to PixelUtil.toDIPFromPixel(host.height.toFloat()).toDouble(),
      "textLength" to text.length,
      "selectionStart" to selectionStart,
      "selectionEnd" to selectionEnd,
    )
  }
}
