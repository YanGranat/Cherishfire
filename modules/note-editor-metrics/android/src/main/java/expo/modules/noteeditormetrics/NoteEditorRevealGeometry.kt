package expo.modules.noteeditormetrics

internal data class EditorRevealGeometry(
  val viewportTop: Int,
  val viewportBottom: Int,
  val editorTop: Int,
  val editorBottom: Int,
  val actionsTop: Int,
  val actionsBottom: Int,
  val caretTop: Int,
  val caretBottom: Int,
  val selectionAtEnd: Boolean,
  val gap: Int,
  val allowTopReveal: Boolean = true
)

// A positive delta increases scrollY. All coordinates use the same pixel space.
internal fun getEditorRevealDelta(geometry: EditorRevealGeometry): Int {
  if (
    geometry.gap < 0 ||
    geometry.viewportBottom <= geometry.viewportTop ||
    geometry.editorBottom <= geometry.editorTop ||
    geometry.actionsBottom <= geometry.actionsTop ||
    geometry.caretBottom <= geometry.caretTop
  ) {
    return 0
  }

  val viewportTop = geometry.viewportTop.toLong()
  val effectiveBottom = geometry.viewportBottom.toLong() - geometry.gap
  val availableHeight = effectiveBottom - viewportTop
  if (availableHeight <= 0L) return 0

  val unionTop = minOf(geometry.editorTop, geometry.actionsTop).toLong()
  val unionBottom = maxOf(geometry.editorBottom, geometry.actionsBottom).toLong()
  val delta = when {
    unionBottom - unionTop <= availableHeight -> when {
      unionBottom > effectiveBottom -> unionBottom - effectiveBottom
      geometry.allowTopReveal && unionTop < viewportTop -> unionTop - viewportTop
      else -> 0L
    }
    geometry.selectionAtEnd -> {
      val effectiveTop = viewportTop + geometry.gap
      val caretTop = geometry.caretTop.toLong()
      val caretBottom = geometry.caretBottom.toLong()
      val caretHeight = caretBottom - caretTop
      val caretAvailableHeight = effectiveBottom - effectiveTop
      if (caretHeight > caretAvailableHeight) return 0

      val spanTop = minOf(caretTop, geometry.actionsTop.toLong())
      val spanBottom = maxOf(caretBottom, geometry.actionsBottom.toLong())
      val spanFits = spanBottom - spanTop <= caretAvailableHeight
      val targetTop = if (spanFits) spanTop else caretTop
      val targetBottom = if (spanFits) spanBottom else caretBottom
      when {
        targetBottom > effectiveBottom -> targetBottom - effectiveBottom
        targetTop < effectiveTop -> targetTop - effectiveTop
        else -> 0L
      }
    }
    else -> {
      val effectiveTop = viewportTop + geometry.gap
      val caretTop = geometry.caretTop.toLong()
      val caretBottom = geometry.caretBottom.toLong()
      if (caretBottom - caretTop > effectiveBottom - effectiveTop) return 0
      when {
        caretBottom > effectiveBottom -> caretBottom - effectiveBottom
        caretTop < effectiveTop -> caretTop - effectiveTop
        else -> 0L
      }
    }
  }

  return if (delta in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) delta.toInt() else 0
}
