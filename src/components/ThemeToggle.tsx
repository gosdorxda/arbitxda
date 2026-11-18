"use client";

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="theme-icon-sun">
      <path
        fill="currentColor"
        d="M8 11.25A3.25 3.25 0 1 0 8 4.75a3.25 3.25 0 0 0 0 6.5zM8 1.25a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 1.25zm0 11a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 12.25zM1.25 8a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5H2A.75.75 0 0 1 1.25 8zm11 0a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1A.75.75 0 0 1 12.25 8zM3.22 3.22a.75.75 0 0 1 1.06 0l.7.7A.75.75 0 1 1 3.92 4.98l-.7-.7a.75.75 0 0 1 0-1.06zm7.8 7.8a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06zM12.08 3.22a.75.75 0 0 1 0 1.06l-.7.7a.75.75 0 1 1-1.06-1.06l.7-.7a.75.75 0 0 1 1.06 0zM4.28 11.02a.75.75 0 0 1 0 1.06l-.7.7A.75.75 0 1 1 2.52 11.72l.7-.7a.75.75 0 0 1 1.06 0z"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="theme-icon-moon">
      <path
        fill="currentColor"
        d="M7.04 2.18a.75.75 0 0 1 .1 1.05 5.25 5.25 0 1 0 5.63 5.63.75.75 0 0 1 1.32.4A6.75 6.75 0 1 1 6.1 2.08a.75.75 0 0 1 .94.1z"
      />
    </svg>
  );
}

function applyTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.toggle("light", theme === "light");
  try {
    window.localStorage.setItem("arbit-theme", theme);
  } catch {
    // storage diblokir
  }
}

export function ThemeToggle() {
  const toggle = () => {
    const isLight =
      document.documentElement.classList.contains("light") ||
      document.documentElement.getAttribute("data-theme") === "light";
    applyTheme(isLight ? "dark" : "light");
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="btn-ghost inline-flex h-8 w-8 items-center justify-center !px-0"
      title="Ganti mode terang/gelap"
      aria-label="Ganti mode terang atau gelap"
    >
      <SunIcon />
      <MoonIcon />
    </button>
  );
}
