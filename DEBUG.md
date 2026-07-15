# DEBUG.md

## Objective

Your job is **NOT** to add major new features unless explicitly requested.

Your primary responsibility is to systematically find, reproduce, diagnose, and permanently fix bugs while improving the overall stability, reliability, and maintainability of the application.

If, during debugging, you identify a **small quality-of-life feature, utility, or architectural improvement** that would naturally improve the usability, reliability, or workflow of the app, you should implement it. These improvements should feel like natural enhancements rather than new standalone features.

---

# Core Rules

- Never guess the cause of a bug.
- Always identify the root cause before making changes.
- Do not create temporary workarounds unless absolutely necessary.
- Fix the underlying issue, not just the symptoms.
- Keep fixes as small and isolated as possible.
- Never break existing functionality.
- Maintain backwards compatibility whenever possible.
- Prioritize long-term maintainability over quick fixes.

---

# Intelligent Improvements

While debugging, you are encouraged to implement **small improvements** if they naturally improve the application.

Examples include:

- Better loading indicators
- Missing confirmation dialogs
- Improved error messages
- Empty states
- Better validation
- Keyboard shortcuts
- Tooltips
- Better accessibility
- Improved animations
- Smoother transitions
- More informative status indicators
- Better logging
- Auto-refresh where appropriate
- Small UI consistency improvements
- Better default settings
- More resilient error handling
- Automatic retries for safe operations
- Minor performance optimizations
- Cleaner spacing/alignment
- Better responsive behavior
- Improved settings organization
- Small workflow improvements that reduce clicks

Do **not** implement completely new standalone features unless requested.

A good rule is:

> "Would an experienced developer naturally include this while fixing the surrounding code?"

If yes, implement it.

If no, leave it for a future feature request.

---

# Debugging Process

For every issue:

1. Reproduce the bug consistently.
2. Trace the execution path.
3. Identify the exact root cause.
4. Explain why it occurs.
5. Implement the cleanest fix.
6. Verify the issue is resolved.
7. Check related functionality.
8. Repeat until no related issues remain.

---

# What To Check

Always inspect for:

- Runtime errors
- Console errors
- Build failures
- TypeScript errors
- Linter warnings
- Memory leaks
- Event listener leaks
- Duplicate listeners
- Async issues
- Race conditions
- Infinite loops
- UI freezes
- Layout issues
- Incorrect state updates
- API failures
- Missing null checks
- Promise handling
- Resource cleanup
- Security concerns
- Performance bottlenecks
- Dead code
- Unused imports
- Accessibility problems

---

# UI Verification

Ensure:

- Every button functions.
- Every page loads.
- Every modal behaves correctly.
- Keyboard shortcuts work.
- Loading states appear correctly.
- Error states are useful.
- Empty states are handled.
- Animations remain smooth.
- DPI scaling works.
- Window resizing works.
- Multi-monitor behavior is correct.

---

# Performance

Watch for:

- High CPU usage
- High RAM usage
- GPU overuse
- Slow startup
- Slow rendering
- Unnecessary re-renders
- Blocking operations
- Large bundle sizes
- Expensive calculations
- Duplicate API requests

Optimize only when measurable improvements can be made.

---

# Logging

During debugging:

- Add temporary logging where necessary.
- Remove temporary logs before finishing.
- Keep useful production logs.
- Avoid unnecessary console output.

---

# Code Quality

Every modified file should:

- Follow project conventions.
- Remain modular.
- Avoid duplicated logic.
- Remove obsolete code.
- Use descriptive naming.
- Be easy to maintain.
- Include comments only where they add value.

---

# Validation

Before considering a fix complete:

- Rebuild the application.
- Resolve all build errors.
- Resolve all TypeScript errors.
- Resolve all lint warnings where appropriate.
- Test the affected functionality.
- Test related functionality.
- Ensure no regressions were introduced.

---

# Output Format

For each completed fix:

## Bug
Describe the issue.

## Root Cause
Explain why it happened.

## Solution
Describe the implemented fix.

## Additional Improvements
List any small quality-of-life or workflow improvements implemented while working in the area, and explain why they improve the application.

## Verification
Explain how the fix was tested.

## Regression Check
List related functionality that was verified.

---

# Final Goal

Continue debugging until:

- No reproducible bugs remain.
- No runtime errors remain.
- No build errors remain.
- No TypeScript errors remain.
- No unnecessary warnings remain.
- No obvious performance issues remain.
- No regressions are introduced.

The application should leave each debugging session **more stable, cleaner, slightly more polished, and easier to use** than when it started, without introducing unnecessary complexity or unrelated major features.