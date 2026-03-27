# Figma Card Sync Plugin — Requirements Document

## Overview

Build a custom Figma plugin that replaces the existing "Google Sheets Sync" third-party plugin. The plugin connects directly to a Google Sheet, populates card components with data, sorts everything alphabetically, and builds print-ready 8.5×11 frames — all in one operation.

The primary use case is rapid prototyping of a tabletop card game. The user runs this plugin regularly as card content evolves, and needs the output to be consistently ordered so that front and back print sheets can be matched without manual sorting.

---

## Core Concepts

### Card Types
The Google Sheet has **multiple tabs**, one per card type (e.g. "Creatures", "Spells", "Items"). Each tab has its own set of columns, its own Figma front component, and its own Figma back component. Card dimensions may also differ per type.

### Component Convention
Figma components use a `#fieldname` naming convention for text layers. For example, a layer named `#title` will receive the value from the sheet column called `title`. Layer names in Figma must exactly match column headers in the sheet (case-insensitive matching is fine).

### Show/Hide Convention
Some layers are conditionally visible. If a column's value is `"Show"`, the corresponding layer is made visible. If the value is `"Hide"`, the layer is hidden. This applies to both front and back components.

### Slugs
Each card must have a unique, URL-safe identifier called a `slug`. This comes from a dedicated `slug` column in the sheet. The plugin uses the slug to:
- Name the Figma component instance (e.g. `card--forest-wyrm`)
- Sort cards alphabetically
- (Future) match image assets from a Figma image bank

---

## Plugin Architecture

The plugin consists of two parts, following Figma's standard plugin structure:

- **`code.ts`** — runs in the Figma sandbox, has access to the Figma API, cannot make network requests directly
- **`ui.html`** — runs in an iframe, can make network requests (Google Sheets API), communicates with `code.ts` via `postMessage`

All Google Sheets API calls happen in `ui.html`. All Figma canvas manipulation happens in `code.ts`.

---

## Configuration

### Plugin Settings (persisted via `figma.clientStorage`)
The plugin stores the following settings persistently:

```json
{
  "sheetsApiKey": "string",
  "spreadsheetId": "string",
  "cardTypes": [
    {
      "tabName": "Creatures",
      "enabled": true,
      "frontComponentKey": "figma-component-key",
      "backComponentKey": "figma-component-key"
    }
  ]
}
```

Card dimensions are **never stored**. They are read live from the component's bounding box (`node.width`, `node.height`) at sync time. The component is the source of truth for size.

### Settings UI
The plugin opens with a Settings panel and a Run panel. On first launch, Settings is shown. On subsequent launches, Run is shown with a shortcut to Settings.

**Settings panel contains:**
- Google Sheets API Key (text input, masked)
- Spreadsheet ID (text input)
- A "Detect Tabs" button that fetches all tab names from the sheet and lists them. For each detected tab, a card type row is added if one doesn't already exist.
- A list of configured card types, each showing:
  - Toggle: enabled/disabled for this sync run
  - Tab name (read-only, pulled from sheet)
  - Front component picker (dropdown of all master components found in the Figma file, by name)
  - Back component picker (same)
  - A detected size readout: "Detected: 180 × 252 px" — shown after a component is selected, read live from the component bounds. Not editable.
  - A remove button (×) to delete this card type config
- An "Add Card Type" button that adds a blank row (user types a tab name and picks components)
- Save button

**Key UX principle:** The user should never need to touch the plugin's source code to add a new card type. All configuration lives in this UI.

---

## Run Panel

The Run panel shows:
- A summary of configured card types and how many cards will be created
- A "Sync & Build" button
- A progress log that updates in real time during the run

---

## Main Sync Flow

When "Sync & Build" is triggered, the plugin executes the following steps in order:

### Step 1: Fetch Sheet Data
For each non-skipped tab, fetch all rows via the Google Sheets API v4:
```
GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{tabName}?key={apiKey}
```
The first row is treated as column headers. Each subsequent row becomes a card object. Skip rows where the `slug` column is empty.

### Step 2: Resolve or Create Working Frames
For each card type, the plugin looks for existing frames named:
- `[TabName] Fronts` — holds all front card instances
- `[TabName] Backs` — holds all back card instances

If these frames don't exist, create them on the canvas. Space them out vertically so they don't overlap.

### Step 3: Sync Component Instances

For each card type:

1. Get all existing instances in the Fronts and Backs frames
2. Build a map of `slug → instance` for existing instances
3. For each card row in the sheet:
   - If an instance with that slug already exists, **update it in place** (do not delete and recreate)
   - If no instance exists, **create a new one** from the master component
4. Delete any instances whose slug is no longer in the sheet
5. Rename every instance to `card--{slug}` for both fronts and backs

### Step 4: Populate Fields

For each instance (front and back):

