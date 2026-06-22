"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

type Theme = "dark" | "light";

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
}>({
  theme: "dark",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("hunter-harness-theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const followSystem = () => {
      if (localStorage.getItem("hunter-harness-theme") === null) {
        setTheme(media.matches ? "light" : "dark");
      }
    };
    followSystem();
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const chooseTheme = (value: Theme) => {
    localStorage.setItem("hunter-harness-theme", value);
    setTheme(value);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: chooseTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
