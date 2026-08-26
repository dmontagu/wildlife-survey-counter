# Wildlife Survey Counter — Frontend

## Tech Stack
- **React 19** + TypeScript
- **Tailwind CSS v4** (CSS-first, no config file — all theming in `src/index.css`)
- **shadcn/ui** (new-york style, neutral base color, lucide icons)
- **Vite 7** with `@vitejs/plugin-react-swc` and `@tailwindcss/vite` plugin

## shadcn Components
Components live in `src/components/ui/` and are installed via the CLI:
```bash
npx shadcn@latest add <component> --yes --overwrite
```
**Do not hand-write shadcn components.** Always use the CLI so they get proper styling, animations, and the correct `radix-ui` imports.

Currently installed: `button`, `dialog`, `dropdown-menu`, `input`, `tooltip`, `tooltip`

Config: `components.json` in the frontend root.

## Architecture
- **State**: React Context + `useReducer` with undo/redo via patches (`src/state.ts`, `src/types.ts`)
- **Rendering**: RAF-based canvas with dirty flag (`src/hooks/useCanvasRenderer.ts`)
- **Viewport**: Separate hook for pan/zoom (`src/hooks/useViewport.ts`)
- **Interaction**: Modifier-key-driven, no tool modes — `Canvas.tsx`'s `onMouseDown` resolves the gesture roughly as follows (see the numbered `Priority` comments in `Canvas.tsx` for the exact order):
  - **Alt** = bbox drawing, but only while the Advanced bbox tool is on (`state.bboxCreationEnabled`). Alt+drag = draw bbox, Alt+click = add point
  - **Space** (hold) = pan by tracking raw mouse movement (no click needed)
  - **Shift+Cmd/Ctrl+drag** = box-select and confirm in one gesture
  - **Shift** = extend selection on a marker; box-select on empty canvas
  - **Cmd/Ctrl** = click a marker to add it to the selection and confirm it; drag empty canvas to pan; Cmd/Ctrl+scroll = zoom (bare scroll pans on macOS and zooms elsewhere)
  - **No modifier**: click empty canvas adds a point when nothing is selected, otherwise clears the selection; drag empty canvas = pan
  - Drag annotation = move, drag bbox handle = resize
  - Middle mouse drag = pan
  - Backspace = delete manual annotations, reject imported ones
- **Config**: `src/config.ts` defines the keyboard shortcuts (`KEYS` — including `Enter`/`Shift+Enter` to confirm/unconfirm and `E`/`Shift+E` to cycle the class) and the `ELK_CATEGORY_OPTIONS` table, plus zoom bounds; click behavior lives in `Canvas.tsx`
- **Classes**: `ELK_CATEGORY_OPTIONS` is the only place the class list is written down — each entry's colour,
  badge, marker shape, group, and optional letter drives the palette, the shortcuts, the E-cycle, counts, the
  status bar, the help overlay, and both export canvases. Don't spell the letters out anywhere else; the help
  dialog is generated from the table. `shortcut` is optional on purpose: bare letters are a scarce namespace
  shared with `KEYS`, and `config.test.ts` fails the build if a class letter collides with one of those bindings.
  Marker shape carries certainty rather than identity — a plain dot or solid outline is a specific call, a dashed
  ring means "unclassified" at that level
- **Persistence**: localStorage saves/restores the current image, its annotations, and UI preferences across refreshes (prefix: `wsc:`); images opened from disk are stored as blobs in IndexedDB (`wsc-browser-images`, see `src/lib/browser-images.ts`)

## Path Aliases
`@/` maps to `./src/` (configured in both `tsconfig.json` and `vite.config.ts`).

## Server
The backend is a Python server (`src/wildlife_counter/server.py`) that serves images from `storage/samples/` and `storage/uploads/` directories. Vite proxies `/api`, `/samples`, and `/uploads` to `http://localhost:8100`.

## Testing

**Vitest** + **Testing Library** in a jsdom environment. Config lives in the `test` block of
`vite.config.ts`; shared setup is `src/tests/setup.ts` and shared fixtures are `src/tests/helpers.tsx`.

```bash
make test-ts                        # whole suite (also runs in CI)
make test-ts ARGS=storage           # scope to files matching a pattern
make test-ts ARGS='-t "undo"'       # scope to test names
make test-ts-watch                  # watch mode
```

- Tests live next to the code as `*.test.ts` / `*.test.tsx`. Vitest isolates each file, so no
  naming convention is needed to opt out of shared state.
