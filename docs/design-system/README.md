# InferHarness Design System

Status: Current design-system overview

Last updated: 2026-07-25

## 1. Purpose

This document describes the current InferHarness design system at the token,
component, and implementation-rule level. It is intended to help contributors
extend the UI without inventing new visual language.

The original high-fidelity handoff was moved from
`specs/new-layouts/design_handoff_01_design_system/` into this directory.
`docs/design-system/tokens/` is now the durable design-system specification
snapshot:

- `docs/design-system/tokens/colors_and_type.css`;
- `docs/design-system/tokens/components.css`;
- `docs/design-system/tokens/fonts/`.

The live frontend implementation uses:

- `frontend/src/styles/tokens/colors_and_type.css`;
- `frontend/src/styles/tokens/components.css`.

`frontend/src/styles/tokens/` is the runtime copy. Its CSS and font files must
remain byte-identical to the durable snapshot. Use the documented token files
as the source for exact CSS custom-property names and values.

## 2. Design Intent

InferHarness uses a calm, dense, local-tool interface for engineers reviewing
servers, models, runs, logs, metrics, and structured results.

The visual language is:

- warm paper backgrounds;
- near-black ink text;
- IBM Plex typography;
- restrained gold selection and focus accents;
- compact controls and data-dense surfaces;
- borders before heavy shadows;
- clear status color for success, error, and pending states.

The design system should make long inspection sessions readable. It should not
feel like a marketing page, decorative dashboard, or generic SaaS template.

## 3. Token Layers

`frontend/src/styles/index.css` imports the token files first:

```css
@import './tokens/colors_and_type.css';
@import './tokens/components.css';
```

Page, shell, and feature-specific styles are layered after those imports. New UI
styles should prefer existing tokens before adding local values.

The current token layers are:

| Layer | File | Contents |
|---|---|---|
| Color and type foundations | `docs/design-system/tokens/colors_and_type.css` and `frontend/src/styles/tokens/colors_and_type.css` | Font faces, font families, type scale, color ramps, semantic colors, borders, radii, shadows, spacing, motion, layout constants |
| Component primitives | `docs/design-system/tokens/components.css` and `frontend/src/styles/tokens/components.css` | Shared classes for buttons, icon buttons, nav buttons, fields, cards, health pills, tabs, list items, status text, code blocks, tables, metrics cards, and page chrome |
| App implementation | `frontend/src/styles/index.css` and feature CSS | Actual shell, page layouts, feature views, and targeted overrides |

## 4. Color System

The palette is organized around paper, ink, gold, and semantic status colors.

### 4.1 Paper

Paper tokens define backgrounds, surfaces, borders, and disabled fills:

- `--paper-0`: brightest hover lift;
- `--paper-1`: card and modal surface;
- `--paper-2`: row stripe and inner panel;
- `--paper-3` through `--paper-6`: page gradient and lower-contrast surfaces;
- `--paper-7` and `--paper-8`: default and input borders;
- `--paper-9`: disabled fill and neutral chip.

Use paper tokens instead of hardcoded whites, grays, or beige variants.

### 4.2 Ink

Ink tokens define text and dark surfaces:

- `--ink-9`: primary text and primary button fill;
- `--ink-8` and `--ink-7`: strong body text and emphasized UI text;
- `--ink-6` through `--ink-3`: secondary, muted, and metadata text;
- `--ink-2`: footnotes;
- `--ink-1`: dark code/pre surface.

Use ink tokens for text contrast instead of introducing local black or gray
values.

### 4.3 Gold

Gold is the only accent family. It marks selection, focus, active tabs, and
primary attention. It is not decorative.

Defined gold tokens are `--gold-1` through `--gold-5`:

- `--gold-1`: tint and soft focus surface;
- `--gold-2`: hover on accent surfaces;
- `--gold-3`: default focus and active border;
- `--gold-4`: selected-list border;
- `--gold-5`: deep accent, used sparingly.

Do not introduce blue or purple accents for active state. If a new gold shade is
needed, add it deliberately in the token file before using it.

### 4.4 Semantic Colors

Semantic tokens carry state:

- `--ok`, `--ok-tint`, `--ok-halo`: success and healthy state;
- `--danger`, `--danger-icon`, `--danger-tint`, `--danger-halo`: error and destructive state;
- `--pending`, `--pending-text`, `--pending-halo`: pending or streaming state;
- `--warning-dot`, `--warning-tint`: warning and in-progress attention.

Use semantic colors only for state. Do not use them as general decoration.

## 5. Typography

The system uses self-hosted IBM Plex:

| Token | Family | Use |
|---|---|---|
| `--font-sans` | IBM Plex Sans | Body text, headings, buttons, forms, navigation |
| `--font-mono` | IBM Plex Mono | IDs, model names, URLs, hashes, counts, code-like values |
| `--font-serif` | IBM Plex Serif | Rare editorial/display use only |

The active type scale is tokenized from `--fs-xs` through `--fs-5xl`.
Common usage:

- `--fs-xs` and `--fs-sm`: labels, metadata, table headers, health pills;
- `--fs-base`: dense data and table cells;
- `--fs-md`: default body and form text;
- `--fs-lg`: lead text;
- `--fs-xl` through `--fs-3xl`: section and page headings;
- `--fs-4xl` and `--fs-5xl`: exceptional display surfaces.

Production page styles set normal letter spacing for headings and display text
through `frontend/src/styles/index.css`. Uppercase labels and metadata can use
tracked spacing through `--tracking-label` or `--tracking-eyebrow`.

