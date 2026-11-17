package expo.modules.noteeditormetrics

import org.junit.Assert.assertEquals
import org.junit.Test

class NoteEditorRevealGeometryTest {
  private val geometry = EditorRevealGeometry(
    viewportTop = 40,
    viewportBottom = 400,
    editorTop = 70,
    editorBottom = 170,
    actionsTop = 180,
    actionsBottom = 212,
    caretTop = 132,
    caretBottom = 152,
    selectionAtEnd = true,
    gap = 12
  )

  @Test
  fun visibleShortEditorDoesNotScroll() {
    assertEquals(0, getEditorRevealDelta(geometry))
  }

  @Test
  fun visibleEndOfOversizedEditorDoesNotRevealItsTop() {
    assertEquals(0, getEditorRevealDelta(geometry.copy(
      editorTop = -560,
      editorBottom = 220,
      actionsTop = 230,
      actionsBottom = 264,
      caretTop = 200,
      caretBottom = 220
    )))
  }

  @Test
  fun hiddenEndOfOversizedEditorIncludesActions() {
    assertEquals(716, getEditorRevealDelta(geometry.copy(
      editorTop = 240,
      editorBottom = 1060,
      actionsTop = 1070,
      actionsBottom = 1104,
      caretTop = 1040,
      caretBottom = 1060
    )))
  }

  @Test
  fun shortEditorBelowViewportMovesOnlyEnoughToRevealActions() {
    assertEquals(14, getEditorRevealDelta(geometry.copy(
      editorTop = 300,
      editorBottom = 360,
      actionsTop = 370,
      actionsBottom = 402,
      caretTop = 340,
      caretBottom = 360
    )))
  }

  @Test
  fun shortEditorAboveViewportMovesOnlyEnoughToRevealEditorTop() {
    assertEquals(-24, getEditorRevealDelta(geometry.copy(
      editorTop = 16,
      editorBottom = 76,
      actionsTop = 86,
      actionsBottom = 118,
      caretTop = 56,
      caretBottom = 76
    )))
  }

  @Test
  fun shortEditorKeepsWholeUnionWhenSelectionIsInterior() {
    assertEquals(14, getEditorRevealDelta(geometry.copy(
      editorTop = 300,
      editorBottom = 360,
      actionsTop = 370,
      actionsBottom = 402,
      caretTop = 310,
      caretBottom = 330,
      selectionAtEnd = false
    )))
  }

  @Test
  fun exactFitDoesNotScroll() {
    assertEquals(0, getEditorRevealDelta(geometry.copy(
      editorTop = 40,
      editorBottom = 350,
      actionsTop = 356,
      actionsBottom = 388,
      caretTop = 330,
      caretBottom = 350
    )))
  }

  @Test
  fun exactFitAboveViewportStillRevealsWholeUnion() {
    assertEquals(-24, getEditorRevealDelta(geometry.copy(
      editorTop = 16,
      editorBottom = 326,
      actionsTop = 332,
      actionsBottom = 364,
      caretTop = 306,
      caretBottom = 326
    )))
  }

  @Test
  fun onePixelBottomOverflowIsCorrected() {
    assertEquals(1, getEditorRevealDelta(geometry.copy(
      editorTop = 41,
      editorBottom = 351,
      actionsTop = 357,
      actionsBottom = 389,
      caretTop = 331,
      caretBottom = 351
    )))
  }

