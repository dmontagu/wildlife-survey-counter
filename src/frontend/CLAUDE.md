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

Currently installed: `button`, `dialog`, `dropdown-menu`, `tooltip`

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
- **Config**: `src/config.ts` defines the keyboard shortcuts (`KEYS`), zoom bounds, and label categories; click behavior lives in `Canvas.tsx`
- **Persistence**: localStorage saves/restores the current image, its annotations, and UI preferences across refreshes (prefix: `wsc:`); images opened from disk are stored as blobs in IndexedDB (`wsc-browser-images`, see `src/lib/browser-images.ts`)

## Path Aliases
`@/` maps to `./src/` (configured in both `tsconfig.json` and `vite.config.ts`).

## Server
The backend is a Python server (`src/wildlife_counter/server.py`) that serves images from `storage/samples/` and `storage/uploads/` directories. Vite proxies `/api`, `/samples`, and `/uploads` to `http://localhost:8100`.

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
