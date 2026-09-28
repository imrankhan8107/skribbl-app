export type ThemeName = "light" | "dark" | "cyberpunk" | "forest" | "synthwave";

export interface ThemeOption {
  id: ThemeName;
  label: string;
  icon: string;
  previewColors: [string, string, string]; // primary, bg, accent
}

export const THEMES: ThemeOption[] = [
  {
    id: "light",
    label: "Classic Light",
    icon: "☀️",
    previewColors: ["#6c63ff", "#f5f7fa", "#ff6584"],
  },
  {
    id: "dark",
    label: "Midnight Dark",
    icon: "🌙",
    previewColors: ["#818cf8", "#0f172a", "#38bdf8"],
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    icon: "⚡",
    previewColors: ["#facc15", "#090a0f", "#ec4899"],
  },
  {
    id: "forest",
    label: "Emerald Forest",
    icon: "🌲",
    previewColors: ["#10b981", "#06231a", "#6ee7b7"],
  },
  {
    id: "synthwave",
    label: "Synthwave",
    icon: "🌅",
    previewColors: ["#f43f5e", "#1b0d2d", "#fbbf24"],
  },
];

const THEME_STORAGE_KEY = "skribbl_theme";

export function getStoredTheme(): ThemeName {
  if (typeof window === "undefined") return "light";
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeName;
    if (saved && THEMES.some((t) => t.id === saved)) {
      return saved;
    }
  } catch {
    // LocalStorage might be restricted
  }
  return "light";
}

export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

export function initTheme(): ThemeName {
  const current = getStoredTheme();
  applyTheme(current);
  return current;
}
