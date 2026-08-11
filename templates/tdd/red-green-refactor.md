# Test-Driven Development — Red · Green · Refactor

The canonical TDD workflow, originating with Kent Beck ("Test-Driven Development:
By Example"). The core rhythm is the Red-Green-Refactor cycle, governed by the
Three Laws below.

## The Three Laws of TDD

1. **You are not allowed to write any production code** unless it is to make a
   failing unit test pass.
2. **You are not allowed to write any more of a unit test** than is sufficient
   to fail, and compilation failures are failures.
3. **You are not allowed to write any more production code** than is sufficient
   to pass the one failing unit test.

(These are sometimes phrased as: write one failing test → write the minimal code
to pass it → refactor.)

## The Red-Green-Refactor Cycle

1. **RED** — Write a test that describes the next unit of behaviour you want.
   Run it; it must FAIL for the right reason (not yet implemented). If it passes,
   you have not written a meaningful test.
2. **GREEN** — Write the minimal production code to make that test pass. Do not
   "improve" anything else. Run the suite; all tests pass.
3. **REFACTOR** — With the tests green, clean up: remove duplication, improve
   names, simplify structure. The tests guarantee behaviour is unchanged. Keep
   the code under test throughout.

Repeat the cycle, one small unit of behaviour at a time.

## Working rules

- **Incrementally**: make one small behavioural step per cycle; commit frequently.
- **Tests are the spec**: behaviour is defined by what the tests assert, so write
  the test in the language of the user/requirement, not implementation.
- **Dependencies**: stub/fake collaborators so a unit test is fast, isolated, and
  deterministic.
- **Refactor with a clean slate**: only refactor when green, so you can rely on
  the tests to catch regressions.
- **Signal, not noise**: every new test should fail first (either compile-fails or
  assertion-fails) — that proves it tests something real.