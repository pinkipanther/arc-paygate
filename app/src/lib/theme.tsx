import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";
type Resolved = "light" | "dark";

interface ThemeCtx {
  theme: Theme;
  systemTheme: Resolved;
  resolvedTheme: Resolved;
  setTheme: (t: Theme) => void;
}

const KEY = "paygate.theme";
const Ctx = createContext<ThemeCtx | null>(null);

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Same shape as next-themes' useTheme, so shadcn and Magic UI components work unchanged. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(stored);
  const [systemTheme, setSystem] = useState<Resolved>(() => (mq().matches ? "dark" : "light"));

  useEffect(() => {
    const m = mq();
    const on = () => setSystem(m.matches ? "dark" : "light");
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const resolvedTheme: Resolved = theme === "system" ? systemTheme : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode: keep it for this tab only */
    }
  }, []);

  return <Ctx.Provider value={{ theme, systemTheme, resolvedTheme, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme outside ThemeProvider");
  return c;
}