- **Prefer `userEvent` and semantic queries** (`getByRole`, `getByLabelText`) over DOM structure, so
  a styling change does not break a test about behaviour. Class names appear in both the palette and
  the status bar, so read counts through `statusCount()` in `src/tests/helpers.tsx`.
- Reducer and pure-function tests carry the transition matrices and edge cases; App-level tests
  (`src/app-*.test.tsx`) mount the real tree and assert on what actually lands in browser storage.
- **`fast-check`** for properties that must hold over any input — normalisation round-trips, storage
  key uniqueness, undo/redo integrity. Reach for it when "for all X" is the actual requirement.
- jsdom implements no canvas, `ResizeObserver`, object URLs, or image loading. Those stubs live in
  `src/tests/setup.ts` and `stubImageLoading()`; don't re-stub them per file.

### Persistence is the thing to test hardest

A release that loses a reviewer's counts is the worst failure this app has. Two suites exist for it
and should grow whenever the stored shape changes:

- `src/app-storage-upgrade.test.tsx` — snapshots of browser storage as *previously shipped builds*
  wrote it, each opened by today's build. **Add a snapshot whenever the persisted shape changes.**
- `src/app-persistence.test.tsx` — the save/restore loop through the real component tree, including
  unreadable payloads, a full `localStorage`, and deleting one image without touching another.

The rule they encode: a build may migrate stored data, but it may never delete what it could not
understand. Anything unreadable is copied to `<key>:unreadable` rather than overwritten, and a
migration only drops its source once the destination write has succeeded.

`src/lib/storage.test.ts` and `src/config.test.ts` pin the storage key names and the shipped class
ids as literals. If one of those tests fails, the change needs a migration — not a new expectation.

## Formatting & Linting
**Biome** handles both formatting and linting (replaces Prettier + ESLint). Config in `biome.json` at repo root.
- No semicolons, single quotes, trailing commas, 2-space indent, 119 char line width
- `npm run check` — format + lint with auto-fix
- `npm run format` — format only
- `npm run lint` — lint only

## Key Conventions
- All UI components use Tailwind classes (no inline styles)
- Colors for annotation states are defined in `src/colors.ts`
- The canvas is the only place raw DOM drawing happens — everything else is React + Tailwind
- Use shadcn semantic color tokens (`bg-background`, `text-foreground`, `border`, `text-muted-foreground`, etc.) not raw colors in components

## Styling Conventions

The app is **dark only** (`<html class="dark">`; the `:root` tokens in `src/index.css` are the dark values). The look is
deliberately quiet so the survey imagery reads: green-black sage ground, snow-white type, sage for chrome, and the
marker colours (one per class in `config.ts`, plus the non-class states in `colors.ts`) reserved for markers and the
brand mark. Amber, red, and yellow are spoken for by unconfirmed, rejected, and selection, so a new class colour has
to come from the cool half of the wheel.

- **Tokens only.** Palette, radius, and fonts live in `src/index.css`. Do not use raw Tailwind colours (`slate-*`,
  `white/10`, `amber-*`…) in components; the floating panels over the image use `bg-popover/85` + `border-border`
  through `OverlayPanel` in `ImageToolOverlays.tsx`.
- **Amber means "unconfirmed".** `--unconfirmed` / `bg-unconfirmed` is only for the unconfirmed marker state and
  controls that act on it. Notices, warnings, and emphasis use the neutral tokens.
- **One radius.** `rounded-md`/`rounded-lg` (from `--radius`) and `rounded-full`. No `rounded-xl`/`2xl`.
- **Type.** Public Sans (self-hosted via `@fontsource-variable/public-sans`), with `font-mono` for `<kbd>` and the
  build hash. Scale: `text-xs` for metadata and hints, `text-sm` for UI, `text-base` for lead copy, `text-3xl`+ for
  the masthead. Avoid `text-[10px]`/`text-[11px]` and uppercase-tracked eyebrow labels; section headings are
  `text-sm font-semibold` in normal case.
- **Hierarchy from space and rules, not boxes.** Prefer `border-t`/`divide-y` and whitespace over nested bordered
  cards. The dashed drop zone is the only bordered block on the landing page.
- **Contrast.** Primary buttons are sage with dark text (`--primary-foreground`); white text on the sage fails AA.
- **Instructions are not furniture.** Put how-to copy in the Help dialog or a tooltip, not in always-visible panels.
- Dialog/tooltip animations come from `tw-animate-css` (imported in `index.css`); `prefers-reduced-motion` disables
  them globally.
