package expo.modules.noteeditormetrics

import java.lang.ref.WeakReference

internal data class FramePlan(
  val firstFocus: Boolean,
  val viewportChanged: Boolean,
  val restoreX: Int?,
  val restoreY: Int?
)

internal class EditorViewportFrameState<Focus : Any>(
  initialX: Int,
  initialY: Int,
  initialHeight: Int,
  initialTop: Int
) {
  var lastDrawX: Int = initialX
    private set
  var lastDrawY: Int = initialY
    private set

  private var lastDrawHeight = initialHeight
  private var lastDrawTop = initialTop
  private var focusRef: WeakReference<Focus>? = null
  private var lastDrawFingerprint: Any? = null
  private var deferredFocusRef: WeakReference<Focus>? = null
  private var dragging = false
  private var momentum = false
  private var gestureChangedSinceDraw = false

  fun plan(focus: Focus?, height: Int, top: Int): FramePlan? {
    if (focus == null) return null
    val firstFocus = focusRef?.get() !== focus
    val momentumTakeover = firstFocus && momentum
    if (dragging || (!momentumTakeover && (momentum || gestureChangedSinceDraw))) return null
    val viewportChanged = height != lastDrawHeight || top != lastDrawTop
    val restore = firstFocus || viewportChanged
    return FramePlan(
      firstFocus = firstFocus,
      viewportChanged = viewportChanged,
      restoreX = if (restore) lastDrawX else null,
      restoreY = if (restore) lastDrawY else null
    )
  }

  fun geometryChanged(fingerprint: Any?): Boolean = fingerprint != lastDrawFingerprint

  fun deferFocusDraw(focus: Focus, moved: Boolean): Boolean {
    if (!moved || focusRef?.get() === focus || deferredFocusRef?.get() === focus) return false
    deferredFocusRef = WeakReference(focus)
    return true
  }

  fun onDraw(focus: Focus?, x: Int, y: Int, height: Int, top: Int, fingerprint: Any?) {
    lastDrawX = x
    lastDrawY = y
    lastDrawHeight = height
    lastDrawTop = top
    focusRef = focus?.let { WeakReference(it) }
    lastDrawFingerprint = fingerprint
    deferredFocusRef = null
    gestureChangedSinceDraw = false
  }

  fun onScrollEvent(name: String) {
    when (name) {
      "topScrollBeginDrag" -> {
        dragging = true
        momentum = false
        gestureChangedSinceDraw = true
      }
      "topScrollEndDrag" -> {
        dragging = false
        gestureChangedSinceDraw = true
      }
      "topMomentumScrollBegin" -> {
        momentum = true
        gestureChangedSinceDraw = true
      }
      "topMomentumScrollEnd" -> {
        momentum = false
        gestureChangedSinceDraw = true
      }
    }
  }

  fun onTouchReset(cancelled: Boolean = false) {
    dragging = false
    momentum = false
    gestureChangedSinceDraw = cancelled
  }
}
