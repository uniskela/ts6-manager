import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const BASE_THEMES = ['light', 'dark', 'black'] as const;
export const ACCENTS = ['cyan', 'violet', 'red', 'blue', 'emerald', 'amber'] as const;
export const SIDEBAR_SECTION_IDS = ['overview', 'management', 'security', 'content', 'system', 'automation'] as const;

export type BaseTheme = (typeof BASE_THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];
export type SidebarSections = Record<SidebarSectionId, boolean>;

export const DEFAULT_BASE_THEME: BaseTheme = 'dark';
export const DEFAULT_ACCENT: Accent = 'cyan';
export const DEFAULT_SIDEBAR_SECTIONS: SidebarSections = {
  overview: true,
  management: true,
  security: true,
  content: true,
  system: true,
  automation: true,
};

function isBaseTheme(value: unknown): value is BaseTheme {
  return typeof value === 'string' && BASE_THEMES.includes(value as BaseTheme);
}

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && ACCENTS.includes(value as Accent);
}

function migrateSidebarSections(value: unknown): SidebarSections {
  const sections = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(
    SIDEBAR_SECTION_IDS.map(id => [id, typeof sections[id] === 'boolean' ? sections[id] : true]),
  ) as SidebarSections;
}

export function applyAppearance(baseTheme: BaseTheme, accent: Accent) {
  const root = document.documentElement;
  root.dataset.theme = baseTheme;
  root.dataset.accent = accent;
  root.classList.toggle('dark', baseTheme !== 'light');
  root.classList.toggle('black', baseTheme === 'black');
  root.style.colorScheme = baseTheme === 'light' ? 'light' : 'dark';

  const themeColour = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColour) {
    themeColour.content = baseTheme === 'light' ? '#f8fafc' : baseTheme === 'black' ? '#000000' : '#0b0e13';
  }
}

function migrateUiState(persisted: unknown) {
  const state = persisted && typeof persisted === 'object' ? persisted as Record<string, unknown> : {};
  const legacyTheme = isBaseTheme(state.theme) ? state.theme : undefined;
  return {
    sidebarCollapsed: state.sidebarCollapsed === true,
    sidebarSections: migrateSidebarSections(state.sidebarSections),
    baseTheme: isBaseTheme(state.baseTheme) ? state.baseTheme : legacyTheme ?? DEFAULT_BASE_THEME,
    accent: isAccent(state.accent) ? state.accent : DEFAULT_ACCENT,
  };
}

interface UiStore {
  sidebarCollapsed: boolean;
  sidebarSections: SidebarSections;
  baseTheme: BaseTheme;
  accent: Accent;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarSection: (sectionId: SidebarSectionId) => void;
  toggleTheme: () => void;
  setBaseTheme: (theme: BaseTheme) => void;
  setAccent: (accent: Accent) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      sidebarSections: { ...DEFAULT_SIDEBAR_SECTIONS },
      baseTheme: DEFAULT_BASE_THEME,
      accent: DEFAULT_ACCENT,
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebarSection: (sectionId) => set(state => ({
        sidebarSections: {
          ...state.sidebarSections,
          [sectionId]: !state.sidebarSections[sectionId],
        },
      })),
      toggleTheme: () => {
        const next = get().baseTheme === 'light' ? 'dark' : 'light';
        set({ baseTheme: next });
        applyAppearance(next, get().accent);
      },
      setBaseTheme: (baseTheme) => {
        set({ baseTheme });
        applyAppearance(baseTheme, get().accent);
      },
      setAccent: (accent) => {
        set({ accent });
        applyAppearance(get().baseTheme, accent);
      },
    }),
    {
      name: 'ts6-ui',
      version: 2,
      migrate: migrateUiState,
      merge: (persisted, current) => ({ ...current, ...migrateUiState(persisted) }),
      partialize: ({ sidebarCollapsed, sidebarSections, baseTheme, accent }) => ({
        sidebarCollapsed,
        sidebarSections,
        baseTheme,
        accent,
      }),
      onRehydrateStorage: () => (state) => {
        applyAppearance(state?.baseTheme ?? DEFAULT_BASE_THEME, state?.accent ?? DEFAULT_ACCENT);
      },
    },
  ),
);
