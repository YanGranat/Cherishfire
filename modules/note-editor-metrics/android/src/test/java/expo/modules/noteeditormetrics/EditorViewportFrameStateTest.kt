package expo.modules.noteeditormetrics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorViewportFrameStateTest {
  private val focus = Any()
  private val state = EditorViewportFrameState<Any>(12, 30, 400, 40)
  private data class Fingerprint(val caretTop: Int, val editorHeight: Int)

  @Test
  fun firstFocusRestoresInitialDrawBaseline() {
    assertEquals(FramePlan(true, false, 12, 30), state.plan(focus, 400, 40))
    assertEquals(12, state.lastDrawX)
    assertEquals(30, state.lastDrawY)
  }

  @Test
  fun repeatedPlansDoNotCommitFocusViewportOrScroll() {
    assertEquals(FramePlan(true, true, 12, 30), state.plan(focus, 250, 50))
    assertEquals(FramePlan(true, true, 12, 30), state.plan(focus, 250, 50))
    assertEquals(FramePlan(true, false, 12, 30), state.plan(Any(), 400, 40))
    assertEquals(12, state.lastDrawX)
    assertEquals(30, state.lastDrawY)
  }

  @Test
  fun drawIsTheOnlyBaselineCommit() {
    state.plan(focus, 250, 50)
    assertTrue(state.deferFocusDraw(focus, true))
    assertEquals(12, state.lastDrawX)
    assertEquals(30, state.lastDrawY)
    state.onDraw(focus, 18, 100, 250, 50, Fingerprint(80, 600))
    assertEquals(18, state.lastDrawX)
    assertEquals(100, state.lastDrawY)
    assertEquals(FramePlan(false, false, null, null), state.plan(focus, 250, 50))
    assertFalse(state.geometryChanged(Fingerprint(80, 600)))
  }

  @Test
  fun laterPreDrawChangeWithoutDrawRetainsPriorBaseline() {
    state.onDraw(null, 12, 90, 400, 40, null)
    assertEquals(FramePlan(true, true, 12, 90), state.plan(focus, 260, 40))
    assertTrue(state.deferFocusDraw(focus, true))
    assertEquals(FramePlan(true, true, 12, 90), state.plan(focus, 260, 40))
    assertFalse(state.deferFocusDraw(focus, true))
    assertEquals(90, state.lastDrawY)
    assertTrue(state.geometryChanged(Fingerprint(160, 900)))
  }

  @Test
  fun drawBeforeFocusDoesNotMarkFutureFocusAsDrawn() {
    state.onDraw(null, 2, 75, 320, 45, null)
    assertEquals(FramePlan(true, false, 2, 75), state.plan(focus, 320, 45))
    assertTrue(state.deferFocusDraw(focus, true))
  }

  @Test
  fun focusChangesBeforeDrawDoNotShareOneDeferralFlag() {
    val secondFocus = Any()
    assertTrue(state.deferFocusDraw(focus, true))
    assertFalse(state.deferFocusDraw(focus, true))
    assertTrue(state.deferFocusDraw(secondFocus, true))
    assertFalse(state.deferFocusDraw(secondFocus, true))
    assertEquals(FramePlan(true, false, 12, 30), state.plan(secondFocus, 400, 40))
  }

  @Test
  fun alreadyDrawnFocusIsNotDeferredAgain() {
    state.onDraw(focus, 12, 30, 400, 40, null)
    assertFalse(state.deferFocusDraw(focus, true))
    assertEquals(FramePlan(false, false, null, null), state.plan(focus, 400, 40))
  }

  @Test
  fun clampedOrUnchangedScrollDoesNotConsumeDeferral() {
    assertFalse(state.deferFocusDraw(focus, false))
    assertTrue(state.deferFocusDraw(focus, true))
    assertFalse(state.deferFocusDraw(focus, true))
  }

  @Test
  fun drawClearsDeferralForAnotherUnpaintedFocus() {
    val secondFocus = Any()
    assertTrue(state.deferFocusDraw(focus, true))
    state.onDraw(secondFocus, 12, 60, 400, 40, null)
    assertTrue(state.deferFocusDraw(focus, true))
    assertEquals(FramePlan(true, false, 12, 60), state.plan(focus, 400, 40))
  }

  @Test
  fun heightAndTopChangesIndependentlyRestoreDrawBaseline() {
    state.onDraw(focus, 8, 95, 400, 40, null)
    assertEquals(FramePlan(false, true, 8, 95), state.plan(focus, 250, 40))
    assertEquals(FramePlan(false, true, 8, 95), state.plan(focus, 400, 60))
    assertEquals(FramePlan(false, false, null, null), state.plan(focus, 400, 40))
  }

  @Test
  fun fingerprintsAreComparedWithLastDrawNotLastPlan() {
    state.onDraw(focus, 12, 30, 400, 40, Fingerprint(80, 600))
    assertFalse(state.geometryChanged(Fingerprint(80, 600)))
    assertTrue(state.geometryChanged(Fingerprint(100, 600)))
    state.plan(focus, 400, 40)
    assertTrue(state.geometryChanged(Fingerprint(100, 600)))
    assertTrue(state.geometryChanged(Fingerprint(80, 700)))
    state.onDraw(focus, 12, 45, 400, 40, Fingerprint(100, 600))
    assertFalse(state.geometryChanged(Fingerprint(100, 600)))
    assertTrue(state.geometryChanged(Fingerprint(80, 600)))
  }

  @Test
  fun nullFocusCannotProducePlanOrCommitPendingFocus() {
    assertNull(state.plan(null, 200, 70))
    assertEquals(FramePlan(true, false, 12, 30), state.plan(focus, 400, 40))
    state.onDraw(null, 5, 20, 200, 70, null)
    assertEquals(FramePlan(true, false, 5, 20), state.plan(focus, 200, 70))
  }

  @Test
  fun losingDrawnFocusMakesLaterRefocusAFirstFocus() {
    state.onDraw(focus, 12, 30, 400, 40, null)
    state.onDraw(null, 12, 60, 400, 40, null)
    assertEquals(FramePlan(true, false, 12, 60), state.plan(focus, 400, 40))
  }

  @Test
  fun dragBlocksResizeCorrectionEvenAfterDraw() {
    state.onDraw(focus, 12, 30, 400, 40, null)
    state.onScrollEvent("topScrollBeginDrag")
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 70, 250, 40, null)
    assertNull(state.plan(focus, 250, 40))
    state.onScrollEvent("topScrollEndDrag")
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 85, 250, 40, null)
    assertEquals(FramePlan(false, false, null, null), state.plan(focus, 250, 40))
    assertEquals(85, state.lastDrawY)
  }

  @Test
  fun dragEndingBeforeDrawStillHoldsOneFrame() {
    state.onScrollEvent("topScrollBeginDrag")
    state.onScrollEvent("topScrollEndDrag")
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(null, 12, 90, 250, 40, null)
    assertEquals(FramePlan(true, false, 12, 90), state.plan(focus, 250, 40))
  }

  @Test
  fun momentumRemainsBlockedAcrossDrawsAndItsEndHoldsOneFrame() {
    state.onDraw(focus, 12, 30, 400, 40, null)
    state.onScrollEvent("topMomentumScrollBegin")
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 100, 250, 40, null)
    assertNull(state.plan(focus, 250, 40))
    state.onScrollEvent("topMomentumScrollEnd")
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 120, 250, 40, null)
    assertNotNull(state.plan(focus, 250, 40))
    assertEquals(120, state.lastDrawY)
  }

  @Test
  fun newDragResetsPreviousMomentum() {
    state.onScrollEvent("topMomentumScrollBegin")
    state.onScrollEvent("topScrollBeginDrag")
    state.onScrollEvent("topScrollEndDrag")
    assertNull(state.plan(focus, 400, 40))
    state.onDraw(focus, 12, 90, 400, 40, null)
    assertEquals(FramePlan(false, false, null, null), state.plan(focus, 400, 40))
  }

  @Test
  fun ordinaryScrollEventsDoNotCreateGestureHold() {
    state.onDraw(focus, 12, 30, 400, 40, null)
    state.onScrollEvent("topScroll")
    state.onScrollEvent("topContentSizeChange")
    assertEquals(FramePlan(false, false, null, null), state.plan(focus, 400, 40))
  }

  @Test
  fun stableIdlePlansNeitherRestoreNorDefer() {
    val fingerprint = Fingerprint(80, 600)
    state.onDraw(focus, 12, 30, 400, 40, fingerprint)
    repeat(5) {
      assertEquals(FramePlan(false, false, null, null), state.plan(focus, 400, 40))
      assertFalse(state.geometryChanged(fingerprint))
      assertFalse(state.deferFocusDraw(focus, false))
    }
  }

  @Test
  fun focusUsesObjectIdentityRatherThanValueEquality() {
    class EqualFocus {
      override fun equals(other: Any?): Boolean = other is EqualFocus
      override fun hashCode(): Int = 0
    }
    val first = EqualFocus()
    val second = EqualFocus()
    val identityState = EditorViewportFrameState<EqualFocus>(0, 50, 400, 40)
    assertEquals(first, second)
    identityState.onDraw(first, 0, 50, 400, 40, null)
    assertEquals(FramePlan(true, false, 0, 50), identityState.plan(second, 400, 40))
    assertTrue(identityState.deferFocusDraw(second, true))
    assertFalse(identityState.deferFocusDraw(first, true))
  }

  @Test
  fun equalUnpaintedFocusObjectsHaveIndependentDeferrals() {
    class EqualFocus {
      override fun equals(other: Any?): Boolean = other is EqualFocus
      override fun hashCode(): Int = 0
    }
    val first = EqualFocus()
    val second = EqualFocus()
    val identityState = EditorViewportFrameState<EqualFocus>(0, 50, 400, 40)
    assertTrue(identityState.deferFocusDraw(first, true))
    assertTrue(identityState.deferFocusDraw(second, true))
    assertFalse(identityState.deferFocusDraw(second, true))
  }

  @Test
  fun touchResetAfterFlingClearsMomentumWithoutMomentumEndEvent() {
    state.onDraw(focus, 12, 30, 400, 40, null)
    state.onScrollEvent("topMomentumScrollBegin")
    state.onDraw(focus, 12, 100, 400, 40, null)
    assertNull(state.plan(focus, 250, 40))
    state.onTouchReset()
    assertEquals(FramePlan(false, true, 12, 100), state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 110, 400, 40, null)
    assertEquals(FramePlan(false, true, 12, 110), state.plan(focus, 250, 40))
  }

  @Test
  fun touchResetAfterCancelledDragClearsDragWithoutEndDragEvent() {
    state.onScrollEvent("topScrollBeginDrag")
    state.onDraw(focus, 12, 80, 400, 40, null)
    assertNull(state.plan(focus, 250, 40))
    state.onTouchReset(cancelled = true)
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 90, 400, 40, null)
    assertEquals(FramePlan(false, true, 12, 90), state.plan(focus, 250, 40))
  }

  @Test
  fun repeatedTouchCancellationsKeepHoldUntilNextDraw() {
    state.onTouchReset(cancelled = true)
    state.onTouchReset(cancelled = true)
    assertNull(state.plan(focus, 400, 40))
    state.onDraw(null, 12, 70, 400, 40, null)
    assertEquals(FramePlan(true, false, 12, 70), state.plan(focus, 400, 40))
  }

  @Test
  fun touchDownThenNewFocusBeforeDrawPreservesFirstFocusBarrier() {
    val secondFocus = Any()
    state.onDraw(focus, 12, 90, 400, 40, null)
    state.onScrollEvent("topMomentumScrollBegin")
    state.onTouchReset()
    assertEquals(FramePlan(true, true, 12, 90), state.plan(secondFocus, 250, 40))
    assertTrue(state.deferFocusDraw(secondFocus, true))
    assertFalse(state.deferFocusDraw(secondFocus, true))
    assertEquals(90, state.lastDrawY)
    assertEquals(FramePlan(true, true, 12, 90), state.plan(secondFocus, 250, 40))
  }

  @Test
  fun nativeDragAfterTouchDownReestablishesGestureHold() {
    state.onTouchReset(cancelled = true)
    assertNull(state.plan(focus, 400, 40))
    state.onTouchReset()
    assertNotNull(state.plan(focus, 400, 40))
    state.onScrollEvent("topScrollBeginDrag")
    assertNull(state.plan(focus, 250, 40))
    state.onDraw(focus, 12, 75, 250, 40, null)
    assertNull(state.plan(focus, 250, 40))
  }

  @Test
  fun momentumKeepsAlreadyDrawnFocusHeldAfterGestureHoldClears() {
    state.onDraw(focus, 12, 60, 400, 40, null)
    state.onScrollEvent("topMomentumScrollBegin")
    state.onDraw(focus, 12, 95, 400, 40, null)
    assertNull(state.plan(focus, 250, 40))
    assertEquals(95, state.lastDrawY)
  }

  @Test
  fun newPhysicalFocusCanTakeOverMomentumFromPreviousDrawBaseline() {
    val secondFocus = Any()
    state.onDraw(focus, 12, 60, 400, 40, null)
    state.onScrollEvent("topMomentumScrollBegin")
    state.onDraw(focus, 12, 95, 400, 40, null)
    assertEquals(FramePlan(true, true, 12, 95), state.plan(secondFocus, 250, 40))
    assertEquals(95, state.lastDrawY)
    assertTrue(state.deferFocusDraw(secondFocus, true))
  }

  @Test
  fun momentumBeginThenNewFocusBeforeDrawCanTakeOverImmediately() {
    val secondFocus = Any()
    state.onDraw(focus, 12, 60, 400, 40, null)
    state.onScrollEvent("topMomentumScrollBegin")
    assertEquals(FramePlan(true, true, 12, 60), state.plan(secondFocus, 250, 40))
    assertNull(state.plan(focus, 250, 40))
    assertEquals(60, state.lastDrawY)
  }
}
