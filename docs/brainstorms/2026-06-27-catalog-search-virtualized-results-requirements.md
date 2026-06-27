---
date: 2026-06-27
topic: catalog-search-virtualized-results
---

# Catalog Search Virtualized Results Requirements

## Summary

The catalog search page should move from full result cards to a dense, virtualized results table that remains fast as the catalog grows. Search, filters, sort, counts, URL state, copy actions, and warning signals should still apply to the complete local result set while the browser renders only a bounded visible window.

---

## Problem Frame

The current catalog search page renders full result cards for every entry and then filters, hides, sorts, and reorders those DOM nodes client-side. That is acceptable for the seed catalog, but it will become a browser performance problem as the catalog grows toward thousands of entries.

The search page is also doing too much inspection work. Search results should help users scan and compare Caplets quickly, while the detail page remains the place to inspect full warnings, source metadata, and `CAPLET.md` content before installation.

---

## Key Decisions

- **Virtualize a complete local result set.** The page should keep instant client-side search over a compact index while only rendering the visible row window.
- **Use dense rows instead of full cards.** The search page becomes a scanning surface; the detail page remains the inspection surface.
- **Use page scrolling.** The browser scrollbar should remain the main scroll model, with a compact sticky toolbar under the site header.
- **Use a proven virtualization library.** Scroll measurement, overscan, resize behavior, focus behavior, and browser edge cases should not be hand-rolled.
- **Use `$impeccable` during implementation.** The dense table, sticky controls, responsive behavior, accessibility, status icon affordances, and browser polish must be shaped and reviewed with Impeccable.

---

## Actors

- A1. **Catalog search user.** Searches, filters, sorts, scans rows, copies install commands, and opens detail pages.
- A2. **Keyboard and assistive technology user.** Navigates the sticky toolbar, virtualized rows, copy controls, tooltips, and detail links without relying on pointer hover or color alone.
- A3. **Implementation agent.** Builds the search page hardening and uses `$impeccable` as part of frontend design and polish.
- A4. **Future catalog operator.** Needs the search page to remain usable as the index grows to thousands of official and community entries.

---

## Requirements

**Result Shape**

- R1. The search results surface must use dense table-like rows rather than full result cards.
- R2. Each row must show the Caplet title, official or community status, install count, truncated description, truncated install command, copy action, and compact status indicators.
- R3. Row descriptions must truncate after a fixed length or fixed visual space so rows remain scan-friendly.
- R4. Install commands must truncate visually while remaining copyable through an icon button.
- R5. Rows must link or otherwise route users to the detail page for full inspection.
- R6. Full warning explanations, complete source metadata, and full `CAPLET.md` inspection must remain on the detail page rather than expanding every search result row.

**Status Signals**

- R7. Local control, setup required, project binding required, vault secrets required, and similar risk or readiness signals must appear as icons in the row.
- R8. Status icons must have hover and keyboard-accessible tooltips or equivalent labels.
- R9. A compact legend must explain status icons near the results controls.
- R10. Status meaning must not rely on color alone.
- R11. Iconography must use the catalog's existing icon system rather than custom hand-rolled glyphs.

**Virtualization And Search Behavior**

- R12. The page must use a proven virtualization library for the result rows.
- R13. The virtualized list must render only the visible row window plus reasonable overscan.
- R14. The page must support a catalog size of 10,000 entries without rendering thousands of result rows into the DOM.
- R15. Search, filters, and sort must operate against the complete local compact index, not only the currently rendered rows.
- R16. Search result count must reflect the complete filtered result set.
- R17. Changing search, filters, or sort must reset the virtualized list to the top while preserving focus in the active control.
- R18. Search, filter, sort, and pagination-like rendering behavior must keep shareable URL state for query, scope, setup, tag, and sort.
- R19. The result list must preserve expected browser page scrolling instead of introducing a nested internal scroll panel.

**Toolbar And Layout**

- R20. The search input, filters, sort control, result count, and status legend must live in a compact sticky toolbar.
- R21. The sticky toolbar must remain visible while users scroll through results.
- R22. The toolbar must stay compact enough that it does not dominate the viewport on desktop or mobile.
- R23. Desktop and tablet rows should use a fixed-height layout to simplify virtualization and avoid scroll jumps.
- R24. Mobile rows may stack fields, but their height and truncation rules must remain predictable enough for stable virtualization.
- R25. The dense results surface must fit the existing Caplets product design system and Starwind-based catalog UI.

**Accessibility And Interaction**

- R26. Copy buttons, row detail links, filters, sort controls, tooltips, and sticky toolbar controls must be keyboard accessible.
- R27. Result count updates, no-results state, and copy success or failure must be announced accessibly.
- R28. Focus states must remain visible in light, dark, and system color schemes.
- R29. Virtualization must not trap focus, lose focus during rerenders, or make keyboard navigation skip unpredictably.
- R30. Touch targets on mobile must remain usable even though rows are denser than the current cards.
- R31. Reduced-motion preferences must be respected for any row, toolbar, tooltip, or copy-feedback transitions.

**Implementation Process**

- R32. Implementation must use `$impeccable` for product-register shaping and polish of the dense search results UI.
- R33. The Impeccable pass must specifically cover visual hierarchy, density, toolbar compactness, status-icon comprehension, responsive behavior, accessibility, and browser rendering polish.
- R34. The implementation must keep the detail page as the inspection surface and avoid moving dense-row performance work into unrelated detail-page redesign.

---

## Key Flows

- F1. Search and scan dense results
  - **Trigger:** A user searches or filters the catalog.
  - **Actors:** A1
  - **Steps:** The sticky toolbar updates URL-backed search state, the result count updates for the full filtered set, the list resets to the top, and the user scans dense rows with title, status, installs, description, install command, and icons.
  - **Covered by:** R1, R2, R15, R16, R17, R18, R20, R21

