package expo.modules.noteeditormetrics

import android.content.Context
import android.graphics.Canvas
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import com.facebook.react.views.scroll.ReactScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** Yoga owns child layout; this host bounds the list's keyboard-transition painting. */
class NoteEditorViewportView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var controller: NoteEditorViewportController? = null

  init {
    clipChildren = false
    clipToPadding = false
  }

  override fun clipToPaddingBox(canvas: Canvas) {
    canvas.clipRect(0, 0, width, height)
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN || event.actionMasked == MotionEvent.ACTION_CANCEL) {
      controller?.onTouchReset(event.actionMasked == MotionEvent.ACTION_CANCEL)
    }
    return super.dispatchTouchEvent(event)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    attachController()
  }

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    attachController()
  }

  override fun onViewRemoved(child: View) {
    disposeController()
    super.onViewRemoved(child)
    attachController()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attachController()
  }

  override fun onDetachedFromWindow() {
    disposeController()
    super.onDetachedFromWindow()
  }

  fun disposeController() {
    controller?.dispose()
    controller = null
  }

  private fun attachController() {
    if (!isAttachedToWindow || controller != null) return
    val scrollView = findScrollView(this) ?: return
    controller = NoteEditorViewportController(scrollView, viewTreeObserver)
  }

  private fun findScrollView(parent: ViewGroup): ReactScrollView? {
    for (index in 0 until parent.childCount) {
      val child = parent.getChildAt(index)
      if (child is ReactScrollView) return child
      if (child is ViewGroup) findScrollView(child)?.let { return it }
    }
    return null
  }
}
