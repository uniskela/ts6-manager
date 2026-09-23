import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const BASE_THEMES = ['light', 'dark', 'black'] as const;
export const ACCENTS = ['cyan', 'violet', 'red', 'blue', 'emerald', 'amber'] as const;
export const SIDEBAR_SECTION_IDS = ['overview', 'management', 'security', 'content', 'system', 'automation'] as const;
export const BACKGROUNDS = ['none', 'grid', 'dots', 'glow', 'aurora', 'noise'] as const;
export const BACKGROUND_MOTIONS = ['system', 'off', 'on'] as const;
export const BACKGROUND_INTENSITIES = ['subtle', 'normal', 'strong'] as const;

export type BaseTheme = (typeof BASE_THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type PermissionLabelMode = 'simple' | 'technical';
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];
export type SidebarSections = Record<SidebarSectionId, boolean>;
export type Background = (typeof BACKGROUNDS)[number];
export type BackgroundMotion = (typeof BACKGROUND_MOTIONS)[number];
export type BackgroundIntensity = (typeof BACKGROUND_INTENSITIES)[number];
export type ResolvedMotion = 'on' | 'off';

export const DEFAULT_BASE_THEME: BaseTheme = 'dark';
export const DEFAULT_ACCENT: Accent = 'cyan';
// 'grid' preserves the background treatment every existing user already sees.
export const DEFAULT_BACKGROUND: Background = 'grid';
export const DEFAULT_BACKGROUND_MOTION: BackgroundMotion = 'system';
export const DEFAULT_BACKGROUND_INTENSITY: BackgroundIntensity = 'normal';
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

function isBackground(value: unknown): value is Background {
  return typeof value === 'string' && BACKGROUNDS.includes(value as Background);
}

function isBackgroundMotion(value: unknown): value is BackgroundMotion {
  return typeof value === 'string' && BACKGROUND_MOTIONS.includes(value as BackgroundMotion);
}

function isBackgroundIntensity(value: unknown): value is BackgroundIntensity {
  return typeof value === 'string' && BACKGROUND_INTENSITIES.includes(value as BackgroundIntensity);
}

/**
 * Resolves whether decorative background motion should actually run, given the
 * user's preference and (when following System) the OS-level reduced-motion setting.
 */
export function resolveBackgroundMotion(motion: BackgroundMotion, systemPrefersReducedMotion: boolean): ResolvedMotion {
  if (motion === 'off') return 'off';
  if (motion === 'on') return 'on';
  return systemPrefersReducedMotion ? 'off' : 'on';
}

function isPermissionLabelMode(value: unknown): value is PermissionLabelMode {
  return value === 'simple' || value === 'technical';
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
    background: isBackground(state.background) ? state.background : DEFAULT_BACKGROUND,
    backgroundMotion: isBackgroundMotion(state.backgroundMotion) ? state.backgroundMotion : DEFAULT_BACKGROUND_MOTION,
    backgroundIntensity: isBackgroundIntensity(state.backgroundIntensity) ? state.backgroundIntensity : DEFAULT_BACKGROUND_INTENSITY,
    permissionLabelMode: isPermissionLabelMode(state.permissionLabelMode) ? state.permissionLabelMode : 'simple',
    showQueryClients: state.showQueryClients === true,
  };
}

interface UiStore {
  sidebarCollapsed: boolean;
  sidebarSections: SidebarSections;
  baseTheme: BaseTheme;
  accent: Accent;
  background: Background;
  backgroundMotion: BackgroundMotion;
  backgroundIntensity: BackgroundIntensity;
  permissionLabelMode: PermissionLabelMode;
  showQueryClients: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarSection: (sectionId: SidebarSectionId) => void;
  toggleTheme: () => void;
  setBaseTheme: (theme: BaseTheme) => void;
  setAccent: (accent: Accent) => void;
  setBackground: (background: Background) => void;
  setBackgroundMotion: (motion: BackgroundMotion) => void;
  setBackgroundIntensity: (intensity: BackgroundIntensity) => void;
  setPermissionLabelMode: (mode: PermissionLabelMode) => void;
  setShowQueryClients: (show: boolean) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      sidebarSections: { ...DEFAULT_SIDEBAR_SECTIONS },
      baseTheme: DEFAULT_BASE_THEME,
      accent: DEFAULT_ACCENT,
      background: DEFAULT_BACKGROUND,
      backgroundMotion: DEFAULT_BACKGROUND_MOTION,
      backgroundIntensity: DEFAULT_BACKGROUND_INTENSITY,
      permissionLabelMode: 'simple',
      showQueryClients: false,
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
      setBackground: (background) => set({ background }),
      setBackgroundMotion: (backgroundMotion) => set({ backgroundMotion }),
      setBackgroundIntensity: (backgroundIntensity) => set({ backgroundIntensity }),
      setPermissionLabelMode: (permissionLabelMode) => set({ permissionLabelMode }),
      setShowQueryClients: (showQueryClients) => set({ showQueryClients }),
    }),
    {
      name: 'ts6-ui',
      version: 5,
      migrate: migrateUiState,
      merge: (persisted, current) => ({ ...current, ...migrateUiState(persisted) }),
      partialize: ({
        sidebarCollapsed, sidebarSections, baseTheme, accent, background, backgroundMotion, backgroundIntensity,
        permissionLabelMode, showQueryClients,
      }) => ({
        sidebarCollapsed,
        sidebarSections,
        baseTheme,
        accent,
        background,
        backgroundMotion,
        backgroundIntensity,
        permissionLabelMode,
        showQueryClients,
      }),
      onRehydrateStorage: () => (state) => {
        applyAppearance(state?.baseTheme ?? DEFAULT_BASE_THEME, state?.accent ?? DEFAULT_ACCENT);
      },
    },
  ),
);