- F2. Scroll a large result set
  - **Trigger:** A filtered or unfiltered result set contains thousands of entries.
  - **Actors:** A1, A4
  - **Steps:** The user scrolls with the browser scrollbar, the virtualizer updates the visible row window, and the DOM row count remains bounded.
  - **Covered by:** R12, R13, R14, R19, R23, R24

- F3. Copy an install command from a row
  - **Trigger:** A user finds a promising Caplet in the dense list.
  - **Actors:** A1, A2
  - **Steps:** The row shows a truncated command, the user activates the copy icon button, the full command is copied, and copy feedback is announced.
  - **Covered by:** R4, R26, R27, R28, R30

- F4. Interpret status icons
  - **Trigger:** A row has local-control, setup, project-binding, Vault, or similar status signals.
  - **Actors:** A1, A2
  - **Steps:** The row shows compact icons, the toolbar legend explains them, and hover or keyboard interaction reveals an accessible label.
  - **Covered by:** R7, R8, R9, R10, R11, R26

- F5. Open full inspection
  - **Trigger:** A user needs to inspect a Caplet before installing.
  - **Actors:** A1
  - **Steps:** The user opens the detail page from a dense row and reviews complete warnings, metadata, and `CAPLET.md` content there.
  - **Covered by:** R5, R6, R34

- F6. Implement and polish the UI
  - **Trigger:** A future agent implements the virtualized search results work.
  - **Actors:** A3
  - **Steps:** The agent uses the existing product design context, applies `$impeccable`, verifies density and accessibility, and polishes the browser behavior.
  - **Covered by:** R25, R32, R33

---

## Acceptance Examples

- AE1. **Covers R1, R2, R6.** Given the catalog search page loads, when results are displayed, then they appear as dense rows with title, status, install count, truncated description, truncated command, copy action, and icons rather than full warning cards.
- AE2. **Covers R12, R13, R14.** Given a test index contains 10,000 entries, when the search page renders and the user scrolls, then the DOM contains only a bounded row window plus overscan instead of thousands of rendered result rows.
- AE3. **Covers R15, R16, R17, R18.** Given a user changes the search query, filter, or sort, when the result set updates, then the count reflects all matching entries, URL state updates, focus remains in the active control, and the list scrolls back to the first row.
- AE4. **Covers R19, R20, R21, R22.** Given a user scrolls through many results, when the page moves, then the browser scrollbar is the main scroll mechanism and the compact toolbar remains visible without consuming excessive viewport height.
- AE5. **Covers R4, R26, R27.** Given a row's install command is longer than the available column, when it renders, then the command truncates visually, the copy icon has an accessible name, and activating it copies the full command.
- AE6. **Covers R7, R8, R9, R10.** Given rows include local control, setup, project binding, or Vault status, when a user sees the list, then the icons are explained by the legend and by accessible tooltip or label behavior.
- AE7. **Covers R23, R24, R29.** Given the list is virtualized, when rows enter and leave the visible window, then row height remains predictable and keyboard focus is not lost or skipped unexpectedly.
- AE8. **Covers R28, R31.** Given a user has dark mode or reduced motion enabled, when they use the toolbar, rows, tooltips, and copy feedback, then focus remains visible and motion is reduced or removed.
- AE9. **Covers R32, R33.** Given implementation is complete, when the frontend is reviewed with `$impeccable`, then the dense results surface passes product-register scrutiny for hierarchy, density, responsive layout, accessibility, and polish.

---

## Success Criteria

- The search page remains usable with a 10,000-entry mocked catalog.
- Initial render does not create thousands of result row DOM nodes.
- Scrolling keeps the rendered row count bounded.
- Search, filters, and sort remain responsive and reset the result window to the top.
- The sticky toolbar remains compact and visible during page scroll.
- Rows are dense enough to scan like a table while still exposing copy and detail actions.
- Status icons are understandable through a legend and accessible labels.
- Copy buttons, row links, tooltips, theme modes, and mobile layout continue to work.
- The implementation includes an Impeccable design and polish pass.

---

## Scope Boundaries

- Server-side search and remote result paging are out of scope for v1.
- Loading more results from an API as the user scrolls is out of scope for v1.
- Redesigning the detail page is out of scope except for preserving it as the inspection destination.
- Full warning explanations in every search result row are out of scope.
- Explicit timing targets such as a fixed millisecond filter budget are out of scope; behavioral performance acceptance is sufficient for this hardening pass.

---

## Dependencies / Assumptions

- The catalog can ship a compact client-side search index containing row-level fields without embedding full `CAPLET.md` bodies in the search page.
- The existing catalog detail route remains the canonical inspection surface.
- The catalog continues to use the Caplets product design system and Starwind component direction.
- The implementation environment can add or use a virtualization library compatible with the Astro catalog app.
- Status icon meanings are stable enough to document in a compact legend.
- The existing light, dark, and system theme controls remain part of the catalog UI.

---

## Sources / Research

- `docs/brainstorms/2026-06-26-caplets-catalog-search-site-requirements.md` for the broader catalog search-site scope.
- `apps/catalog/src/components/ResultList.astro` for the current full-list rendering behavior.
- `apps/catalog/src/components/CapletResult.astro` for the current full result-card shape.
- `apps/catalog/src/scripts/search.ts` for current client-side filtering, sorting, hiding, and DOM reordering behavior.
- `apps/catalog/src/lib/search-filter.ts` for current local search semantics.
- `PRODUCT.md` and `DESIGN.md` for the Caplets product design register and visual system.
- `$impeccable` product-register guidance for implementation-time UI shaping and polish.
