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

Currently installed: `button`, `dialog`, `dropdown-menu`

Config: `components.json` in the frontend root.

## Architecture
- **State**: React Context + `useReducer` with undo/redo via patches (`src/state.ts`, `src/types.ts`)
- **Rendering**: RAF-based canvas with dirty flag (`src/hooks/useCanvasRenderer.ts`)
- **Viewport**: Separate hook for pan/zoom (`src/hooks/useViewport.ts`)
- **Interaction**: Modifier-key-driven with a toggleable Add/Select mode (`A` key):
  - **Alt** = always create (force-add, ignores hit-testing). Alt+click = add point, Alt+drag = draw bbox
  - **Shift** = extend selection. Shift+click = multi-select toggle
  - **Cmd/Ctrl** = system/navigation. Cmd+scroll = zoom, Cmd+drag = pan
  - **Space** (hold) = pan via pointer lock (no click needed)
  - **No modifier**: mode-dependent. In Select mode: click = select. In Add mode: click empty = add point
  - Drag annotation = move, drag bbox handle = resize
  - Middle mouse drag = pan
  - Backspace = delete manual annotations, reject imported ones
- **Config**: `src/config.ts` defines all keybindings and click behavior in one place
- **Persistence**: localStorage saves/restores image filename + annotations across refreshes (prefix: `wsc:`)

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
