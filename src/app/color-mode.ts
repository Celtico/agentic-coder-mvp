// Light or dark: Chakra's conditions read the class of <html>; the Markdown preview reads data-color-mode.
export function applyColorMode(mode: "light" | "dark") {
  const html = document.documentElement
  html.classList.toggle("dark", mode === "dark")
  html.classList.toggle("light", mode === "light")
  document.body.setAttribute("data-color-mode", mode)
}
