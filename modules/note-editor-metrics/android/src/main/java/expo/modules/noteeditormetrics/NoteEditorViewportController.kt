package expo.modules.noteeditormetrics

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import com.facebook.react.R
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.facebook.react.uimanager.events.EventDispatcherListener
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.textinput.ReactEditText
import java.util.WeakHashMap
import kotlin.math.max

/** One native visibility owner for the focused note, before the frame is drawn. */
internal class NoteEditorViewportController(
  private val scrollView: ReactScrollView,
  private val observer: ViewTreeObserver,
) :
  ViewTreeObserver.OnPreDrawListener,
  ViewTreeObserver.OnDrawListener,
  EventDispatcherListener {
  private data class Snapshot(
    val input: ReactEditText,
    val viewportTop: Int,
    val viewportBottom: Int,
    val inputContentTop: Int,
    val editorHeight: Int,
    val actionsContentTop: Int,
    val actionsHeight: Int,
    val caretTop: Int,
    val caretBottom: Int,
    val selectionStart: Int,
    val selectionEnd: Int,
    val textLength: Int,
  )

  private val dispatcher = (scrollView.context as? ReactContext)?.let {
    UIManagerHelper.getEventDispatcherForReactTag(it, scrollView.id)
  }
  private val initializedInputs = WeakHashMap<ReactEditText, Boolean>()
  private val gap = PixelUtil.toPixelFromDIP(12f).toInt()
  private var disposed = false
  private val frameState = EditorViewportFrameState<ReactEditText>(
    scrollView.scrollX, scrollView.scrollY, scrollView.height, screenTop(scrollView),
  )

  init {
    observer.addOnPreDrawListener(this)
    observer.addOnDrawListener(this)
    dispatcher?.addListener(this)
  }

  override fun onEventDispatch(event: Event<*>) {
    if (disposed || event.viewTag != scrollView.id) return
    frameState.onScrollEvent(event.eventName)
  }

  fun onTouchReset(cancelled: Boolean) {
    if (!disposed) frameState.onTouchReset(cancelled)
  }

  override fun onPreDraw(): Boolean {
    if (disposed || !scrollView.isShown) return true
    val input = focusedNoteInput() ?: return true
    val plan = frameState.plan(input, scrollView.height, screenTop(scrollView)) ?: return true
    if (!initializedInputs.containsKey(input)) {
      initializedInputs[input] = true
      if (nativeId(input)?.startsWith("note-editor-end:") == true) {
        val end = input.text?.length ?: 0
        input.maybeSetSelection(0, end, end)
      }
    }
    // TextView owns the active handle of a range selection.
    if (input.selectionStart != input.selectionEnd) return true
    val beforeX = scrollView.scrollX
    val beforeY = scrollView.scrollY
    if (plan.restoreX != null && plan.restoreY != null) {
      snapScroll(plan.restoreX, plan.restoreY)
    }

    val snapshot = snapshot(input)
    if (snapshot != null && (plan.firstFocus || plan.viewportChanged || frameState.geometryChanged(snapshot))) {
      // Native range-handle placement remains TextView's responsibility.
      if (snapshot.selectionStart == snapshot.selectionEnd) {
        val offset = scrollView.scrollY
        val delta = getEditorRevealDelta(EditorRevealGeometry(
          viewportTop = snapshot.viewportTop,
          viewportBottom = snapshot.viewportBottom,
          editorTop = snapshot.inputContentTop - offset,
          editorBottom = snapshot.inputContentTop - offset + snapshot.editorHeight,
          actionsTop = snapshot.actionsContentTop - offset,
          actionsBottom = snapshot.actionsContentTop - offset + snapshot.actionsHeight,
          caretTop = snapshot.inputContentTop - offset + snapshot.caretTop,
          caretBottom = snapshot.inputContentTop - offset + snapshot.caretBottom,
          selectionAtEnd = snapshot.selectionEnd == snapshot.textLength,
          gap = gap,
          allowTopReveal = snapshot.selectionEnd != snapshot.textLength ||
            snapshot.inputContentTop - offset + snapshot.caretTop < snapshot.viewportTop,
        ))
        if (delta != 0) {
          snapScroll(scrollView.scrollX, max(0, offset + delta))
        }
      }
    }

    val moved = beforeX != scrollView.scrollX || beforeY != scrollView.scrollY
    if (frameState.deferFocusDraw(input, moved)) {
      // TextView may have a later pre-draw callback. Keep the previous valid
      // frame once, then let the settled native geometry draw normally.
      scrollView.postInvalidateOnAnimation()
      return false
    }
    return true
  }

  override fun onDraw() {
    if (disposed) return
    val input = focusedNoteInput()
    frameState.onDraw(input, scrollView.scrollX, scrollView.scrollY,
      scrollView.height, screenTop(scrollView), input?.let { snapshot(it) })
  }

  fun dispose() {
    if (disposed) return
    disposed = true
    dispatcher?.removeListener(this)
    initializedInputs.clear()
    // Listener removal is not allowed during ViewTreeObserver's draw dispatch.
    Handler(Looper.getMainLooper()).post {
      if (observer.isAlive) {
        observer.removeOnPreDrawListener(this)
        observer.removeOnDrawListener(this)
      }
    }
  }

  private fun snapScroll(x: Int, y: Int) {
    // Direct scrollTo does not cancel either native scroll animator.
    scrollView.abortAnimation()
    if (scrollView.flingAnimator.isRunning) {
      scrollView.flingAnimator.cancel()
      frameState.onTouchReset()
    }
    scrollView.scrollTo(x, y)
  }

  private fun focusedNoteInput(): ReactEditText? {
    val input = scrollView.findFocus() as? ReactEditText ?: return null
    return input.takeIf { nativeId(it)?.startsWith("note-editor:") == true ||
      nativeId(it)?.startsWith("note-editor-end:") == true }
  }

  private fun snapshot(input: ReactEditText): Snapshot? {
    val clip = input.parent as? View ?: return null
    val card = clip.parent as? ViewGroup ?: return null
    val id = nativeId(input) ?: return null
    val key = id.substringAfter(':')
    val actions = findActions(card, "note-editor-actions:$key") ?: return null
    val viewport = Rect()
    if (!scrollView.getGlobalVisibleRect(viewport) || viewport.height() <= 0 || actions.height <= 0) return null
    val layout = input.layout ?: return null
    if (layout.width != input.width - input.compoundPaddingLeft - input.compoundPaddingRight || layout.lineCount <= 0) return null
    val textLength = input.text?.length ?: return null
    val start = input.selectionStart
    val end = input.selectionEnd
    if (start < 0 || end < 0 || start > textLength || end > textLength || layout.text.length != textLength) return null
    val line = layout.getLineForOffset(end)
    val top = input.totalPaddingTop - input.scrollY + layout.getLineTop(line)
    val bottom = input.totalPaddingTop - input.scrollY + layout.getLineBottom(line)
    if (top < 0 || bottom <= top || bottom > clip.height) return null
    return Snapshot(
      input, viewport.top, viewport.bottom, screenTop(input) + scrollView.scrollY,
      clip.height, screenTop(actions) + scrollView.scrollY, actions.height,
      top, bottom, start, end, textLength,
    )
  }

  private fun findActions(parent: ViewGroup, id: String): View? {
    for (index in 0 until parent.childCount) {
      val child = parent.getChildAt(index)
      if (nativeId(child) == id) return child
      if (child is ViewGroup) findActions(child, id)?.let { return it }
    }
    return null
  }

  private fun nativeId(view: View): String? = view.getTag(R.id.view_tag_native_id) as? String

  private fun screenTop(view: View): Int {
    val location = IntArray(2)
    view.getLocationOnScreen(location)
    return location[1]
  }
}