  @Test
  fun oversizedInteriorSelectionIgnoresDistantActions() {
    assertEquals(0, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 150,
      caretBottom = 170
    )))
  }

  @Test
  fun oversizedInteriorSelectionBelowViewportRevealsOnlyCaret() {
    assertEquals(12, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 380,
      caretBottom = 400
    )))
  }

  @Test
  fun oversizedInteriorSelectionAboveViewportIncludesTopGap() {
    assertEquals(-16, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 36,
      caretBottom = 56
    )))
  }

  @Test
  fun interiorCaretAtEitherGapBoundaryDoesNotScroll() {
    assertEquals(0, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 52,
      caretBottom = 72
    )))
    assertEquals(0, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 368,
      caretBottom = 388
    )))
  }

  @Test
  fun caretTooTallForBothGapsDoesNotProduceConflictingCorrection() {
    assertEquals(0, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 40,
      caretBottom = 380
    )))
  }

  @Test
  fun exactHeightInteriorCaretCanBeAlignedWithBothGaps() {
    assertEquals(-12, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 40,
      caretBottom = 376
    )))
  }

  @Test
  fun smallViewportCannotRevealAnEndCaretWithBothGaps() {
    assertEquals(0, getEditorRevealDelta(geometry.copy(
      viewportBottom = 60
    )))
  }

  @Test
  fun smallViewportCannotRevealAnInteriorCaretWithBothGaps() {
    assertEquals(0, getEditorRevealDelta(oversizedInterior().copy(
      viewportBottom = 70
    )))
  }

  @Test
  fun invalidBoundsDoNotScroll() {
    val invalid = listOf(
      geometry.copy(viewportBottom = geometry.viewportTop),
      geometry.copy(viewportBottom = geometry.viewportTop - 1),
      geometry.copy(editorBottom = geometry.editorTop),
      geometry.copy(editorBottom = geometry.editorTop - 1),
      geometry.copy(actionsBottom = geometry.actionsTop),
      geometry.copy(actionsBottom = geometry.actionsTop - 1),
      geometry.copy(caretBottom = geometry.caretTop),
      geometry.copy(caretBottom = geometry.caretTop - 1),
      geometry.copy(gap = -1),
      geometry.copy(gap = 360),
      geometry.copy(gap = 361)
    )
    invalid.forEach { assertEquals(it.toString(), 0, getEditorRevealDelta(it)) }
  }

  @Test
  fun negativeScreenCoordinatesRemainValid() {
    assertEquals(14, getEditorRevealDelta(geometry.copy(
      viewportTop = -360,
      viewportBottom = 0,
      editorTop = -100,
      editorBottom = -40,
      actionsTop = -30,
      actionsBottom = 2,
      caretTop = -60,
      caretBottom = -40
    )))
  }

  @Test
  fun wideCoordinateRangeDoesNotOverflowUnionHeight() {
    assertEquals(0, getEditorRevealDelta(geometry.copy(
      editorTop = Int.MIN_VALUE,
      editorBottom = 100,
      actionsTop = 110,
      actionsBottom = 140,
      caretTop = 80,
      caretBottom = 100
    )))
  }

  @Test
  fun unrepresentableScrollDeltaDoesNotWrap() {
    assertEquals(0, getEditorRevealDelta(geometry.copy(
      viewportTop = Int.MIN_VALUE,
      viewportBottom = Int.MIN_VALUE + 100,
      editorTop = Int.MAX_VALUE - 100,
      editorBottom = Int.MAX_VALUE - 40,
      actionsTop = Int.MAX_VALUE - 30,
      actionsBottom = Int.MAX_VALUE,
      caretTop = Int.MAX_VALUE - 60,
      caretBottom = Int.MAX_VALUE - 40
    )))
  }

  @Test
  fun unionUsesBothEditorAndActionsExtents() {
    assertEquals(24, getEditorRevealDelta(geometry.copy(
      editorTop = 310,
      editorBottom = 412,
      actionsTop = 280,
      actionsBottom = 300,
      caretTop = 390,
      caretBottom = 410
    )))
  }

  @Test
  fun initialVisibleEndDoesNotAlignWholeEditorTop() {
    assertEquals(0, getEditorRevealDelta(geometry.copy(
      viewportTop = 96,
      viewportBottom = 1160,
      editorTop = -288,
      editorBottom = 432,
      actionsTop = 448,
      actionsBottom = 488,
      caretTop = 408,
      caretBottom = 432,
      allowTopReveal = false
    )))
  }

  @Test
  fun laterRevealStillAlignsWholeEditorTopByDefault() {
    assertEquals(-384, getEditorRevealDelta(geometry.copy(
      viewportTop = 96,
      viewportBottom = 1160,
      editorTop = -288,
      editorBottom = 432,
      actionsTop = 448,
      actionsBottom = 488,
      caretTop = 408,
      caretBottom = 432
    )))
  }

  @Test
  fun initialHiddenEndStillRevealsActions() {
    assertEquals(188, getEditorRevealDelta(geometry.copy(
      viewportTop = 96,
      viewportBottom = 1160,
      editorTop = 640,
      editorBottom = 1280,
      actionsTop = 1296,
      actionsBottom = 1336,
      caretTop = 1256,
      caretBottom = 1280,
      allowTopReveal = false
    )))
  }

  @Test
  fun initialInteriorCaretStillUsesTopGap() {
    assertEquals(-16, getEditorRevealDelta(oversizedInterior().copy(
      caretTop = 36,
      caretBottom = 56,
      allowTopReveal = false
    )))
  }

  @Test
  fun oversizedEndVisibilityTaxonomyRevealsTheFittingSpanOrPrioritizesCaret() {
    data class EndCase(
      val name: String,
      val caretTop: Int,
      val caretBottom: Int,
      val actionsTop: Int,
      val actionsBottom: Int,
      val delta: Int
    )
    val cases = listOf(
      EndCase("both above", -100, -80, -64, -32, -152),
      EndCase("caret above actions crossing top", 0, 20, 40, 72, -52),
      EndCase("caret above actions within", 0, 20, 60, 92, -52),
      EndCase("caret above actions crossing bottom", 0, 20, 380, 412, -52),
      EndCase("caret above actions below", 0, 20, 420, 452, -52),
      EndCase("caret crossing top actions within", 40, 60, 76, 108, -12),
      EndCase("caret crossing top actions crossing bottom", 40, 60, 380, 412, -12),
      EndCase("caret crossing top actions below", 40, 60, 420, 452, -12),
      EndCase("both within with editor top offscreen", 150, 170, 186, 218, 0),
      EndCase("caret within actions crossing bottom", 330, 350, 366, 398, 10),
      EndCase("caret within actions below fitting span", 320, 340, 410, 442, 54),
      EndCase("caret within actions below oversized span", 150, 170, 600, 632, 0),
      EndCase("caret crossing bottom actions below", 380, 400, 416, 448, 60),
      EndCase("both below fitting span", 450, 470, 486, 518, 130),
      EndCase("both below oversized span", 420, 440, 900, 932, 52),
      EndCase("both above oversized span", -500, -480, 0, 32, -552)
    )
    cases.forEach { case ->
      assertEquals(case.name, case.delta, getEditorRevealDelta(geometry.copy(
        editorTop = -2000,
        editorBottom = case.caretBottom,
        actionsTop = case.actionsTop,
        actionsBottom = case.actionsBottom,
        caretTop = case.caretTop,
        caretBottom = case.caretBottom,
        allowTopReveal = false
      )))
    }
  }

  @Test
  fun endSpanExactFitAndOnePixelOverflowChooseDifferentTargets() {
    val end = geometry.copy(
      editorTop = -2000,
      editorBottom = 120,
      caretTop = 100,
      caretBottom = 120,
      actionsTop = 404,
      actionsBottom = 436
    )
    assertEquals(48, getEditorRevealDelta(end))
    assertEquals(0, getEditorRevealDelta(end.copy(actionsTop = 405, actionsBottom = 437)))
  }

  @Test
  fun endCaretAtEitherGapBoundaryDoesNotMoveTheEditorTop() {
    val end = geometry.copy(editorTop = -2000)
    assertEquals(0, getEditorRevealDelta(end.copy(
      editorBottom = 72,
      caretTop = 52,
      caretBottom = 72,
      actionsTop = 88,
      actionsBottom = 120
    )))
    assertEquals(0, getEditorRevealDelta(end.copy(
      editorBottom = 340,
      caretTop = 320,
      caretBottom = 340,
      actionsTop = 356,
      actionsBottom = 388
    )))
  }

  @Test
  fun endCaretHasPriorityWhenOnlyItsExactHeightFits() {
    val end = geometry.copy(
      viewportBottom = 84,
      editorTop = -2000,
      editorBottom = 120,
      caretTop = 100,
      caretBottom = 120,
      actionsTop = 136,
      actionsBottom = 168
    )
    assertEquals(48, getEditorRevealDelta(end))
    assertEquals(0, getEditorRevealDelta(end.copy(caretBottom = 121, editorBottom = 121)))
  }

  private fun oversizedInterior() = geometry.copy(
    editorTop = -560,
    editorBottom = 1060,
    actionsTop = 1070,
    actionsBottom = 1104,
    selectionAtEnd = false
  )
}