Use tabular numbers for metrics and comparable numeric fields.

## 6. Spacing, Layout, and Sizing

Spacing follows a 4px base grid with a 2px micro step. Use `--s-*` tokens for
new shared styles:

- compact gaps: `--s-2`, `--s-3`, `--s-4`;
- control and row padding: `--s-5`, `--s-6`, `--s-8`;
- card and page padding: `--s-10`, `--s-12`, `--s-16`;
- large page spacing: `--s-20`, `--s-24`, `--s-32`.

Current layout tokens include:

- `--page-max`: default page width;
- `--page-max-wide`: wide page width;
- `--sidebar-w`: token-level sidebar width;
- `--nav-btn-size`: square nav button size;
- `--input-h`: standard input height;
- `900px`: canonical breakpoint for the compact top bar and off-canvas
  navigation. Breakpoint values are written directly in media queries because
  CSS custom properties cannot be used in media-query conditions.

The production shell uses `--sidebar-w` for its 220px desktop sidebar.

## 7. Radii and Shape

Use established radius tokens:

- `--r-pill`: chips, pills, circular status elements;
- `--r-input`: inputs and compact controls;
- `--r-row`: dense rows;
- `--r-list`: list items and code surfaces;
- `--r-card-sm`: small metric cards;
- `--r-card`: standard cards;
- `--r-nav-btn`: sidebar navigation buttons;
- `--r-tab`: browser-style tabs.

The UI should stay compact and practical. Avoid large decorative rounded panels
unless a feature already uses that treatment.

## 8. Borders, Shadows, and Elevation

Most surfaces use a one-pixel border instead of elevation.

Use:

- `--border-default` for normal surface edges;
- `--border-input` for form fields;
- `--border-divider` and `--border-table-row` for separators;
- `--border-error` for validation and destructive state;
- `--border-selected` for selected cards, rows, and choices.

Shadows are reserved for explicit elevation:

- `--shadow-card` and `--shadow-card-hover` for lifted cards;
- `--shadow-header` for sticky page chrome;
- `--shadow-nav`, `--shadow-nav-active`, and `--shadow-nav-press` for navigation controls;
- `--shadow-modal` and `--shadow-popover` for overlays.

Do not add new shadow styles for ordinary page sections.

## 9. Interaction States

The global focus rule is:

```css
:focus-visible {
  outline: 2px solid var(--gold-3);
  outline-offset: 2px;
}
```

Interactive states should follow these patterns:

- hover card or list item: warmer/lighter paper background, no layout shift;
- selected card or list item: `--bg-selected` plus `--border-selected`;
- primary action: ink background with paper text;
- destructive action: danger background with paper text;
- disabled action: neutral paper fill, reduced emphasis, no hover effect;
- pending action: pending or warning indicator without replacing error/success colors.

Keep tap targets at least 44px tall where the control is a primary navigational
or repeated action.

## 10. Component Primitives

The shared primitive classes in `components.css` are available for new surfaces:

| Primitive | Classes | Use |
|---|---|---|
| Buttons | `.btn`, `.btn--ghost`, `.btn--danger`, `.btn--pending`, `.btn--sm` | Text actions and primary commands |
| Icon buttons | `.icon-btn`, `.icon-btn--danger` | Compact icon-only actions |
| Navigation buttons | `.nav-btn`, `.nav-btn.is-active` | Sidebar/navigation controls |
| Fields | `.field`, `.textarea` | Inputs and textareas |
| Cards | `.card`, `.card--hover` | Bordered content groups |
| Health | `.health`, `.health__dot`, `.health--up`, `.health--down`, `.health--pending` | Backend/server status |
| Tabs | `.tabs`, `.tabs__btn`, `.detail-tabs`, `.detail-tabs__btn` | Mode and detail navigation |
| Lists | `.list-item`, `.list-item.is-selected` | Selectable rows/cards |
| Status text | `.status-ok`, `.status-failed`, `.status-pending` | Inline state labels |
| Code | `.pre--dark`, `.pre--light`, `.code-inline` | Logs, JSON, commands, inline code |
| Tables | `.table` | Dense tabular data |
| Metrics | `.metric-card`, `.metric-card__row` | Compact metric summaries |

Prefer these primitives for new UI before creating feature-local variants.

## 11. Implementation Rules

- Import token files before app and feature styles.
- Use CSS custom properties from token files for color, type, spacing, radius,
  shadow, motion, and layout values.
- Keep new static visual constants in token files when they are meant to be
  reused.
- Keep the `docs/design-system/tokens/` snapshot synchronized with
  `frontend/src/styles/tokens/` when token files or bundled fonts change.
- Keep feature-specific layout classes in `frontend/src/styles/index.css` or a
  targeted feature stylesheet.
- Do not reference a token alias unless it is defined in the token files.
- Do not hardcode credentials, server URLs, or user data into visual examples.
- Do not use the handoff files as runtime imports; copy or translate stable
  token values into the frontend token files.

## 12. Change Control

Update this document when:

- a token family is added, removed, or renamed;
- the token snapshot under `docs/design-system/tokens/` changes;
- a core primitive changes behavior or state styling;
- the app shell or page layout rules change materially;
- a new visual pattern becomes broadly reusable;
- the design handoff is re-baselined.

Implementation plans, one-off page mockups, and screenshots should stay under
`specs/` unless they become durable product contracts.
