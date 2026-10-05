# Swipe the Resume Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the home screen, swiping left on the "Resume Day X" card reveals an action button. With no sets logged it's **Discard**, which deletes the session immediately. With sets logged it's **Finish**, which opens the finish sheet.

**Architecture:** A wrapper around the existing `.day-btn.resume` button holds an action button behind it. Pointer Events (which work for iOS touch and for Playwright's mouse) drag the card horizontally with `transform: translateX`, and it snaps open or closed on release. Only `app/app.js`, `app/styles.css` and `tests/offline.test.mjs` change.

**Tech Stack:** vanilla JS, CSS, and Playwright (`PW_CHANNEL=chrome` locally).

## Global Constraints

- **Code style:** no build step and no frameworks. Match the existing style in `app/app.js` (2-space indent, `$`, `esc`, `go`, `render`, the `data-act` click dispatch in `onMainClick`).
- **Action button text:** the label is exactly `Discard` when `sessionSets().length === 0`, otherwise exactly `Finish`.
- **Discard behavior:** swipe Discard calls the existing `discardSession()` with **no** `confirm()`. The existing workout-screen Discard button and its `confirm` stay unchanged.
- **Finish behavior:** swipe Finish runs `go('workout')` and then `openFinish()`. That is the same finish sheet as the workout screen.
- **Gestures:**
  - A tap on the closed card still resumes (`data-act="resume"`).
  - Vertical scrolling must keep working. Use `touch-action: pan-y` on the swipeable card, and only treat a drag as a swipe once horizontal movement is more than 10 px and greater than the vertical movement.
  - Opening snaps the card left by the action button's width (88px). Closing snaps it back to 0.
  - Snap open when the card was dragged more than 44px left. Otherwise snap closed.
  - Tapping anywhere outside the open card closes it.
  - A drag must not also fire the resume click.
- **The home page's other day buttons don't change.**
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.

## File Map

| File | Change |
|---|---|
| `app/app.js` | In `viewHome()`, wrap the resume button in `.swipe` with an action button behind it. Add a swipe handler bound once in `bindEvents()`. Add `swipe-discard` and `swipe-finish` cases to `onMainClick`. |
| `app/styles.css` | Add `.swipe`, `.swipe-action` (danger red for Discard, `--good` green for Finish), and transform/transition rules. |
| `tests/offline.test.mjs` | Add swipe assertions (see Task 1). |

---

### Task 1: Swipeable Resume card

**Files:** modify `app/app.js`, `app/styles.css` and `tests/offline.test.mjs`.

- [ ] **Step 1: Write the failing test.** In `tests/offline.test.mjs`, section 7 currently starts Day A online, checks the prefill, then clicks `[data-act="discard"]` on the workout screen. Replace that discard with a swipe on the home page:
  - Click `[data-nav="home"]` and wait for `.swipe .day-btn.resume`.
  - Add a helper `swipeLeft(page, selector)` that gets the element's bounding box and drags it with `page.mouse` from 80% to 15% of its width along its vertical middle, in about 8 steps.
  - Assert that `.swipe-action` is visible and has the text `Discard`.
  - Click `.swipe-action`, then wait until `.day-btn.resume` has count 0.
  - Assert that `window.__wl.state.active` is `null`.
  - Keep the rest of section 7 (history checks) as it is.

  In section 8, after the first `logSet(page, 0, 1)` and before the `#rest-plus` click (so the Day B session has 1 set logged), add a detour:
  - Click `[data-nav="home"]`.
  - `swipeLeft` the resume card and assert that `.swipe-action` has the text `Finish`.
  - Swipe the card back right (drag from 15% to 80%) and assert that it closed: the card's computed transform is `none` or translateX 0, and the action button can no longer be clicked.
  - Click the resume card, which should resume (`section[data-ex="0"]` is visible).
  - Then continue section 8 exactly as before. The `#rest-plus` click needs the rest bar, and the rest started by that ✓ is still running, so it's still visible after resuming.

  After section 8 has done its `[data-act="finish"]` flow, nothing else changes. Also add one assertion that tapping Finish from the swipe opens the sheet. Do it in the detour above: instead of swiping back right, tap the `Finish` action, assert that `#fin-save` is visible, then close the sheet. Look at `openFinish()` in app.js for how the modal closes (a cancel button or backdrop), and use that. After closing it, assert that `section[data-ex="0"]` is visible. If closing the modal isn't possible without saving, report NEEDS_CONTEXT.

  Run `PW_CHANNEL=chrome node tests/offline.test.mjs`. It should fail waiting for `.swipe .day-btn.resume`.

- [ ] **Step 2: Implement it** following the Global Constraints. Notes:
  - Bind the pointer handlers once (delegated on `main()` or the swipe element after render) and keep each one small.
  - Use `pointerdown`, `pointermove`, `pointerup` and `pointercancel`. Use `setPointerCapture` once a horizontal swipe is detected. Suppress the click that follows a drag, for example with a `dragged` flag that a capture-phase click listener checks and clears.
  - The action button sits under the card's right edge (absolutely positioned inside `.swipe`), and the card slides over it.
  - Mark the open state with a class (`.swipe.open`) so CSS sets `transform: translateX(-88px)`. While dragging, set an inline transform with no transition. On release, clear it and let the class plus the transition take over.
  - Tapping outside an open swipe removes `.open` (a document `pointerdown` listener).

- [ ] **Step 3:** Run `PW_CHANNEL=chrome npm test`. Every test should pass and the run should end with `PASS — …`.

- [ ] **Step 4: Visual check.**
  - Take a screenshot at a 375px viewport with the card swiped open, saved to `test-results/swipe.png` with `.catch(() => {})` like the other screenshots.
  - Look at it and confirm that the card slid left and the red Discard button shows on the right, with no overlap glitches.

- [ ] **Step 5: Commit.**

```bash
git add app/app.js app/styles.css tests/offline.test.mjs
git commit -m "Home: swipe the Resume card left to Discard (no sets) or Finish

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