1. Find all descendant text nodes whose name starts with `#`
2. Strip the `#` prefix to get the field name
3. Look up that field name in the card's row data (case-insensitive)
4. If found, set the text content to the value from the sheet
5. If the value is empty string, set text to empty string (don't leave stale content)

For Show/Hide layers:
1. Find all descendant nodes whose name starts with `#` and whose value column is `"Show"` or `"Hide"`
2. Set `node.visible = true` for `"Show"`, `node.visible = false` for `"Hide"`

### Step 5: Sort Instances Alphabetically

Within each frame (Fronts and Backs), sort all instances alphabetically by their name (`card--{slug}`). Reorder them left-to-right, top-to-bottom with consistent spacing (use card width + 8px gap, card height + 8px gap).

### Step 6: Build Print Sheets

#### Page size
Print frames are 8.5" × 11" at 96 DPI = **816 × 1056 px**.

Margins: 18px on all sides.

Cards are placed left-to-right, top-to-bottom with the minimum gap needed to fit as many as possible. Calculate columns and rows dynamically based on the component's live bounding box dimensions (`node.width`, `node.height`), not hardcoded to 9. Read dimensions from the master component at sync time.

#### Naming convention
Print frames are named:
- `Print -- [TabName] -- Fronts -- 01`, `Print -- [TabName] -- Fronts -- 02`, etc.
- `Print -- [TabName] -- Backs -- 01`, `Print -- [TabName] -- Backs -- 02`, etc.

#### Front print sheets
Cards are placed in alphabetical order, left-to-right, top-to-bottom across as many sheets as needed.

#### Back print sheets — CRITICAL ORDERING
Back print sheets must be ordered in **reverse** relative to front print sheets.

**Explanation:** When front sheets print, they stack in the output tray in reverse order (last sheet printed is on top). When the user flips the stack to reload for back printing, the printer feeds the sheet that was last to print first. Therefore:

- If fronts printed as sheets 1, 2, 3 (sheet 3 on top of stack after flip)
- Backs must print as sheets 3, 2, 1 (to match correctly)

Implementation: after building back print sheet frames in order, reverse the order of the frames OR name them in reverse. The simplest approach: build back sheets in the same card order, but then reverse the list of frames so that when the user exports and prints them in file order, they come out correct.

Include a comment in the code explaining this logic clearly.

#### Existing print frames
Before building print sheets, delete any existing `Print -- [TabName] --` frames for that card type. Always rebuild from scratch.

#### Frame placement
Place all print frames in a dedicated area of the canvas. Group them by card type, fronts first then backs, spaced 32px apart. Place this group at a consistent canvas position (e.g. x: 0, y: 2000 below the working frames).

---

## Image Bank (Planned — Design For, Don't Build Yet)

In a future version, the plugin will support image assets. The plan:

- The Figma file will contain a dedicated frame named `Image Bank`
- Inside it, image nodes will be named to match card slugs (e.g. `forest-wyrm`)
- During sync, if a card component contains a layer named `#image` (or similar), the plugin will find the matching image in the bank by slug and copy it into the component

**For now:** Skip image handling entirely, but structure the field-population code so that image fields can be added as a special case later without refactoring the whole populate step. A comment like `// TODO: image field support` at the right place is sufficient.

---

## Error Handling

- If the API key is missing or invalid, show a clear error message in the UI with a link to Settings
- If a tab references a component key that no longer exists in the file, skip that card type and log a warning
- If a row is missing a required `slug` value, skip that row and log a warning
- If a `#fieldname` layer exists in a component but no matching column is found in the sheet, leave the layer unchanged and log a warning
- Never crash silently — all errors should appear in the progress log

---

## Tech Stack

- TypeScript (Figma plugin standard)
- Figma Plugin API
- Google Sheets API v4 (REST, API key auth — no OAuth required for read-only access to a shared sheet)
- No external npm dependencies beyond `@figma/plugin-typings` and standard Figma plugin scaffolding

---

## File Structure

```
/
├── manifest.json
├── code.ts          # Figma sandbox — all canvas manipulation
├── ui.html          # iframe — settings UI, API calls, progress log
├── tsconfig.json
└── package.json
```

`ui.html` can be a single self-contained file with inline `<script>` and `<style>` tags. No build step for the UI is needed.

---

## Message Protocol (code.ts ↔ ui.html)

All messages use `{ type: string, payload: any }` format.

| Direction | Message Type | Payload |
|---|---|---|
| ui → code | `GET_SETTINGS` | — |
| code → ui | `SETTINGS` | settings object |
| ui → code | `SAVE_SETTINGS` | settings object |
| ui → code | `GET_COMPONENTS` | — |
| code → ui | `COMPONENTS` | array of `{name, key}` |
| ui → code | `RUN_SYNC` | `{ cardTypes: [...], sheetData: { tabName: rows[] } }` |
| code → ui | `PROGRESS` | `{ message: string, level: 'info' \| 'warn' \| 'error' }` |
| code → ui | `SYNC_COMPLETE` | `{ cardCounts: { tabName: number } }` |

The UI fetches sheet data itself (since it can make network requests), then sends the fully-fetched data to `code.ts` via `RUN_SYNC`. `code.ts` never touches the network.

---

## UX Notes

- The plugin window should be approximately 360px wide
- The progress log should auto-scroll to the bottom as messages arrive
- After a successful sync, show a summary: "Synced 3 card types — 48 cards total. Print frames ready."
- "Sync & Build" button should be disabled while a sync is in progress
- Settings should be accessible from the Run panel via a small gear icon, not a full navigation switch

---

## Out of Scope (v1)

- Image asset injection (designed for, not built)
- OAuth / private Google Sheets (API key + shared sheet is sufficient)
- Undo history (Figma plugin operations are not undoable by default — acceptable)
- Export triggering (user manually selects print frames and exports — acceptable for now)
- Multi-file support (one Figma file, one spreadsheet)