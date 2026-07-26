# IMPLEMENTATION — Mini Widget Library, Search & Favourites System

> **How to use this file:** Paste this entire document into Claude Code. This is a complete implementation specification for redesigning the Mini Widget system into a scalable, searchable, and user-friendly feature library.

---

# Goal

The current Mini Widgets section is beginning to grow beyond a manageable size. As more widgets are added, users will eventually need to scroll through long lists to find what they want, making discovery difficult and reducing usability.

The goal of this implementation is to completely redesign how Mini Widgets are managed without changing how existing widgets function.

The new system should feel similar to:

- Raycast Extensions
- Windows Widgets
- BetterDiscord Plugin Manager
- VSCode Extensions (simplified)

Instead of showing every widget permanently, users should have a dedicated Widget Library that can be opened from the main interface.

The Widget Library becomes the central location for:

- Browsing every widget
- Searching widgets
- Reading widget descriptions
- Enabling/disabling widgets
- Marking favourites
- Seeing recently used widgets
- Viewing widget categories

The existing Mini Widget section on the dashboard should only display:

- Enabled widgets
- Favourite widgets
- Recently used widgets (optional)

This keeps the dashboard clean while allowing unlimited future widgets.

This implementation is infrastructure for future development and must be designed to support dozens (or even hundreds) of widgets without requiring future redesigns.

---

# Deliverables

Implement:

✓ Mini Widget Library

✓ Widget Search

✓ Widget Categories

✓ Widget Metadata System

✓ Favourite Widgets

✓ Recently Used Widgets

✓ Widget Registry

✓ Smooth opening animations

✓ Keyboard navigation

✓ Persistent settings

✓ Modular architecture for future widgets

---

# Constraints (Non-Negotiable)

- Existing widgets must continue working exactly as before.
- Existing settings must migrate automatically.
- No widget functionality may be removed.
- The UI must remain consistent with the application's glassmorphism style.
- No placeholder implementations.
- Every animation must run at 60fps.
- Every state must persist after restarting the application.
- New widgets added later should only require registration in one place.
- Errors must be logged through the Logger.

---

# Phase 1 — Widget Registry Architecture

The first step is replacing the current hardcoded widget list with a proper registry system.

Every widget should register itself using a shared object.

Each widget should expose metadata such as:

- Internal ID
- Display Name
- Description
- Category
- Icon
- Version
- Author
- Favourite state
- Enabled state
- Search keywords

Example metadata:

Weather Enhanced

Description:
Advanced weather forecasts, humidity, wind, hourly forecast and more.

Category:
Weather

Keywords:

- weather
- rain
- forecast
- humidity
- wind

Future widgets should require only one registration entry to automatically appear throughout the application.

No UI should contain hardcoded widget lists anymore.

---

# Phase 2 — Widget Library

Replace the existing widget dropdown with a dedicated Widget Library.

The Widget Library should open from:

Mini Widgets
↓

Widget Library

Opening animation:

Scale

95%

↓

100%

Fade

0%

↓

100%

Background blur increases smoothly.

The library should have:

-------------------------------------------------

Search Bar

Categories

Widget Grid

-------------------------------------------------

Each widget card should contain:

Icon

Widget Name

Short description

Enabled toggle

Favourite button

Category

Version

Hover effects

Clicking anywhere on the card should open a detailed panel.

---

Detailed panel

Shows:

Large icon

Full description

Features

Current status

Version

Dependencies (future)

Buttons

Enable

Disable

Favourite

Open widget

Close

---

# Phase 3 — Search System

At the top of the Widget Library should be a universal search bar.

Searching should happen instantly.

No search button.

Search updates while typing.

The search should include:

Widget names

Descriptions

Keywords

Categories

Example

Typing

spotify

Returns

Spotify Enhanced

Typing

music

Returns

Spotify

Lyrics

Visualizer

Typing

network

Returns

Internet Monitor

Ping Tester

Network Statistics

Future widgets automatically become searchable through their metadata.

Search should ignore:

Capitalisation

Extra spaces

Minor spelling differences

Use fuzzy searching where practical.

---

# Phase 4 — Categories & Favourites

Widgets should be organised into categories.

Example categories:

General

Gaming

Spotify

Media

Audio

Productivity

System

Utilities

Experimental

Networking

Weather

Displays

Searching

Clipboard

Users should be able to filter by category.

Example:

Only Gaming

Only Audio

Only Productivity

etc.

---

Favourite System

Every widget card has:

★

Clicking it:

Animates

Empty

↓

Filled

The favourite state saves automatically.

Favourite widgets appear:

Inside the Widget Library

AND

Inside the dashboard Mini Widget section.

This gives quick access to frequently used widgets.

Favourite ordering should always appear before non-favourites.

---

# Phase 5 — Dashboard Integration

The dashboard Mini Widget section should no longer show every widget.

Instead it should display:

Pinned/Favourite Widgets

Enabled Widgets

Recently Used Widgets (optional)

The dashboard should remain clean.

Example:

Mini Widgets

Weather Enhanced

Spotify Enhanced

Clipboard History

Timer

Bluetooth

...

Everything else remains inside the Widget Library.

Clicking

Browse Widgets

opens the full Widget Library.

Users should never need to scroll through dozens of widgets on the dashboard.

---

# Phase 6 — Polish, UX & Validation

Animations

Every interaction should feel premium.

Hover

Slight lift

Shadow grows

Border glow

Favourite

Scale

0.9

↓

1.15

↓

1.0

Toggle

Smooth sliding switch

Search

Results animate in

Cards reposition smoothly

Opening

Blur

Fade

Scale

Closing

Reverse animation

Loading

Skeleton cards

No flashing

No layout jumps

---

Keyboard Navigation

Arrow keys

Navigate widgets

Enter

Open widget

Space

Toggle favourite

Ctrl+F

Focus search

Esc

Close library

---

Persistence

The following should persist:

Enabled widgets

Favourite widgets

Last selected category

Window size

Search history (optional)

Recently opened widgets

---

Performance

Opening the Widget Library should take less than 150ms.

Searching should feel instant.

No unnecessary re-renders.

Support at least 100 widgets without noticeable slowdown.

---

Acceptance Tests

✓ Existing widgets continue functioning.

✓ Widget Library opens correctly.

✓ Search finds widgets instantly.

✓ Favourites save after restart.

✓ Dashboard only displays enabled/favourite widgets.

✓ Categories filter correctly.

✓ Keyboard navigation works.

✓ Search is fuzzy and case-insensitive.

✓ Animations remain smooth.

✓ New widgets only require registration in the Widget Registry.

✓ No hardcoded widget lists remain.

✓ Logger reports any registry or loading errors.

---

Versioning

When complete:

- Update application version.
- Update CHANGELOG.md.
- Document the new Widget Registry architecture.
- List every modified file.
- Add developer documentation explaining how to register new widgets.

The final implementation should make adding future widgets require minimal code changes while significantly improving scalability, usability, and discoverability.